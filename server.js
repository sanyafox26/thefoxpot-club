/**
 * THE FOXPOT CLUB — Phase 1 MVP — server.js (FULL)
 * Stack: Node.js + Express + Telegraf + pg + crypto (built-in)
 *
 * DO NOT BREAK (already working, kept):
 * ✅ /checkin <venue_id> → OTP 6 digits, TTL 10 min
 * ✅ Web Panel /panel → login Venue ID + PIN → HMAC cookie session 8h → /panel/dashboard
 * ✅ Confirm OTP → counted visit in Postgres
 * ✅ Counted: max 1/day per Fox+venue, reset 00:00 Europe/Warsaw
 * ✅ X/Y stats (counted only)
 * ✅ Debounce confirm 15 min (same Fox+venue)
 * ✅ Login rate limit: 10 failed/IP → block 15 min
 * ✅ sendMessage in try/catch
 * ✅ counted_visits ON CONFLICT DO NOTHING
 * ✅ warsawDayKey()
 *
 * ADD (requested, priority):
 * STEP 1: Venue statuses (Reserve + Today Limited) in Panel Dashboard + DB + limits
 * STEP 2: Fox rating + invites + city + awarding rules
 * STEP 3: Fox registration via bot /start (city → nickname → invite code optional → confirm)
 * STEP 4: Venue registration invite-only + admin approve/reject
 *
 * ENV required:
 * - BOT_TOKEN
 * - DATABASE_URL
 * - PUBLIC_URL
 *
 * ENV optional:
 * - WEBHOOK_SECRET           (string, used to mount Telegraf webhook on Express)
 * - ADMIN_USER_ID            (Telegram numeric id as string; used to allow /admin in bot)
 * - ADMIN_WEB_KEY            (string; required to open /admin/venues in browser)
 */

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Telegraf } = require("telegraf");

// -------------------- ENV --------------------
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : "";
const ADMIN_WEB_KEY = process.env.ADMIN_WEB_KEY ? String(process.env.ADMIN_WEB_KEY) : "";

// -------------------- APP --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -------------------- DB --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
});

async function db(text, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(text, params);
  } finally {
    c.release();
  }
}

async function dbTx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

// -------------------- CONSTANTS (LOCKED) --------------------
const TZ = "Europe/Warsaw";
const OTP_TTL_MIN = 10; // minutes
const CONFIRM_DEBOUNCE_MIN = 15; // minutes
const COOKIE_TTL_HOURS = 8;
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_BLOCK_MIN = 15;

// Venue status limits (LOCKED)
const RESERVE_MAX_PER_MONTH = 2;
const RESERVE_MAX_HOURS = 24;
const RESERVE_MIN_AHEAD_HOURS = 24;

const LIMITED_MAX_PER_WEEK = 2;
const LIMITED_MAX_HOURS = 3;
const LIMITED_REASONS = ["FULL", "PRIVATE EVENT", "KITCHEN LIMIT"];

// -------------------- TABLES (LOCKED prefix fp1_*) --------------------
const T = {
  venues: "fp1_venues",
  foxes: "fp1_foxes",
  checkins: "fp1_checkins",
  counted: "fp1_counted_visits",
  // new:
  inviteCodes: "fp1_invite_codes",
  venueRequests: "fp1_venue_requests",
  reserves: "fp1_venue_reserves",
  limitedEvents: "fp1_venue_limited_events",
};

// -------------------- TIME HELPERS --------------------
function nowUtc() {
  return new Date();
}

function warsawDayKey(d = new Date()) {
  // Returns YYYY-MM-DD in Europe/Warsaw
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function warsawWeekKey(d = new Date()) {
  // Monday-Sunday week key. Return YYYY-MM-DD of Monday (Warsaw).
  // We derive Warsaw local date then compute Monday.
  const ymd = warsawDayKey(d); // YYYY-MM-DD
  const [yy, mm, dd] = ymd.split("-").map((x) => parseInt(x, 10));
  // Create a UTC date at noon to avoid DST edge issues; we only need day-of-week mapping
  const temp = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  // Get weekday in Warsaw by formatting parts
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(temp);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const idx = map[weekday] ?? 0;

  const monday = new Date(temp.getTime() - idx * 24 * 3600 * 1000);
  // Format monday in Warsaw again
  return warsawDayKey(monday);
}

function addMinutes(date, mins) {
  return new Date(date.getTime() + mins * 60000);
}

function addHours(date, hrs) {
  return new Date(date.getTime() + hrs * 3600000);
}

// -------------------- CRYPTO HELPERS --------------------
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function randomHex(nBytes) {
  return crypto.randomBytes(nBytes).toString("hex");
}

function genOTP6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function genInviteCode() {
  // Short-ish, safe: 10 chars base32-like
  const raw = crypto.randomBytes(8).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return raw.toUpperCase();
}

function makePinSalt() {
  return randomHex(8);
}

function makePinHash(pin, salt) {
  return sha256Hex(`${salt}:${pin}`);
}

// -------------------- HTML HELPERS --------------------
const UI = {
  bg: "#0f1220",
  card: "#14182b",
  accent: "#6e56ff",
  border: "#2a2f49",
};

function safeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeHtml(title)}</title>
</head>
<body style="margin:0;background:${UI.bg};color:white;font-family:system-ui,Segoe UI,Arial;">
  <div style="max-width:980px;margin:0 auto;padding:28px;">
    ${body}
  </div>
</body>
</html>`;
}

function card(title, contentHtml) {
  return `
  <div style="background:${UI.card};border:1px solid ${UI.border};border-radius:14px;padding:18px;">
    <div style="font-size:18px;font-weight:800;margin-bottom:10px;">${safeHtml(title)}</div>
    ${contentHtml}
  </div>`;
}

function btn(label) {
  return `<button type="submit" style="padding:10px 14px;border-radius:10px;border:0;background:${UI.accent};color:white;font-weight:800;cursor:pointer;">${safeHtml(
    label
  )}</button>`;
}

function input(name, placeholder = "", value = "", type = "text") {
  return `<input name="${safeHtml(name)}" type="${safeHtml(type)}" placeholder="${safeHtml(
    placeholder
  )}" value="${safeHtml(value)}" style="width:100%;padding:10px;border-radius:10px;border:1px solid ${
    UI.border
  };background:${UI.bg};color:white;" />`;
}

function select(name, options, selected) {
  return `<select name="${safeHtml(name)}" style="width:100%;padding:10px;border-radius:10px;border:1px solid ${
    UI.border
  };background:${UI.bg};color:white;">
    ${options
      .map((o) => {
        const sel = o === selected ? "selected" : "";
        return `<option value="${safeHtml(o)}" ${sel}>${safeHtml(o)}</option>`;
      })
      .join("")}
  </select>`;
}

function link(href, text) {
  return `<a href="${safeHtml(href)}" style="color:#9aa4ff;">${safeHtml(text)}</a>`;
}

function panelUrl() {
  return `${PUBLIC_URL}/panel`;
}

// -------------------- COOKIE SESSION (HMAC signed, 8h) --------------------
const SESSION_COOKIE = "fp1_panel";
const SESSION_KEY = sha256Hex(`${DATABASE_URL}|${PUBLIC_URL}|panel`); // stable per deployment

function signSession(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_KEY).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(cookieVal) {
  if (!cookieVal || typeof cookieVal !== "string") return null;
  const parts = cookieVal.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", SESSION_KEY).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!obj || !obj.venueId || !obj.exp) return null;
    if (Date.now() > Number(obj.exp)) return null;
    return obj;
  } catch {
    return null;
  }
}

