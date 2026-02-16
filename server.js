/**
 * THE FOXPOT CLUB — Phase 1 MVP — server.js (FIX: war_day missing)
 * Dependencies only: express, telegraf, pg, crypto
 */

const express = require("express");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------------- ENV ---------------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "wh";
const COOKIE_SECRET = process.env.COOKIE_SECRET || `${WEBHOOK_SECRET}_cookie`;
const PORT = process.env.PORT || 8080;

if (!DATABASE_URL) console.error("❌ DATABASE_URL missing");
if (!BOT_TOKEN) console.error("❌ BOT_TOKEN missing");
if (!PUBLIC_URL) console.error("❌ PUBLIC_URL missing");

/* ---------------- DB ---------------- */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : undefined,
});

async function dbNow() {
  const r = await pool.query("SELECT NOW() as now");
  return r.rows[0].now;
}

/* -------- Warsaw day/week helpers -------- */
function warsawDayKey(d = new Date()) {
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
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
  }).format(d);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[w] || 1;
}

function warsawWeekKey(d = new Date()) {
  const key = warsawDayKey(d);
  const [yy, mm, dd] = key.split("-").map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  const dow = warsawDow(base);
  const monday = new Date(base.getTime() - (dow - 1) * 86400000);
  return warsawDayKey(monday); // monday date as bucket
}

/* ---------------- schema helpers ---------------- */
async function hasColumn(table, col) {
  const r = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2
    LIMIT 1
  `,
    [table, col]
  );
  return r.rowCount > 0;
}

async function ensureTable(sql) {
  await pool.query(sql);
}

async function ensureColumn(table, col, ddl) {
  const exists = await hasColumn(table, col);
  if (!exists) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

// IMPORTANT: do not kill server if index creation fails (risk-first)
async function ensureIndexSafe(sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    console.error("INDEX_WARN", e && e.message ? e.message : e);
  }
}

function pinHash(pin, salt) {
  return crypto.createHmac("sha256", salt).update(pin).digest("hex");
}

/* ---------------- MIGRATIONS (SAFE) ---------------- */
async function migrate() {
  // Core tables
  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_venues (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Venue',
      city TEXT NOT NULL DEFAULT 'Warsaw',
      pin_hash TEXT,
      pin_salt TEXT,
      reserve_start TIMESTAMPTZ,
      reserve_end TIMESTAMPTZ,
      limited_reason TEXT,
      limited_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await ensureTable(`
    CREATE TABLE IF NOT EXISTS fp1_foxes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT UNIQUE,
      username TEXT,
      rating INT NOT NULL DEFAULT 1,
      invites INT NOT NULL DEFAULT 3,
      city TEXT NOT NULL DEFAULT 'Warsaw',
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
      war_day TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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

  // Ensure columns exist even if tables were created earlier (THIS FIXES YOUR ERROR)
  await ensureColumn("fp1_counted_visits", "war_day", "TEXT");
  await ensureColumn("fp1_checkins", "war_day", "TEXT");

  // Backfill war_day for old rows (Warsaw date from created_at)
  // Safe: only fills NULLs
  await pool.query(`
    UPDATE fp1_counted_visits
    SET war_day = to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD')
    WHERE war_day IS NULL
  `);

  await pool.query(`
    UPDATE fp1_checkins
    SET war_day = to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD')
    WHERE war_day IS NULL
  `);

  // Seed test venues if none
  const v = await pool.query("SELECT COUNT(*)::int AS c FROM fp1_venues");
  if (v.rows[0].c === 0) {
    const pin = "123456";
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = pinHash(pin, salt);
    await pool.query(
      `INSERT INTO fp1_venues(name, city, pin_hash, pin_salt)
       VALUES
       ('Test Kebab #1','Warsaw',$1,$2),
       ('Test Pizza #2','Warsaw',$1,$2)`,
      [hash, salt]
    );
  }

  // Indexes (adaptive, safe)
  await ensureIndexSafe(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_otp ON fp1_checkins(otp)`);
  await ensureIndexSafe(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_expires ON fp1_checkins(expires_at)`);

  const hasUser = await hasColumn("fp1_counted_visits", "user_id");
  const hasFox = await hasColumn("fp1_counted_visits", "fox_id");
  if (hasUser) {
    await ensureIndexSafe(
      `CREATE INDEX IF NOT EXISTS idx_fp1_counted_u ON fp1_counted_visits(venue_id, war_day, user_id)`
    );
  }
  if (hasFox) {
    await ensureIndexSafe(
      `CREATE INDEX IF NOT EXISTS idx_fp1_counted_f ON fp1_counted_visits(venue_id, war_day, fox_id)`
    );
  }

  await ensureIndexSafe(`CREATE INDEX IF NOT EXISTS idx_fp1_reserve_logs ON fp1_venue_reserve_logs(venue_id, created_at)`);
  await ensureIndexSafe(`CREATE INDEX IF NOT EXISTS idx_fp1_limited_logs ON fp1_venue_limited_logs(venue_id, week_key)`);

  console.log("✅ Migrations OK");
}

