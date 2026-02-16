/**
 * THE FOXPOT CLUB — Phase 1 MVP
 * Single-file server.js (Node.js + Express + Telegraf + pg)
 * Dependencies: express, telegraf, pg, crypto (built-in)
 *
 * What this file guarantees:
 * - /health ok
 * - Telegram: /start (register/profile), /checkin <venue_id>, /venues, /panel
 * - Web Panel: /panel login (venue_id + PIN), /panel/dashboard
 * - Confirm OTP -> counted visit (1/day per fox+venue, Warsaw day), debounce 15 min
 * - Venue statuses in panel:
 *   - 📍 Rezerwa: max 2 / month, max 24h, set >= 24h ahead, stored in fp1_venues (reserve_start, reserve_end) + log table
 *   - Dziś ograniczone: max 2 / week (Mon–Sun Warsaw), max 3h, stored in fp1_venues (limited_reason, limited_until) + log table
 * - Auto-migrations on startup (safe)
 */

const express = require("express");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* -------------------------- ENV -------------------------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://...up.railway.app
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "wh";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : null;
const PORT = process.env.PORT || 8080;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
}
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing");
}
if (!PUBLIC_URL) {
  console.error("❌ PUBLIC_URL missing");
}

/* -------------------------- DB -------------------------- */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : undefined,
});

async function dbNow() {
  const r = await pool.query("SELECT NOW() as now");
  return r.rows[0].now;
}

/**
 * Warsaw day helpers:
 * - warsawDayKey(date) -> "YYYY-MM-DD" in Europe/Warsaw
 * - warsawWeekKey(date) -> "YYYY-Www" where week is Mon–Sun (simple key)
 */
function warsawDayKey(d = new Date()) {
  // Convert to Warsaw local date using Intl (stable for day key)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${day}`;
}

function warsawDow(d = new Date()) {
  // 1..7 (Mon..Sun)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
  }).format(d);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[parts] || 1;
}

function warsawWeekKey(d = new Date()) {
  // Key based on Monday start (Mon–Sun)
  // We'll compute "weekStartDateKey" (Monday date key) and use it.
  const key = warsawDayKey(d);
  const [yy, mm, dd] = key.split("-").map((x) => parseInt(x, 10));
  // Construct a UTC date at noon to avoid DST edges, then shift by Warsaw offset via Intl day logic
  const base = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  const dow = warsawDow(base); // Mon=1..Sun=7
  const diffDays = dow - 1; // how many days since Monday
  const monday = new Date(base.getTime() - diffDays * 86400000);
  const mondayKey = warsawDayKey(monday);
  return mondayKey; // good enough as week bucket
}

/* -------------------------- Self-adaptive columns -------------------------- */
async function hasColumn(table, col) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
  `;
  const r = await pool.query(q, [table, col]);
  return r.rowCount > 0;
}

async function ensureTable(sql) {
  await pool.query(sql);
}

async function ensureColumn(table, col, ddlTypeAndDefault) {
  const exists = await hasColumn(table, col);
  if (!exists) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddlTypeAndDefault}`);
  }
}

async function ensureIndex(indexSql) {
  // Postgres: CREATE INDEX IF NOT EXISTS supported (for indexes yes)
  await pool.query(indexSql);
}