function setCookie(res, name, val, maxAgeSeconds) {
  const secure = PUBLIC_URL.startsWith("https://");
  const parts = [
    `${name}=${val}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  setCookie(res, name, "", 0);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const map = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) map[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return map[name] || "";
}

// -------------------- LOGIN RATE LIMIT (IP) --------------------
const loginFailsByIp = new Map(); // ip -> { fails, blockedUntilTs }

function getIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function isIpBlocked(ip) {
  const rec = loginFailsByIp.get(ip);
  if (!rec) return false;
  if (rec.blockedUntilTs && Date.now() < rec.blockedUntilTs) return true;
  return false;
}

function registerFail(ip) {
  const rec = loginFailsByIp.get(ip) || { fails: 0, blockedUntilTs: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_FAIL_LIMIT) {
    rec.blockedUntilTs = Date.now() + LOGIN_BLOCK_MIN * 60000;
    rec.fails = 0; // reset counter after block
  }
  loginFailsByIp.set(ip, rec);
}

// -------------------- DB SCHEMA (CREATE/ALTER) --------------------
async function ensureSchema() {
  // venues
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.venues} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      pin_salt TEXT NOT NULL DEFAULT '',
      pin_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- STEP 1 (status fields)
      reserve_start TIMESTAMPTZ NULL,
      reserve_end TIMESTAMPTZ NULL,
      limited_reason TEXT NULL,
      limited_until TIMESTAMPTZ NULL
    );
  `);

  // foxes (STEP 2 columns)
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.foxes} (
      id SERIAL PRIMARY KEY,
      user_id BIGINT UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rating INT NOT NULL DEFAULT 0,
      invites INT NOT NULL DEFAULT 0,
      city TEXT NOT NULL DEFAULT 'Warsaw',
      -- to avoid double-awarding rating thresholds:
      bonus_10 BOOLEAN NOT NULL DEFAULT FALSE,
      bonus_20 BOOLEAN NOT NULL DEFAULT FALSE,
      bonus_30 BOOLEAN NOT NULL DEFAULT FALSE,
      bonus_100_level INT NOT NULL DEFAULT 0
    );
  `);

  // checkins
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.checkins} (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      user_id BIGINT NOT NULL,
      otp TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ NULL
    );
  `);

  // counted visits
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.counted} (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      user_id BIGINT NOT NULL,
      day_key DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Invite codes (STEP 3)
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.inviteCodes} (
      code TEXT PRIMARY KEY,
      created_by_user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_by_user_id BIGINT NULL,
      used_at TIMESTAMPTZ NULL
    );
  `);

  // Venue requests (STEP 4)
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.venueRequests} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      fox_nick TEXT NOT NULL,
      invited_by_user_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ NULL
    );
  `);

  // Reserve events (STEP 1 limit enforcement)
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.reserves} (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      reserve_start TIMESTAMPTZ NOT NULL,
      reserve_end TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Limited events (STEP 1 weekly cap)
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.limitedEvents} (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      reason TEXT NOT NULL,
      limited_until TIMESTAMPTZ NOT NULL,
      week_key DATE NOT NULL, -- monday date in Warsaw
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Indexes
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_checkins_venue_otp ON ${T.checkins}(venue_id, otp);`);
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_checkins_expires ON ${T.checkins}(expires_at);`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS fp1_idx_counted_unique ON ${T.counted}(venue_id, user_id, day_key);`);
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_invite_unused ON ${T.inviteCodes}(created_by_user_id, used_at);`);
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_reserves_venue ON ${T.reserves}(venue_id, reserve_start);`);
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_limited_venue_week ON ${T.limitedEvents}(venue_id, week_key);`);

  // Seed test venues if empty
  const r = await db(`SELECT COUNT(*)::int AS c FROM ${T.venues};`);
  if ((r.rows[0]?.c || 0) === 0) {
    const s1 = makePinSalt();
    const h1 = makePinHash("123456", s1);
    await db(`INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`, [
      "Test Kebab #1",
      "Warsaw",
      s1,
      h1,
    ]);

    const s2 = makePinSalt();
    const h2 = makePinHash("123456", s2);
    await db(`INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`, [
      "Test Pizza #2",
      "Warsaw",
      s2,
      h2,
    ]);

    console.log("✅ Seeded test venues: 1,2 (PIN 123456).");
  }
}

// -------------------- CORE DB FUNCTIONS --------------------
async function getVenueById(venueId, client = null) {
  const q = client ? client.query.bind(client) : db;
  const r = await q(`SELECT * FROM ${T.venues} WHERE id=$1;`, [venueId]);
  return r.rows[0] || null;
}

async function verifyVenuePin(venueId, pin, client = null) {
  const q = client ? client.query.bind(client) : db;
  const v = await getVenueById(venueId, client);
  if (!v) return { ok: false, reason: "VENUE_NOT_FOUND" };
  if (!v.pin_salt || !v.pin_hash) return { ok: false, reason: "PIN_NOT_SET" };
  const computed = makePinHash(String(pin), String(v.pin_salt));
  if (computed !== v.pin_hash) return { ok: false, reason: "PIN_INVALID" };
  return { ok: true, venue: v };
}

async function getFoxByUserId(userId, client = null) {
  const q = client ? client.query.bind(client) : db;
  const r = await q(`SELECT * FROM ${T.foxes} WHERE user_id=$1;`, [userId]);
  return r.rows[0] || null;
}

async function upsertFoxBasic(userId, username, client = null) {
  const q = client ? client.query.bind(client) : db;
  await q(
    `INSERT INTO ${T.foxes}(user_id, username)
     VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username;`,
    [userId, username || ""]
  );
}

function normalizeCity(s) {
  return String(s || "").trim().toLowerCase();
}

// --- Rating / Invites awarding ---
async function addFoxRatingInvites(userId, deltaRating, deltaInvites, client) {
  // client is required inside transaction
  const fox = await getFoxByUserId(userId, client);
  if (!fox) return;

  let rating = Number(fox.rating || 0);
  let invites = Number(fox.invites || 0);

  rating += Number(deltaRating || 0);
  invites += Number(deltaInvites || 0);

  // Apply threshold bonuses (one-time for 10/20/30; +10 for each 100 milestone)
  let bonusInvites = 0;

  const newBonus10 = fox.bonus_10 || false;
  const newBonus20 = fox.bonus_20 || false;
  const newBonus30 = fox.bonus_30 || false;
  let bonus10 = newBonus10;
  let bonus20 = newBonus20;
  let bonus30 = newBonus30;

  if (!bonus10 && rating >= 10) {
    bonusInvites += 1;
    bonus10 = true;
  }
  if (!bonus20 && rating >= 20) {
    bonusInvites += 2;
    bonus20 = true;
  }
  if (!bonus30 && rating >= 30) {
    bonusInvites += 3;
    bonus30 = true;
  }

  let bonus100Level = Number(fox.bonus_100_level || 0);
  if (rating >= 100) {
    const targetLevel = Math.floor(rating / 100) * 100; // 100,200,300,...
    // award +10 for each 100-level crossed beyond stored bonus100Level
    while (bonus100Level < targetLevel) {
      bonus100Level += 100;
      // only award starting at 100
      if (bonus100Level >= 100) bonusInvites += 10;
    }
  }

  invites += bonusInvites;

  await client.query(
    `UPDATE ${T.foxes}
     SET rating=$2, invites=$3, bonus_10=$4, bonus_20=$5, bonus_30=$6, bonus_100_level=$7
     WHERE user_id=$1;`,
    [userId, rating, invites, bonus10, bonus20, bonus30, bonus100Level]
  );

  return { rating, invites };
}