/* ---------------- Panel session (cookie, HMAC) ---------------- */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME = "fp1_panel_session";

function signSession(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expSig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig))) return null;
  } catch {
    return null;
  }
  const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!obj || !obj.venue_id || !obj.exp) return null;
  if (Date.now() > obj.exp) return null;
  return obj;
}

function getCookie(req) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map((s) => s.trim());
  for (const p of parts) if (p.startsWith(COOKIE_NAME + "=")) return p.slice((COOKIE_NAME + "=").length);
  return null;
}

function setCookie(res, value) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requirePanelAuth(req, res, next) {
  const tok = getCookie(req);
  const sess = verifySession(tok);
  if (!sess) return res.redirect("/panel");
  req.panel = sess;
  next();
}

/* ---------------- UI helpers ---------------- */
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pageShell(title, body) {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;font-family:system-ui;background:#0f1220;color:#fff}
.wrap{max-width:920px;margin:0 auto;padding:18px}
.card{background:#14182b;border:1px solid #2a2f49;border-radius:14px;padding:16px;margin:12px 0}
h1{font-size:18px;margin:0 0 10px}
label{display:block;font-size:12px;opacity:.8;margin:10px 0 6px}
input,select,button{width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0b0e19;color:#fff}
button{background:#6e56ff;border:none;font-weight:700;cursor:pointer}
.muted{opacity:.75;font-size:12px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:10px}
a{color:#c6baff;text-decoration:none}
.err{background:#2a0f16;border:1px solid #6b1a2b;border-radius:12px;padding:10px;margin:12px 0}
.ok{background:#102a1a;border:1px solid #1f6b3a;border-radius:12px;padding:10px;margin:12px 0}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

/* ---------------- Core functions ---------------- */
async function getVenue(venueId) {
  const r = await pool.query(`SELECT * FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
  return r.rows[0] || null;
}

function otp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function upsertFox(ctx) {
  const tgId = String(ctx.from.id);
  const username = ctx.from.username || null;

  const r = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [tgId]);
  if (r.rowCount === 0) {
    await pool.query(
      `INSERT INTO fp1_foxes(user_id, username, rating, invites, city)
       VALUES ($1,$2,1,3,'Warsaw')
       ON CONFLICT (user_id) DO NOTHING`,
      [tgId, username]
    );
  } else {
    await pool.query(`UPDATE fp1_foxes SET username=COALESCE($1,username) WHERE user_id=$2`, [username, tgId]);
  }

  const rr = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [tgId]);
  return rr.rows[0];
}

async function hasCountedToday(venueId, userId) {
  const day = warsawDayKey(new Date());
  const r = await pool.query(
    `SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND war_day=$2 AND user_id=$3 LIMIT 1`,
    [venueId, day, userId]
  );
  return r.rowCount > 0;
}

async function countXY(venueId, userId) {
  const x = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND user_id=$2`,
    [venueId, userId]
  );
  const y = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]);
  return { X: x.rows[0].c, Y: y.rows[0].c };
}

async function createCheckin(venueId, userId) {
  const otp = otp6();
  const now = new Date();
  const warDay = warsawDayKey(now);
  const expires = new Date(now.getTime() + 10 * 60 * 1000);

  const r = await pool.query(
    `INSERT INTO fp1_checkins(venue_id, user_id, otp, expires_at, war_day)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [venueId, userId, otp, expires.toISOString(), warDay]
  );
  return r.rows[0];
}

async function listPending(venueId) {
  const now = await dbNow();
  const r = await pool.query(
    `SELECT otp, expires_at
     FROM fp1_checkins
     WHERE venue_id=$1 AND confirmed_at IS NULL AND expires_at > $2
     ORDER BY created_at DESC
     LIMIT 20`,
    [venueId, now]
  );
  return r.rows;
}

async function confirmOtp(venueId, otp) {
  const now = await dbNow();
  const pending = await pool.query(
    `SELECT * FROM fp1_checkins
     WHERE venue_id=$1 AND otp=$2 AND confirmed_at IS NULL AND expires_at > $3
     ORDER BY created_at DESC LIMIT 1`,
    [venueId, otp, now]
  );
  if (pending.rowCount === 0) return { ok: false, code: "NOT_FOUND" };

  const row = pending.rows[0];
  const userId = String(row.user_id);
  const warDay = row.war_day || warsawDayKey(new Date());

  // mark confirmed
  await pool.query(
    `UPDATE fp1_checkins SET confirmed_at=NOW(), confirmed_by_venue_id=$1 WHERE id=$2`,
    [venueId, row.id]
  );

  // counted insert only if not exists for today
  const exists = await pool.query(
    `SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND war_day=$2 AND user_id=$3 LIMIT 1`,
    [venueId, warDay, userId]
  );

  let countedAdded = false;
  if (exists.rowCount === 0) {
    await pool.query(
      `INSERT INTO fp1_counted_visits(venue_id, user_id, war_day) VALUES ($1,$2,$3)`,
      [venueId, userId, warDay]
    );
    countedAdded = true;

    // rating +1 on counted visit
    await pool.query(`UPDATE fp1_foxes SET rating = rating + 1 WHERE user_id=$1`, [userId]);
  }

  return { ok: true, userId, warDay, countedAdded };
}

/* ---------------- Venue statuses ---------------- */
async function setReserve(venueId, startIso, hours) {
  const now = new Date();
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return { ok: false, msg: "Nieprawidłowa data startu." };

  if (start.getTime() < now.getTime() + 24 * 60 * 60 * 1000) {
    return { ok: false, msg: "Rezerwa musi być ustawiona min. 24h wcześniej." };
  }

  const dur = Math.max(1, Math.min(24, parseInt(hours, 10) || 24));
  const end = new Date(start.getTime() + dur * 60 * 60 * 1000);

  const monthKey = warsawDayKey(now).slice(0, 7); // YYYY-MM
  const c = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM fp1_venue_reserve_logs
     WHERE venue_id=$1 AND to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM')=$2`,
    [venueId, monthKey]
  );
  if (c.rows[0].c >= 2) return { ok: false, msg: "Limit rezerwy: max 2 / miesiąc." };

  await pool.query(`UPDATE fp1_venues SET reserve_start=$1,reserve_end=$2 WHERE id=$3`, [
    start.toISOString(),
    end.toISOString(),
    venueId,
  ]);
  await pool.query(
    `INSERT INTO fp1_venue_reserve_logs(venue_id,reserve_start,reserve_end) VALUES ($1,$2,$3)`,
    [venueId, start.toISOString(), end.toISOString()]
  );
  return { ok: true };
}

async function clearReserve(venueId) {
  await pool.query(`UPDATE fp1_venues SET reserve_start=NULL,reserve_end=NULL WHERE id=$1`, [venueId]);
  return { ok: true };
}

async function setLimited(venueId, reason, hours) {
  const allowed = ["FULL", "PRIVATE EVENT", "KITCHEN LIMIT"];
  const r = allowed.includes(String(reason)) ? String(reason) : "FULL";
  const dur = Math.max(1, Math.min(3, parseInt(hours, 10) || 1));
  const now = new Date();
  const until = new Date(now.getTime() + dur * 60 * 60 * 1000);

  const wk = warsawWeekKey(now);
  const c = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_venue_limited_logs WHERE venue_id=$1 AND week_key=$2`,
    [venueId, wk]
  );
  if (c.rows[0].c >= 2) return { ok: false, msg: "Limit: max 2 / tydzień (Mon–Sun Warsaw)." };

  await pool.query(`UPDATE fp1_venues SET limited_reason=$1,limited_until=$2 WHERE id=$3`, [
    r,
    until.toISOString(),
    venueId,
  ]);
  await pool.query(
    `INSERT INTO fp1_venue_limited_logs(venue_id,week_key,reason,until_at) VALUES ($1,$2,$3,$4)`,
    [venueId, wk, r, until.toISOString()]
  );
  return { ok: true };
}

async function clearLimited(venueId) {
  await pool.query(`UPDATE fp1_venues SET limited_reason=NULL,limited_until=NULL WHERE id=$1`, [venueId]);
  return { ok: true };
}

/* ---------------- Routes ---------------- */
app.get("/", (req, res) => res.send("OK"));

app.get("/health", async (req, res) => {
  try {
    const now = await dbNow();
    res.json({ ok: true, db: true, now, tz: "Europe/Warsaw" });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e && e.message ? e.message : e) });
  }
});

app.get("/panel", async (req, res) => {
  const sess = verifySession(getCookie(req));
  if (sess) return res.redirect("/panel/dashboard");

  const msg = req.query.msg ? `<div class="err">${escapeHtml(req.query.msg)}</div>` : "";
  res.send(
    pageShell(
      "Panel",
      `<div class="card">
        <h1>Panel Lokalu</h1>
        ${msg}
        <form method="POST" action="/panel/login">
          <label>Venue ID</label>
          <input name="venue_id" required placeholder="np. 1"/>
          <label>PIN (6 cyfr)</label>
          <input name="pin" required placeholder="123456" inputmode="numeric"/>
          <button type="submit">Zaloguj</button>
        </form>
      </div>`
    )
  );
});

const loginFail = new Map();
function loginRate(ip) {
  const x = loginFail.get(ip) || { fails: 0, until: 0 };
  if (x.until && Date.now() < x.until) return { blocked: true };
  return { blocked: false, x };
}
function loginBad(ip) {
  const x = loginFail.get(ip) || { fails: 0, until: 0 };
  x.fails += 1;
  if (x.fails >= 10) {
    x.until = Date.now() + 15 * 60 * 1000;
    x.fails = 0;
  }
  loginFail.set(ip, x);
}
function loginOk(ip) {
  loginFail.set(ip, { fails: 0, until: 0 });
}

app.post("/panel/login", async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0] : req.ip).trim();
    const rl = loginRate(ip);
    if (rl.blocked) return res.redirect(`/panel?msg=${encodeURIComponent("Za dużo prób. Spróbuj za 15 minut.")}`);

    const venueId = String(req.body.venue_id || "").trim();
    const pin = String(req.body.pin || "").trim();
    if (!venueId || !pin) {
      loginBad(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("Brak danych.")}`);
    }

    const v = await getVenue(venueId);
    if (!v || !v.pin_salt || !v.pin_hash) {
      loginBad(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("Nie znaleziono lokalu / brak PIN.")}`);
    }

    const calc = pinHash(pin, v.pin_salt);
    if (calc !== v.pin_hash) {
      loginBad(ip);
      return res.redirect(`/panel?msg=${encodeURIComponent("Błędny PIN.")}`);
    }

    loginOk(ip);
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

  const ok = req.query.ok ? `<div class="ok">${escapeHtml(req.query.ok)}</div>` : "";
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

  const reserveStatus =
    v.reserve_start && v.reserve_end
      ? `ZAPLANOWANA: ${new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "medium" }).format(
          new Date(v.reserve_start)
        )} → ${new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "medium" }).format(
          new Date(v.reserve_end)
        )}`
      : "Brak";

  const limitedStatus =
    v.limited_reason && v.limited_until
      ? `${escapeHtml(v.limited_reason)} do ${new Intl.DateTimeFormat("pl-PL", {
          timeZone: "Europe/Warsaw",
          dateStyle: "short",
          timeStyle: "medium",
        }).format(new Date(v.limited_until))}`
      : "Brak";

  res.send(
    pageShell(
      "Dashboard",
      `<div class="card">
        <div class="topbar">
          <div><h1>Panel: ${escapeHtml(v.name)} (ID ${escapeHtml(v.id)})</h1></div>
          <div><a href="/panel/logout">Wyloguj</a></div>
        </div>
        ${ok}${err}
      </div>

      <div class="card">
        <h1>Confirm OTP</h1>
        <form method="POST" action="/panel/confirm">
          <label>OTP (6 cyfr)</label>
          <input name="otp" required placeholder="np. 874940" inputmode="numeric"/>
          <button type="submit">Confirm</button>
          <div class="muted" style="margin-top:10px">OTP ważny 10 minut.</div>
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
            <option value="1">1</option><option value="2">2</option><option value="4">4</option><option value="8">8</option>
            <option value="24" selected>24</option>
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
          <select name="hours"><option value="1">1</option><option value="2">2</option><option value="3" selected>3</option></select>
          <button type="submit">Ustaw Dziś ograniczone</button>
        </form>
        <form method="POST" action="/panel/limited/clear" style="margin-top:10px">
          <button type="submit">Anuluj</button>
        </form>
      </div>`
    )
  );
});

let bot = null;

app.post("/panel/confirm", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const otp = String(req.body.otp || "").trim();
  try {
    const r = await confirmOtp(venueId, otp);
    if (!r.ok) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("OTP nie znaleziono albo wygasł.")}`);

    // notify telegram (safe)
    if (bot) {
      try {
        const v = await getVenue(venueId);
        const xy = await countXY(venueId, r.userId);
        await bot.telegram.sendMessage(
          Number(r.userId),
          `✅ Confirm OK
🏪 ${v.name}
📅 Day (Warszawa): ${r.warDay}
📊 X/Y: ${xy.X}/${xy.Y}`
        );
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
    const startLocal = String(req.body.start || "").trim();
    const hours = String(req.body.hours || "24").trim();
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

/* ---------------- Telegram ---------------- */
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    try {
      const fox = await upsertFox(ctx);
      const total = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [
        String(ctx.from.id),
      ]);
      await ctx.reply(
        `🦊 Твій профіль
Rating: ${fox.rating}
Invites: ${fox.invites}
Місто: ${fox.city}
Counted visits всього: ${total.rows[0].c}

Команди:
/checkin <venue_id>
/venues
/panel`
      );
    } catch (e) {
      console.error("START_ERR", e);
      await ctx.reply("Błąd. Spróbuj ponownie.");
    }
  });

  bot.command("panel", async (ctx) => ctx.reply(`Panel: ${PUBLIC_URL}/panel`));

  bot.command("venues", async (ctx) => {
    const r = await pool.query(`SELECT id,name,city FROM fp1_venues ORDER BY id ASC LIMIT 50`);
    const lines = r.rows.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`);
    await ctx.reply(`🏪 Lokale:\n${lines.join("\n")}\n\nCheck-in: /checkin <venue_id>`);
  });

  bot.command("checkin", async (ctx) => {
    try {
      const parts = String(ctx.message.text || "").trim().split(/\s+/);
      const venueId = parts[1];
      if (!venueId) return ctx.reply("Użycie: /checkin <venue_id>");

      await upsertFox(ctx);
      const userId = String(ctx.from.id);

      const already = await hasCountedToday(venueId, userId);
      if (already) {
        const xy = await countXY(venueId, userId);
        const v = await getVenue(venueId);
        const day = warsawDayKey(new Date());
        return ctx.reply(
          `DZIŚ JUŻ BYŁO ✅
🏪 Lokal: ${v ? v.name : venueId}
📅 Dzień (Warszawa): ${day}
📊 X/Y: ${xy.X}/${xy.Y}
Wróć jutro po 00:00 (Warszawa).
Panel: ${PUBLIC_URL}/panel`
        );
      }

      const c = await createCheckin(venueId, userId);
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

  app.use(bot.webhookCallback(`/${WEBHOOK_SECRET}`));
}

/* ---------------- BOOT ---------------- */
(async () => {
  try {
    await migrate();

    if (bot && PUBLIC_URL) {
      const hookUrl = `${PUBLIC_URL}/${WEBHOOK_SECRET}`;
      await bot.telegram.setWebhook(hookUrl);
      console.log("✅ Webhook set:", hookUrl);
    }

    app.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
  } catch (e) {
    console.error("BOOT_ERR", e);
    process.exit(1);
  }
})();
