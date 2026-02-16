'use strict';

/**
 * THE FOXPOT CLUB — Phase 1 MVP — server.js v2.0
 *
 * FIXES vs v1:
 *  1. PIN більше НЕ в URL — cookie-сесії (HMAC-signed, 8 год)
 *  2. Debounce 15 хв — немає дублікатів counted_visit за 15 хв
 *  3. sendMessage у try/catch — панель ніколи не падає через помилку бота
 *  4. Rate limit логіну — макс 10 спроб / 15 хв з одного IP
 *  5. Race condition fix — UNIQUE constraint + ON CONFLICT DO NOTHING
 *
 * ENV required:
 *   BOT_TOKEN, DATABASE_URL, PUBLIC_URL
 * ENV optional:
 *   WEBHOOK_SECRET, SESSION_SECRET, PORT
 */

const express = require('express');
const crypto  = require('crypto');
const { Pool }    = require('pg');
const { Telegraf } = require('telegraf');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── ENV ────────────────────────────────────────────────────────────────────

const PORT           = process.env.PORT           || 8080;
const BOT_TOKEN      = process.env.BOT_TOKEN      || '';
const DATABASE_URL   = process.env.DATABASE_URL   || '';
const PUBLIC_URL     = process.env.PUBLIC_URL      || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!DATABASE_URL)  console.error('❌ Missing DATABASE_URL');
if (!BOT_TOKEN)     console.error('❌ Missing BOT_TOKEN');
if (!PUBLIC_URL)    console.error('❌ Missing PUBLIC_URL');
if (!process.env.SESSION_SECRET)
  console.warn('⚠️  SESSION_SECRET not set — sessions will reset on every server restart. Add it to Railway env vars.');

// ─── DB ─────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=') ? undefined : { rejectUnauthorized: false },
});

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// ─── TABLE NAMES ─────────────────────────────────────────────────────────────

const T = {
  venues:   'fp1_venues',
  foxes:    'fp1_foxes',
  checkins: 'fp1_checkins',
  counted:  'fp1_counted_visits',
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function warsawDayKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const y   = parts.find(p => p.type === 'year')?.value;
  const m   = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function genOTP6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function pinHash(pin, salt) {
  return sha256Hex(`${salt}:${pin}`);
}

function salt8() {
  return crypto.randomBytes(8).toString('hex');
}

function safeHtml(s) {
  return String(s ?? '')
    .replaceAll('&',  '&amp;')
    .replaceAll('<',  '&lt;')
    .replaceAll('>',  '&gt;')
    .replaceAll('"',  '&quot;')
    .replaceAll("'", '&#039;');
}

async function db(text, params = []) {
  const c = await pool.connect();
  try   { return await c.query(text, params); }
  finally { c.release(); }
}

function panelUrl() {
  return `${PUBLIC_URL.replace(/\/$/, '')}/panel`;
}

// ─── SESSION — HMAC-signed cookie (stateless, no DB needed) ─────────────────
//
// Format stored in cookie:  base64url( venueId:timestamp:hmacSig )
// venueId   = number (no colons)
// timestamp = number (no colons)
// hmacSig   = 64-char hex (no colons)
// lastIndexOf(':') always finds the sig boundary correctly.

function createSessionToken(venueId) {
  const payload = `${venueId}:${Date.now()}`;
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifySessionToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) return null;

    const payload = decoded.substring(0, lastColon);
    const sig     = decoded.substring(lastColon + 1);

    const expected = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(payload)
      .digest('hex');

    // Always use timingSafeEqual to prevent timing attacks
    const sigBuf      = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const [venueStr, tsStr] = payload.split(':');
    const venueId = Number(venueStr);
    const ts      = Number(tsStr);
    if (!venueId || !ts) return null;

    // Session expires after 8 hours
    if (Date.now() - ts > 8 * 60 * 60 * 1000) return null;

    return { venueId };
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach(part => {
    const [name, ...rest] = part.trim().split('=');
    try { out[name.trim()] = decodeURIComponent(rest.join('=')); }
    catch { /* ignore bad encoding */ }
  });
  return out;
}

function getSession(req) {
  const token = parseCookies(req)['foxpot_session'];
  if (!token) return null;
  return verifySessionToken(token);
}