async function ensureFoxRegistered(userId, username, city, invitedByUserId, client) {
  // Register brand new fox: rating +1, invites=3, city
  // If already exists, do nothing.
  const existing = await getFoxByUserId(userId, client);
  if (existing) {
    // Update username if needed
    await client.query(`UPDATE ${T.foxes} SET username=$2 WHERE user_id=$1;`, [userId, username || ""]);
    return { created: false, fox: existing };
  }

  await client.query(
    `INSERT INTO ${T.foxes}(user_id, username, rating, invites, city)
     VALUES ($1,$2,1,3,$3);`,
    [userId, username || "", city || "Warsaw"]
  );

  // inviter gets +1 rating (successful invite) if invitedByUserId provided
  if (invitedByUserId) {
    await addFoxRatingInvites(invitedByUserId, 1, 0, client);
  }

  const fox = await getFoxByUserId(userId, client);
  return { created: true, fox };
}

// --- counted / X/Y ---
async function getXY(userId, venueId, client = null) {
  const q = client ? client.query.bind(client) : db;
  const x = await q(`SELECT COUNT(*)::int AS c FROM ${T.counted} WHERE user_id=$1 AND venue_id=$2;`, [userId, venueId]);
  const y = await q(`SELECT COUNT(*)::int AS c FROM ${T.counted} WHERE venue_id=$1;`, [venueId]);
  return { X: x.rows[0]?.c || 0, Y: y.rows[0]?.c || 0 };
}

async function countedExistsToday(userId, venueId, client = null) {
  const q = client ? client.query.bind(client) : db;
  const dayKey = warsawDayKey(new Date());
  const r = await q(
    `SELECT 1 FROM ${T.counted} WHERE user_id=$1 AND venue_id=$2 AND day_key=$3::date LIMIT 1;`,
    [userId, venueId, dayKey]
  );
  return { exists: r.rowCount > 0, dayKey };
}

// Debounce: if same user+venue confirmed in last 15 min, treat as already confirmed
async function confirmedDebounce(userId, venueId, client = null) {
  const q = client ? client.query.bind(client) : db;
  const r = await q(
    `SELECT 1
     FROM ${T.checkins}
     WHERE user_id=$1 AND venue_id=$2
       AND confirmed_at IS NOT NULL
       AND confirmed_at > NOW() - INTERVAL '${CONFIRM_DEBOUNCE_MIN} minutes'
     LIMIT 1;`,
    [userId, venueId]
  );
  return r.rowCount > 0;
}

// Insert counted visit (race safe)
async function insertCountedVisit(userId, venueId, dayKey, client) {
  // ON CONFLICT DO NOTHING ensures no duplicate for same day
  const r = await client.query(
    `INSERT INTO ${T.counted}(venue_id, user_id, day_key)
     VALUES ($1,$2,$3::date)
     ON CONFLICT DO NOTHING
     RETURNING id;`,
    [venueId, userId, dayKey]
  );
  return r.rowCount > 0;
}

async function totalCountedVisits(userId, client = null) {
  const q = client ? client.query.bind(client) : db;
  const r = await q(`SELECT COUNT(*)::int AS c FROM ${T.counted} WHERE user_id=$1;`, [userId]);
  return r.rows[0]?.c || 0;
}

// -------------------- STEP 1: VENUE STATUS LOGIC --------------------
async function reserveCountThisMonth(venueId, client) {
  // month by Warsaw date (use current Warsaw day_key month)
  const ymd = warsawDayKey(new Date()); // YYYY-MM-DD
  const [yy, mm] = ymd.split("-").map((x) => parseInt(x, 10));
  // month range in UTC for query: from first day 00:00 Warsaw approx by constructing Warsaw local date as string
  // Simpler: use created_at in DB with date_trunc month at Warsaw? We'll compute with TIME ZONE 'Europe/Warsaw'
  const r = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM ${T.reserves}
     WHERE venue_id=$1
       AND (reserve_start AT TIME ZONE '${TZ}')::date >= make_date($2,$3,1)
       AND (reserve_start AT TIME ZONE '${TZ}')::date < (make_date($2,$3,1) + INTERVAL '1 month')::date;`,
    [venueId, yy, mm]
  );
  return r.rows[0]?.c || 0;
}

async function limitedCountThisWeek(venueId, weekKeyMonday, client) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM ${T.limitedEvents} WHERE venue_id=$1 AND week_key=$2::date;`,
    [venueId, weekKeyMonday]
  );
  return r.rows[0]?.c || 0;
}

function clampReserveDurationHours(h) {
  const allowed = [1, 2, 4, 8, 24];
  const v = Number(h);
  return allowed.includes(v) ? v : 1;
}

function clampLimitedDurationHours(h) {
  const allowed = [1, 2, 3];
  const v = Number(h);
  return allowed.includes(v) ? v : 1;
}

// -------------------- STEP 4: VENUE REQUESTS (invite-only) --------------------
async function findFoxByNick(nick, client) {
  const clean = String(nick || "").trim();
  if (!clean) return null;

  // Accept "@name" or "name"
  const n = clean.startsWith("@") ? clean.slice(1) : clean;

  // match username (stored with @ or without) case-insensitive
  const r = await client.query(
    `SELECT * FROM ${T.foxes}
     WHERE LOWER(REPLACE(username,'@','')) = LOWER($1)
     LIMIT 1;`,
    [n]
  );
  return r.rows[0] || null;
}

// -------------------- PANEL AUTH MIDDLEWARE --------------------
async function requirePanelSession(req, res, next) {
  const raw = getCookie(req, SESSION_COOKIE);
  const sess = verifySession(raw);
  if (!sess) return res.redirect("/panel");

  // Ensure venue still exists
  try {
    const v = await getVenueById(Number(sess.venueId));
    if (!v) {
      clearCookie(res, SESSION_COOKIE);
      return res.redirect("/panel");
    }
    req.panel = { venueId: Number(sess.venueId), venue: v };
    next();
  } catch {
    clearCookie(res, SESSION_COOKIE);
    return res.redirect("/panel");
  }
}

// -------------------- HEALTH --------------------
app.get("/health", async (req, res) => {
  try {
    const t = await db("SELECT NOW() AS now;");
    res.json({ ok: true, db: true, now: t.rows[0]?.now, tz: TZ });
  } catch (e) {
    res.json({ ok: true, db: false, error: String(e?.message || e), tz: TZ });
  }
});

// -------------------- PANEL: LOGIN --------------------
app.get("/panel", (req, res) => {
  const body = `
    <div style="display:flex;flex-direction:column;gap:14px;">
      ${card(
        "Panel lokalu",
        `
        <div style="opacity:.85;margin-bottom:12px;">Zaloguj się PIN-em lokalu</div>
        <form method="POST" action="/panel/login">
          <div style="display:flex;gap:12px;align-items:flex-end;">
            <div style="flex:1;">
              <div style="font-size:12px;opacity:.8;margin-bottom:6px;">Venue ID</div>
              ${input("venue", "np. 1", "", "text")}
            </div>
            <div style="flex:1;">
              <div style="font-size:12px;opacity:.8;margin-bottom:6px;">PIN (6 cyfr)</div>
              ${input("pin", "123456", "", "password")}
            </div>
          </div>
          <div style="margin-top:12px;">${btn("Zaloguj")}</div>
        </form>
        <div style="margin-top:10px;font-size:13px;opacity:.7;">Test: Venue 1 / PIN 123456</div>
        `
      )}
    </div>
  `;
  res.send(page("Panel lokalu", body));
});