async function migrate() {
  // Core tables (minimal; if you already have them, IF NOT EXISTS keeps safe)
  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_venues (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Venue',
      city TEXT NOT NULL DEFAULT 'Warsaw',
      pin_hash TEXT,
      pin_salt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_foxes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT UNIQUE,
      username TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_checkins (
      id BIGSERIAL PRIMARY KEY,
      venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      user_id BIGINT,
      fox_id BIGINT,
      otp TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      confirmed_by_venue_id BIGINT,
      war_day TEXT
    )
  `);

  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_counted_visits (
      id BIGSERIAL PRIMARY KEY,
      venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      user_id BIGINT,
      fox_id BIGINT,
      war_day TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // New columns for Fox profile
  await ensureColumn("fp1_foxes", "rating", "INT NOT NULL DEFAULT 1");
  await ensureColumn("fp1_foxes", "invites", "INT NOT NULL DEFAULT 3");
  await ensureColumn("fp1_foxes", "city", "TEXT NOT NULL DEFAULT 'Warsaw'");

  // Venue status columns
  await ensureColumn("fp1_venues", "reserve_start", "TIMESTAMPTZ");
  await ensureColumn("fp1_venues", "reserve_end", "TIMESTAMPTZ");
  await ensureColumn("fp1_venues", "limited_reason", "TEXT");
  await ensureColumn("fp1_venues", "limited_until", "TIMESTAMPTZ");

  // Logs for limits
  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_venue_reserve_logs (
      id BIGSERIAL PRIMARY KEY,
      venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      reserve_start TIMESTAMPTZ NOT NULL,
      reserve_end TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_venue_limited_logs (
      id BIGSERIAL PRIMARY KEY,
      venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      week_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      until_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Indexes
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_otp ON fp1_checkins(otp)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_expires ON fp1_checkins(expires_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_counted_unique ON fp1_counted_visits(venue_id, war_day, user_id, fox_id)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_reserve_logs_month ON fp1_venue_reserve_logs(venue_id, created_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_limited_logs_week ON fp1_venue_limited_logs(venue_id, week_key)`);

  // Seed test venues if none
  const v = await pool.query("SELECT COUNT(*)::int AS c FROM fp1_venues");
  if (v.rows[0].c === 0) {
    // Default pin 123456
    const pin = "123456";
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHmac("sha256", salt).update(pin).digest("hex");

    await pool.query(
      `INSERT INTO fp1_venues(name, city, pin_hash, pin_salt)
       VALUES
       ('Test Kebab #1','Warsaw',$1,$2),
       ('Test Pizza #2','Warsaw',$1,$2)`,
      [hash, salt]
    );
  }

  console.log("✅ Migrations OK");
}

/* -------------------------- Cookie session (Panel) -------------------------- */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE_NAME = "fp1_panel_session";
const COOKIE_SECRET = process.env.COOKIE_SECRET || (WEBHOOK_SECRET + "_cookie");

function signSession(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expSig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig))) return null;
  const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!obj || !obj.venue_id || !obj.exp) return null;
  if (Date.now() > obj.exp) return null;
  return obj;
}

function setCookie(res, value) {
  // SameSite=Lax, HttpOnly
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getCookie(req) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map((s) => s.trim());
  for (const p of parts) {
    if (p.startsWith(COOKIE_NAME + "=")) return p.slice((COOKIE_NAME + "=").length);
  }
  return null;
}

function requirePanelAuth(req, res, next) {
  const tok = getCookie(req);
  const sess = verifySession(tok);
  if (!sess) {
    return res.redirect("/panel");
  }
  req.panel = sess; // {venue_id, exp}
  next();
}