function setSessionCookie(res, venueId) {
  const token = createSessionToken(venueId);
  res.setHeader('Set-Cookie',
    `foxpot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 3600}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `foxpot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// ─── RATE LIMIT — login attempts per IP ──────────────────────────────────────
// Max 10 failed attempts per IP within 15 minutes

const loginFails = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const now = Date.now();
  const e = loginFails.get(ip);
  if (!e || now > e.resetAt) return false;
  return e.count >= 10;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const e = loginFails.get(ip);
  if (!e || now > e.resetAt) {
    loginFails.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    e.count++;
  }
}

function resetLoginFails(ip) {
  loginFails.delete(ip);
}

// Clean up expired entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFails) {
    if (now > e.resetAt) loginFails.delete(ip);
  }
}, 60 * 60 * 1000);

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

async function ensureSchema() {
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.venues} (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL DEFAULT '',
      city       TEXT        NOT NULL DEFAULT '',
      pin_salt   TEXT        NOT NULL DEFAULT '',
      pin_hash   TEXT        NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS ${T.foxes} (
      id         SERIAL  PRIMARY KEY,
      user_id    BIGINT  UNIQUE,
      username   TEXT    NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS ${T.checkins} (
      id           SERIAL  PRIMARY KEY,
      venue_id     INT     NOT NULL,
      user_id      BIGINT  NOT NULL,
      otp          TEXT    NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ NULL
    );
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS ${T.counted} (
      id         SERIAL  PRIMARY KEY,
      venue_id   INT     NOT NULL,
      user_id    BIGINT  NOT NULL,
      day_key    DATE    NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Indexes
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_checkins_venue_otp
            ON ${T.checkins}(venue_id, otp);`);

  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_checkins_expires
            ON ${T.checkins}(expires_at);`);

  // Migration fix: drop old non-unique index created by v1 (if exists)
  await db(`DROP INDEX IF EXISTS fp1_idx_counted_unique;`);

  // Create proper UNIQUE index (required for ON CONFLICT DO NOTHING)
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS fp1_uniq_counted
            ON ${T.counted}(venue_id, user_id, day_key);`);

  // Seed 2 test venues if table is empty
  const r = await db(`SELECT COUNT(*)::int AS c FROM ${T.venues};`);
  if ((r.rows[0]?.c || 0) === 0) {
    const s1 = salt8();
    const h1 = pinHash('123456', s1);
    await db(
      `INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`,
      ['Test Kebab #1', 'Warsaw', s1, h1]
    );

    const s2 = salt8();
    const h2 = pinHash('123456', s2);
    await db(
      `INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`,
      ['Test Pizza #2', 'Warsaw', s2, h2]
    );

    console.log('✅ Seeded fp1_venues (PIN 123456).');
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────

async function getVenue(venueId) {
  const r = await db(
    `SELECT id, name, city, pin_salt, pin_hash FROM ${T.venues} WHERE id=$1;`,
    [venueId]
  );
  return r.rows[0] || null;
}

async function verifyPin(venueId, pin) {
  const v = await getVenue(venueId);
  if (!v) return { ok: false };
  const h = pinHash(String(pin), String(v.pin_salt || ''));
  return h === v.pin_hash ? { ok: true, venue: v } : { ok: false };
}

async function upsertFox(userId, username) {
  await db(
    `INSERT INTO ${T.foxes}(user_id, username)
     VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username;`,
    [userId, username || '']
  );
}

async function countedExistsToday(userId, venueId) {
  const day = warsawDayKey();
  const r = await db(
    `SELECT 1 FROM ${T.counted}
     WHERE user_id=$1 AND venue_id=$2 AND day_key=$3::date LIMIT 1;`,
    [userId, venueId, day]
  );
  return { exists: r.rowCount > 0, day };
}

// FIX: Debounce — was there a confirmed check-in for this user+venue in last 15 min?
async function recentConfirmExists(userId, venueId) {
  const r = await db(
    `SELECT 1 FROM ${T.checkins}
     WHERE user_id=$1 AND venue_id=$2
       AND confirmed_at IS NOT NULL
       AND confirmed_at > NOW() - INTERVAL '15 minutes'
     LIMIT 1;`,
    [userId, venueId]
  );
  return r.rowCount > 0;
}

// FIX: ON CONFLICT DO NOTHING eliminates race condition from two simultaneous confirms
async function addCounted(userId, venueId) {
  const day = warsawDayKey();
  const r = await db(
    `INSERT INTO ${T.counted}(user_id, venue_id, day_key)
     VALUES ($1, $2, $3::date)
     ON CONFLICT (venue_id, user_id, day_key) DO NOTHING
     RETURNING id;`,
    [userId, venueId, day]
  );
  return { added: r.rowCount > 0, day };
}

async function getXY(userId, venueId) {
  const x = await db(
    `SELECT COUNT(*)::int AS c FROM ${T.counted}
     WHERE user_id=$1 AND venue_id=$2;`,
    [userId, venueId]
  );
  const y = await db(
    `SELECT COUNT(*)::int AS c FROM ${T.counted}
     WHERE venue_id=$1;`,
    [venueId]
  );
  return { X: x.rows[0]?.c || 0, Y: y.rows[0]?.c || 0 };
}

// ─── ROUTE: HEALTH ────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    const t = await db(`SELECT NOW() AS now;`);
    res.json({ ok: true, db: true, now: t.rows[0]?.now, tz: 'Europe/Warsaw' });
  } catch (e) {
    res.json({ ok: true, db: false, error: String(e?.message || e) });
  }
});

// ─── ROUTE: PANEL — Login page ────────────────────────────────────────────────

app.get('/panel', (req, res) => {
  // If already logged in → go straight to dashboard
  if (getSession(req)) return res.redirect('/panel/dashboard');

  const errMsg =
    req.query.err === 'r' ? 'Zbyt wiele prób. Spróbuj za 15 minut.' :
    req.query.err === '1' ? 'Błędny Venue ID lub PIN.' :
    '';

  res.send(`<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Panel lokalu — FoxPot</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0f1220;
      color: #fff;
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #14182b;
      padding: 32px;
      border-radius: 16px;
      width: 100%;
      max-width: 380px;
    }
    h2 { margin: 0 0 24px; font-size: 22px; }
    label { display: block; margin-bottom: 6px; opacity: .75; font-size: 14px; }
    input {
      width: 100%;
      padding: 11px 14px;
      border-radius: 10px;
      border: 1px solid #2a2f49;
      background: #0f1220;
      color: #fff;
      font-size: 16px;
      margin-bottom: 16px;
    }
    input:focus { outline: none; border-color: #6e56ff; }
    button {
      width: 100%;
      padding: 13px;
      border: 0;
      border-radius: 10px;
      background: #6e56ff;
      color: #fff;
      font-weight: 700;
      font-size: 16px;
      cursor: pointer;
    }
    button:hover { background: #5a44e0; }
    .err {
      color: #ff7b7b;
      font-size: 14px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: #2a1a1a;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>🦊 Panel lokalu</h2>
    ${errMsg ? `<div class="err">${safeHtml(errMsg)}</div>` : ''}
    <form method="POST" action="/panel/login">
      <label>Venue ID</label>
      <input name="venue" type="number" min="1" required autocomplete="off" placeholder="np. 1" />
      <label>PIN (6 cyfr)</label>
      <input name="pin" type="password" maxlength="6" required autocomplete="current-password" placeholder="••••••" />
      <button type="submit">Zaloguj →</button>
    </form>
  </div>
</body>
</html>`);
});

// ─── ROUTE: PANEL — Login action ──────────────────────────────────────────────

app.post('/panel/login', async (req, res) => {
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  // Rate limit check
  if (isRateLimited(ip)) {
    return res.redirect('/panel?err=r');
  }

  const venueId = Number(String(req.body.venue || '').trim());
  const pin     = String(req.body.pin || '').trim();

  if (!venueId || !pin) return res.redirect('/panel?err=1');

  const { ok } = await verifyPin(venueId, pin);

  if (!ok) {
    recordFailedLogin(ip);
    return res.redirect('/panel?err=1');
  }

  // Login OK — reset fail counter, set cookie, redirect to dashboard
  resetLoginFails(ip);
  setSessionCookie(res, venueId);
  return res.redirect('/panel/dashboard');
});

// ─── ROUTE: PANEL — Logout ────────────────────────────────────────────────────

app.get('/panel/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/panel');
});

// ─── ROUTE: PANEL — Dashboard ────────────────────────────────────────────────

app.get('/panel/dashboard', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.redirect('/panel');

  const { venueId } = session;
  const venue = await getVenue(venueId);
  if (!venue) {
    clearSessionCookie(res);
    return res.redirect('/panel');
  }

  // Load pending (unconfirmed, not expired) check-ins
  const pending = await db(
    `SELECT otp, user_id, expires_at FROM ${T.checkins}
     WHERE venue_id=$1 AND confirmed_at IS NULL AND expires_at > NOW()
     ORDER BY expires_at ASC LIMIT 50;`,
    [venueId]
  );

  const pendingHtml = pending.rows.length === 0
    ? `<div class="empty">Brak aktywnych check-inów</div>`
    : pending.rows.map(r => {
        const secLeft = Math.max(0, Math.round((new Date(r.expires_at) - Date.now()) / 1000));
        const mm = String(Math.floor(secLeft / 60)).padStart(2, '0');
        const ss = String(secLeft % 60).padStart(2, '0');
        return `
        <div class="pending-row">
          <div class="otp-display">${safeHtml(r.otp)}</div>
          <div class="pending-meta">
            Fox: ****${String(r.user_id).slice(-4)}
            &nbsp;|&nbsp;
            ⏱ Wygasa za: <b>${mm}:${ss}</b>
          </div>
        </div>`;
      }).join('');

  // Flash message (success/error from confirm action)
  const flashMsg = req.query.msg
    ? decodeURIComponent(String(req.query.msg))
    : '';
  const flashOk = req.query.ok === '1';
  const flashHtml = flashMsg
    ? `<div class="flash ${flashOk ? 'flash-ok' : 'flash-err'}">${safeHtml(flashMsg)}</div>`
    : '';

  res.send(`<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Panel — ${safeHtml(venue.name)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0f1220;
      color: #fff;
      font-family: system-ui, sans-serif;
      padding: 20px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: #14182b;
      padding: 20px 24px;
      border-radius: 14px;
    }
    h2 { margin: 0 0 6px; font-size: 20px; }
    h3 { margin: 0 0 14px; font-size: 16px; }
    .venue-meta { opacity: .7; font-size: 14px; margin-top: 6px; }
    a.logout { color: #9aa4ff; font-size: 14px; text-decoration: none; }
    a.logout:hover { text-decoration: underline; }

    .otp-row { display: flex; gap: 10px; }
    .otp-row input {
      flex: 1;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid #2a2f49;
      background: #0f1220;
      color: #fff;
      font-size: 24px;
      letter-spacing: 8px;
      text-align: center;
    }
    .otp-row input:focus { outline: none; border-color: #6e56ff; }
    .otp-row button {
      padding: 12px 20px;
      border: 0;
      border-radius: 10px;
      background: #6e56ff;
      color: #fff;
      font-weight: 700;
      font-size: 16px;
      cursor: pointer;
      white-space: nowrap;
    }
    .otp-row button:hover { background: #5a44e0; }

    .pending-row {
      padding: 12px 14px;
      border: 1px solid #2a2f49;
      border-radius: 12px;
      background: #0f1220;
      margin-bottom: 10px;
    }
    .otp-display {
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 8px;
    }
    .pending-meta {
      opacity: .65;
      font-size: 13px;
      margin-top: 4px;
    }
    .empty { opacity: .55; font-style: italic; }
    .refresh-hint { opacity: .45; font-size: 12px; margin-top: 10px; }

    .flash {
      padding: 14px 18px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 15px;
    }
    .flash-ok  { background: #0f2e1a; color: #7fffaa; border: 1px solid #2a5a3a; }
    .flash-err { background: #2e0f0f; color: #ff9f9f; border: 1px solid #5a2a2a; }
  </style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="card">
    <h2>🦊 Panel lokalu</h2>
    <div class="venue-meta">Zalogowano jako: <b>${safeHtml(venue.name)}</b> (ID ${venueId})</div>
    <div style="margin-top:10px;">
      <a href="/panel/logout" class="logout">← Wyloguj</a>
    </div>
  </div>

  <!-- Flash message -->
  ${flashHtml}

  <!-- OTP confirm -->
  <div class="card">
    <h3>Potwierdź OTP gościa</h3>
    <form method="POST" action="/panel/dashboard/confirm" class="otp-row">
      <input
        name="otp"
        placeholder="000000"
        maxlength="6"
        inputmode="numeric"
        pattern="[0-9]{6}"
        required
        autocomplete="off"
        autofocus
      />
      <button type="submit">Confirm ✓</button>
    </form>
  </div>

  <!-- Pending list -->
  <div class="card">
    <h3>Aktywne check-iny <span style="opacity:.5;font-size:13px;">(wygasają za 10 min)</span></h3>
    ${pendingHtml}
    <div class="refresh-hint">Strona odświeża się automatycznie co 30 sekund</div>
  </div>

</div>

<script>
  // Auto-refresh every 30 seconds to update pending list and timers
  setTimeout(() => location.reload(), 30000);
</script>
</body>
</html>`);
});

// ─── ROUTE: PANEL — Confirm OTP ───────────────────────────────────────────────

app.post('/panel/dashboard/confirm', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.redirect('/panel');

  const { venueId } = session;
  const venue = await getVenue(venueId);
  if (!venue) {
    clearSessionCookie(res);
    return res.redirect('/panel');
  }

  const otp = String(req.body.otp || '').trim();

  // Basic OTP format check
  if (!/^\d{6}$/.test(otp)) {
    const msg = encodeURIComponent('Nieprawidłowy OTP — wymagane 6 cyfr');
    return res.redirect(`/panel/dashboard?msg=${msg}`);
  }

  // Find check-in by OTP
  const r = await db(
    `SELECT id, user_id, expires_at, confirmed_at
     FROM ${T.checkins}
     WHERE venue_id=$1 AND otp=$2
     ORDER BY id DESC LIMIT 1;`,
    [venueId, otp]
  );

  if (r.rowCount === 0) {
    const msg = encodeURIComponent('OTP nie znaleziono');
    return res.redirect(`/panel/dashboard?msg=${msg}`);
  }

  const chk = r.rows[0];

  if (new Date(chk.expires_at).getTime() <= Date.now()) {
    const msg = encodeURIComponent('OTP wygasł (limit 10 minut)');
    return res.redirect(`/panel/dashboard?msg=${msg}`);
  }

  if (chk.confirmed_at) {
    const msg = encodeURIComponent('Już potwierdzono ten OTP ✅');
    return res.redirect(`/panel/dashboard?msg=${msg}&ok=1`);
  }

  const userId = Number(chk.user_id);

  // FIX: Debounce — check if this Fox confirmed at this venue in last 15 min
  const isDebounce = await recentConfirmExists(userId, venueId);

  // Always mark check-in as confirmed (regardless of debounce)
  await db(`UPDATE ${T.checkins} SET confirmed_at=NOW() WHERE id=$1;`, [chk.id]);

  if (isDebounce) {
    // Debounce hit — no counted added, just acknowledge
    const xy = await getXY(userId, venueId);

    // FIX: sendMessage in try/catch — panel never crashes on bot error
    try {
      await bot?.telegram.sendMessage(
        userId,
        `⚠️ Wizyta już potwierdzona w ciągu 15 min\n🏪 ${venue.name}\n📊 X/Y: ${xy.X}/${xy.Y}`
      );
    } catch (e) {
      console.error('sendMessage debounce error:', e?.message);
    }

    const msg = encodeURIComponent(`Debounce ⚠️ — wizyta już potwierdzona w ostatnich 15 min (X/Y ${xy.X}/${xy.Y})`);
    return res.redirect(`/panel/dashboard?msg=${msg}&ok=1`);
  }

  // Add counted visit (ON CONFLICT DO NOTHING handles simultaneous confirms)
  const counted = await addCounted(userId, venueId);
  const xy = await getXY(userId, venueId);

  // FIX: sendMessage in try/catch — panel never crashes on bot error
  try {
    if (!counted.added) {
      await bot?.telegram.sendMessage(
        userId,
        `DZIŚ JUŻ BYŁO ✅\n🏪 ${venue.name}\n📅 Dzień (Warszawa): ${counted.day}\n📊 X/Y: ${xy.X}/${xy.Y}`
      );
    } else {
      await bot?.telegram.sendMessage(
        userId,
        `✅ Confirm OK\n🏪 ${venue.name}\n📅 Day (Warszawa): ${counted.day}\n📊 X/Y: ${xy.X}/${xy.Y}`
      );
    }
  } catch (e) {
    console.error('sendMessage confirm error:', e?.message);
    // Confirm still succeeded — do NOT fail the request
  }

  const displayMsg = counted.added
    ? `Confirm OK ✅  (X/Y ${xy.X}/${xy.Y})`
    : `DZIŚ JUŻ BYŁO ✅  (X/Y ${xy.X}/${xy.Y})`;

  const msg = encodeURIComponent(displayMsg);
  return res.redirect(`/panel/dashboard?msg=${msg}&ok=1`);
});

// ─── BOT ──────────────────────────────────────────────────────────────────────

if (bot) {
  bot.start(async ctx => {
    await ctx.reply(
      `THE FOXPOT CLUB — MVP\n\nKomendy:\n/venues\n/panel\n/checkin <venue_id>\n\nPrzykład: /checkin 1`
    );
  });

  bot.command('venues', async ctx => {
    const r = await db(
      `SELECT id, name, city FROM ${T.venues} ORDER BY id ASC LIMIT 50;`
    );
    const list = r.rows.map(v => `• ID ${v.id}: ${v.name} (${v.city})`).join('\n');
    await ctx.reply(`🏪 Lokale (testowe)\n\n${list}\n\nCheck-in: /checkin 1`);
  });

  bot.command('panel', async ctx => {
    await ctx.reply(`Panel: ${panelUrl()}`);
  });

  bot.command('checkin', async ctx => {
    try {
      const text    = String(ctx.message?.text || '');
      const venueId = Number(text.split(' ')[1]);

      if (!venueId) {
        return ctx.reply('Użycie: /checkin <venue_id>\nPrzykład: /checkin 1');
      }

      const v = await getVenue(venueId);
      if (!v) return ctx.reply('Nie znaleziono lokalu.');

      const userId   = Number(ctx.from?.id);
      const username = ctx.from?.username ? `@${ctx.from.username}` : '';
      await upsertFox(userId, username);

      // If already counted today — inform Fox
      const today = await countedExistsToday(userId, venueId);
      if (today.exists) {
        const xy = await getXY(userId, venueId);
        return ctx.reply(
          `DZIŚ JUŻ BYŁO ✅\n🏪 Lokal: ${v.name}\n📅 Dzień (Warszawa): ${today.day}\n📊 X/Y: ${xy.X}/${xy.Y}\nPanel: ${panelUrl()}`
        );
      }

      // Create OTP (valid 10 minutes)
      const otp     = genOTP6();
      const expires = new Date(Date.now() + 10 * 60 * 1000);

      await db(
        `INSERT INTO ${T.checkins}(venue_id, user_id, otp, expires_at)
         VALUES ($1, $2, $3, $4);`,
        [venueId, userId, otp, expires.toISOString()]
      );

      await ctx.reply(
        `✅ Check-in utworzony (10 min)\n\n🏪 ${v.name}\n🔐 OTP: ${otp}\n\nPokaż kod personelowi.\nPanel: ${panelUrl()}`
      );
    } catch (e) {
      console.error('checkin error:', e?.message || e);
      await ctx.reply('Błąd check-in. Spróbuj ponownie.');
    }
  });

  // Webhook setup
  if (WEBHOOK_SECRET && PUBLIC_URL) {
    const webhookPath = `/${WEBHOOK_SECRET.replace(/^\//, '')}`;
    bot.telegram
      .setWebhook(`${PUBLIC_URL.replace(/\/$/, '')}${webhookPath}`)
      .then(()  => console.log('✅ Webhook set:', webhookPath))
      .catch(e  => console.error('❌ Webhook set error:', e?.message || e));
    app.use(bot.webhookCallback(webhookPath));
    console.log('✅ Webhook path ready:', webhookPath);
  } else {
    console.log('ℹ️  WEBHOOK_SECRET or PUBLIC_URL not set — webhook skipped.');
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await ensureSchema();
    console.log('✅ DB schema OK (fp1_*).');
  } catch (e) {
    console.error('❌ ensureSchema error:', e?.message || e);
  }

  app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
})();