app.post("/panel/login", async (req, res) => {
  const ip = getIp(req);
  if (isIpBlocked(ip)) return res.send(page("Zablokowano", card("Zablokowano", `<div>Za dużo prób. Spróbuj później.</div>`)));

  const venueId = Number(String(req.body.venue || "").trim());
  const pin = String(req.body.pin || "").trim();

  if (!Number.isFinite(venueId) || venueId <= 0 || !pin) {
    registerFail(ip);
    return res.redirect("/panel");
  }

  try {
    const v = await verifyVenuePin(venueId, pin);
    if (!v.ok) {
      registerFail(ip);
      return res.redirect("/panel");
    }

    // Create session cookie (HMAC-signed, 8h). PIN NOT in URL.
    const exp = Date.now() + COOKIE_TTL_HOURS * 3600000;
    const token = signSession({ venueId, exp });
    setCookie(res, SESSION_COOKIE, token, COOKIE_TTL_HOURS * 3600);
    res.redirect("/panel/dashboard");
  } catch (e) {
    registerFail(ip);
    res.redirect("/panel");
  }
});

app.get("/panel/logout", (req, res) => {
  clearCookie(res, SESSION_COOKIE);
  res.redirect("/panel");
});

// -------------------- PANEL: DASHBOARD --------------------
app.get("/panel/dashboard", requirePanelSession, async (req, res) => {
  const venue = req.panel.venue;
  const venueId = req.panel.venueId;

  // pending checkins
  const pending = await db(
    `SELECT otp, user_id, expires_at
     FROM ${T.checkins}
     WHERE venue_id=$1 AND confirmed_at IS NULL AND expires_at > NOW()
     ORDER BY expires_at ASC
     LIMIT 50;`,
    [venueId]
  );

  const pendingHtml =
    pending.rows.length === 0
      ? `<div style="opacity:.7;">Brak aktywnych check-inów</div>`
      : `<div style="display:flex;flex-direction:column;gap:10px;">
          ${pending.rows
            .map((r) => {
              return `<div style="padding:10px;border:1px solid ${UI.border};border-radius:12px;background:${UI.bg};">
                <div><b>OTP:</b> ${safeHtml(r.otp)}</div>
                <div style="opacity:.8;font-size:13px;">Fox ID: ****${safeHtml(String(r.user_id).slice(-4))} | Expires: ${safeHtml(
                new Date(r.expires_at).toLocaleString("pl-PL")
              )}</div>
              </div>`;
            })
            .join("")}
        </div>`;

  // current status blocks
  const now = new Date();
  const reserveActive =
    venue.reserve_start && venue.reserve_end && new Date(venue.reserve_start) <= now && now <= new Date(venue.reserve_end);
  const reserveFuture =
    venue.reserve_start && venue.reserve_end && new Date(venue.reserve_start) > now && new Date(venue.reserve_end) > now;

  const limitedActive = venue.limited_until && new Date(venue.limited_until) > now;

  const reserveStatusText = reserveActive
    ? `AKTYWNA do ${new Date(venue.reserve_end).toLocaleString("pl-PL")}`
    : reserveFuture
    ? `ZAPLANOWANA: ${new Date(venue.reserve_start).toLocaleString("pl-PL")} → ${new Date(venue.reserve_end).toLocaleString("pl-PL")}`
    : `Brak`;

  const limitedStatusText = limitedActive
    ? `${safeHtml(venue.limited_reason || "")} do ${new Date(venue.limited_until).toLocaleString("pl-PL")}`
    : `Brak`;

  const body = `
  <div style="display:flex;flex-direction:column;gap:14px;">
    ${card(
      `Panel: ${venue.name} (ID ${venueId})`,
      `
        <div style="opacity:.85;margin-bottom:10px;">${link("/panel/logout", "Wyloguj")}</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          ${card(
            "Confirm OTP",
            `
            <form method="POST" action="/panel/confirm">
              <div style="font-size:12px;opacity:.8;margin-bottom:6px;">OTP (6 cyfr)</div>
              ${input("otp", "np. 874940", "", "text")}
              <div style="margin-top:10px;">${btn("Confirm")}</div>
            </form>
            <div style="margin-top:10px;font-size:13px;opacity:.75;">OTP ważny 10 minut. Debounce: 15 minut.</div>
            `
          )}
          ${card("Pending check-ins", `${pendingHtml}<div style="margin-top:10px;">${link("/panel/dashboard", "Odśwież")}</div>`)}
        </div>
      `
    )}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      ${card(
        "📍 Rezerwa (planowa pauza)",
        `
          <div style="opacity:.85;margin-bottom:10px;"><b>Status:</b> ${safeHtml(reserveStatusText)}</div>
          <div style="font-size:13px;opacity:.75;margin-bottom:10px;">
            Limit: max ${RESERVE_MAX_PER_MONTH} / miesiąc, max 24h, ustaw min. 24h wcześniej.
          </div>
          <form method="POST" action="/panel/reserve/set">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <div style="font-size:12px;opacity:.8;margin-bottom:6px;">Start (datetime)</div>
                ${input("start", "", "", "datetime-local")}
              </div>
              <div>
                <div style="font-size:12px;opacity:.8;margin-bottom:6px;">Czas trwania</div>
                ${select("duration", ["1", "2", "4", "8", "24"], "24")}
                <div style="font-size:12px;opacity:.7;margin-top:6px;">(godziny)</div>
              </div>
            </div>
            <div style="margin-top:10px;">${btn("Ustaw Rezerwę")}</div>
          </form>
          <form method="POST" action="/panel/reserve/clear" style="margin-top:10px;">
            <button type="submit" style="padding:10px 14px;border-radius:10px;border:1px solid ${UI.border};background:${UI.bg};color:white;font-weight:800;cursor:pointer;">Usuń Rezerwę</button>
          </form>
        `
      )}

      ${card(
        'Dziś ograniczone (informacja)',
        `
          <div style="opacity:.85;margin-bottom:10px;"><b>Status:</b> ${safeHtml(limitedStatusText)}</div>
          <div style="font-size:13px;opacity:.75;margin-bottom:10px;">
            Limit: max ${LIMITED_MAX_PER_WEEK} / tydzień (Mon–Sun Warsaw), max 3h. To NIE wyłącza zniżki.
          </div>

          <form method="POST" action="/panel/limited/set">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <div style="font-size:12px;opacity:.8;margin-bottom:6px;">Powód</div>
                ${select("reason", LIMITED_REASONS, "FULL")}
              </div>
              <div>
                <div style="font-size:12px;opacity:.8;margin-bottom:6px;">Do (czas trwania)</div>
                ${select("duration", ["1", "2", "3"], "3")}
                <div style="font-size:12px;opacity:.7;margin-top:6px;">(godziny)</div>
              </div>
            </div>
            <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
              ${btn("Ustaw Dziś ograniczone")}
            </div>
          </form>

          <form method="POST" action="/panel/limited/clear" style="margin-top:10px;">
            <button type="submit" style="padding:10px 14px;border-radius:10px;border:1px solid ${UI.border};background:${UI.bg};color:white;font-weight:800;cursor:pointer;">Anuluj</button>
          </form>
        `
      )}
    </div>
  </div>
  `;

  res.send(page("Dashboard", body));
});