/* -------------------------- HTML helpers -------------------------- */
function pageShell(title, bodyHtml) {
  const bg = "#0f1220", card = "#14182b", acc = "#6e56ff", border = "#2a2f49";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;font-family:system-ui;background:${bg};color:#fff}
  .wrap{max-width:920px;margin:0 auto;padding:18px}
  .card{background:${card};border:1px solid ${border};border-radius:14px;padding:16px;margin:12px 0}
  h1{font-size:18px;margin:0 0 10px}
  label{display:block;font-size:12px;opacity:.8;margin:10px 0 6px}
  input,select,button{width:100%;padding:10px;border-radius:10px;border:1px solid ${border};background:#0b0e19;color:#fff}
  button{background:${acc};border:none;font-weight:700;cursor:pointer}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .muted{opacity:.75;font-size:12px}
  .topbar{display:flex;justify-content:space-between;align-items:center;gap:10px}
  a{color:#c6baff;text-decoration:none}
  .err{background:#2a0f16;border:1px solid #6b1a2b;border-radius:12px;padding:10px;margin:12px 0}
  .ok{background:#102a1a;border:1px solid #1f6b3a;border-radius:12px;padding:10px;margin:12px 0}
</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body></html>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* -------------------------- PIN hash helpers -------------------------- */
function pinHash(pin, salt) {
  return crypto.createHmac("sha256", salt).update(pin).digest("hex");
}

/* -------------------------- Business logic: counted visits -------------------------- */
async function getFoxIdCols() {
  // Return best available column for fox identification in foxes & visits tables
  const foxUserCol = (await hasColumn("fp1_foxes", "user_id")) ? "user_id" : "id";
  // checkins / counted may have user_id or fox_id
  const checkinsCol = (await hasColumn("fp1_checkins", "user_id")) ? "user_id" : "fox_id";
  const countedCol = (await hasColumn("fp1_counted_visits", "user_id")) ? "user_id" : "fox_id";
  return { foxUserCol, checkinsCol, countedCol };
}

function otp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function upsertFoxFromTelegram(ctx, explicitCity) {
  const { foxUserCol } = await getFoxIdCols();
  const user = ctx.from;
  const tgId = BigInt(user.id);

  // Try find existing
  let fox;
  if (foxUserCol === "user_id") {
    const r = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id = $1 LIMIT 1`, [tgId.toString()]);
    fox = r.rows[0];
  } else {
    const r = await pool.query(`SELECT * FROM fp1_foxes WHERE id = $1 LIMIT 1`, [tgId.toString()]);
    fox = r.rows[0];
  }

  if (!fox) {
    // Create new fox
    if (foxUserCol === "user_id") {
      await pool.query(
        `INSERT INTO fp1_foxes(user_id, username, city, rating, invites)
         VALUES ($1, $2, $3, 1, 3)
         ON CONFLICT (user_id) DO NOTHING`,
        [tgId.toString(), user.username || null, explicitCity || "Warsaw"]
      );
      const rr = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id = $1 LIMIT 1`, [tgId.toString()]);
      fox = rr.rows[0];
    } else {
      await pool.query(
        `INSERT INTO fp1_foxes(id, username, city, rating, invites)
         VALUES ($1, $2, $3, 1, 3)
         ON CONFLICT (id) DO NOTHING`,
        [tgId.toString(), user.username || null, explicitCity || "Warsaw"]
      );
      const rr = await pool.query(`SELECT * FROM fp1_foxes WHERE id = $1 LIMIT 1`, [tgId.toString()]);
      fox = rr.rows[0];
    }
  } else {
    // keep username fresh
    await pool.query(`UPDATE fp1_foxes SET username = COALESCE($1, username) WHERE id = $2`, [
      user.username || null,
      fox.id,
    ]);
    if (explicitCity) {
      await pool.query(`UPDATE fp1_foxes SET city = $1 WHERE id = $2`, [explicitCity, fox.id]);
    }
    const rr = await pool.query(`SELECT * FROM fp1_foxes WHERE id = $1 LIMIT 1`, [fox.id]);
    fox = rr.rows[0];
  }

  return fox;
}

async function createCheckin(venueId, tgUserIdStr) {
  const { checkinsCol } = await getFoxIdCols();
  const otp = otp6();
  const now = new Date();
  const warDay = warsawDayKey(now);
  const expires = new Date(now.getTime() + 10 * 60 * 1000);

  // Create checkin row
  const cols = ["venue_id", "otp", "expires_at", "war_day"];
  const vals = [venueId, otp, expires.toISOString(), warDay];

  if (checkinsCol === "user_id") {
    cols.push("user_id");
    vals.push(tgUserIdStr);
  } else {
    cols.push("fox_id");
    vals.push(tgUserIdStr);
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(",");
  const sql = `INSERT INTO fp1_checkins(${cols.join(",")}) VALUES (${placeholders}) RETURNING *`;
  const r = await pool.query(sql, vals);
  return r.rows[0];
}

async function findPendingByOtp(venueId, otp) {
  const now = await dbNow();
  const r = await pool.query(
    `SELECT * FROM fp1_checkins
     WHERE venue_id = $1
       AND otp = $2
       AND confirmed_at IS NULL
       AND expires_at > $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [venueId, otp, now]
  );
  return r.rows[0] || null;
}

async function listPending(venueId) {
  const now = await dbNow();
  const r = await pool.query(
    `SELECT id, otp, expires_at, created_at, user_id, fox_id
     FROM fp1_checkins
     WHERE venue_id = $1
       AND confirmed_at IS NULL
       AND expires_at > $2
     ORDER BY created_at DESC
     LIMIT 20`,
    [venueId, now]
  );
  return r.rows;
}

async function hasCountedVisitToday(venueId, tgUserIdStr) {
  const { countedCol } = await getFoxIdCols();
  const warDay = warsawDayKey(new Date());
  const col = countedCol; // user_id or fox_id
  const r = await pool.query(
    `SELECT 1 FROM fp1_counted_visits
     WHERE venue_id = $1 AND war_day = $2 AND ${col} = $3
     LIMIT 1`,
    [venueId, warDay, tgUserIdStr]
  );
  return r.rowCount > 0;
}

async function countXY(venueId, tgUserIdStr) {
  const { countedCol } = await getFoxIdCols();
  const col = countedCol;
  const r1 = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND ${col}=$2`, [
    venueId,
    tgUserIdStr,
  ]);
  const r2 = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]);
  return { X: r1.rows[0].c, Y: r2.rows[0].c };
}

async function confirmOtpAndCount(venueId, otp) {
  const pending = await findPendingByOtp(venueId, otp);
  if (!pending) return { ok: false, code: "NOT_FOUND" };

  // Debounce: if same fox in same venue confirmed within last 15 min -> do not count new
  const now = new Date();
  const debounceFrom = new Date(now.getTime() - 15 * 60 * 1000);

  const userVal = pending.user_id || pending.fox_id;
  const warDay = pending.war_day || warsawDayKey(now);

  const { countedCol } = await getFoxIdCols();
  const idCol = countedCol; // user_id or fox_id

  // Mark checkin confirmed
  await pool.query(
    `UPDATE fp1_checkins
     SET confirmed_at = NOW(), confirmed_by_venue_id = $1
     WHERE id = $2`,
    [venueId, pending.id]
  );

  // 1/day constraint is enforced by "war_day + venue + user"
  // Debounce check: any confirmed checkin for same user within 15 min?
  const deb = await pool.query(
    `SELECT 1 FROM fp1_checkins
     WHERE venue_id = $1
       AND confirmed_at IS NOT NULL
       AND confirmed_at > $2
       AND (user_id = $3 OR fox_id = $3)
     LIMIT 1`,
    [venueId, debounceFrom.toISOString(), String(userVal)]
  );

  // Insert counted visit safely (race-safe)
  // If already counted today, it won't add a new row due to ON CONFLICT guard we simulate via UNIQUE index not guaranteed,
  // so we do "INSERT ... SELECT WHERE NOT EXISTS".
  const alreadyCounted = await pool.query(
    `SELECT 1 FROM fp1_counted_visits
     WHERE venue_id = $1 AND war_day = $2 AND (${idCol} = $3)
     LIMIT 1`,
    [venueId, warDay, String(userVal)]
  );

  let countedAdded = false;

  if (alreadyCounted.rowCount === 0) {
    const cols = ["venue_id", "war_day"];
    const vals = [venueId, warDay];

    if (idCol === "user_id") {
      cols.push("user_id");
      vals.push(String(userVal));
    } else {
      cols.push("fox_id");
      vals.push(String(userVal));
    }

    const placeholders = vals.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`INSERT INTO fp1_counted_visits(${cols.join(",")}) VALUES (${placeholders})`, vals);
    countedAdded = true;
  }

  // If debounce hit, we still confirm checkin, but counted might be blocked by 1/day anyway.
  return { ok: true, userId: String(userVal), warDay, countedAdded, debounceHit: deb.rowCount > 0 };
}

/* -------------------------- Venue statuses -------------------------- */
async function getVenue(venueId) {
  const r = await pool.query(`SELECT * FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
  return r.rows[0] || null;
}

async function setReserve(venueId, startIso, durationHours) {
  // validations:
  const now = new Date();
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return { ok: false, msg: "Nieprawidłowa data startu." };

  const minAhead = 24 * 60 * 60 * 1000;
  if (start.getTime() < now.getTime() + minAhead) {
    return { ok: false, msg: "Rezerwa musi być ustawiona min. 24h wcześniej." };
  }

  const dur = Math.max(1, Math.min(24, parseInt(durationHours, 10) || 24));
  const end = new Date(start.getTime() + dur * 60 * 60 * 1000);

  // limit: max 2 / month (based on logs in current Warsaw month)
  const warKey = warsawDayKey(now); // YYYY-MM-DD
  const monthKey = warKey.slice(0, 7); // YYYY-MM
  const count = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM fp1_venue_reserve_logs
     WHERE venue_id=$1 AND to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM') = $2`,
    [venueId, monthKey]
  );
  if (count.rows[0].c >= 2) {
    return { ok: false, msg: "Limit rezerwy: max 2 / miesiąc." };
  }

  await pool.query(`UPDATE fp1_venues SET reserve_start=$1, reserve_end=$2 WHERE id=$3`, [
    start.toISOString(),
    end.toISOString(),
    venueId,
  ]);
  await pool.query(
    `INSERT INTO fp1_venue_reserve_logs(venue_id, reserve_start, reserve_end) VALUES ($1,$2,$3)`,
    [venueId, start.toISOString(), end.toISOString()]
  );

  return { ok: true };
}

async function clearReserve(venueId) {
  await pool.query(`UPDATE fp1_venues SET reserve_start=NULL, reserve_end=NULL WHERE id=$1`, [venueId]);
  return { ok: true };
}

async function setLimited(venueId, reason, durationHours) {
  const allowed = ["FULL", "PRIVATE EVENT", "KITCHEN LIMIT"];
  const r = allowed.includes(String(reason)) ? String(reason) : "FULL";
  const dur = Math.max(1, Math.min(3, parseInt(durationHours, 10) || 1));
  const now = new Date();
  const until = new Date(now.getTime() + dur * 60 * 60 * 1000);

  // limit: max 2 / week (Mon–Sun Warsaw)
  const wk = warsawWeekKey(now);
  const count = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM fp1_venue_limited_logs
     WHERE venue_id=$1 AND week_key=$2`,
    [venueId, wk]
  );
  if (count.rows[0].c >= 2) {
    return { ok: false, msg: "Limit: max 2 / tydzień (Mon–Sun Warsaw)." };
  }

  await pool.query(`UPDATE fp1_venues SET limited_reason=$1, limited_until=$2 WHERE id=$3`, [
    r,
    until.toISOString(),
    venueId,
  ]);
  await pool.query(
    `INSERT INTO fp1_venue_limited_logs(venue_id, week_key, reason, until_at) VALUES ($1,$2,$3,$4)`,
    [venueId, wk, r, until.toISOString()]
  );

  return { ok: true };
}

async function clearLimited(venueId) {
  await pool.query(`UPDATE fp1_venues SET limited_reason=NULL, limited_until=NULL WHERE id=$1`, [venueId]);
  return { ok: true };
}

/* -------------------------- Express routes -------------------------- */
app.get("/health", async (req, res) => {
  try {
    const now = await dbNow();
    res.json({ ok: true, db: true, now, tz: "Europe/Warsaw" });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e && e.message ? e.message : e) });
  }
});

app.get("/panel", async (req, res) => {
  const tok = getCookie(req);
  const sess = verifySession(tok);
  if (sess) return res.redirect("/panel/dashboard");

  const msg = req.query.msg ? `<div class="err">${escapeHtml(req.query.msg)}</div>` : "";
  const html = pageShell(
    "Panel Lokalu",
    `
    <div class="card">
      <h1>Panel Lokalu</h1>
      ${msg}
      <form method="POST" action="/panel/login">
        <label>Venue ID</label>
        <input name="venue_id" required placeholder="np. 1"/>
        <label>PIN (6 cyfr)</label>
        <input name="pin" required placeholder="123456" inputmode="numeric" />
        <button type="submit">Zaloguj</button>
      </form>
      <div class="muted" style="margin-top:10px">
        OTP ważny 10 minut. Debounce: 15 minut.
      </div>
    </div>
    `
  );
  res.send(html);
});

const loginFailMap = new Map(); // ip -> {fails, until}
function rateLimitLogin(ip) {
  const x = loginFailMap.get(ip) || { fails: 0, until: 0 };
  const now = Date.now();
  if (x.until && now < x.until) return { blocked: true, ms: x.until - now };
  return { blocked: false, state: x };
}
function markLoginFail(ip) {
  const x = loginFailMap.get(ip) || { fails: 0, until: 0 };
  x.fails += 1;
  if (x.fails >= 10) {
    x.until = Date.now() + 15 * 60 * 1000;
    x.fails = 0;
  }
  loginFailMap.set(ip, x);
}
function markLoginSuccess(ip) {
  loginFailMap.set(ip, { fails: 0, until: 0 });
}

app.post("/panel/login", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.ip;
    const rl = rateLimitLogin(ip);
    if (rl.blocked) {
      return res.redirect(`/panel?msg=${encodeURIComponent("Za dużo prób. Spróbuj za 15 minut.")}`);
    }

    const venueId = String(req.body.venue_id || "").trim();
    const pin = String(req.body.pin || "").trim();

    if (!venueId || !pin) {
      markLoginFail(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("Brak Venue ID lub PIN.")}`);
    }

    const v = await getVenue(venueId);
    if (!v) {
      markLoginFail(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("Nie znaleziono lokalu.")}`);
    }

    const salt = v.pin_salt;
    const hash = v.pin_hash;
    if (!salt || !hash) {
      markLoginFail(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("PIN nie jest skonfigurowany dla lokalu.")}`);
    }

    const calc = pinHash(pin, salt);
    if (calc !== hash) {
      markLoginFail(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("Błędny PIN.")}`);
    }

    markLoginSuccess(ip);

    const token = signSession({ venue_id: String(v.id), exp: Date.now() + SESSION_TTL_MS });
    setCookie(res, token);
    return res.redirect("/panel/dashboard");
  } catch (e) {
    console.error("LOGIN_ERR", e);
    return res.redirect(`/panel?msg=${encodeURIComponent("Błąd logowania.")}`);
  }
});

app.get("/panel/logout", (req, res) => {
  clearCookie(res);
  res.redirect("/panel");
});

app.get("/panel/dashboard", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const v = await getVenue(venueId);
  const pending = await listPending(venueId);

  const msg = req.query.ok ? `<div class="ok">${escapeHtml(req.query.ok)}</div>` : "";
  const err = req.query.err ? `<div class="err">${escapeHtml(req.query.err)}</div>` : "";

  const pendingHtml =
    pending.length === 0
      ? `<div class="muted">Brak aktywnych check-inów</div>`
      : pending
          .map((p) => {
            const leftMin = Math.max(0, Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 60000));
            return `<div class="muted">OTP: <b>${escapeHtml(p.otp)}</b> · wygasa za ~${leftMin} min</div>`;
          })
          .join("");

  // Status display
  const reserveStatus =
    v.reserve_start && v.reserve_end
      ? `Aktywna / zaplanowana: ${escapeHtml(new Date(v.reserve_start).toISOString())} → ${escapeHtml(
          new Date(v.reserve_end).toISOString()
        )}`
      : "Brak";

  const limitedStatus =
    v.limited_reason && v.limited_until
      ? `Aktywny: ${escapeHtml(v.limited_reason)} do ${escapeHtml(new Date(v.limited_until).toISOString())}`
      : "Brak";

  const html = pageShell(
    "Dashboard",
    `
    <div class="card">
      <div class="topbar">
        <div>
          <h1>Panel: ${escapeHtml(v.name)} (ID ${escapeHtml(v.id)})</h1>
        </div>
        <div><a href="/panel/logout">Wyloguj</a></div>
      </div>
      ${msg}${err}
    </div>

    <div class="card">
      <h1>Confirm OTP</h1>
      <form method="POST" action="/panel/confirm">
        <label>OTP (6 cyfr)</label>
        <input name="otp" required placeholder="np. 874940" inputmode="numeric"/>
        <button type="submit">Confirm</button>
        <div class="muted" style="margin-top:10px">OTP ważny 10 minut. Debounce: 15 minut.</div>
      </form>
    </div>

    <div class="card">
      <h1>Pending check-ins</h1>
      ${pendingHtml}
      <form method="GET" action="/panel/dashboard" style="margin-top:10px">
        <button type="submit">Odśwież</button>
      </form>
    </div>

    <div class="card">
      <h1>📍 Rezerwa (planowa pauza)</h1>
      <div class="muted">Status: ${escapeHtml(reserveStatus)}</div>
      <div class="muted">Limit: max 2 / miesiąc, max 24h, ustaw min. 24h wcześniej.</div>

      <form method="POST" action="/panel/reserve/set">
        <label>Start (datetime)</label>
        <input name="start" type="datetime-local" required />
        <label>Czas trwania</label>
        <select name="hours">
          <option value="1">1 (godzina)</option>
          <option value="2">2 (godziny)</option>
          <option value="4">4 (godziny)</option>
          <option value="8">8 (godzin)</option>
          <option value="24" selected>24 (godziny)</option>
        </select>
        <button type="submit">Ustaw Rezerwę</button>
      </form>

      <form method="POST" action="/panel/reserve/clear" style="margin-top:10px">
        <button type="submit">Usuń Rezerwę</button>
      </form>
    </div>

    <div class="card">
      <h1>Dziś ograniczone (informacja)</h1>
      <div class="muted">Status: ${escapeHtml(limitedStatus)}</div>
      <div class="muted">Limit: max 2 / tydzień (Mon–Sun Warsaw), max 3h. To NIE wyłącza zniżki.</div>

      <form method="POST" action="/panel/limited/set">
        <label>Powód</label>
        <select name="reason">
          <option value="FULL">FULL</option>
          <option value="PRIVATE EVENT">PRIVATE EVENT</option>
          <option value="KITCHEN LIMIT">KITCHEN LIMIT</option>
        </select>
        <label>Do (czas trwania)</label>
        <select name="hours">
          <option value="1">1 (godzina)</option>
          <option value="2">2 (godziny)</option>
          <option value="3" selected>3 (godziny)</option>
        </select>
        <button type="submit">Ustaw Dziś ograniczone</button>
      </form>

      <form method="POST" action="/panel/limited/clear" style="margin-top:10px">
        <button type="submit">Anuluj</button>
      </form>
    </div>
    `
  );

  res.send(html);
});

app.post("/panel/confirm", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const otp = String(req.body.otp || "").trim();
  if (!otp) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Brak OTP.")}`);

  try {
    const result = await confirmOtpAndCount(venueId, otp);
    if (!result.ok) {
      return res.redirect(`/panel/dashboard?err=${encodeURIComponent("OTP nie znaleziono albo wygasł.")}`);
    }

    // Notify Telegram (safe)
    if (bot && result.userId) {
      try {
        const venue = await getVenue(venueId);
        const xy = await countXY(venueId, result.userId);
        const msg = `✅ Confirm OK
🏪 ${venue.name}
📅 Day (Warszawa): ${result.warDay}
📊 X/Y: ${xy.X}/${xy.Y}`;
        await bot.telegram.sendMessage(Number(result.userId), msg);
      } catch (e) {
        console.error("TG_SEND_ERR", e);
      }
    }

    return res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Confirm OK")}`);
  } catch (e) {
    console.error("CONFIRM_ERR", e);
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd potwierdzenia OTP.")}`);
  }
});

app.post("/panel/reserve/set", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  try {
    // datetime-local gives "YYYY-MM-DDTHH:mm"
    const startLocal = String(req.body.start || "").trim();
    const hours = String(req.body.hours || "24").trim();

    // Interpret startLocal as Warsaw time: we will append ":00" and treat as Europe/Warsaw by converting using Intl is complex;
    // simplest safe approach: treat it as local time of the browser (usually Warsaw). For MVP it's OK.
    const iso = new Date(startLocal).toISOString();

    const r = await setReserve(venueId, iso, hours);
    if (!r.ok) return res.redirect(`/panel/dashboard?err=${encodeURIComponent(r.msg || "Błąd ustawiania rezerwy.")}`);
    return res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Rezerwa ustawiona.")}`);
  } catch (e) {
    console.error("RESERVE_SET_ERR", e);
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd ustawiania rezerwy.")}`);
  }
});

app.post("/panel/reserve/clear", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  try {
    await clearReserve(venueId);
    return res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Rezerwa usunięta.")}`);
  } catch (e) {
    console.error("RESERVE_CLEAR_ERR", e);
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd usuwania rezerwy.")}`);
  }
});

app.post("/panel/limited/set", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  try {
    const reason = String(req.body.reason || "FULL").trim();
    const hours = String(req.body.hours || "1").trim();
    const r = await setLimited(venueId, reason, hours);
    if (!r.ok) return res.redirect(`/panel/dashboard?err=${encodeURIComponent(r.msg || "Błąd ustawiania statusu.")}`);
    return res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Status ustawiony.")}`);
  } catch (e) {
    console.error("LIMITED_SET_ERR", e);
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd ustawiania statusu.")}`);
  }
});