// -------------------- PANEL: CONFIRM OTP --------------------
app.post("/panel/confirm", requirePanelSession, async (req, res) => {
  const venueId = req.panel.venueId;
  const venue = req.panel.venue;
  const otp = String(req.body.otp || "").trim();

  if (!otp) return res.redirect("/panel/dashboard");

  try {
    await dbTx(async (client) => {
      // find latest checkin for this OTP/venue
      const r = await client.query(
        `SELECT id, user_id, expires_at, confirmed_at
         FROM ${T.checkins}
         WHERE venue_id=$1 AND otp=$2
         ORDER BY id DESC
         LIMIT 1;`,
        [venueId, otp]
      );

      if (r.rowCount === 0) {
        throw new Error("OTP_NOT_FOUND");
      }

      const chk = r.rows[0];

      if (chk.confirmed_at) {
        throw new Error("ALREADY_CONFIRMED");
      }

      // expired
      if (new Date(chk.expires_at).getTime() <= Date.now()) {
        throw new Error("OTP_EXPIRED");
      }

      const userId = Number(chk.user_id);

      // Debounce: if confirmed within 15 min for same user+venue, do not create new counted
      const debounced = await confirmedDebounce(userId, venueId, client);

      // confirm checkin record anyway (so OTP can't be reused)
      await client.query(`UPDATE ${T.checkins} SET confirmed_at=NOW() WHERE id=$1;`, [chk.id]);

      const dayKey = warsawDayKey(new Date());

      // If debounced: behave as "already confirmed" (no counted)
      if (debounced) {
        const xy = await getXY(userId, venueId, client);

        // send message (safe)
        if (bot) {
          try {
            await bot.telegram.sendMessage(
              userId,
              `DZIŚ JUŻ BYŁO ✅\nLokal: ${venue.name}\nDzień (Warszawa): ${dayKey}\nX/Y: ${xy.X}/${xy.Y}`
            );
          } catch (_) {}
        }

        return;
      }

      // Insert counted (race-safe)
      const inserted = await insertCountedVisit(userId, venueId, dayKey, client);

      // Always safe message, even if already exists today
      const xy = await getXY(userId, venueId, client);

      if (!inserted) {
        // already counted today
        if (bot) {
          try {
            await bot.telegram.sendMessage(
              userId,
              `DZIŚ JUŻ BYŁO ✅\nLokal: ${venue.name}\nDzień (Warszawa): ${dayKey}\nX/Y: ${xy.X}/${xy.Y}\nWróć jutro po 00:00 (Warszawa).`
            );
          } catch (_) {}
        }
        return;
      }

      // STEP 2: rating + invites updates on counted confirm
      // - Counted visit confirmed: rating +1
      // - Each 5 counted visits: +1 invite
      // Also thresholds via addFoxRatingInvites()

      // Ensure fox exists at least basic
      await upsertFoxBasic(userId, "", client);

      // add rating +1
      await addFoxRatingInvites(userId, 1, 0, client);

      // each 5 counted visits -> +1 invite
      const total = await totalCountedVisits(userId, client);
      if (total > 0 && total % 5 === 0) {
        await addFoxRatingInvites(userId, 0, 1, client);
      }

      // Notify fox
      if (bot) {
        try {
          await bot.telegram.sendMessage(
            userId,
            `✅ Confirm OK\n🏪 ${venue.name}\n📅 Day (Warszawa): ${dayKey}\n📊 X/Y: ${xy.X}/${xy.Y}`
          );
        } catch (_) {}
      }
    });

    res.redirect("/panel/dashboard");
  } catch (e) {
    const msg = String(e?.message || e);
    let title = "Błąd";
    if (msg === "OTP_NOT_FOUND") title = "OTP nie znaleziono";
    if (msg === "OTP_EXPIRED") title = "OTP wygasł";
    if (msg === "ALREADY_CONFIRMED") title = "Już potwierdzono";

    res.send(
      page(
        title,
        card(title, `<div style="opacity:.85;margin-bottom:12px;">${safeHtml(title)}</div>${link("/panel/dashboard", "Powrót")}`)
      )
    );
  }
});

// -------------------- PANEL: STEP 1 STATUS ENDPOINTS --------------------
app.post("/panel/reserve/set", requirePanelSession, async (req, res) => {
  const venueId = req.panel.venueId;

  const startRaw = String(req.body.start || "").trim(); // datetime-local
  const durRaw = String(req.body.duration || "").trim();

  const durationHours = clampReserveDurationHours(durRaw);

  if (!startRaw) return res.redirect("/panel/dashboard");

  // Parse "YYYY-MM-DDTHH:MM" as Warsaw local time
  // Convert to a Date by treating it as local time in Warsaw.
  // We'll store as TIMESTAMPTZ by using ISO with offset? We avoid external libs; simplest:
  // store as timestamp WITHOUT trusting server timezone by using "AT TIME ZONE" in SQL.
  // We'll send startRaw as text and interpret in SQL with TZ.

  try {
    await dbTx(async (client) => {
      // Count reserves in current Warsaw month
      const cnt = await reserveCountThisMonth(venueId, client);
      if (cnt >= RESERVE_MAX_PER_MONTH) throw new Error("RESERVE_LIMIT_MONTH");

      // Enforce start at least 24h ahead (Warsaw)
      // We'll compute in SQL: (start at time zone Warsaw) >= (now Warsaw + 24h)
      const ahead = await client.query(
        `SELECT
           ( ( ($1::timestamp AT TIME ZONE '${TZ}') ) >= ( (NOW() AT TIME ZONE '${TZ}') + INTERVAL '${RESERVE_MIN_AHEAD_HOURS} hours' ) ) AS ok;`,
        [startRaw]
      );
      if (!ahead.rows[0]?.ok) throw new Error("RESERVE_TOO_SOON");

      // End = start + duration
      // Also cap 24h (already via allowed list)
      const r = await client.query(
        `SELECT
           ($1::timestamp AT TIME ZONE '${TZ}')::timestamptz AS start_ts,
           (($1::timestamp AT TIME ZONE '${TZ}') + ($2 || ' hours')::interval)::timestamptz AS end_ts;`,
        [startRaw, String(durationHours)]
      );

      const startTs = r.rows[0].start_ts;
      const endTs = r.rows[0].end_ts;

      // duration max 24h
      const diffOk = await client.query(`SELECT ($2::timestamptz - $1::timestamptz) <= INTERVAL '${RESERVE_MAX_HOURS} hours' AS ok;`, [
        startTs,
        endTs,
      ]);
      if (!diffOk.rows[0]?.ok) throw new Error("RESERVE_TOO_LONG");

      // Save event + current status in venues
      await client.query(
        `INSERT INTO ${T.reserves}(venue_id, reserve_start, reserve_end) VALUES ($1,$2,$3);`,
        [venueId, startTs, endTs]
      );

      await client.query(
        `UPDATE ${T.venues} SET reserve_start=$2, reserve_end=$3 WHERE id=$1;`,
        [venueId, startTs, endTs]
      );
    });

    res.redirect("/panel/dashboard");
  } catch (e) {
    const msg = String(e?.message || e);
    let text = "Błąd ustawiania rezerwy.";
    if (msg === "RESERVE_LIMIT_MONTH") text = `Limit: max ${RESERVE_MAX_PER_MONTH} rezerwy / miesiąc.`;
    if (msg === "RESERVE_TOO_SOON") text = `Rezerwa musi być ustawiona min. ${RESERVE_MIN_AHEAD_HOURS}h wcześniej.`;
    if (msg === "RESERVE_TOO_LONG") text = `Rezerwa max ${RESERVE_MAX_HOURS}h.`;

    res.send(page("Rezerwa", card("Rezerwa", `<div style="opacity:.85;margin-bottom:12px;">${safeHtml(text)}</div>${link("/panel/dashboard", "Powrót")}`)));
  }
});

app.post("/panel/reserve/clear", requirePanelSession, async (req, res) => {
  const venueId = req.panel.venueId;
  try {
    await db(`UPDATE ${T.venues} SET reserve_start=NULL, reserve_end=NULL WHERE id=$1;`, [venueId]);
  } catch (_) {}
  res.redirect("/panel/dashboard");
});

app.post("/panel/limited/set", requirePanelSession, async (req, res) => {
  const venueId = req.panel.venueId;

  const reason = String(req.body.reason || "").trim();
  const durationHours = clampLimitedDurationHours(String(req.body.duration || "").trim());

  if (!LIMITED_REASONS.includes(reason)) {
    return res.send(page("Błąd", card("Błąd", `<div>Niepoprawny powód.</div>${link("/panel/dashboard", "Powrót")}`)));
  }

  try {
    await dbTx(async (client) => {
      const weekKey = warsawWeekKey(new Date()); // monday date
      const cnt = await limitedCountThisWeek(venueId, weekKey, client);
      if (cnt >= LIMITED_MAX_PER_WEEK) throw new Error("LIMITED_LIMIT_WEEK");

      const until = addHours(new Date(), durationHours);

      // store event + current status
      await client.query(
        `INSERT INTO ${T.limitedEvents}(venue_id, reason, limited_until, week_key) VALUES ($1,$2,$3,$4::date);`,
        [venueId, reason, until.toISOString(), weekKey]
      );

      await client.query(
        `UPDATE ${T.venues} SET limited_reason=$2, limited_until=$3 WHERE id=$1;`,
        [venueId, reason, until.toISOString()]
      );
    });

    res.redirect("/panel/dashboard");
  } catch (e) {
    const msg = String(e?.message || e);
    let text = "Błąd ustawiania statusu.";
    if (msg === "LIMITED_LIMIT_WEEK") text = `Limit: max ${LIMITED_MAX_PER_WEEK} razy / tydzień (Mon–Sun Warsaw).`;
    res.send(page("Dziś ograniczone", card("Dziś ograniczone", `<div style="opacity:.85;margin-bottom:12px;">${safeHtml(text)}</div>${link("/panel/dashboard", "Powrót")}`)));
  }
});

app.post("/panel/limited/clear", requirePanelSession, async (req, res) => {
  const venueId = req.panel.venueId;
  try {
    await db(`UPDATE ${T.venues} SET limited_reason=NULL, limited_until=NULL WHERE id=$1;`, [venueId]);
  } catch (_) {}
  res.redirect("/panel/dashboard");
});