app.post("/panel/limited/clear", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  try {
    await clearLimited(venueId);
    return res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Status anulowany.")}`);
  } catch (e) {
    console.error("LIMITED_CLEAR_ERR", e);
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd anulowania statusu.")}`);
  }
});

/* -------------------------- Telegram bot -------------------------- */
let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      // For MVP: register fox instantly, city defaults Warsaw. (Later you can add city flow)
      const fox = await upsertFoxFromTelegram(ctx, "Warsaw");

      // total counted visits across all venues
      const { countedCol } = await getFoxIdCols();
      const col = countedCol;
      const userIdStr = String(ctx.from.id);

      const total = await pool.query(
        `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE ${col}=$1`,
        [userIdStr]
      );

      const msg = `🦊 Твій профіль
Rating: ${fox.rating}
Invites: ${fox.invites}
Місто: ${fox.city}
Counted visits всього: ${total.rows[0].c}

Команди:
/checkin <venue_id>
/venues
/panel`;
      await ctx.reply(msg);
    } catch (e) {
      console.error("START_ERR", e);
      await ctx.reply("Błąd. Spróbuj ponownie.");
    }
  });

  bot.command("panel", async (ctx) => {
    await ctx.reply(`Panel: ${PUBLIC_URL}/panel`);
  });

  bot.command("venues", async (ctx) => {
    const r = await pool.query(`SELECT id, name, city FROM fp1_venues ORDER BY id ASC LIMIT 50`);
    const lines = r.rows.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`);
    await ctx.reply(`🏪 Lokale:\n${lines.join("\n")}\n\nCheck-in: /checkin <venue_id>`);
  });

  bot.command("checkin", async (ctx) => {
    try {
      const parts = String(ctx.message.text || "").trim().split(/\s+/);
      const venueId = parts[1];
      if (!venueId) return ctx.reply("Użycie: /checkin <venue_id>");

      // ensure fox exists
      await upsertFoxFromTelegram(ctx, "Warsaw");

      const userIdStr = String(ctx.from.id);

      // 1/day lock
      const already = await hasCountedVisitToday(venueId, userIdStr);
      if (already) {
        const xy = await countXY(venueId, userIdStr);
        const v = await getVenue(venueId);
        const warDay = warsawDayKey(new Date());
        return ctx.reply(
          `DZIŚ JUŻ BYŁO ✅
${v ? "🏪 Lokal: " + v.name : "Lokal: " + venueId}
📅 Dzień (Warszawa): ${warDay}
📊 X/Y: ${xy.X}/${xy.Y}
Wróć jutro po 00:00 (Warszawa).
Panel: ${PUBLIC_URL}/panel`
        );
      }

      // Create checkin OTP
      const c = await createCheckin(venueId, userIdStr);
      const v = await getVenue(venueId);
      await ctx.reply(
        `✅ Check-in utworzony (10 min)

🏪 ${v ? v.name : "Lokal " + venueId}
🔐 OTP: ${c.otp}

Personel potwierdza w Panelu.
Panel: ${PUBLIC_URL}/panel`
      );
    } catch (e) {
      console.error("CHECKIN_ERR", e);
      await ctx.reply("Błąd check-in");
    }
  });

  // Webhook
  app.use(bot.webhookCallback(`/${WEBHOOK_SECRET}`));
}

/* -------------------------- Boot -------------------------- */
(async () => {
  try {
    await migrate();

    if (bot && PUBLIC_URL) {
      const hookUrl = `${PUBLIC_URL}/${WEBHOOK_SECRET}`;
      await bot.telegram.setWebhook(hookUrl);
      console.log("✅ Webhook set:", hookUrl);
    }

    app.get("/", (req, res) => res.send("OK"));
    app.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
  } catch (e) {
    console.error("BOOT_ERR", e);
    process.exit(1);
  }
})();