// -------------------- PUBLIC: VENUES MAP DATA (status only, for Phase 2 map) --------------------
// For now: minimal JSON endpoint (not required, but useful)
app.get("/api/venues", async (req, res) => {
  try {
    const r = await db(
      `SELECT id,name,city,reserve_start,reserve_end,limited_reason,limited_until FROM ${T.venues} ORDER BY id ASC LIMIT 500;`
    );
    res.json({ ok: true, venues: r.rows });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- ADMIN WEB: APPROVE/REJECT VENUES --------------------
function requireAdminWeb(req, res, next) {
  if (!ADMIN_WEB_KEY) return res.status(403).send("ADMIN_WEB_KEY not set");
  const key = String(req.query.key || "");
  if (key !== ADMIN_WEB_KEY) return res.status(403).send("Forbidden");
  next();
}

app.get("/admin/venues", requireAdminWeb, async (req, res) => {
  const r = await db(
    `SELECT id,name,address,city,fox_nick,invited_by_user_id,status,created_at
     FROM ${T.venueRequests}
     WHERE status='pending'
     ORDER BY created_at ASC
     LIMIT 200;`
  );

  const rows =
    r.rows.length === 0
      ? `<div style="opacity:.75;">Brak pending.</div>`
      : `<div style="display:flex;flex-direction:column;gap:10px;">
          ${r.rows
            .map((x) => {
              return `<div style="padding:12px;border:1px solid ${UI.border};border-radius:12px;background:${UI.bg};">
                <div style="font-weight:800;">${safeHtml(x.name)}</div>
                <div style="opacity:.85;font-size:13px;">${safeHtml(x.address)} | ${safeHtml(x.city)}</div>
                <div style="opacity:.75;font-size:13px;">Fox: ${safeHtml(x.fox_nick)} (user_id ****${safeHtml(String(x.invited_by_user_id).slice(-4))})</div>
                <div style="margin-top:10px;display:flex;gap:10px;">
                  <form method="POST" action="/admin/venues/${x.id}/approve?key=${encodeURIComponent(ADMIN_WEB_KEY)}">
                    ${btn("Approve")}
                  </form>
                  <form method="POST" action="/admin/venues/${x.id}/reject?key=${encodeURIComponent(ADMIN_WEB_KEY)}">
                    <button type="submit" style="padding:10px 14px;border-radius:10px;border:1px solid ${UI.border};background:${UI.bg};color:white;font-weight:800;cursor:pointer;">Reject</button>
                  </form>
                </div>
              </div>`;
            })
            .join("")}
        </div>`;

  res.send(
    page(
      "Admin / Pending venues",
      `<div style="display:flex;flex-direction:column;gap:14px;">
         ${card("Admin: Pending venues", rows)}
       </div>`
    )
  );
});

app.post("/admin/venues/:id/approve", requireAdminWeb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.redirect(`/admin/venues?key=${encodeURIComponent(ADMIN_WEB_KEY)}`);

  try {
    await dbTx(async (client) => {
      const r = await client.query(`SELECT * FROM ${T.venueRequests} WHERE id=$1 AND status='pending' LIMIT 1;`, [id]);
      if (r.rowCount === 0) return;

      const vr = r.rows[0];

      // Create venue in fp1_venues
      const ins = await client.query(
        `INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4) RETURNING id;`,
        [vr.name, vr.city, vr.pin_salt, vr.pin_hash]
      );
      const venueId = ins.rows[0].id;

      // Mark request approved
      await client.query(`UPDATE ${T.venueRequests} SET status='approved', decided_at=NOW() WHERE id=$1;`, [id]);

      // Award inviter Fox bonuses:
      // rating +1 (same city) or +2 (other city)
      // invites +5 (same city) or +10 (other city)
      const inviterId = Number(vr.invited_by_user_id);
      const inviter = await getFoxByUserId(inviterId, client);
      if (inviter) {
        const sameCity = normalizeCity(inviter.city) === normalizeCity(vr.city);
        const deltaRating = sameCity ? 1 : 2;
        const deltaInvites = sameCity ? 5 : 10;
        await addFoxRatingInvites(inviterId, deltaRating, deltaInvites, client);
      }

      // (Optional) you can log venueId somewhere; not needed now
      void venueId;
    });
  } catch (_) {}

  res.redirect(`/admin/venues?key=${encodeURIComponent(ADMIN_WEB_KEY)}`);
});

app.post("/admin/venues/:id/reject", requireAdminWeb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.redirect(`/admin/venues?key=${encodeURIComponent(ADMIN_WEB_KEY)}`);

  try {
    await db(`UPDATE ${T.venueRequests} SET status='rejected', decided_at=NOW() WHERE id=$1 AND status='pending';`, [id]);
  } catch (_) {}

  res.redirect(`/admin/venues?key=${encodeURIComponent(ADMIN_WEB_KEY)}`);
});

// -------------------- TELEGRAM BOT --------------------
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// In-memory registration state (no extra packages)
const regState = new Map(); // userId -> { step, data, ts }

function setState(userId, step, data = {}) {
  regState.set(String(userId), { step, data, ts: Date.now() });
}
function getState(userId) {
  const s = regState.get(String(userId));
  if (!s) return null;
  // expire after 30 min
  if (Date.now() - s.ts > 30 * 60000) {
    regState.delete(String(userId));
    return null;
  }
  return s;
}
function clearState(userId) {
  regState.delete(String(userId));
}

async function listVenuesText() {
  const r = await db(`SELECT id,name,city FROM ${T.venues} ORDER BY id ASC LIMIT 50;`);
  if (r.rowCount === 0) return "Brak lokali.";
  return r.rows.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`).join("\n");
}

// Create invite code (requires inviter has invites>0)
async function createInviteCodeFor(userId) {
  return await dbTx(async (client) => {
    const fox = await getFoxByUserId(userId, client);
    if (!fox) throw new Error("NO_FOX");
    if (Number(fox.invites || 0) <= 0) throw new Error("NO_INVITES");

    const code = genInviteCode();
    await client.query(`INSERT INTO ${T.inviteCodes}(code, created_by_user_id) VALUES ($1,$2);`, [code, userId]);
    // reserve 1 invite immediately (so code is guaranteed)
    await client.query(`UPDATE ${T.foxes} SET invites = invites - 1 WHERE user_id=$1;`, [userId]);
    return code;
  });
}

async function useInviteCode(code, newUserId) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return { ok: false, reason: "EMPTY" };

  return await dbTx(async (client) => {
    const r = await client.query(`SELECT * FROM ${T.inviteCodes} WHERE code=$1 LIMIT 1;`, [c]);
    if (r.rowCount === 0) return { ok: false, reason: "NOT_FOUND" };
    const ic = r.rows[0];
    if (ic.used_at) return { ok: false, reason: "USED" };

    await client.query(`UPDATE ${T.inviteCodes} SET used_by_user_id=$2, used_at=NOW() WHERE code=$1;`, [c, newUserId]);
    return { ok: true, invitedBy: Number(ic.created_by_user_id) };
  });
}

// Bot: /start — registration flow or profile
if (bot) {
  bot.start(async (ctx) => {
    const userId = Number(ctx.from?.id);
    const username = ctx.from?.username ? `@${ctx.from.username}` : "";

    try {
      const fox = await getFoxByUserId(userId);
      if (fox) {
        const total = await totalCountedVisits(userId);
        await ctx.reply(
          `🦊 Твій профіль\n` +
            `Rating: ${fox.rating}\n` +
            `Invites: ${fox.invites}\n` +
            `Місто: ${fox.city}\n` +
            `Counted visits всього: ${total}\n\n` +
            `Команди:\n` +
            `/checkin <venue_id>\n` +
            `/venues\n` +
            `/panel\n` +
            `/invite (створити invite-код)\n` +
            `/register_venue (реєстрація закладу через Fox)\n`
        );
        return;
      }

      // Start registration
      setState(userId, "CITY", { username });
      await ctx.reply(
        `🦊 Реєстрація Fox (крок 1/4)\n` +
          `Напиши своє місто текстом (наприклад: Warsaw).\n\n` +
          `Порада: можна просто написати "Warsaw".`
      );
    } catch (e) {
      await ctx.reply("Błąd. Spróbuj ponownie.");
    }
  });

  // /venues
  bot.command("venues", async (ctx) => {
    try {
      const t = await listVenuesText();
      await ctx.reply(`🏪 Lokale\n\n${t}\n\nCheck-in: /checkin 1`);
    } catch (_) {
      await ctx.reply("Błąd /venues.");
    }
  });

  // /panel
  bot.command("panel", async (ctx) => {
    await ctx.reply(`Panel lokalu: ${panelUrl()}`);
  });

  // /invite — generate invite code (spends 1 invite immediately)
  bot.command("invite", async (ctx) => {
    const userId = Number(ctx.from?.id);
    const fox = await getFoxByUserId(userId);
    if (!fox) return ctx.reply("Спочатку зареєструйся через /start.");
    try {
      const code = await createInviteCodeFor(userId);
      await ctx.reply(`✅ Invite-код створено:\n${code}\n\nПередай його новому Fox (він введе на реєстрації).`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === "NO_INVITES") return ctx.reply("Немає інвайтів. Зароби інвайти: кожні 5 counted visits → +1.");
      return ctx.reply("Не вдалося створити інвайт.");
    }
  });

  // /checkin <venue_id>
  bot.command("checkin", async (ctx) => {
    try {
      const msg = String(ctx.message?.text || "");
      const parts = msg.split(" ").map((s) => s.trim()).filter(Boolean);
      const venueId = Number(parts[1]);

      if (!Number.isFinite(venueId) || venueId <= 0) {
        return ctx.reply("Użycie: /checkin <venue_id>\nPrzykład: /checkin 1");
      }

      const v = await getVenueById(venueId);
      if (!v) return ctx.reply("Nie znaleziono lokalu.");

      const userId = Number(ctx.from?.id);
      const username = ctx.from?.username ? `@${ctx.from.username}` : "";

      // Fox must be registered (Phase 1). If not, ask to /start.
      const fox = await getFoxByUserId(userId);
      if (!fox) return ctx.reply("Спочатку зареєструйся через /start.");

      await upsertFoxBasic(userId, username);

      // 1/day rule
      const { exists, dayKey } = await countedExistsToday(userId, venueId);
      if (exists) {
        const xy = await getXY(userId, venueId);
        return ctx.reply(
          `DZIŚ JUŻ BYŁO ✅\n` +
            `Lokal: ${v.name}\n` +
            `Dzień (Warszawa): ${dayKey}\n` +
            `X/Y: ${xy.X}/${xy.Y}\n` +
            `Wróć jutro po 00:00 (Warszawa).\n` +
            `Panel: ${panelUrl()}`
        );
      }

      const otp = genOTP6();
      const expires = addMinutes(new Date(), OTP_TTL_MIN);

      await db(
        `INSERT INTO ${T.checkins}(venue_id, user_id, otp, expires_at) VALUES ($1,$2,$3,$4);`,
        [venueId, userId, otp, expires.toISOString()]
      );

      await ctx.reply(
        `✅ Check-in utworzony (${OTP_TTL_MIN} min)\n\n` +
          `🏪 ${v.name}\n` +
          `🔐 OTP: ${otp}\n\n` +
          `Personel potwierdza w Panelu.\n` +
          `Panel: ${panelUrl()}`
      );
    } catch (e) {
      console.error("checkin error:", e?.message || e);
      await ctx.reply("Błąd check-in");
    }
  });

  // STEP 3: registration dialogue handler (text messages)
  bot.on("text", async (ctx) => {
    const userId = Number(ctx.from?.id);
    const text = String(ctx.message?.text || "").trim();
    const state = getState(userId);
    if (!state) return;

    try {
      if (state.step === "CITY") {
        const city = text || "Warsaw";
        state.data.city = city;
        setState(userId, "NICK", state.data);
        return ctx.reply(`🦊 Реєстрація Fox (крок 2/4)\nВведи нікнейм (або напиши "auto" щоб взяти з Telegram).`);
      }

      if (state.step === "NICK") {
        let nick = text;
        if (nick.toLowerCase() === "auto") {
          nick = ctx.from?.username ? `@${ctx.from.username}` : "";
        }
        if (!nick) nick = ctx.from?.username ? `@${ctx.from.username}` : `Fox_${userId}`;

        state.data.nick = nick;
        setState(userId, "INVITE", state.data);
        return ctx.reply(
          `🦊 Реєстрація Fox (крок 3/4)\n` +
            `Якщо маєш invite-код — введи його.\n` +
            `Якщо НЕ маєш — напиши "skip".`
        );
      }

      if (state.step === "INVITE") {
        const invite = text;
        if (invite.toLowerCase() === "skip") {
          state.data.inviteCode = "";
          setState(userId, "CONFIRM", state.data);
          return ctx.reply(
            `🦊 Реєстрація Fox (крок 4/4)\n` +
              `Місто: ${state.data.city}\n` +
              `Нік: ${state.data.nick}\n` +
              `Invite: (нема)\n\n` +
              `Напиши "confirm" щоб завершити.`
          );
        }

        // try use invite code
        const used = await useInviteCode(invite, userId);
        if (!used.ok) {
          return ctx.reply(`❌ Невірний invite-код або вже використаний. Спробуй ще раз, або напиши "skip".`);
        }

        state.data.inviteCode = invite.toUpperCase();
        state.data.invitedBy = used.invitedBy;

        setState(userId, "CONFIRM", state.data);
        return ctx.reply(
          `🦊 Реєстрація Fox (крок 4/4)\n` +
            `Місто: ${state.data.city}\n` +
            `Нік: ${state.data.nick}\n` +
            `Invite: ${state.data.inviteCode}\n\n` +
            `Напиши "confirm" щоб завершити.`
        );
      }

      if (state.step === "CONFIRM") {
        if (text.toLowerCase() !== "confirm") return;

        const username = state.data.nick || (ctx.from?.username ? `@${ctx.from.username}` : "");

        await dbTx(async (client) => {
          // register fox if not exists
          const invitedBy = state.data.invitedBy ? Number(state.data.invitedBy) : null;
          const out = await ensureFoxRegistered(userId, username, state.data.city || "Warsaw", invitedBy, client);
          // If already existed, do not re-add starting invites/rating.
          // Ensure username/city updated if user re-runs flow in future (but they won't, since /start shows profile)
          if (out.created) {
            // nothing else; inviter rating already handled in ensureFoxRegistered via invitedBy.
          } else {
            await client.query(`UPDATE ${T.foxes} SET username=$2, city=$3 WHERE user_id=$1;`, [
              userId,
              username,
              state.data.city || "Warsaw",
            ]);
          }
        });

        clearState(userId);

        const fox = await getFoxByUserId(userId);
        const total = await totalCountedVisits(userId);
        return ctx.reply(
          `✅ Fox зареєстровано!\n\n` +
            `🦊 Твій профіль\n` +
            `Rating: ${fox.rating}\n` +
            `Invites: ${fox.invites}\n` +
            `Місто: ${fox.city}\n` +
            `Counted visits всього: ${total}\n\n` +
            `Команди:\n` +
            `/checkin <venue_id>\n` +
            `/venues\n` +
            `/invite\n` +
            `/register_venue\n`
        );
      }
    } catch (e) {
      clearState(userId);
      await ctx.reply("Błąd rejestracji. Zrób /start jeszcze raz.");
    }
  });

  // STEP 4: Venue registration via bot (invite-only)
  // Command: /register_venue — starts a simple flow: name → address → city → pin → fox nick (auto from requester) → submit pending
  const venueReg = new Map(); // userId -> {step,data,ts}

  function vrSet(userId, step, data = {}) {
    venueReg.set(String(userId), { step, data, ts: Date.now() });
  }
  function vrGet(userId) {
    const s = venueReg.get(String(userId));
    if (!s) return null;
    if (Date.now() - s.ts > 30 * 60000) {
      venueReg.delete(String(userId));
      return null;
    }
    return s;
  }
  function vrClear(userId) {
    venueReg.delete(String(userId));
  }

  bot.command("register_venue", async (ctx) => {
    const userId = Number(ctx.from?.id);
    const fox = await getFoxByUserId(userId);
    if (!fox) return ctx.reply("Спочатку зареєструйся як Fox через /start.");

    vrSet(userId, "NAME", {});
    await ctx.reply("🏪 Реєстрація закладу (крок 1/5)\nВведи назву закладу:");
  });

  bot.on("text", async (ctx) => {
    // venue registration flow uses same 'text' hook; ignore if fox reg is active
    const userId = Number(ctx.from?.id);
    if (getState(userId)) return; // fox registration has priority

    const s = vrGet(userId);
    if (!s) return;

    const text = String(ctx.message?.text || "").trim();
    try {
      if (s.step === "NAME") {
        s.data.name = text;
        vrSet(userId, "ADDRESS", s.data);
        return ctx.reply("🏪 (крок 2/5)\nВведи адресу (текстом):");
      }
      if (s.step === "ADDRESS") {
        s.data.address = text;
        vrSet(userId, "CITY", s.data);
        return ctx.reply("🏪 (крок 3/5)\nВведи місто закладу (наприклад: Warsaw):");
      }
      if (s.step === "CITY") {
        s.data.city = text || "Warsaw";
        vrSet(userId, "PIN", s.data);
        return ctx.reply("🏪 (крок 4/5)\nВведи PIN для персоналу (6 цифр):");
      }
      if (s.step === "PIN") {
        const pin = text;
        if (!/^\d{6}$/.test(pin)) return ctx.reply("PIN має бути рівно 6 цифр. Спробуй ще раз:");
        s.data.pin = pin;
        // Fox nick must be provided (LOCKED). We use Fox username by default and also ask to confirm/edit.
        const foxNickDefault = ctx.from?.username ? `@${ctx.from.username}` : "";
        s.data.foxNick = foxNickDefault || "UNKNOWN";
        vrSet(userId, "FOX_NICK", s.data);
        return ctx.reply(
          `🏪 (крок 5/5)\nВведи нікнейм Fox який запросив (обов’язково).\n` +
            `Порада: твій нік як Fox: ${foxNickDefault || "(нема username в Telegram)"}\n\n` +
            `Введи нік (наприклад: @Ol_lysak):`
        );
      }
      if (s.step === "FOX_NICK") {
        const foxNick = text;
        if (!foxNick) return ctx.reply("Нік Fox обов’язковий. Введи ще раз:");
        s.data.foxNick = foxNick;

        // Create pending request. Must validate foxNick exists.
        await dbTx(async (client) => {
          const inviter = await findFoxByNick(foxNick, client);
          if (!inviter) throw new Error("FOX_NICK_NOT_FOUND");

          const salt = makePinSalt();
          const hash = makePinHash(String(s.data.pin), salt);

          await client.query(
            `INSERT INTO ${T.venueRequests}(name,address,city,pin_salt,pin_hash,fox_nick,invited_by_user_id,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending');`,
            [s.data.name, s.data.address, s.data.city, salt, hash, foxNick, Number(inviter.user_id)]
          );
        });

        vrClear(userId);
        return ctx.reply(
          `✅ Заявку на заклад подано (pending).\n` +
            `Заклад: ${s.data.name}\n` +
            `Місто: ${s.data.city}\n` +
            `Fox: ${s.data.foxNick}\n\n` +
            `Чекаємо approve адміна.`
        );
      }
    } catch (e) {
      const msg = String(e?.message || e);
      vrClear(userId);
      if (msg === "FOX_NICK_NOT_FOUND") {
        return ctx.reply("❌ Нік Fox не знайдено в системі. Перевір правильність і спробуй /register_venue ще раз.");
      }
      return ctx.reply("❌ Помилка реєстрації закладу. Спробуй /register_venue ще раз.");
    }
  });

  // Admin helper in bot (optional)
  bot.command("admin_pending", async (ctx) => {
    if (!ADMIN_USER_ID || String(ctx.from?.id) !== ADMIN_USER_ID) return;
    const r = await db(`SELECT COUNT(*)::int AS c FROM ${T.venueRequests} WHERE status='pending';`);
    const c = r.rows[0]?.c || 0;
    const url = ADMIN_WEB_KEY ? `${PUBLIC_URL}/admin/venues?key=${encodeURIComponent(ADMIN_WEB_KEY)}` : "(ADMIN_WEB_KEY not set)";
    await ctx.reply(`Pending venues: ${c}\nAdmin URL: ${url}`);
  });

  // Webhook setup (no extra packages)
  if (WEBHOOK_SECRET && PUBLIC_URL) {
    const path = `/${WEBHOOK_SECRET.replace(/^\//, "")}`;
    bot.telegram
      .setWebhook(`${PUBLIC_URL}${path}`)
      .then(() => console.log("✅ Webhook set:", path))
      .catch((e) => console.error("Webhook set error:", e?.message || e));
    app.use(bot.webhookCallback(path));
    console.log("✅ Webhook path ready:", path);
  } else {
    console.log("ℹ️ WEBHOOK_SECRET or PUBLIC_URL missing — webhook not set here.");
  }
}

// -------------------- BOOT --------------------
(async () => {
  try {
    await ensureSchema();
    console.log("✅ DB schema OK.");
  } catch (e) {
    console.error("❌ ensureSchema error:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log(`✅ Server listening on ${PORT}`);
  });
})();
