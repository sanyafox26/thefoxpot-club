"use strict";

/**
 * THE FOXPOT CLUB — Phase 1 MVP — server.js V27.0
 *
 * NOWOŚCI V27:
 *  ✅ /leave + /settings → "🚪 Opuść klub" — soft delete (is_deleted, deleted_at)
 *  ✅ Potwierdzenie przed usunięciem (inline keyboard)
 *  ✅ Reset: rating, invites, streak, achievements, visits — founder_number zachowany
 *  ✅ Powrót z nowym zaproszeniem: /start <KOD> → czyste konto, founder status
 *  ✅ is_deleted guard na wszystkich komendach bota
 *  ✅ Admin notification przy opuszczeniu klubu
 *
 * V24 (bez zmін):
 *  ✅ POST /api/venue/scan     — Fox сканує QR локалу (+1 rating, +5 invites, obligation 24h)
 *  ✅ POST /api/venue/checkin  — Fox робить check-in в локалі (виконує obligation)
 *  ✅ Штрафна система: 1-й раз -10 + блок до ранку, 2-й -20, 3-й -50 + бан 7 днів
 *  ✅ Лічильник порушень скидається після відбуття 7-денного бану
 *  ✅ CRON кожні 15 хв — автоштраф за прострочені obligations
 *
 * V23 (без змін):
 *  ✅ POST /api/invite/create
 *  ✅ GET  /api/invite/stats
 *
 * V20 (без змін):
 *  ✅ GET  /webapp               — serwuje webapp.html (Telegram Mini App)
 *  ✅ GET  /api/profile          — profil użytkownika (auth Telegram initData)
 *  ✅ GET  /api/venues           — lista aktywnych lokali
 *  ✅ POST /api/checkin          — generuje OTP dla check-inu
 *  ✅ POST /api/spin             — daily spin
 *  ✅ GET  /api/achievements     — lista osiągnięć użytkownika
 *  ✅ GET  /api/top              — leaderboard Top 10 + moja pozycja
 */

const express  = require("express");
const crypto   = require("crypto");
const path     = require("path");
const { Telegraf, Markup } = require("telegraf");
const { Pool }             = require("pg");
const { setupSupport, migrateSupport } = require("./fox_support");
const jwt      = require("jsonwebtoken");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "12mb" }));
// CORS for Capacitor + COOP for popups (Google Maps)
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin === "capacitor://localhost" || origin === "http://localhost" || origin === "https://localhost") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Telegram-Init-Data, X-Pwa-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ═══════════════════════════════════════════════════════════════
   ENV
═══════════════════════════════════════════════════════════════ */
const BOT_TOKEN      = (process.env.BOT_TOKEN      || "").trim();
const DATABASE_URL   = (process.env.DATABASE_URL   || "").trim();
const PUBLIC_URL     = (process.env.PUBLIC_URL     || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || require("crypto").randomBytes(32).toString("hex")).trim();
const COOKIE_SECRET  = (process.env.COOKIE_SECRET  || require("crypto").randomBytes(32).toString("hex")).trim();
const ADMIN_SECRET   = (process.env.ADMIN_SECRET   || "").trim();
const JWT_SECRET     = (process.env.JWT_SECRET     || COOKIE_SECRET).trim();
const ADMIN_TG_ID    = (process.env.ADMIN_TG_ID    || "").trim();
const PORT           = process.env.PORT || 8080;

if (!DATABASE_URL)            console.error("❌ DATABASE_URL missing");
if (!BOT_TOKEN)               console.error("❌ BOT_TOKEN missing");
if (!process.env.WEBHOOK_SECRET) console.warn("⚠️  WEBHOOK_SECRET not set — using random (sessions reset on restart)");
if (!process.env.COOKIE_SECRET)  console.warn("⚠️  COOKIE_SECRET not set — using random (sessions reset on restart)");
if (!ADMIN_SECRET)            console.warn("⚠️  ADMIN_SECRET not set — admin panel disabled");
if (!PUBLIC_URL)   console.error("❌ PUBLIC_URL missing");

/* ═══════════════════════════════════════════════════════════════
   DB
═══════════════════════════════════════════════════════════════ */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function dbNow() {
  const r = await pool.query("SELECT NOW() AS now");
  return r.rows[0].now;
}

/* ═══════════════════════════════════════════════════════════════
   РАЙОНИ ВАРШАВИ
═══════════════════════════════════════════════════════════════ */
// ── Cities & Districts for registration ──
const CITY_DISTRICTS = {
  "Warszawa": ["Śródmieście","Praga-Południe","Mokotów","Żoliborz","Wola","Ursynów","Praga-Północ","Targówek","Bielany","Bemowo","Białołęka","Wilanów"],
  "Kraków": ["Stare Miasto","Grzegórzki","Prądnik Czerwony","Prądnik Biały","Krowodrza","Bronowice","Zwierzyniec","Dębniki","Podgórze","Nowa Huta"],
  "Wrocław": ["Stare Miasto","Śródmieście","Krzyki","Fabryczna","Psie Pole"],
  "Gdańsk": ["Śródmieście","Wrzeszcz","Oliwa","Przymorze","Zaspa","Chełm","Letnica"],
  "Poznań": ["Stare Miasto","Nowe Miasto","Grunwald","Jeżyce","Wilda"],
  "Łódź": ["Śródmieście","Bałuty","Górna","Polesie","Widzew"],
};
const BIG_CITIES = Object.keys(CITY_DISTRICTS);
const POLISH_CITIES = [
  ...BIG_CITIES,
  "Szczecin","Bydgoszcz","Lublin","Białystok","Katowice","Gdynia",
  "Częstochowa","Radom","Toruń","Kielce","Rzeszów","Olsztyn",
  "Opole","Gliwice","Zabrze","Sosnowiec","Zielona Góra","Bytom",
];
// Backward compat
const WARSAW_DISTRICTS = [...CITY_DISTRICTS["Warszawa"], "Inna dzielnica"];
const ALL_DISTRICTS = Object.values(CITY_DISTRICTS).flat();

function getAllValidDistricts() {
  return [...ALL_DISTRICTS, "Inna dzielnica"];
}

async function sendCityKeyboard(ctx, mode = "register") {
  const text = mode === "register"
    ? `🏙️ W jakim mieście mieszkasz?\n\n(Pomaga nam znaleźć lokale w pobliżu)`
    : `🏙️ Wybierz swoje miasto:`;
  const buttons = [];
  // Big cities first (2 per row)
  for (let i = 0; i < BIG_CITIES.length; i += 2) {
    const row = [Markup.button.callback(BIG_CITIES[i], `city_${BIG_CITIES[i]}`)];
    if (BIG_CITIES[i + 1]) row.push(Markup.button.callback(BIG_CITIES[i + 1], `city_${BIG_CITIES[i + 1]}`));
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("📋 Inne miasto →", "city_other_list")]);
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

async function sendOtherCitiesKeyboard(ctx) {
  const others = POLISH_CITIES.filter(c => !BIG_CITIES.includes(c));
  const buttons = [];
  for (let i = 0; i < others.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3 && i + j < others.length; j++) {
      row.push(Markup.button.callback(others[i + j], `city_${others[i + j]}`));
    }
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("⬅️ Wróć", "city_back_main")]);
  await ctx.editMessageText("🏙️ Wybierz swoje miasto:", Markup.inlineKeyboard(buttons));
}

async function sendDistrictKeyboard(ctx, city, mode = "register") {
  const districts = CITY_DISTRICTS[city];
  if (!districts) return; // no districts for this city
  const text = mode === "register"
    ? `📍 Ostatni krok!\n\nW jakiej dzielnicy (${city}) mieszkasz?`
    : `📍 Wybierz dzielnicę (${city}):`;
  const buttons = [];
  for (let i = 0; i < districts.length; i += 2) {
    const row = [Markup.button.callback(districts[i], `district_${districts[i]}`)];
    if (districts[i + 1]) row.push(Markup.button.callback(districts[i + 1], `district_${districts[i + 1]}`));
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("🗺️ Inna dzielnica", `district_Inna dzielnica`)]);
  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */
function warsawDayKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const y   = parts.find(p => p.type === "year").value;
  const m   = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${day}`;
}

function warsawWeekBounds(d = new Date()) {
  const wDay = warsawDayKey(d);
  const dt   = new Date(`${wDay}T00:00:00+01:00`);
  const dow  = dt.getDay();
  const diff = (dow === 0 ? -6 : 1 - dow);
  const mon  = new Date(dt.getTime() + diff * 86400000);
  const sun  = new Date(mon.getTime() + 6  * 86400000);
  const fmt  = x => x.toISOString().slice(0, 10);
  return { mon: fmt(mon), sun: fmt(sun) };
}

function warsawHour() {
  return Number(new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Warsaw", hour: "numeric", hour12: false,
  }).format(new Date()));
}

function otp6() {
  return String(crypto.randomInt(100000, 999999));
}

function genInviteCode(len = 10) {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alpha[bytes[i] % alpha.length];
  return out;
}

function pinHash(pin, salt) {
  return crypto.createHmac("sha256", salt).update(pin).digest("hex");
}

// ── Telegram user data helper — handles all edge cases ──
// TG users may have: username (optional), first_name (required by TG), last_name (optional)
// Some users have NO username, some have unicode names, some have empty strings
function tgDisplayName(from) {
  if (!from) return "fox";
  // Prefer username, then first_name + last_name, then first_name, then user id
  if (from.username) return from.username;
  const first = (from.first_name || "").trim();
  const last = (from.last_name || "").trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  return String(from.id || "fox");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isAdmin(userId) {
  return ADMIN_TG_ID && String(userId) === String(ADMIN_TG_ID);
}

function generateSlug(name) {
  return String(name || "").toLowerCase()
    .replace(/ą/g,'a').replace(/ć/g,'c').replace(/ę/g,'e').replace(/ł/g,'l')
    .replace(/ń/g,'n').replace(/ó/g,'o').replace(/ś/g,'s').replace(/ź/g,'z').replace(/ż/g,'z')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
const CONSENT_VERSION = "1.1";

async function hasConsent(userId) {
  const r = await pool.query(
    `SELECT consent_version FROM fp1_foxes WHERE user_id=$1 AND consent_at IS NOT NULL LIMIT 1`,
    [userId]
  );
  return r.rowCount > 0 && r.rows[0].consent_version === CONSENT_VERSION;
}

async function saveConsent(userId) {
  await pool.query(
    `UPDATE fp1_foxes SET consent_at=NOW(), consent_version=$1 WHERE user_id=$2`,
    [CONSENT_VERSION, userId]
  );
}

/* ═══════════════════════════════════════════════════════════════
   SCHEMA HELPERS
═══════════════════════════════════════════════════════════════ */
async function hasColumn(table, col) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, col]
  );
  return r.rowCount > 0;
}

async function ensureColumn(table, col, ddl) {
  if (!(await hasColumn(table, col)))
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

async function ensureIndex(sql) {
  try { await pool.query(sql); }
  catch (e) { console.warn("INDEX_WARN", e?.message || e); }
}

/* ═══════════════════════════════════════════════════════════════
   MIGRATIONS
═══════════════════════════════════════════════════════════════ */
let COUNTED_DAY_COL = "war_day";

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venues (
      id           BIGSERIAL PRIMARY KEY,
      name         TEXT        NOT NULL DEFAULT 'Venue',
      city         TEXT        NOT NULL DEFAULT 'Warszawa',
      address      TEXT        NOT NULL DEFAULT '',
      pin_hash     TEXT,
      pin_salt     TEXT,
      status       TEXT        NOT NULL DEFAULT 'active',
      approved     BOOLEAN     NOT NULL DEFAULT FALSE,
      fox_nick     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_foxes (
      id                   BIGSERIAL PRIMARY KEY,
      user_id              BIGINT UNIQUE,
      username             TEXT,
      rating               INT         NOT NULL DEFAULT 1,
      invites              INT         NOT NULL DEFAULT 3,
      invites_from_5visits INT         NOT NULL DEFAULT 0,
      city                 TEXT        NOT NULL DEFAULT 'Warszawa',
      invited_by_user_id   BIGINT,
      invite_code_used     TEXT,
      invite_used_at       TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Ensure username is nullable (fix legacy NOT NULL constraint)
  await pool.query(`ALTER TABLE fp1_foxes ALTER COLUMN username DROP NOT NULL`).catch(()=>{});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_checkins (
      id                    BIGSERIAL PRIMARY KEY,
      venue_id              BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      user_id               BIGINT,
      otp                   TEXT        NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at            TIMESTAMPTZ NOT NULL,
      confirmed_at          TIMESTAMPTZ,
      confirmed_by_venue_id BIGINT,
      war_day               TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_counted_visits (
      id         BIGSERIAL PRIMARY KEY,
      venue_id   BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      user_id    BIGINT NOT NULL,
      war_day    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_invites (
      id                 BIGSERIAL PRIMARY KEY,
      code               TEXT UNIQUE NOT NULL,
      max_uses           INT  NOT NULL DEFAULT 1,
      uses               INT  NOT NULL DEFAULT 0,
      created_by_user_id BIGINT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_invite_uses (
      id              BIGSERIAL PRIMARY KEY,
      invite_id       BIGINT NOT NULL REFERENCES fp1_invites(id) ON DELETE CASCADE,
      used_by_user_id BIGINT NOT NULL,
      used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(invite_id, used_by_user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venue_status (
      id         BIGSERIAL PRIMARY KEY,
      venue_id   BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      type       TEXT        NOT NULL,
      reason     TEXT,
      starts_at  TIMESTAMPTZ NOT NULL,
      ends_at    TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_stamps (
      id         BIGSERIAL PRIMARY KEY,
      venue_id   BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      user_id    BIGINT NOT NULL,
      emoji      TEXT   NOT NULL DEFAULT '⭐',
      delta      INT    NOT NULL DEFAULT 1,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_achievements (
      id               BIGSERIAL PRIMARY KEY,
      user_id          BIGINT      NOT NULL,
      achievement_code TEXT        NOT NULL,
      unlocked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, achievement_code)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_daily_spins (
      id             BIGSERIAL PRIMARY KEY,
      user_id        BIGINT    NOT NULL,
      spin_date      DATE      NOT NULL,
      prize_type     TEXT      NOT NULL,
      prize_value    INT       NOT NULL DEFAULT 0,
      prize_label    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, spin_date)
    )
  `);

   /* ── V26: таблиця receipts (чеки) ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_receipts (
      id               BIGSERIAL PRIMARY KEY,
      user_id          BIGINT      NOT NULL,
      venue_id         BIGINT      NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      checkin_id       BIGINT,
      amount_paid      NUMERIC(10,2) NOT NULL,
      amount_original  NUMERIC(10,2) NOT NULL,
      discount_percent NUMERIC(5,2)  NOT NULL DEFAULT 0,
      discount_saved   NUMERIC(10,2) NOT NULL DEFAULT 0,
      bonuses_awarded  BOOLEAN     NOT NULL DEFAULT FALSE,
      war_day          TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_receipts_user  ON fp1_receipts(user_id)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_receipts_venue ON fp1_receipts(venue_id)`);
   await ensureColumn("fp1_receipts", "category", "TEXT");
  /* ── V24: нова таблиця venue_obligations ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venue_obligations (
      id                 BIGSERIAL PRIMARY KEY,
      user_id            BIGINT      NOT NULL,
      venue_id           VARCHAR(50) NOT NULL,
      venue_name         VARCHAR(200),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at         TIMESTAMPTZ NOT NULL,
      fulfilled          BOOLEAN     NOT NULL DEFAULT FALSE,
      fulfilled_at       TIMESTAMPTZ,
      violation_count    INT         NOT NULL DEFAULT 0,
      banned_until       TIMESTAMPTZ,
      last_violation_at  TIMESTAMPTZ
    )
  `);
  await pool.query(`UPDATE fp1_venues SET discount_percent=10 WHERE discount_percent!=10`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_venue_obligations_expires ON fp1_venue_obligations(expires_at)`);

  await ensureColumn("fp1_checkins",       "war_day",               "TEXT");
  await ensureColumn("fp1_checkins",       "visitor_phone",         "TEXT");
  await ensureColumn("fp1_checkins",       "visitor_lat",           "NUMERIC(10,7)");
  await ensureColumn("fp1_checkins",       "visitor_lng",           "NUMERIC(10,7)");
  await ensureColumn("fp1_checkins",       "distance_km",           "NUMERIC(10,3)");
  await ensureColumn("fp1_checkins",       "suspicious_distance",   "BOOLEAN NOT NULL DEFAULT FALSE");

  // Proximity promo fields for venues
  await ensureColumn("fp1_venues",          "promo_radius",          "INT");
  await ensureColumn("fp1_venues",          "promo_message",         "TEXT");
  await ensureColumn("fp1_venues",          "promo_active",          "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_venues",          "promo_start",           "TIMESTAMPTZ");
  await ensureColumn("fp1_venues",          "promo_end",             "TIMESTAMPTZ");
  await ensureColumn("fp1_counted_visits", "war_day",               "TEXT");
  await ensureColumn("fp1_counted_visits", "visitor_phone",         "TEXT");
  await ensureColumn("fp1_counted_visits", "is_credited",           "BOOLEAN NOT NULL DEFAULT TRUE");
  await ensureColumn("fp1_foxes",          "invites_from_5visits",  "INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes",          "invited_by_user_id",    "BIGINT");
  await ensureColumn("fp1_foxes",          "invite_code_used",      "TEXT");
  await ensureColumn("fp1_foxes",          "invite_used_at",        "TIMESTAMPTZ");
  await ensureColumn("fp1_venues",         "address",               "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("fp1_venues",         "fox_nick",              "TEXT");
  await ensureColumn("fp1_venues",         "approved",              "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_venues",         "ref_code",              "TEXT UNIQUE");
  await ensureColumn("fp1_venues",         "staff_bonus_enabled",   "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_venues",         "staff_bonus_amount",    "INT NOT NULL DEFAULT 2");
  await ensureColumn("fp1_venues",         "is_trial",              "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_venues",         "monthly_visit_limit",   "INT NOT NULL DEFAULT 20");
  await ensureColumn("fp1_venues",         "discount_percent",      "NUMERIC(5,2) NOT NULL DEFAULT 10");
  await ensureColumn("fp1_venues",         "lat",                   "NUMERIC(10,7)");
  await ensureColumn("fp1_venues",         "lng",                   "NUMERIC(10,7)");
   await ensureColumn("fp1_venues",         "description",           "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("fp1_venues",         "recommended",           "TEXT NOT NULL DEFAULT ''");
   await ensureColumn("fp1_venues",         "venue_type",            "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("fp1_venues",         "cuisine",               "TEXT NOT NULL DEFAULT ''");
   await ensureColumn("fp1_venues",         "tags",                  "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("fp1_venues",         "pioneer_number",        "INT");
  // Venue social links
  await ensureColumn("fp1_venues",         "instagram_url",         "TEXT");
  await ensureColumn("fp1_venues",         "facebook_url",          "TEXT");
  await ensureColumn("fp1_venues",         "tiktok_url",            "TEXT");
  await ensureColumn("fp1_venues",         "youtube_url",           "TEXT");
  await ensureColumn("fp1_venues",         "website_url",           "TEXT");
  await ensureColumn("fp1_venues",         "menu_file_url",         "TEXT");
  await ensureColumn("fp1_venues",         "phone",                 "TEXT");
  // Venue menu files (multiple images/PDFs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venue_menu_files (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migrate legacy single menu_file_url to new table
  try {
    const legacy = await pool.query(`SELECT id, menu_file_url FROM fp1_venues WHERE menu_file_url IS NOT NULL AND menu_file_url != ''`);
    for (const v of legacy.rows) {
      const exists = await pool.query(`SELECT 1 FROM fp1_venue_menu_files WHERE venue_id=$1 AND url=$2`, [v.id, v.menu_file_url]);
      if (exists.rowCount === 0) await pool.query(`INSERT INTO fp1_venue_menu_files(venue_id,url,sort_order) VALUES($1,$2,0)`, [v.id, v.menu_file_url]);
    }
  } catch(e) { console.warn("Menu file migration:", e.message); }
  // Venue slug for public page
  await ensureColumn("fp1_venues",         "slug",                  "TEXT");
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_venues_slug ON fp1_venues(slug) WHERE slug IS NOT NULL`).catch(()=>{});
  // V29: Venue photos (multiple URLs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venue_photos (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(venue_id, sort_order)
    )
  `);
  // Venue menu items
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_menu_items (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'main',
      price NUMERIC(8,2),
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureColumn("fp1_menu_items",     "photo_url",             "TEXT");

  // Reviews (private — visible only to venue in panel)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_reviews (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      venue_id INT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      checkin_id BIGINT UNIQUE,
      rating INT CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
      text TEXT,
      venue_reply TEXT,
      venue_reply_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_reviews_venue ON fp1_reviews(venue_id, created_at DESC)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_reviews_user ON fp1_reviews(user_id)`);
  // Migration: make rating nullable (was NOT NULL)
  await pool.query(`ALTER TABLE fp1_reviews ALTER COLUMN rating DROP NOT NULL`).catch(()=>{});
  await pool.query(`ALTER TABLE fp1_reviews DROP CONSTRAINT IF EXISTS fp1_reviews_rating_check`).catch(()=>{});
  await pool.query(`ALTER TABLE fp1_reviews ADD CONSTRAINT fp1_reviews_rating_check CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5))`).catch(()=>{});

  // Promotions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_promotions (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      package TEXT NOT NULL DEFAULT 'start',
      promo_text TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_promo_orders (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      package TEXT NOT NULL DEFAULT 'start',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await ensureColumn("fp1_receipts",       "reason",                "TEXT");

  // ── V27: NEW CHOICE SYSTEM (parallel to old category/reason) ──
  await ensureColumn("fp1_receipts",       "choice_source",         "TEXT");      // top3 / category / custom
  await ensureColumn("fp1_receipts",       "agg_category",          "TEXT");      // main/snack/dessert/drink/alcohol/other
  await ensureColumn("fp1_receipts",       "dish_id",               "INT");       // FK to venue_dishes if top3
  await ensureColumn("fp1_receipts",       "custom_text",           "TEXT");      // user-typed dish name
  await ensureColumn("fp1_receipts",       "bonus_awarded_base",    "BOOLEAN DEFAULT FALSE");
  await ensureColumn("fp1_receipts",       "bonus_awarded_mini",    "BOOLEAN DEFAULT FALSE");

  // data_contributions counter on foxes
  await ensureColumn("fp1_foxes",          "data_contributions",    "INT NOT NULL DEFAULT 0");

  // venue_dishes table (Top 3 per venue)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venue_dishes (
      id          BIGSERIAL PRIMARY KEY,
      venue_id    BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL,
      sort_order  INT NOT NULL,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(venue_id, sort_order)
    )
  `);
  // Venue nominations & votes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_nominations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Warszawa',
      address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'voting',
      vote_threshold INT NOT NULL DEFAULT 50,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureColumn("fp1_nominations", "place_id", "TEXT");
  await ensureColumn("fp1_nomination_votes", "voter_phone", "TEXT");
  await ensureColumn("fp1_city_votes", "voter_phone", "TEXT");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_nomination_votes (
      id SERIAL PRIMARY KEY,
      nomination_id INT NOT NULL REFERENCES fp1_nominations(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      tg_user_id TEXT,
      is_member BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(nomination_id, fingerprint)
    )
  `);
  // City nominations & votes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_city_nominations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL DEFAULT 'Polska',
      status TEXT NOT NULL DEFAULT 'voting',
      vote_threshold INT NOT NULL DEFAULT 1000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_city_votes (
      id SERIAL PRIMARY KEY,
      city_nomination_id INT NOT NULL REFERENCES fp1_city_nominations(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      tg_user_id TEXT,
      is_member BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(city_nomination_id, fingerprint)
    )
  `);

  // Individual Fox discounts per venue
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_fox_discounts (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      user_id TEXT NOT NULL,
      discount_percent NUMERIC(5,2) NOT NULL,
      is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(venue_id, user_id)
    )
  `);

  await ensureColumn("fp1_foxes",          "referred_by_venue",     "BIGINT");
  await ensureColumn("fp1_foxes",          "founder_number",        "INT");
  await ensureColumn("fp1_foxes",          "founder_registered_at", "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "district",              "TEXT");
  await ensureColumn("fp1_foxes",          "country",               "TEXT NOT NULL DEFAULT 'Polska'");
  await ensureColumn("fp1_foxes",          "streak_current",        "INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes",          "streak_last_date",      "DATE");
  await ensureColumn("fp1_foxes",          "streak_freeze_available","INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes",          "streak_best",           "INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_daily_spins",    "prize_label",           "TEXT");
   await ensureColumn("fp1_foxes",          "consent_at",            "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "consent_version",       "TEXT");
  await ensureColumn("fp1_foxes",          "is_demo",               "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "demo_venue_id",         "INT");
  await ensureColumn("fp1_foxes",          "demo_expires_at",       "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "no_show_count",         "INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes",          "banned_until",          "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "deleted_at",            "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "is_deleted",            "BOOLEAN NOT NULL DEFAULT FALSE");

  // V28: Trial system (venue-based, 60min, no penalty)
  await ensureColumn("fp1_foxes",          "trial_active",          "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "trial_origin_venue_id", "INT");
  await ensureColumn("fp1_foxes",          "trial_expires_at",      "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "trial_blocked_venue_id","INT");
  await ensureColumn("fp1_foxes",          "trial_blocked_until",   "TIMESTAMPTZ");
  await ensureColumn("fp1_foxes",          "join_source",           "TEXT");

  // Social subscriptions bonus
  await ensureColumn("fp1_foxes",          "sub_instagram",         "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "sub_tiktok",            "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "sub_youtube",           "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "sub_telegram",          "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "sub_facebook",          "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_foxes",          "sub_bonus_claimed",     "BOOLEAN NOT NULL DEFAULT FALSE");

  // Fix fp1_invite_uses if created with wrong schema
  await ensureColumn("fp1_invite_uses",    "invite_id",             "BIGINT");
  await ensureColumn("fp1_invite_uses",    "used_by_user_id",       "BIGINT");
  await ensureColumn("fp1_invite_uses",    "code",                  "TEXT");
  await ensureColumn("fp1_invite_uses",    "used_by_tg",            "BIGINT");
  await ensureColumn("fp1_foxes",          "phone",                 "TEXT");
  // Drop NOT NULL constraints that may exist from old schema
  await pool.query(`ALTER TABLE fp1_invite_uses ALTER COLUMN code DROP NOT NULL`).catch(()=>{});
  await pool.query(`ALTER TABLE fp1_invite_uses ALTER COLUMN used_by_tg DROP NOT NULL`).catch(()=>{});
  await pool.query(`ALTER TABLE fp1_invite_uses ALTER COLUMN invite_id DROP NOT NULL`).catch(()=>{});
  await pool.query(`ALTER TABLE fp1_invite_uses ALTER COLUMN used_by_user_id DROP NOT NULL`).catch(()=>{});

  // V27: Reservations table for trial venues
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_reservations (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      venue_id INT NOT NULL REFERENCES fp1_venues(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      expired BOOLEAN NOT NULL DEFAULT FALSE,
      penalty_applied BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_reservations_venue ON fp1_reservations(venue_id, expires_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_reservations_user ON fp1_reservations(user_id, expires_at)`);

  try { await pool.query(`ALTER TABLE fp1_invites ALTER COLUMN created_by_fox_id DROP NOT NULL`); } catch {}
  try { await pool.query(`ALTER TABLE fp1_invites ALTER COLUMN created_by_tg DROP NOT NULL`); } catch {}

  await ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_foxes_founder_number ON fp1_foxes(founder_number) WHERE founder_number IS NOT NULL`);
  await ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_venues_pioneer_number ON fp1_venues(pioneer_number) WHERE pioneer_number IS NOT NULL`);

  // Auto-assign pioneer_number (safe — skips if already assigned)
  try {
    const hasPioneers = await pool.query(`SELECT 1 FROM fp1_venues WHERE pioneer_number IS NOT NULL LIMIT 1`);
    if (hasPioneers.rowCount === 0) {
      await pool.query(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
          FROM fp1_venues
          WHERE pioneer_number IS NULL AND approved=TRUE AND LOWER(city) IN ('warsaw','warszawa')
        )
        UPDATE fp1_venues SET pioneer_number=ranked.rn
        FROM ranked WHERE fp1_venues.id=ranked.id AND ranked.rn <= 50
      `);
    }
  } catch(e) { console.warn("pioneer_number migration skipped:", e.message); }
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_achievements_user   ON fp1_achievements(user_id)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_otp        ON fp1_checkins(otp)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_expires    ON fp1_checkins(expires_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_invites_code        ON fp1_invites(code)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_venue_status_vid    ON fp1_venue_status(venue_id, type, ends_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_stamps_venue_user   ON fp1_stamps(venue_id, user_id)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_daily_spins_user    ON fp1_daily_spins(user_id, spin_date)`);

  const venuesNoCode = await pool.query(`SELECT id FROM fp1_venues WHERE ref_code IS NULL`);
  for (const v of venuesNoCode.rows) {
    let code = null;
    for (let i = 0; i < 20; i++) {
      const c = genInviteCode(8);
      const ex = await pool.query(`SELECT 1 FROM fp1_venues WHERE ref_code=$1 LIMIT 1`, [c]);
      if (ex.rowCount === 0) { code = c; break; }
    }
    if (code) await pool.query(`UPDATE fp1_venues SET ref_code=$1 WHERE id=$2`, [code, v.id]);
  }

  await pool.query(`UPDATE fp1_counted_visits SET war_day=to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD') WHERE war_day IS NULL`);
  await pool.query(`UPDATE fp1_checkins SET war_day=to_char(created_at AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD') WHERE war_day IS NULL`);

  // Assign founder numbers only if none exist yet (one-time, safe)
  try {
    const hasFounders = await pool.query(`SELECT 1 FROM fp1_foxes WHERE founder_number IS NOT NULL LIMIT 1`);
    if (hasFounders.rowCount === 0) {
      await pool.query(`
        WITH ranked AS (
          SELECT user_id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
          FROM fp1_foxes
          WHERE founder_number IS NULL AND ($1 = '' OR user_id != $1::bigint)
        )
        UPDATE fp1_foxes SET founder_number=ranked.rn, founder_registered_at=NOW()
        FROM ranked WHERE fp1_foxes.user_id=ranked.user_id AND ranked.rn <= 1000
      `, [ADMIN_TG_ID || ""]);
    }
  } catch(e) { console.warn("founder_number migration skipped:", e.message); }

  const hasDayKey = await hasColumn("fp1_counted_visits", "day_key");
  COUNTED_DAY_COL = hasDayKey ? "day_key" : "war_day";
  console.log("✅ COUNTED_DAY_COL =", COUNTED_DAY_COL);

  const vc = await pool.query("SELECT COUNT(*)::int AS c FROM fp1_venues");
  if (vc.rows[0].c === 0) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = pinHash("123456", salt);
    // Demo venues with real Warsaw coordinates
    const demoVenues = [
     { name: "Fox Pub Centrum",    city: "Warszawa", address: "ul. Nowy Świat 22",       lat: 52.2319, lng: 21.0222, is_trial: false, discount: 10 },
      { name: "Złoty Kebab",        city: "Warszawa", address: "ul. Chmielna 15",          lat: 52.2297, lng: 21.0122, is_trial: true,  discount: 10 },
      { name: "Craft Beer Corner",  city: "Warszawa", address: "ul. Mokotowska 48",        lat: 52.2180, lng: 21.0180, is_trial: false, discount: 10 },
      { name: "Praga Street Food",  city: "Warszawa", address: "ul. Ząbkowska 6",          lat: 52.2506, lng: 21.0444, is_trial: true,  discount: 10 },
      { name: "Bistro Żoliborz",    city: "Warszawa", address: "pl. Wilsona 2",            lat: 52.2680, lng: 20.9934, is_trial: false, discount: 10 },
    ];
    for (const v of demoVenues) {
      await pool.query(
       `INSERT INTO fp1_venues(name,city,address,pin_hash,pin_salt,approved,lat,lng,is_trial,monthly_visit_limit,discount_percent)
         VALUES($1,$2,$3,$4,$5,TRUE,$6,$7,$8,20,$9)`,
        [v.name, v.city, v.address, hash, salt, v.lat, v.lng, v.is_trial, v.discount || 10]
      );
    }
    console.log("✅ Demo venues seeded with coordinates");
  } else {
    // Update existing venues with coords if missing
    await pool.query(`UPDATE fp1_venues SET lat=52.2319, lng=21.0222 WHERE name='Test Kebab #1' AND lat IS NULL`);
    await pool.query(`UPDATE fp1_venues SET lat=52.2350, lng=21.0200 WHERE name='Test Pizza #2' AND lat IS NULL`);
    await pool.query(`UPDATE fp1_venues SET lat=52.2180, lng=21.0050 WHERE name='Test Bar #3'   AND lat IS NULL`);
  }

  // PWA sessions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_pwa_sessions (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT UNIQUE NOT NULL,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // OTP codes for phone auth
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_otp_codes (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fp1_otp_phone ON fp1_otp_codes(phone, created_at DESC)`).catch(()=>{});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_foxes_phone ON fp1_foxes(phone) WHERE phone IS NOT NULL`).catch(()=>{});

  // Leaderboard cache table — pre-computed results updated by CRON
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_leaderboard_cache (
      key          TEXT PRIMARY KEY,
      user_id      TEXT,
      username     TEXT,
      venue_id     INT,
      venue_name   TEXT,
      value        NUMERIC(10,2) NOT NULL DEFAULT 0,
      period       TEXT,
      achieved_at  TIMESTAMPTZ,
      extra        JSONB,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureColumn("fp1_leaderboard_cache", "period", "TEXT");
  await ensureColumn("fp1_leaderboard_cache", "achieved_at", "TIMESTAMPTZ");

  await migrateSupport(pool);
  // Auto-generate slugs for venues without one
  try {
    const noSlug = await pool.query(`SELECT id, name FROM fp1_venues WHERE slug IS NULL`);
    for (const v of noSlug.rows) {
      let slug = generateSlug(v.name);
      const dup = await pool.query(`SELECT 1 FROM fp1_venues WHERE slug=$1 AND id!=$2`, [slug, v.id]);
      if (dup.rowCount > 0) slug = slug + '-' + v.id;
      await pool.query(`UPDATE fp1_venues SET slug=$1 WHERE id=$2`, [slug, v.id]);
    }
  } catch(e) { console.warn("Slug migration:", e.message); }

  // Set Praga Street Food coordinates to Szwedzka 30, Warszawa (for geo testing)
  await pool.query(`UPDATE fp1_venues SET lat=52.2563, lng=21.0412, address='Szwedzka 30, Warszawa' WHERE name='Praga Street Food' AND (lat IS NULL OR lat != 52.2563)`).catch(()=>{});

  // One-time fix: Proba3 got inflated rating from old INSERT (rating=1 base instead of 0)
  await pool.query(`UPDATE fp1_foxes SET rating=21 WHERE username='Proba3' AND rating=24`).catch(()=>{});

  console.log("✅ Migrations OK (V26 + Support)");
}

/* ═══════════════════════════════════════════════════════════════
   DAILY SPIN
═══════════════════════════════════════════════════════════════ */
const SPIN_PRIZES = [
  { type: "rating", value: 2,  label: "+2 punkty",       emoji: "🎁", weight: 60 },
  { type: "rating", value: 5,  label: "+5 punktów",      emoji: "⭐", weight: 20 },
  { type: "invite", value: 1,  label: "+1 zaproszenie",  emoji: "🎟️", weight: 10 },
  { type: "rating", value: 15, label: "+15 punktów",     emoji: "💎", weight: 7  },
  { type: "freeze", value: 1,  label: "+1 Freeze streak",emoji: "❄️", weight: 3  },
];

const SPIN_EMOJIS = ["🦊", "💎", "⭐", "🎁", "👑", "🔥", "🎟️", "❄️", "🏆", "🎰"];

function pickPrize() {
  const total = SPIN_PRIZES.reduce((s, p) => s + p.weight, 0);
  let rand = crypto.randomInt(0, total);
  for (const prize of SPIN_PRIZES) {
    rand -= prize.weight;
    if (rand < 0) return prize;
  }
  return SPIN_PRIZES[0];
}

function randomSpinRow() {
  const row = [];
  for (let i = 0; i < 5; i++) {
    row.push(SPIN_EMOJIS[crypto.randomInt(0, SPIN_EMOJIS.length)]);
  }
  return row.join(" ");
}

async function hasSpunToday(userId) {
  const today = warsawDayKey();
  const r = await pool.query(
    `SELECT * FROM fp1_daily_spins WHERE user_id=$1 AND spin_date=$2 LIMIT 1`,
    [String(userId), today]
  );
  return r.rows[0] || null;
}

async function recordSpin(userId, prize) {
  const today = warsawDayKey();
  await pool.query(
    `INSERT INTO fp1_daily_spins(user_id, spin_date, prize_type, prize_value, prize_label)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [String(userId), today, prize.type, prize.value, prize.label]
  );
}

async function applyPrize(userId, prize) {
  if (prize.type === "rating") {
    await pool.query(`UPDATE fp1_foxes SET rating=rating+$1 WHERE user_id=$2`, [prize.value, String(userId)]);
  } else if (prize.type === "invite") {
    await pool.query(`UPDATE fp1_foxes SET invites=invites+$1 WHERE user_id=$2`, [prize.value, String(userId)]);
  } else if (prize.type === "freeze") {
    await pool.query(`UPDATE fp1_foxes SET streak_freeze_available=streak_freeze_available+$1 WHERE user_id=$2`, [prize.value, String(userId)]);
  }
}

async function doSpin(ctx) {
  const userId = String(ctx.from.id);
  const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
  if (fox.rowCount === 0 || fox.rows[0].is_deleted)
    return ctx.reply("❌ Najpierw zarejestruj się przez /start <KOD>");

  const alreadySpun = await hasSpunToday(userId);
  if (alreadySpun) {
    const now      = new Date();
    const tomorrow = new Date(`${warsawDayKey(new Date(now.getTime() + 86400000))}T00:00:00+01:00`);
    const diffMs   = tomorrow - now;
    const hours    = Math.floor(diffMs / 3600000);
    const mins     = Math.floor((diffMs % 3600000) / 60000);
    return ctx.reply(
      `🎰 Już kręciłeś dziś!\n\nNagroda: ${alreadySpun.prize_label}\n\nNastępny spin za: ${hours}h ${mins}min`
    );
  }

  const prize = pickPrize();
  const msg = await ctx.reply(`🎰 Kręcimy...\n\n[ ${randomSpinRow()} ]`);
  const msgId = msg.message_id;
  const chatId = ctx.chat.id;

  await sleep(700);
  try { await ctx.telegram.editMessageText(chatId, msgId, null, `🎰 Kręcimy...\n\n[ ${randomSpinRow()} ]`); } catch {}
  await sleep(700);
  try { await ctx.telegram.editMessageText(chatId, msgId, null, `🎰 Kręcimy...\n\n[ ${randomSpinRow()} ]`); } catch {}
  await sleep(800);
  try { await ctx.telegram.editMessageText(chatId, msgId, null, `🎰 Kręcimy...\n\n[ ${randomSpinRow()} ]`); } catch {}
  await sleep(900);

  await recordSpin(userId, prize);
  await applyPrize(userId, prize);

  const updated = await pool.query(`SELECT rating, invites, streak_freeze_available FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
  const f = updated.rows[0];

  const finalRow = `${prize.emoji} ${prize.emoji} ${prize.emoji}`;
  let finalMsg = `🎰 WYNIK!\n\n[ ${finalRow} ]\n\n`;
  finalMsg += `${prize.emoji} ${prize.label}!\n\n`;
  finalMsg += `📊 Twoje statystyki:\n`;
  finalMsg += `⭐ Punkty: ${f.rating}\n`;
  finalMsg += `🎟️ Zaproszenia: ${f.invites}\n`;
  finalMsg += `❄️ Freeze: ${f.streak_freeze_available}\n\n`;
  finalMsg += `Następny spin jutro!`;

  try {
    await ctx.telegram.editMessageText(chatId, msgId, null, finalMsg);
  } catch {
    await ctx.reply(finalMsg);
  }

  await checkAchievements(userId);
}

/* ═══════════════════════════════════════════════════════════════
   STREAK
═══════════════════════════════════════════════════════════════ */
async function updateStreak(userId) {
  const today = warsawDayKey();
  const fox = await pool.query(
    `SELECT streak_current, streak_last_date, streak_freeze_available, streak_best
     FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [String(userId)]
  );
  if (fox.rowCount === 0) return null;
  const f    = fox.rows[0];
  const last = f.streak_last_date ? String(f.streak_last_date).slice(0, 10) : null;
  if (last === today) return null;

  const yesterday = warsawDayKey(new Date(Date.now() - 86400000));
  let newStreak   = f.streak_current || 0;
  let newFreeze   = f.streak_freeze_available || 0;
  let bonusRating = 0;
  let bonusFreeze = 0;

  if (last === yesterday)      newStreak += 1;
  else if (last) {
    if (newFreeze > 0) { newStreak += 1; newFreeze -= 1; }
    else newStreak = 1;
  } else newStreak = 1;

  if (newStreak < 7)                                bonusRating = 1;
  if (newStreak % 7 === 0 && newStreak % 30 !== 0) bonusRating = 5;
  if (newStreak === 30)  { bonusRating = 15; bonusFreeze = 1; }
  if (newStreak === 90)  bonusRating = 50;
  if (newStreak === 365) bonusRating = 200;

  const newBest = Math.max(newStreak, f.streak_best || 0);
  await pool.query(
    `UPDATE fp1_foxes SET streak_current=$1, streak_last_date=$2,
     streak_freeze_available=$3, streak_best=$4, rating=rating+$5 WHERE user_id=$6`,
    [newStreak, today, newFreeze + bonusFreeze, newBest, bonusRating, String(userId)]
  );
  return { newStreak, bonusRating, bonusFreeze };
}

/* ═══════════════════════════════════════════════════════════════
   OSIĄGNIĘCIA
═══════════════════════════════════════════════════════════════ */
const ACHIEVEMENTS = {
  explorer_1:   { label: "Pierwszy krok",    emoji: "🐾", rating: 5,   check: (s) => s.venues >= 1   },
  explorer_10:  { label: "Turysta",          emoji: "🗺️", rating: 10,  check: (s) => s.venues >= 10  },
  explorer_30:  { label: "Podróżnik",        emoji: "✈️", rating: 30,  check: (s) => s.venues >= 30  },
  explorer_100: { label: "Legenda miejsc",   emoji: "🌍", rating: 100, check: (s) => s.venues >= 100 },
  social_1:     { label: "Przyjaciel",       emoji: "🤝", rating: 5,   check: (s) => s.invites_sent >= 1   },
  social_10:    { label: "Rekruter",         emoji: "📣", rating: 50,  check: (s) => s.invites_sent >= 10  },
  social_50:    { label: "Ambasador",        emoji: "⭐", rating: 200, check: (s) => s.invites_sent >= 50  },
  social_100:   { label: "Legenda",          emoji: "👑", rating: 500, check: (s) => s.invites_sent >= 100 },
  streak_7:     { label: "7 dni z rzędu",    emoji: "🔥", rating: 10,  check: (s) => s.streak_best >= 7   },
  streak_30:    { label: "30 dni z rzędu",   emoji: "💪", rating: 50,  check: (s) => s.streak_best >= 30  },
  streak_90:    { label: "90 dni z rzędu",   emoji: "🏅", rating: 150, check: (s) => s.streak_best >= 90  },
  streak_365:   { label: "365 dni!",         emoji: "🏆", rating: 500, check: (s) => s.streak_best >= 365 },
  visits_1:     { label: "Pierwsza wizyta",  emoji: "🎉", rating: 5,   check: (s) => s.total_visits >= 1   },
  visits_10:    { label: "10 wizyt",         emoji: "🥈", rating: 10,  check: (s) => s.total_visits >= 10  },
  visits_50:    { label: "50 wizyt",         emoji: "🥇", rating: 50,  check: (s) => s.total_visits >= 50  },
  visits_100:   { label: "100 wizyt",        emoji: "💫", rating: 100, check: (s) => s.total_visits >= 100 },
  pioneer:      { label: "Pionier",          emoji: "🚀", rating: 20,  check: (s) => s.is_pioneer  },
  night_fox:    { label: "Nocny Fox",        emoji: "🌙", rating: 10,  check: (s) => s.is_night    },
  morning_fox:  { label: "Poranny Fox",      emoji: "🌅", rating: 10,  check: (s) => s.is_morning  },
  vip_diamond:  { label: "VIP Diamond",      emoji: "💎", rating: 200, check: (s) => s.total_visits >= 301 },
  spin_10:      { label: "10 spinów",        emoji: "🎰", rating: 15,  check: (s) => s.total_spins >= 10  },
  spin_30:      { label: "30 spinów",        emoji: "🎰", rating: 50,  check: (s) => s.total_spins >= 30  },
  // Data & Insight achievements
  data_10:      { label: "Insight Fox",      emoji: "🧠", rating: 10,  check: (s) => s.data_contributions >= 10  },
  data_25:      { label: "Local Analyst",    emoji: "🧠", rating: 25,  check: (s) => s.data_contributions >= 25  },
  data_50:      { label: "Data Alpha",       emoji: "🧠", rating: 50,  check: (s) => s.data_contributions >= 50  },
  data_150:     { label: "Master of Insight",emoji: "🧠", rating: 150, check: (s) => s.data_contributions >= 150 },
};

async function checkAchievements(userId, extraStats = {}) {
  const uid = String(userId);
  const fox = await pool.query(`SELECT streak_best, data_contributions FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [uid]);
  if (fox.rowCount === 0) return [];

  const totalVisits  = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [uid]);
  const uniqueVenues = await pool.query(`SELECT COUNT(DISTINCT venue_id)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [uid]);
  const invitesSent  = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_invites WHERE created_by_user_id=$1`, [uid]);
  const totalSpins   = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_daily_spins WHERE user_id=$1`, [uid]);

  const stats = {
    total_visits: totalVisits.rows[0].c,
    venues:       uniqueVenues.rows[0].c,
    invites_sent: invitesSent.rows[0].c,
    streak_best:  fox.rows[0].streak_best || 0,
    total_spins:  totalSpins.rows[0].c,
    data_contributions: fox.rows[0].data_contributions || 0,
    is_pioneer:   extraStats.is_pioneer || false,
    is_night:     extraStats.is_night   || false,
    is_morning:   extraStats.is_morning || false,
  };

  const existing = await pool.query(`SELECT achievement_code FROM fp1_achievements WHERE user_id=$1`, [uid]);
  const have = new Set(existing.rows.map(r => r.achievement_code));

  const newOnes = [];
  let totalBonus = 0;

  for (const [code, ach] of Object.entries(ACHIEVEMENTS)) {
    if (have.has(code)) continue;
    if (!ach.check(stats)) continue;
    try {
      await pool.query(`INSERT INTO fp1_achievements(user_id, achievement_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [uid, code]);
      totalBonus += ach.rating;
      newOnes.push({ code, ...ach });
    } catch (e) { console.error("ACH_INSERT_ERR", e?.message); }
  }

  if (totalBonus > 0)
    await pool.query(`UPDATE fp1_foxes SET rating=rating+$1 WHERE user_id=$2`, [totalBonus, uid]);

  return newOnes;
}

function formatAchievements(newOnes) {
  if (!newOnes || newOnes.length === 0) return "";
  const lines = newOnes.map(a => `${a.emoji} ${a.label} +${a.rating} pkt`);
  return `\n\n🏆 Nowe osiągnięcia!\n${lines.join("\n")}`;
}

/* ═══════════════════════════════════════════════════════════════
   PIONIER FOX
═══════════════════════════════════════════════════════════════ */
const FOUNDER_LIMIT = 1000;

async function assignFounderNumber(userId) {
  if (isAdmin(userId)) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const check = await client.query(`SELECT founder_number FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [String(userId)]);
    if (check.rows[0]?.founder_number) { await client.query("ROLLBACK"); return check.rows[0].founder_number; }
    const nextNum = await client.query(`
      SELECT n AS num FROM generate_series(1,$1) AS n
      WHERE n NOT IN (SELECT founder_number FROM fp1_foxes WHERE founder_number IS NOT NULL)
      ORDER BY n ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `, [FOUNDER_LIMIT]);
    if (nextNum.rowCount === 0) { await client.query("ROLLBACK"); return null; }
    const num = nextNum.rows[0].num;
    await client.query(`UPDATE fp1_foxes SET founder_number=$1, founder_registered_at=NOW() WHERE user_id=$2`, [num, String(userId)]);
    await client.query("COMMIT");
    return num;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("FOUNDER_ERR", e?.message || e);
    return null;
  } finally { client.release(); }
}

function founderBadge(num) { return num ? `👑 Pionier Fox #${num}` : ""; }

async function founderSpotsLeft() {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE founder_number IS NOT NULL`);
  return Math.max(0, FOUNDER_LIMIT - r.rows[0].c);
}

/* ═══════════════════════════════════════════════════════════════
   TOP FOX BADGES — P0.2: shared helper
═══════════════════════════════════════════════════════════════ */
const TOP_FOX_COLORS = { year: "#FF8A00", month: "#3B82F6", week: "#22C55E" };
const TOP_FOX_LABELS = { year: "🏆 Top Fox roku", month: "👑 Top Fox miesiąca", week: "🔥 Top Fox tygodnia" };

async function getTopFoxBadges() {
  const warsawNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
  const dow = warsawNow.getDay();
  const weekStart = new Date(warsawNow); weekStart.setDate(weekStart.getDate() - dow); weekStart.setHours(0,0,0,0);
  const monthStart = new Date(warsawNow); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const yearStart = new Date(warsawNow); yearStart.setMonth(0,1); yearStart.setHours(0,0,0,0);

  // Exclude admin from TOP rankings (parameterized)
  const adminExclude = ADMIN_TG_ID ? ` AND user_id != $2` : '';
  const mkParams = (dateStr) => ADMIN_TG_ID ? [dateStr, ADMIN_TG_ID] : [dateStr];
  const [tw, tm, ty] = await Promise.all([
    pool.query(`SELECT user_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE${adminExclude} GROUP BY user_id ORDER BY cnt DESC, MIN(created_at) ASC LIMIT 1`, mkParams(weekStart.toISOString())),
    pool.query(`SELECT user_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE${adminExclude} GROUP BY user_id ORDER BY cnt DESC, MIN(created_at) ASC LIMIT 1`, mkParams(monthStart.toISOString())),
    pool.query(`SELECT user_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE${adminExclude} GROUP BY user_id ORDER BY cnt DESC, MIN(created_at) ASC LIMIT 1`, mkParams(yearStart.toISOString())),
  ]);

  const badges = {};
  const yId = ty.rows[0]?.user_id ? String(ty.rows[0].user_id) : null;
  const mId = tm.rows[0]?.user_id ? String(tm.rows[0].user_id) : null;
  const wId = tw.rows[0]?.user_id ? String(tw.rows[0].user_id) : null;
  if (yId) badges[yId] = "year";
  if (mId && !badges[mId]) badges[mId] = "month";
  if (wId && !badges[wId]) badges[wId] = "week";
  return badges;
}

function topFoxHtml(badge) {
  if (!badge) return "";
  return ` <span style="color:${TOP_FOX_COLORS[badge]};font-weight:700;font-size:12px">${TOP_FOX_LABELS[badge]}</span>`;
}

/* ═══════════════════════════════════════════════════════════════
   SESSION
═══════════════════════════════════════════════════════════════ */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME    = "fp1_panel_session";
const PWA_COOKIE_NAME = "fp1_pwa";
const PWA_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signSession(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const dot = String(token).lastIndexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expSig  = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
  try {
    const sb = Buffer.from(sig), eb = Buffer.from(expSig);
    if (sb.length !== eb.length) return null;
    if (!crypto.timingSafeEqual(sb, eb)) return null;
  } catch { return null; }
  const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!obj?.venue_id || !obj?.exp) return null;
  if (Date.now() > obj.exp) return null;
  return obj;
}

function getCookie(req) {
  const raw = req.headers.cookie || "";
  for (const p of raw.split(";")) {
    const t = p.trim();
    if (t.startsWith(COOKIE_NAME + "=")) return t.slice(COOKIE_NAME.length + 1);
  }
  return null;
}
function setCookie(res, value) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function requirePanelAuth(req, res, next) {
  const sess = verifySession(getCookie(req));
  if (!sess) return res.redirect("/panel");
  req.panel = sess; next();
}
function requireAdminAuth(req, res, next) {
  const sess = verifySession(getCookie(req));
  if (!sess || sess.role !== "admin") return res.redirect("/admin/login");
  req.admin = sess; next();
}

/* ═══════════════════════════════════════════════════════════════
   RATE LIMIT
═══════════════════════════════════════════════════════════════ */
const loginFail = new Map();
function getIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown"; }
function loginRate(ip) { const x = loginFail.get(ip) || { fails:0, until:0 }; return x.until && Date.now() < x.until ? { blocked:true } : { blocked:false }; }
function loginBad(ip) { const x = loginFail.get(ip) || { fails:0, until:0 }; x.fails += 1; if (x.fails >= 5) { x.until = Date.now() + 15*60*1000; x.fails = 0; } loginFail.set(ip, x); }
function loginOk(ip) { loginFail.delete(ip); }

// Generic rate limiter: key → { count, windowStart }
const rateBuckets = new Map();
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now - b.start > windowMs) { rateBuckets.set(key, { count: 1, start: now }); return false; }
  b.count++;
  if (b.count > maxAttempts) return true; // blocked
  return false;
}
// Cleanup stale buckets every 10 min
setInterval(() => { const now = Date.now(); for (const [k, v] of rateBuckets) { if (now - v.start > 30*60*1000) rateBuckets.delete(k); } }, 10*60*1000);

/* ═══════════════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════════════ */
function pageShell(title, body, extraCss = "") {
  return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:#0f1220;color:#fff}
.wrap{max-width:960px;margin:0 auto;padding:16px}
.card{background:#14182b;border:1px solid #2a2f49;border-radius:14px;padding:16px;margin:12px 0}
h1{font-size:18px;margin:0 0 10px}h2{font-size:15px;margin:0 0 8px;opacity:.85}
label{display:block;font-size:12px;opacity:.8;margin:10px 0 5px}
input,select,textarea{width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0b0e19;color:#fff;font-size:14px}
input:focus,select:focus{outline:none;border-color:#6e56ff}
button{padding:10px 16px;border-radius:10px;border:none;background:#6e56ff;color:#fff;font-weight:700;cursor:pointer;font-size:14px}
button:hover{background:#5a44e0}button.danger{background:#8b1a1a}button.outline{background:transparent;border:1px solid #2a2f49;color:#ccc}
.muted{opacity:.6;font-size:12px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
a{color:#c6baff;text-decoration:none}a:hover{text-decoration:underline}
.err{background:#2a0f16;border:1px solid #6b1a2b;border-radius:12px;padding:10px;margin:10px 0;font-size:14px}
.ok{background:#102a1a;border:1px solid #1f6b3a;border-radius:12px;padding:10px;margin:10px 0;font-size:14px}
.warn{background:#2a200a;border:1px solid #6b4a0a;border-radius:12px;padding:10px;margin:10px 0;font-size:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}
.badge-ok{background:#1a4a2a;color:#6fffaa}.badge-warn{background:#3a2a0a;color:#ffcc44}.badge-err{background:#3a0a0a;color:#ff7777}
@media(max-width:600px){.grid2{grid-template-columns:1fr}}${extraCss}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function flash(req) {
  const ok   = req.query.ok   ? `<div class="ok">${escapeHtml(req.query.ok)}</div>`   : "";
  const err  = req.query.err  ? `<div class="err">${escapeHtml(req.query.err)}</div>` : "";
  const warn = req.query.warn ? `<div class="warn">${escapeHtml(req.query.warn)}</div>` : "";
  return ok + err + warn;
}

/* ═══════════════════════════════════════════════════════════════
   CORE DB
═══════════════════════════════════════════════════════════════ */
async function getVenue(venueId) {
  const r = await pool.query(`SELECT * FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
  return r.rows[0] || null;
}

async function upsertFox(ctx) {
  const tgId = String(ctx.from.id);
  const username = tgDisplayName(ctx.from);
  await pool.query(
    `INSERT INTO fp1_foxes(user_id,username,rating,invites,city) VALUES($1,$2,0,0,'Warszawa')
     ON CONFLICT(user_id) DO UPDATE SET username=COALESCE(EXCLUDED.username,fp1_foxes.username)`,
    [tgId, username]
  );
  const r = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [tgId]);
  return r.rows[0];
}

async function hasCountedToday(venueId, userId) {
  const day = warsawDayKey();
  const phone = await resolveVoterPhone(userId);

  // Layer 1: Check counted_visits by user_id OR visitor_phone
  let r;
  if (phone) {
    r = await pool.query(
      `SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND ${COUNTED_DAY_COL}=$2 AND (user_id=$3 OR visitor_phone=$4) LIMIT 1`,
      [venueId, day, String(userId), phone]
    );
  } else {
    r = await pool.query(
      `SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND ${COUNTED_DAY_COL}=$2 AND user_id=$3 LIMIT 1`,
      [venueId, day, String(userId)]
    );
  }
  if (r.rowCount > 0) return true;

  // Layer 2: Check confirmed checkins by visitor_phone (survives account deletion)
  if (phone) {
    const c = await pool.query(
      `SELECT 1 FROM fp1_checkins WHERE venue_id=$1 AND war_day=$2 AND confirmed_at IS NOT NULL AND visitor_phone=$3 LIMIT 1`,
      [venueId, day, phone]
    );
    if (c.rowCount > 0) return true;
  }

  return false;
}

async function countXY(venueId, userId) {
  const x = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND user_id=$2 AND is_credited=TRUE`, [venueId, String(userId)]);
  const y = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`, [venueId]);
  return { X: x.rows[0].c, Y: y.rows[0].c };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function createCheckin(venueId, userId, foxLat, foxLng) {
  const otp = otp6(), now = new Date(), warDay = warsawDayKey(now);
  const expires = new Date(now.getTime() + 10 * 60 * 1000);
  const phoneQ = await pool.query(`SELECT phone FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [String(userId)]);
  const visitorPhone = phoneQ.rows[0]?.phone || null;
  // Calculate distance to venue (soft anti-fraud)
  let distKm = null, suspicious = false;
  if (foxLat && foxLng) {
    const vq = await pool.query(`SELECT lat, lng FROM fp1_venues WHERE id=$1`, [venueId]);
    if (vq.rows[0]?.lat && vq.rows[0]?.lng) {
      distKm = haversineKm(foxLat, foxLng, parseFloat(vq.rows[0].lat), parseFloat(vq.rows[0].lng));
      if (distKm !== null) distKm = parseFloat(distKm.toFixed(3));
      suspicious = distKm !== null && distKm > 5;
    }
  }
  const r = await pool.query(
    `INSERT INTO fp1_checkins(venue_id,user_id,otp,expires_at,war_day,visitor_phone,visitor_lat,visitor_lng,distance_km,suspicious_distance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [venueId, String(userId), otp, expires.toISOString(), warDay, visitorPhone, foxLat||null, foxLng||null, distKm, suspicious]
  );
  return r.rows[0];
}

async function listPending(venueId) {
  const now = await dbNow();
  const r = await pool.query(
    `SELECT c.otp, c.expires_at, c.user_id, f.username, f.rating, f.founder_number,
     (SELECT COUNT(*)::int FROM fp1_counted_visits cv WHERE cv.venue_id=$1 AND cv.user_id=c.user_id AND cv.is_credited=TRUE) AS fox_visits,
     (SELECT COUNT(*)::int FROM fp1_counted_visits cv WHERE cv.venue_id=$1 AND cv.is_credited=TRUE) AS total_visits,
     (SELECT rv.rating FROM fp1_reviews rv WHERE rv.user_id=c.user_id::text AND rv.venue_id=$1 ORDER BY rv.created_at DESC LIMIT 1) AS last_review_rating
     FROM fp1_checkins c LEFT JOIN fp1_foxes f ON f.user_id=c.user_id
     WHERE c.venue_id=$1 AND c.confirmed_at IS NULL AND c.expires_at>$2
     ORDER BY c.created_at DESC LIMIT 20`,
    [venueId, now]
  );
  return r.rows;
}

async function awardInvitesFrom5Visits(userId) {
  const tot = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [String(userId)]);
  const fox = await pool.query(`SELECT invites_from_5visits AS earned FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [String(userId)]);
  const total = tot.rows[0].c, earned = fox.rows[0]?.earned || 0, shouldEarn = Math.floor(total / 5);
  if (shouldEarn > earned) {
    const delta = shouldEarn - earned;
    await pool.query(`UPDATE fp1_foxes SET invites=invites+$1, invites_from_5visits=$2 WHERE user_id=$3`, [delta, shouldEarn, String(userId)]);
    return delta;
  }
  return 0;
}

async function confirmOtp(venueId, otp) {
  const now = await dbNow();
  const pending = await pool.query(
    `SELECT * FROM fp1_checkins WHERE venue_id=$1 AND otp=$2 AND confirmed_at IS NULL AND expires_at>$3 ORDER BY created_at DESC LIMIT 1`,
    [venueId, String(otp), now]
  );
  if (pending.rowCount === 0) return { ok: false, code: "NOT_FOUND" };

  const row = pending.rows[0];
  const userId = String(row.user_id);
  const day = row.war_day || warsawDayKey();

  const debounce = await pool.query(
    `SELECT 1 FROM fp1_checkins WHERE user_id=$1 AND venue_id=$2 AND confirmed_at IS NOT NULL AND confirmed_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
    [userId, venueId]
  );
  if (debounce.rowCount > 0) {
    await pool.query(`UPDATE fp1_checkins SET confirmed_at=NOW() WHERE id=$1`, [row.id]);
    return { ok:true, userId, day, countedAdded:false, debounce:true, inviteAutoAdded:0, isFirstEver:false, newAch:[] };
  }

  // V26: ТІЛЬКИ підтверджуємо check-in. БЕЗ бонусів — вони тепер в POST /api/receipt
  await pool.query(`UPDATE fp1_checkins SET confirmed_at=NOW(), confirmed_by_venue_id=$1 WHERE id=$2`, [venueId, row.id]);
  const already = await hasCountedToday(venueId, userId);
  return { ok:true, userId, day, checkin_id:row.id, countedAdded:false, debounce:false,
    receipt_pending:!already, inviteAutoAdded:0, isFirstEver:false, newAch:[] };
}

/* ═══════════════════════════════════════════════════════════════
   VENUE STATUS
═══════════════════════════════════════════════════════════════ */
async function reserveCountThisMonth(venueId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_venue_status WHERE venue_id=$1 AND type='reserve'
     AND date_trunc('month',starts_at AT TIME ZONE 'Europe/Warsaw')=date_trunc('month',NOW() AT TIME ZONE 'Europe/Warsaw') AND ends_at>NOW()`,
    [venueId]
  );
  return r.rows[0].c;
}

async function limitedCountThisWeek(venueId) {
  const { mon, sun } = warsawWeekBounds();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_venue_status WHERE venue_id=$1 AND type='limited'
     AND (starts_at AT TIME ZONE 'Europe/Warsaw')::date BETWEEN $2::date AND $3::date`,
    [venueId, mon, sun]
  );
  return r.rows[0].c;
}

async function currentVenueStatus(venueId) {
  const r = await pool.query(
    `SELECT * FROM fp1_venue_status WHERE venue_id=$1 AND starts_at<=NOW() AND ends_at>NOW() ORDER BY created_at DESC LIMIT 1`,
    [venueId]
  );
  return r.rows[0] || null;
}

/* ═══════════════════════════════════════════════════════════════
   STAMPS
═══════════════════════════════════════════════════════════════ */
async function stampBalance(venueId, userId) {
  const r = await pool.query(`SELECT COALESCE(SUM(delta),0)::int AS balance FROM fp1_stamps WHERE venue_id=$1 AND user_id=$2`, [venueId, String(userId)]);
  return r.rows[0].balance;
}

async function stampHistory(venueId, userId, limit = 10) {
  const r = await pool.query(`SELECT emoji,delta,note,created_at FROM fp1_stamps WHERE venue_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT $3`, [venueId, String(userId), limit]);
  return r.rows;
}

/* ═══════════════════════════════════════════════════════════════
   INVITES
═══════════════════════════════════════════════════════════════ */
async function redeemInviteCode(userId, codeRaw) {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!code) return { ok:false, reason:"NO_CODE" };
  const inv = await pool.query(`SELECT * FROM fp1_invites WHERE code=$1 LIMIT 1`, [code]);
  if (inv.rowCount === 0) return { ok:false, reason:"NOT_FOUND" };
  const invite = inv.rows[0];

  // Check uses limit
  if (Number(invite.uses) >= Number(invite.max_uses)) return { ok:false, reason:"EXHAUSTED" };

  // Check if already used by this user — try all possible column combos
  try {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='fp1_invite_uses'`
    );
    const colNames = new Set(cols.rows.map(r => r.column_name));

    // Duplicate check
    if (colNames.has('code') && colNames.has('used_by_tg')) {
      const dup = await pool.query(`SELECT 1 FROM fp1_invite_uses WHERE code=$1 AND used_by_tg=$2 LIMIT 1`, [code, String(userId)]);
      if (dup.rowCount > 0) return { ok:false, reason:"ALREADY_USED" };
    } else if (colNames.has('code') && colNames.has('used_by_user_id')) {
      const dup = await pool.query(`SELECT 1 FROM fp1_invite_uses WHERE code=$1 AND used_by_user_id=$2 LIMIT 1`, [code, String(userId)]);
      if (dup.rowCount > 0) return { ok:false, reason:"ALREADY_USED" };
    }

    // Build INSERT dynamically based on actual columns
    const insertCols = [];
    const insertVals = [];
    let pi = 1;
    if (colNames.has('code'))              { insertCols.push('code');              insertVals.push(code); }
    if (colNames.has('used_by_tg'))        { insertCols.push('used_by_tg');        insertVals.push(String(userId)); }
    if (colNames.has('used_by_user_id'))   { insertCols.push('used_by_user_id');   insertVals.push(String(userId)); }
    if (colNames.has('invite_id') && invite.id) { insertCols.push('invite_id'); insertVals.push(invite.id); }

    if (insertCols.length > 0) {
      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(`INSERT INTO fp1_invite_uses(${insertCols.join(',')}) VALUES(${placeholders})`, insertVals);
    }
  } catch(e) {
    console.error("INVITE_USE_ERR", e?.message);
  }

  // Update uses count — try by code if id doesn't work
  try {
    await pool.query(`UPDATE fp1_invites SET uses=uses+1 WHERE code=$1`, [code]);
  } catch(e) {
    console.error("INVITE_USES_UPDATE_ERR", e?.message);
  }

  // Link inviter
  await pool.query(
    `UPDATE fp1_foxes SET invited_by_user_id=COALESCE(invited_by_user_id,$1), invite_code_used=COALESCE(invite_code_used,$2), invite_used_at=COALESCE(invite_used_at,NOW()) WHERE user_id=$3`,
    [invite.created_by_user_id ? String(invite.created_by_user_id) : null, code, String(userId)]
  );
  if (invite.created_by_user_id)
    await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [String(invite.created_by_user_id)]);
  return { ok:true };
}

async function createInviteCode(tgUserId) {
  const userId = String(tgUserId);
  const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
  if (fox.rowCount === 0) return { ok:false, reason:"NO_FOX" };
  if (Number(fox.rows[0].invites) <= 0) return { ok:false, reason:"NO_INVITES" };
  let code = null;
  for (let i = 0; i < 20; i++) {
    const c = genInviteCode(10);
    const ex = await pool.query(`SELECT 1 FROM fp1_invites WHERE code=$1 LIMIT 1`, [c]);
    if (ex.rowCount === 0) { code = c; break; }
  }
  if (!code) return { ok:false, reason:"CODE_GEN_FAIL" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dec = await client.query(`UPDATE fp1_foxes SET invites=invites-1 WHERE user_id=$1 AND invites>0 RETURNING invites`, [userId]);
    if (dec.rowCount === 0) { await client.query("ROLLBACK"); return { ok:false, reason:"NO_INVITES" }; }
    await client.query(`INSERT INTO fp1_invites(code,max_uses,uses,created_by_user_id) VALUES($1,1,0,$2)`, [code, Number(userId)]);
    await client.query("COMMIT");
    return { ok:true, code, invites_left:dec.rows[0].invites };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally { client.release(); }
}

/* ═══════════════════════════════════════════════════════════════
   GROWTH
═══════════════════════════════════════════════════════════════ */
async function countNewFoxThisMonth(venueId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE referred_by_venue=$1 AND date_trunc('month',created_at AT TIME ZONE 'Europe/Warsaw')=date_trunc('month',NOW() AT TIME ZONE 'Europe/Warsaw')`,
    [venueId]
  );
  return r.rows[0].c;
}

async function countNewFoxTotal(venueId) {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE referred_by_venue=$1`, [venueId]);
  return r.rows[0].c;
}

async function getGrowthLeaderboard(limit = 10) {
  const r = await pool.query(
    `SELECT v.id,v.name,v.city,COUNT(f.id)::int AS new_fox FROM fp1_venues v
     LEFT JOIN fp1_foxes f ON f.referred_by_venue=v.id AND date_trunc('month',f.created_at AT TIME ZONE 'Europe/Warsaw')=date_trunc('month',NOW() AT TIME ZONE 'Europe/Warsaw')
     WHERE v.approved=TRUE GROUP BY v.id,v.name,v.city ORDER BY new_fox DESC,v.name ASC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/* ═══════════════════════════════════════════════════════════════
   V20: АВТОРИЗАЦІЯ TELEGRAM WEBAPP
═══════════════════════════════════════════════════════════════ */
function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (expectedHash !== hash) return null;

    const userStr = params.get("user");
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    console.error("TG_AUTH_ERR", e?.message);
    return null;
  }
}

// ── Trial on-demand expiry check ──
async function checkTrialExpiry(userId) {
  const f = await pool.query(
    `SELECT trial_active, trial_origin_venue_id, trial_expires_at FROM fp1_foxes WHERE user_id=$1 LIMIT 1`,
    [userId]
  );
  if (f.rowCount === 0) return;
  const fox = f.rows[0];
  if (fox.trial_active && fox.trial_expires_at && new Date(fox.trial_expires_at) < new Date()) {
    // Expired → block this venue until midnight Warsaw
    const wStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
    const wOffset = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" })).getTime()
                  - new Date(new Date().toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const midnightUtc = new Date(new Date(wStr + "T23:59:59.999").getTime() - wOffset);
    await pool.query(
      `UPDATE fp1_foxes SET trial_active=FALSE, trial_origin_venue_id=NULL, trial_expires_at=NULL,
       trial_blocked_venue_id=$1, trial_blocked_until=$2 WHERE user_id=$3`,
      [fox.trial_origin_venue_id, midnightUtc.toISOString(), userId]
    );
    console.log(`[Trial] Expired user=${userId} venue=${fox.trial_origin_venue_id} blocked until midnight`);
  }
}

// Helper: extract userId from TG initData OR JWT Bearer token
async function resolveUserId(req) {
  // Try TG initData first
  const initData = req.headers["x-telegram-init-data"] || "";
  const tgUser = verifyTelegramInitData(initData);
  if (tgUser) return String(tgUser.id);
  // Try JWT Bearer
  try {
    const authH = req.headers.authorization || "";
    if (authH.startsWith("Bearer ")) {
      const decoded = jwt.verify(authH.slice(7), JWT_SECRET);
      if (decoded.fox_id) {
        const fq = await pool.query(`SELECT user_id FROM fp1_foxes WHERE id=$1 AND is_deleted=FALSE LIMIT 1`, [decoded.fox_id]);
        if (fq.rows.length) return String(fq.rows[0].user_id);
      }
    }
  } catch(_) {}
  return null;
}

async function requireWebAppAuth(req, res, next) {
  // ── 1. Telegram initData ──
  const initData = req.headers["x-telegram-init-data"] || "";
  const user = verifyTelegramInitData(initData);
  if (user) { req.tgUser = user; return next(); }

  // ── 2. PWA cookie (найнадійніший спосіб для iOS Safari) ──
  const rawCookies = req.headers.cookie || "";
  let pwaCookieVal = null;
  for (const p of rawCookies.split(";")) {
    const t = p.trim();
    if (t.startsWith(PWA_COOKIE_NAME + "=")) { pwaCookieVal = t.slice(PWA_COOKIE_NAME.length + 1); break; }
  }
  if (pwaCookieVal) {
    try {
      const result = await pool.query(
        `SELECT tg_id FROM fp1_pwa_sessions WHERE token=$1 AND expires_at > NOW()`,
        [pwaCookieVal]
      );
      if (result.rows.length) {
        req.tgUser = { id: result.rows[0].tg_id };
        return next();
      }
    } catch(e) { console.error("[PWA Cookie Auth]", e.message); }
  }

  // ── 3. PWA token header (fallback) ──
  const pwaToken = req.headers["x-pwa-token"] || "";
  if (pwaToken) {
    try {
      const result = await pool.query(
        `SELECT tg_id FROM fp1_pwa_sessions WHERE token=$1 AND expires_at > NOW()`,
        [pwaToken]
      );
      if (result.rows.length) {
        req.tgUser = { id: result.rows[0].tg_id };
        return next();
      }
    } catch(e) { console.error("[PWA Auth]", e.message); }
  }

  // ── 4. JWT Bearer token (phone auth) ──
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
      if (decoded.fox_id) {
        const foxQ = await pool.query(`SELECT user_id FROM fp1_foxes WHERE id=$1 AND is_deleted=FALSE LIMIT 1`, [decoded.fox_id]);
        if (foxQ.rows.length) {
          req.tgUser = { id: foxQ.rows[0].user_id || decoded.fox_id };
          req.foxJwt = decoded;
          return next();
        }
      }
    } catch(e) { /* invalid/expired token — fall through */ }
  }

  return res.status(401).json({ error: "Unauthorized" });
}

/* ═══════════════════════════════════════════════════════════════
   AUTH — Phone OTP (SMS)
═══════════════════════════════════════════════════════════════ */
app.post("/api/auth/send-otp", express.json(), async (req, res) => {
  try {
    const { phone } = req.body || {};
    // Validate Polish phone: +48 followed by 9 digits
    const cleaned = String(phone || "").replace(/[\s\-()]/g, "");
    if (!/^\+48\d{9}$/.test(cleaned)) {
      return res.status(400).json({ error: "Nieprawidłowy numer telefonu. Format: +48XXXXXXXXX" });
    }

    // Soft rate limit for sending codes:
    // 1) Min 60s between sends
    const lastSend = await pool.query(
      `SELECT created_at FROM fp1_otp_codes WHERE phone=$1 ORDER BY created_at DESC LIMIT 1`, [cleaned]
    );
    if (lastSend.rows.length) {
      const secsSince = (Date.now() - new Date(lastSend.rows[0].created_at).getTime()) / 1000;
      if (secsSince < 60) {
        const wait = Math.ceil(60 - secsSince);
        return res.status(429).json({ error: `Poczekaj ${wait}s przed ponownym wysłaniem kodu.` });
      }
    }
    // 2) Max 3 codes per 15 min
    const recent15 = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM fp1_otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '15 minutes'`, [cleaned]
    );
    if (recent15.rows[0].cnt >= 3) {
      return res.status(429).json({ error: "Za dużo kodów. Poczekaj 15 minut." });
    }
    // 3) Max 8 codes per hour (hard spam block)
    const recent1h = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM fp1_otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [cleaned]
    );
    if (recent1h.rows[0].cnt >= 8) {
      return res.status(429).json({ error: "Za dużo prób. Spróbuj ponownie za godzinę." });
    }

    // Generate 6-digit code
    // TODO: remove hardcoded OTP, use random + Twilio
    const code = "123456";
    await pool.query(
      `INSERT INTO fp1_otp_codes(phone, code) VALUES($1, $2)`,
      [cleaned, code]
    );

    // TODO: Twilio integration — send SMS
    // For now: return code in response for testing
    console.log(`[OTP] ${cleaned} → ${code}`);

    res.json({ ok: true, phone: cleaned, _debug_code: code });
  } catch(e) {
    console.error("SEND_OTP_ERR", e.message);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

app.post("/api/auth/verify-otp", express.json(), async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    const cleaned = String(phone || "").replace(/[\s\-()]/g, "");
    if (!/^\+48\d{9}$/.test(cleaned) || !code) {
      return res.status(400).json({ error: "Nieprawidłowe dane" });
    }

    // Check if phone is blocked (5+ failed attempts → 30 min block)
    const blockQ = await pool.query(
      `SELECT attempts, created_at FROM fp1_otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '30 minutes' AND attempts >= 5 ORDER BY created_at DESC LIMIT 1`,
      [cleaned]
    );
    if (blockQ.rows.length) {
      const unblockAt = new Date(blockQ.rows[0].created_at);
      unblockAt.setMinutes(unblockAt.getMinutes() + 30);
      const minsLeft = Math.ceil((unblockAt - Date.now()) / 60000);
      return res.status(429).json({ error: `Zbyt wiele błędnych prób. Numer zablokowany na ${minsLeft} min.` });
    }

    // Find valid OTP: not used, < 5 min old, < 5 attempts
    const otpQ = await pool.query(
      `SELECT id, code, attempts FROM fp1_otp_codes
       WHERE phone=$1 AND used=FALSE AND created_at > NOW() - INTERVAL '5 minutes' AND attempts < 5
       ORDER BY created_at DESC LIMIT 1`,
      [cleaned]
    );

    if (!otpQ.rows.length) {
      return res.status(400).json({ error: "Kod wygasł lub nie istnieje. Wyślij nowy." });
    }

    const otp = otpQ.rows[0];

    if (otp.code !== String(code).trim()) {
      // Wrong code — increment attempts
      await pool.query(`UPDATE fp1_otp_codes SET attempts=attempts+1 WHERE id=$1`, [otp.id]);
      const left = 4 - otp.attempts;
      return res.status(400).json({ error: `Nieprawidłowy kod. Pozostało prób: ${left}` });
    }

    // Mark OTP as used
    await pool.query(`UPDATE fp1_otp_codes SET used=TRUE WHERE id=$1`, [otp.id]);

    // Find or create Fox
    let foxQ = await pool.query(`SELECT id, user_id, username, city FROM fp1_foxes WHERE phone=$1 AND is_deleted=FALSE LIMIT 1`, [cleaned]);
    let isNew = false;
    let foxId;

    if (foxQ.rows.length) {
      foxId = foxQ.rows[0].id;
    } else {
      // Check if deleted fox with this phone exists (re-registration after Opuść klub)
      const deletedQ = await pool.query(`SELECT id, user_id, banned_until, deleted_at FROM fp1_foxes WHERE phone=$1 AND is_deleted=TRUE LIMIT 1`, [cleaned]);
      if (deletedQ.rows.length) {
        const df = deletedQ.rows[0];
        // If banned, reject
        if (df.banned_until && new Date(df.banned_until) > new Date()) {
          return res.status(403).json({ error: "Konto zablokowane do " + new Date(df.banned_until).toLocaleDateString("pl") });
        }
        // 24h cooldown after account deletion
        if (df.deleted_at) {
          const cooldownEnd = new Date(df.deleted_at);
          cooldownEnd.setHours(cooldownEnd.getHours() + 24);
          if (cooldownEnd > new Date()) {
            const msLeft = cooldownEnd - new Date();
            const h = Math.floor(msLeft / 3600000);
            const m = Math.ceil((msLeft % 3600000) / 60000);
            const timeStr = h > 0 ? `${h}h ${m}min` : `${m} min`;
            return res.status(429).json({ error: `Możesz ponownie dołączyć za ${timeStr}.` });
          }
        }
        // Re-activate: reset ALL stats to zero, keep founder_number
        const pseudoId = -Date.now();
        await pool.query(`
          UPDATE fp1_foxes SET
            is_deleted = FALSE, deleted_at = NULL,
            user_id = $1, username = NULL,
            rating = 0, invites = 0,
            streak_current = 0, streak_best = 0, streak_last_date = NULL,
            streak_freeze_available = 0, city = 'Warszawa', district = NULL,
            consent_at = NULL, consent_version = NULL,
            sub_instagram = FALSE, sub_tiktok = FALSE, sub_youtube = FALSE,
            sub_telegram = FALSE, sub_facebook = FALSE, sub_bonus_claimed = FALSE,
            invited_by_user_id = NULL, invite_code_used = NULL, invite_used_at = NULL
          WHERE id = $2
        `, [pseudoId, df.id]);
        // Clean achievements and spins (visits kept for anti-cheat)
        await pool.query(`DELETE FROM fp1_achievements WHERE user_id = $1`, [String(df.user_id)]);
        await pool.query(`DELETE FROM fp1_daily_spins WHERE user_id = $1`, [String(df.user_id)]);
        foxId = df.id;
        isNew = true;
      } else {
        // Create new Fox with phone (no tg_id)
        // Use negative timestamp as pseudo user_id to avoid conflicts with TG ids
        const pseudoId = -Date.now();
        const ins = await pool.query(
          `INSERT INTO fp1_foxes(user_id, phone, rating, invites, city) VALUES($1, $2, 0, 0, 'Warszawa') RETURNING id`,
          [pseudoId, cleaned]
        );
        foxId = ins.rows[0].id;
        isNew = true;
      }
    }

    // Generate JWT (7 days)
    const token = jwt.sign({ fox_id: foxId, phone: cleaned }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ ok: true, token, is_new: isNew });
  } catch(e) {
    console.error("VERIFY_OTP_ERR", e.message);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

app.post("/api/auth/onboard", express.json(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (!decoded.fox_id) return res.status(401).json({ error: "Unauthorized" });

    const { username, city, district } = req.body || {};
    if (!username || !city) return res.status(400).json({ error: "Podaj nick i miasto" });

    const clean = String(username).trim().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);
    if (clean.length < 2) return res.status(400).json({ error: "Nick musi mieć min. 2 znaki (a-z, 0-9, _)" });

    await pool.query(
      `UPDATE fp1_foxes SET username=$1, city=$2, district=$3, consent_at=NOW(), consent_version='phone_v1' WHERE id=$4`,
      [clean, city, district || null, decoded.fox_id]
    );

    // Auto-redeem invite code if provided
    const inviteCode = req.body.invite_code;
    if (inviteCode) {
      const foxQ = await pool.query(`SELECT user_id FROM fp1_foxes WHERE id=$1 LIMIT 1`, [decoded.fox_id]);
      if (foxQ.rows.length) {
        const result = await redeemInviteCode(foxQ.rows[0].user_id, inviteCode);
        if (result.ok) {
          // Invited fox gets rating=3 (bonus +2 on top of base 1)
          await pool.query(`UPDATE fp1_foxes SET rating = GREATEST(rating, 3) WHERE id=$1`, [decoded.fox_id]);
        }
      }
    }

    res.json({ ok: true });
  } catch(e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return res.status(401).json({ error: "Sesja wygasła" });
    console.error("ONBOARD_ERR", e.message);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// GET /api/invite/info/:code — public invite info (inviter nick)
app.get("/api/invite/info/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const inv = await pool.query(
      `SELECT i.code, i.uses, i.max_uses, f.username FROM fp1_invites i LEFT JOIN fp1_foxes f ON f.user_id=i.created_by_user_id WHERE i.code=$1 LIMIT 1`,
      [code]
    );
    if (!inv.rows.length || Number(inv.rows[0].uses) >= Number(inv.rows[0].max_uses)) {
      return res.json({ valid: false });
    }
    res.json({ valid: true, inviter: inv.rows[0].username || 'Fox' });
  } catch(e) { res.json({ valid: false }); }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTES — HEALTH & STATIC
═══════════════════════════════════════════════════════════════ */
app.get("/",        (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/partners",(_req, res) => res.sendFile(path.join(__dirname, "partners.html")));
app.get("/rules",   (_req, res) => res.sendFile(path.join(__dirname, "rules.html")));
app.get("/privacy", (_req, res) => res.sendFile(path.join(__dirname, "privacy.html")));
app.get("/rules.html",   (_req, res) => res.sendFile(path.join(__dirname, "rules.html")));
app.get("/privacy.html", (_req, res) => res.sendFile(path.join(__dirname, "privacy.html")));
app.get("/partners.html", (_req, res) => res.sendFile(path.join(__dirname, "partners.html")));
app.get("/faq",      (_req, res) => res.sendFile(path.join(__dirname, "faq.html")));
app.get("/faq.html", (_req, res) => res.sendFile(path.join(__dirname, "faq.html")));
app.get("/voting",      (_req, res) => res.sendFile(path.join(__dirname, "voting.html")));
app.get("/voting.html", (_req, res) => res.sendFile(path.join(__dirname, "voting.html")));
app.get("/version", (_req, res) => res.type("text/plain").send("FP_SERVER_V27_0_OK"));

// ── Invite link without Telegram ──
app.get("/invite/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const inv = await pool.query(`SELECT code, uses, max_uses FROM fp1_invites WHERE code=$1 LIMIT 1`, [code]);
    if (inv.rowCount && Number(inv.rows[0].uses) < Number(inv.rows[0].max_uses)) {
      return res.redirect(`/webapp?invite=${encodeURIComponent(code)}`);
    }
    // Invalid or exhausted
    res.status(404).send(`<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FoxPot Club</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0b14;color:#f0f0f5;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:20px}a{color:#F59E0B;text-decoration:none;font-weight:700}</style></head><body><div><div style="font-size:48px;margin-bottom:16px">🦊</div><h2>Kod zaproszenia wygasł lub jest nieprawidłowy</h2><p style="color:#888;margin-bottom:20px">Poproś znajomego o nowy kod zaproszenia.</p><a href="/">← Strona główna</a></div></body></html>`);
  } catch(e) {
    res.redirect('/');
  }
});

/* ── PWA ── */
app.get("/manifest.json", (_req, res) => {
  res.setHeader("Content-Type", "application/manifest+json");
  res.sendFile(path.join(__dirname, "manifest.json"));
});
app.get("/sw.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "sw.js"));
});
app.get("/offline.html", (_req, res) => res.sendFile(path.join(__dirname, "offline.html")));
/* ── PWA Icons (base64 embedded — замінює app.get("/icons/:file",...)) ── */
const ICON_192_B64 = "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAA0rklEQVR4nO19adRlRXnu89beZ/jON3U30NBM2iByUSCMRqM30SsOqNFEJStm0AwmONx45TrerJvEpVlZJjfxLnM14hAx4AACERRBUEBQoAWaZmqZuuluupuep2883zl777o/9q6qt2rv0/DPH/U+LL4+Z++aT73PO1Tt2tTrrdIQCARRQv2qGyAQCH51EAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEEQMIQCBIGIIAQgEEUMIQCCIGEIAAkHEEAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEEQMIQCBIGIIAQgEEUMIQCCIGEIAAkHEEAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEEQMIQCBIGIIAQgEEUMIQCCIGEIAAkHEEAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoiR/qob8KvG5EQPBEBDAwDIu1t+09CobvPLIJta+zdcrvIWUVAuTxXW2XTHT0VUtUvrke0zaWxW1kSttb1O5R/wFppym1vl6rJ1QENr/r1eDpkxIL8xZZqqH7yMKp0pwubVOhgZbdtORGV6soVV98xv4dpj2jY7vziyrzEgegIwE8p+ZZ8plG+eiM31cPKHAuTRgnZEowNi0N7MJoA0mqgjlE8CwesFE9AaOWie3pGErjFFUGfTRar+aDZWLD15wl6Kqt94zeoPrmrteq51OVbBb1XWTvaTNoyrXb46R4dtiBtCAJX2a9J6Wms3sTkbVEpLl8qzpvmM9iJTQVglNd+xc5Nghd+KqdF8TKhKjReQDb9WIy5fgGxJVoC1E46gT8Q/Uf1qSIrU8MklYmNZkQjrqZeDWK7QzqpbTy4FVZaO1kFu7cZOiEBiANZE9L9zbW6uNwjsyDKrvE33jPlu/lYmMFdQru7yftmGalKztNpkqEx+Syy2Dr8FvJdc+3vtUwQQjbADwjJsI2oWUXPehpGxH30XxyPVBqIzFbnrzo1oNtma2iOIngCMQd4kNNYdrWc4DErhMkSinahXZXItR8aYYCk0SJfa3xcCXnVJA4YgnvdMZh3iCpAahDfss2snLOm4C64HoQD6Focb4yZysmPFtTSclUVeWtTzc14JLRLiJDXKNosP4gJwcJsYbELZoFv5VQOhhQxzx2VnQsDmnq/JGm2Eym9vcKyt9+5PYC90UNXtWxosFQukea2oOuVKZilC/16bFG5AnKvkZ2gy0a0oV/Vp7ffIejm2LGbagwf0WB81SxP8XjBt9dhIxB8QCyAANU6MUJ+Rf9HPb9J5RY0KNAZmdFNZlTlMcMJZd0e004pMAK1gMJXp5SbUBDY0591VnpMV6GnaumZt0tbupm407V2Tw9yclMgfY+v+VPmrQpyREhCi+P8AxALwJjDZZTUGrkkpvOkXpKsEVAmVH4xzQTxP3Eb52+TbsIfzySkUePAyjbnO4uWB0JtYQii4nh6v+u6WFyut7S2VcP+BqjSjB83pbAcXxAwEGG74a/xkgrV8WbL6N1yqDe2i2CEWQOVLa+30jSekdp26cerVyrL+cn2tztm2nmVQ9+E9jW+1ZPOkbW4Rm+xMahroDbB11QMBvlWB2n1bV9U3O25eFaEI+4Lvuy5m3Jxq57+D7/zUnQtvlETDPy8IAQDVZDMmZaAj+IaayremwLyvEtp/SnmgmjdhJ69vGDgFG0zakdGCwGrwWsAa5/pg/nGOuhUWQy6GoMinOpvHCqhpAtl2uNUKe9NVTFxYD6OFKfxs2sT6FcJb9XCWhqtF/PznghAAYE1IHqX2VJOZq1yiKj/T+JtGk3uecjDHuYZqEvVw45EhkvouG22nuxVWHjHn/3HNbFIQF5o6vE1NZUdrbQ3N95FKnyXifbdLguYfz4R3ffANJNbewNRw5OrG8nBxPrEPSggBAOA+s9banx1Mm4Vr0zUl4824BulvrJqb304oRshQQ8sbbhrN2SidsNqamMVjiM4QiIkJECtvlEQFrQc4aWg4oXSlM4EN2IEJfbhiUiu/yYio+yCNQ984bhFCgoBMETkT1l4p/zfLVfDnjF2U8twBThh+VSa+wJeseDsIhEIz4SGq1cnLginPM7mNiLnNveUGIiNy7F55A0SuPa7NzdLhCSUZptIoCn4dLI5QBeL4AGo+6KELg0bhbobZ8cdGRFf9I1eUaSbnwwaeiBJCAKCGqc5i1+YPW7MOI+Z8Iulg/z430Ykl9jjGfDTCX93UXhmhj1umXxoWToC1EW0fxqqx0X9iaXkgwpIGc4VYcYUuapt0SksiwXivW+bQTMYZoZYkUNsWZUmocZc/8bb7cQ/bQu2+VcPc8J0Lv2nB6Ae0YkL0BOBZycwcHqkcKPxK0EyDlsWQTx5VmU5j1stpshhY7ioJVQJHKAqNTovwsXf/F4xPLocmIE0TkEqRthIolSBN20habRApECUgAlSSIE1SkCrbpAjIsyGKIoMiBVIEpRRACtAFVNKGUgqUpCBKAJVCJW2QSgBokEpAVOCvP3U5nty4A91Oy3OjPDcCBBSF3znSlpN4P3nAJNgQ6cc+7MVR/k4Dqnq1UIAQgMNIyQxnZy21vz/PmcleXIGo2mfANCevXZsVBvJ4w5OkoFEpDXH6S0/D3MT5yId9pGkLSZIgSROkaYpW2kKSJoAGWq0WpqYmAa2RJIQ0bSFNE7RaKdIkdZ/TFGmqQKSglEKaplBpCiQJAPO/P202PHA1Nj+zC+1WypbxbMeYye0sDddvfkkzadc18iN/YOz1JjTFUHTwSSAE4MGZvv4kCWLoVRpfA5E2us4XfsCZy2B3wmlYcymM6cqt9MpwJZZjsZ9hIc1RDHOkLYVEAUklr0lSQBcak5MTyJdyfPEfL8V5556JC9/4W5iZW0QrLQW/FHqfBIgApZKSUKr/lSr/J6VARMh0im56AF/68ndwcHaAI5f3kGUFQH7PavEVbbrIaJRbR9rl9aEbr/oXywrsuPGx1iNHPFpETwB+4K/6aHzwQONwZdUcA+CkwRDsJQCC5/erq5rvnNNUWxqz3oQtltBqAYQCShESpaAUoIw8aY3ly6fx+BMb8aUvXY71j66HLjK87a2vw+JiH0qZZcKyVKOlCRqKVFWOhtYFtKbKldAglMTS6XSwZ8P9uOm2xzAx3kVeFN4AEahcZ9L1xpftC/xwjxWbqJa4NAeDUb/lOCE8S0CE3yD6ZUAuu8a3dAJW3bLLWL4mCdfofQVW1/rukna+MQM1puUJWF3VUl6RFzZXXuTIiwJ5nkNrjbHeGK6+9gZc8uH/jfFeG//w9x/DmjVrsW//IbRaKfK8QFGUZeRZhiwbIs8zZFmGPDf/5+W94RDZcIA8GyAbDjAYFlBqDj+4/kY8s2MBnbbyni70NxAFDwITOeGvDRPvf4Oprhs/smwNI8t+L7uRq15ClIieAPgKWoj6zjZ4WtlG7Xme8JMJUOnaHb8dXiOcOezVwYjIk6/qS1Fo5HkOAFBK4atf+SYu/8ZVGB/v4WMf/Uu8/nX/Ffv3H8B99z+EbreLoihQFAWGRQJKx6BaY+W/6RiSVg9Ju4ekNYakNQbV6oKSLqA6oKSNiYkxzG/+Oa649h60q8BfsKHYWhYlqZZ9anIHRgyGGWzUSZH3WttkuqrNeROEw4m6rAOIC1Ci2qPP4lYIXHoWyPInMV924lquFqUG+QJcfbJ+MPOBzdp5/XkCpjV15QJ02iiKAloXZXlESNstfO1r38LPf7YGrVaKV7z8bJz+0hejnSZ4yakvwC03/xQXvPY3MBwOkaRtTNGzmNm+GYtVMxQRKFFIVAIigkpSqCSxLVaKsHfHFnzhazfhoScPoddJUOSa82TZC0/Otf1bXtOeVJbLh2azFXlpQxfKrf1bVe5xiXWlvIvmJ2DWm0AIwCKcIODrzjycVM8W3uG+p7fXfmRu1CwJRxquQL4HQWsNUoRut4NisQBpoChyTE0vw/evvwV33nEPVqxYhj179+Oss16CNE2QtFr4nbf+N3z2c5dj69YdWH7EUdB71+D/fPUbuP2BA1VkgkUdSVXmsvLZDRoHZoaYX1IY76XVJiBCoREQVNDLIJJvYyosn9Y6qCsYE82Evxo3jyjsqoNh8eq+GUoRfA/RuwBWe7MHS4j7BWwy8jMCn2vHnBfVrvLbDercTWV78hsnJ6ufKiuCP5DT6nQBlP7/xOQEfrn+KVx/3Y2YnJxAluUgIqxceQQWF/rYuWs/Lrrot7F8IsV3r/0xjj0ixU9+dAMuu3EPDi6k2DeXYP9sin1z5f/7Z8vve2cJew8R9s6U/++ZUUDSxcR4Cl1o1yfWXm8pn48Dc6GMgiZ/QAPoID+xtI5IdJiUtwn+kIdNihlCAHr0dhA3TckG/JyiJn/SEjdfUdfo3rWGdHanG38UOfjXBLHgqk7bbYAISZJimOW46srroBJlqynyAkVe4KkNm3DppVfgqFUn4u8/9QHcdsuPsPmZZ7HyuBOR5xlI50hIg6iAogIJaSil7edE6fJa9bko8srsd2G3hgULAA0nE7PxM88dOCnmn92v0GwheR+8WjnzmN/RFCtbgByidwHMWfI84u89Esy+P5cG8cihMvsJzVzgXeTBBx7RqlXkvhRVWpW0UeQ5pqcncNtP7sKmTVswPT2FPM9BmkCK8NDDj2H16uPxzW/9J449dhU++MH3YGp6OR57YisueP1b8aENh3D9zQ8jy3LreReFLusI2mBWH1SSgkBl/MF2o768yWMrXmDEKOigq/zpB+85Ap4wNK20u+1sAw22QxoEvrtDxN8gegIA6tanIwHfV/XymLQ8T1igdv6nl6sWWDRmNNN21tdnKXV5Pr6rhkBJgjRNMBgM8dOf3oXuWBd5Ua4EFEWB8fEebv/pGrz4lNU4auWR+Nf/9zU8sG49/vRP34XzzjseS+k4PvHxv8K7/2Aj+ksZ0la59TcvSsFSSVLuCkwSAAStC7Q7CbZt+iXee8kVyHJubevRhBdul67dr2wF7UjA0XA1FjVCLX+j2u8XlB9+1k0/aKSIngC4xreSaZSNk26PJWzwyi+p1FdeIIpn8IXffOYHhnplBsuGVjNW/5SrBIQ8G2BqagoP3P8gtj+7AxMT4+XegKodaZpidm4R/3HF95AohV6vh7vuWoM1a+7Hqae+CC972dl4+W+8Amf/2vnoKY08K9BqpWX0XxGS6tkBlSRQCiiQYuVkhp/d/APsO7CIZVNd5HlhH4LyCY91xQxhNZaH88G9uAAbhxrB8vFkaV1Mocn1OEy4IUJETwCjEYp3+Tdc6waYTmMRQgpIQAcTuckyqAWyqrK8yLZne2joIkfaauO++x+CjZDzIKbWaLdb2Lf/YCnUpNAbH4cuCqx94CHcv/ZBXHXVdTjnnDPx4Q9fjJNPPhFzs/NI03LZz98KTEAyhp37HsR3b3gQaZqWy49W1nRdurg5ELJDqIlr7o5fVhhLNOJuDi0x10xcovE9BAIPEgT0Jmxds/ATdULRJ56Da3i2lGiCh+E8rykhtuGHAkLwAtpUrdOTAgFIKMNSf4BntjyDln0Yx7Vfo9xPkKYpElUu6xm//dW/+XKc8dIXY2FxEXfeeQ/+8i8/go0bt6LT6WAwzKqdguX/eZ5jOMzRTjI8+uC9eHTDQYx1VbkE2CTYLJBXjkMwAF6W+ri6L2wswiK0rt1xws//cBtLwBE9AdTmJY9Ms8j84QooZd4/vDPc+NJYl/1s2cayiiUXExT0iMQE6nIkCpibX8DMoRmkrVZDZVV7mOOrFKHfX8Lq1Sfiim/8Cz70gT/C1NQU9uzZi89//qvojo1hYWEBeV4gy4vy32yIxaUctLQLt9x+P2YXNRJFrpcE50p5nGocd/L650N7yf00TMgtsTiyDOGEv2mExRIIEb0LMCpg5BmPVP3RdW1Tbj1tenVVZbCH0f6RPinVL3qBiKo93KLWBZTWmJ2dR39pgHanXa7Lm/xVrMBkMn+LvEC328a3vnMd7rr7fqxefQKSVGF8ooe1ax/EU09uxAknrMK+fQfQbreRpwmyLEerO4WZZ9fhJ3dtRLedoKie7W90iYi1vGkITCyAeQ3ey0x9M8D1OTDsieA9fFh33NjbmYJYjhCCWAAemkxPAkZqHDtZdbO32aTomhWgMSNGNUjb++HrswCN4WBYPonXhNCvJiBRCRQpTE9NYueuPbjjjjXo95egSGFpMMAnPvkZPLr+CUxNTaDVIugix/TUGKbz9fjCl6/Gph05uu1y55+twmxQCs5CAKzxUqXxgxzcvXHWljWrEJ4Z6JO1G01HNtrGTLyM/HmK4DeLGdFbAKjmmKdVAG8SeX4+18rWPChzGV3jG5+mDAJTf4ExUNVqk9iomjOfG7UVIc+HSBIF1RDaLnOV+ZRSKICSLLIl5EV5vFeSKHQ6HaRJAhAw1u1g8+ateP/7P45zzjkT73rnBZgay7F27X24b+2T+MUje9Hrplb7+0Ppxx/C63ZsmcXDdbsVfGZx1dfzeWxE10rgX/jRg+BWWlV+4wtHI4MQgBE67Xa1eeAE4S0gs5Q2AGgEV7P4gZ+DvxbTTEzy6MD/FkiNPehCKcIgA+ZmZ9DrvbD0/0PBs/vqFebmF9BJNI49+kisOu44TE1Pod1uYWFhAZs2bcXWbTuxtLSEVruFdqsFIuDmW27Hgw89gfe/+1X47Bd+jOnpKYyPtWrWRniycHnMl6+57TAF7oBLUo8f2ICeJU37Y1Vc4Q5Hsat+Ng5TD7zy8QUcQcQMIQCjfJ9jcZiLvvEsuT9pzwY0jmktY+W9siVCp/GbbIbAXYVPCkkCLPQ19uzeh2NO7GFsbByLi3NQpKxJroiQ5QWypVlc8Koz8MYLX4MTV5+KVccdj6OOOgLTUz3keYbt23fh/rWP4fY778XDDz+GvXv3oshznHHWanzw3a/EI+vuxcTEBHpdhSwrKqOEKjJyJr3btddsrXgqfESMoMkuJyvs7ug1Nqy1amrGRDB42jK6MIAQAKrdZ2y5adS0MIJvtQ7cvDKax9Nq1h8ma0GYM//M5DURdPdEnNOc3DUJQQT0B8DGp7fjgrMSHHX0MXj6ycfQ6XbLrboEDLMC450CH/nYX+DsX/9NDHPCC088GsefcCJanS5279iOTc/sQZH3ccZpK3HGi1+HxcVXY2Z2HkWhMdHp4957foZrbt6AbqcMBFbUZ3c++nGT4AOLWYCN2+Hkjo+fTxDa09jhKclkiDckYBvLcQ9RHf5XjgtCAEbwnWMZTI+GydKw2cUEmE1qoyXL5MTS+SqrybIwy5C1ffWsEl1oECk8sH433vF7+3DGmWfgifUPozs2BtIFCk1oJRne996LsHuG8OWvXIm/+LN3YHqyC10M8fC6x/H4U9twzPhebFj/C9y5ZgO275zBINNotdpIFGHXnoN4+tlF9MY6ZZkw4m8HwvunNlSMIQPHxk9vfHnNtTPrr8+0VSu0G1uzUYrtBGz27hudjqghBAC4qFJ4CWAaxPzV9sAJb3W55sKWacNJxm0Cp5BYaQ22rdW4bLurBtDrKjzw5AL2PPMQXvub5+OH148hLwoQEbJhjhOOXYHrbrwHG57YiE995pOYXjaFhYVFbNq8HY8+vg2rp7bj+qu+j8t/uA1LQ6pOAzaEWAYIJye69tixupwziR+lVE0Aj7TvZtWZzzEo6yM/SdmpcPZbsR2AtbvajJtnKyDcmBUzol8GdBMZh58Y5HazeXkAG/wyk9Az/JueAQAnFV6+K5lP5vAJRfP24HZLYddB4Ic/XoezTtI4//wzsLiwCEWEVivBs7vm8MijG3H6mS/BSS86CQsLi9i/fwaPbXgWL1ixiJ/ffgu+eM12tDsdTE+0MNZR6LYVuh2FsW6CVgIr/G6HTijnOugba7hpa9OgBr5D7XBWGxyl4Dkp9pp1u4ZI9j8v+Bf6KMTPAxQAQgDukdcKtbmsn2PCEFXHZAN8v4BXDtshWJuTfmGw0SvGAFxzOvO2fDlIr5Pg6lt3Y8/T9+GPf/8C9LoKeVEmShTQbqfIkUAXBQaDDLv3HECqEui5jfj2TVsxNdECdIG8KF/vVW791Shy9jhwLaJWhzY+Nmu7ibNZYa09FzBiHExaNhyWfGokHX5zThgftaZnOIQJhABGzwG7YcWY5qH/TkE6t+/fFsEMz2af1GQPjVff/Pc+2PLLC60U2HGA8G9X3I1zT8rxjrdfiIX5OSSJqsz4BPv3HcRSf4jF/hLmFweY6Go8u20Hdu4foJWWz/7zvtVOQbZ2fHXVmOusLcY+sUeAkivHuDaep1VjQbLbqY2WN5m1ht++qo1aa+iiaBhhTrhkiaQKM7hWjvpRIkL0BFCbHWBz00x0BFOMQuF2M8nmNZbDc0wyUjxPnSpGrU6yDW2YHk/wo3vncO3V38dH33seXnbOS3BoZh5JotBqtbBjx0488dQmkErQXxqAkGFpMIA5xt+PmrMOgN03nQk233gfK23vbboxVpG95/RzzZXg/Q7u6fBiECsINxn4O35tICIoQxhACMAoMmOvWl80kDxPA7vjvyhIwEnCzzjKEnAC45MM07qeC+G7A0CpDcc6Cf7lW5tx96034Auffj1ecMJKzM0vlu8LJMJVV16HmZl5aK0xHGZotVNnXgeWTRhU89wWLzjh2s/vOVJpOliVkybP1xRf8C+YmIr5qUzcxBE2SxyYTlq7LVg2WvAcez9iQPQEQPxfGj0pqOke+WVw05kb6qG167nK3nMG2hNvz8C2lohmwS/HD4kCNKW45J8fxpMPr8G1X3oHVh51BA7NzGNioofNm7fgG5ddhU67jYWBwvJl4+iZx3lNW9xTObYVPimR889rAwQvjzGBTFu9AL7V3NrLXyPVyswpzzFgLhdGC35gw/mNEo1fQ/QE4OYEIQy2ASboNCLs1PAEIFDXngBVz/AzDdYAsj+HK8fKfujiAii002xaa7QSjYJSvOdv1uL2W+/GjV/7XZx+2onYsXsGk5PjuGfNvbjs69/GoGhj+ZFH44VHt9FfKjcNmXIbzXLt98f44E19d733GcEjz3BlpMHYcv+XBGnjAl4Yv57R+wWDmEyZ5jBvfo4Q1Outino8Jid6gVHNTVVttZL/cFAokSa9KyEUcu999FQXIGcAV7nrBbAmuho0L7nKVmhgZn6AP3jdMbj4j16Br/9gO6649j60WwDpDCefcho+/t/fhK2P/Qz/6/NrceSyTnmsl+mb8fc9z8Dtu2885Zc12XlR7rQeU0bjgLHv7oEijdpzEqOsM1anLbIm96bN/q80O7/QWGYsEAKoCKBJaA34lAnhmaFsl5rW5Us663LiBJcLRq0Nnj+rqziBFT+WvvrEtSqVzwEcmMnwwmNSvP9dZyJtT+HKm57CI0/sQH9hHquOOwEffNcpuPbGR/D4lkV0WoRC61p59kEcvs3RNov51OTky5BSMwG4kayTIBsbOwxk09oTnE1HA5/fcaQf0zAM0WSzzMwJAUROAGOwTirzM72jwVEnAAruOT/XRMB1zaVotBlsIc4G4N/L5oST3wmJ09i8gvJDkij0hxrz83284owj8JpXnIw9BzM88NguPLlxF4gUjjumh+27+lCknTXh1c0KJrg99/BjHiYVmbZzsuC7+bgr3zAiHrE1GAx8pYZbZN54+NEF32PQrjlCAEIAmJzoOdVFzcZ9qJ09zcsw2imog2qp/AlvSx/hV5gjvqgmfUE9VJ4hOLeQoShyrD5uGiesmsLiUh+bts/i0EyGTluVz/fbCHtdgEu5d66QEzoerKyEsFrVqAkxJ9lwpKotvZ79boiP5W+MPFTtde6Q9seVWzT2xKSyvNn5xcb2xAIhgPEem5P8SI8gyqxDrULWl2/WgPXn/t0kRYNJUTexG1jH3dJO2Ox9oFngNKAUQKTQH2QYDnN0OwnSJFgFsH633yaTgmtavzIneH4zmGtwOJhxId8JCA9H9QWbD4nvOtTDrHWiNilitwDkYSBvrlQTxTusv5raZnJqM9FKyaBaUdVfFhNwZQGk60E0U67fFgKr0Idmk9zkM16MTcP1n0Z5hkeOdkpopy0UWiMvtLfCMHIJ1DaAa1juegTCP1Lqq3SNy3H+SNa8moZ22vMWjXehOYFX5VjXLChvhFMWG6JfBrTamfng3kqT2QKs/anTZG+XU89fsjLfQ//cF1RWhgbbtMK0s60g1GbBlNbBXQ1bksnu9ceXodEg1z87QGwnHq/W8J5truFLXXik6dfpl6W9wqzkB5UE9TYIdDFy2U+EHxALwJnednqPNiCJm/WBAqlNpyZBbUrPNvgkpcMOaHfyTZ5rJEl1AGeVSSWEPCsf+00TBX6GoDHpTR2JIq+P5Tv/iuodAQoa5YqB1uUbhgmEJFHlsV9aQyUKWpfvEkiUAillDYAiL+wDQ+bZA6CMOeR52WClVGUsODLUBY8gAJVp5AcVyb3M05GGe+7fGT4m3uCPbehm8VGRh4EdhAC4JqmZ4SXCS1Tl48lraUzwii2VedNQs5BVpU0PHlooX+mtyif9lCJMT47j4KEFjI110G6lGAwyLMwMMDXVwzDLcPBQv9RyhUaaJpia6tkJTlT6uIOlIcx2416vi/GxNubm+1hcHKDdTjFYGqA3Pobx8S6W+gPsO7CI5csmkKYK+/bNoNtto9frYGZ2AcNhDiKFPM8wPt5Ft9OG1hr79s0AKM8qzLMcy1dMIS8KHDgwB0CDFEEX5dOJ471OFW4g674YirCjGXpPVIkuH3fmarCc3m/rjbqGI1wxAAAIAQQyXwW97MRj08n6mXUv0jsU05Q7YoZxreesCI1ca/zdJ34PJ518HOZmBxjrpjhwYBb/8Llr8IkPvxPX3/QLPLDuCZx5+sn4/Xf+Fj792e/gzJe+EH/xZxeCinJv/7Zte/HZ//s9mOj54tIAH/jzC3He+aeiWBqgPTGGq6++E9defxde9YqX4uI/vxDj4z3MzvXxxS//APeufRy/8+ZX4s1vOA9//enLsXPnPnzmb96Dvftmcem//wAfeO+bcc65LwbyDAtLGb5xxa149JebkCQJ3vfet+D1rz0bRMDaB5/G5794HY5btQJf+uf3YZAVGAxyjE93cf+9j+HSr9+M3linJEEdCL7R+148gsc7qvQsC5kASD1y4IO7dhSQRaSIPgYAz+x0887YBfYREu0mpguWBcYkN1ubquJVkqsTKLcK33nXL3Hb7Q/jorech/W/fAY33/YgtNa46M1nYtnkGOYWZjA9NYY/evv5GOYaL169Eq952Wp8+5p7cPV1v8Btd653iwkELC0N8Xu/fS6WFvr4t6/fhu989y6sf2wbXnbui3DN1z+ETZt34nP/ei22b9+D6y7/KM58yYn46c8fwmkvWol//tS78L4/eS3++KJX4o67HkGWabzjLeehnQBf+MpNmJsf4MqvXYK8KPDXl/wu/sf734xvXXU7Lv3qD/Gm152LSz93MfYfmMPV192NbDDEG19zOv7ze3fhoUe2oN1K7XiZ/nvxBTuc7JAUFgsI9yrYsux42ov2N+LUIMrfIXoLwIOn/R3cCcDh1Bk9lXxPnC2feSaH036kCLfe+Qgmxp/C+/7wPHz/xnvw6BPbcdSRU9iy8Sl86D3n4W0XnIQTjl2BzRueRKIUDh2awWBuF97wylWYnuzgh7c9ifmFJUyMdwAAaZpi6+ZNGNcZfu2UHqanUtx62x787SVvxt13P4RP/t2/48gVy3Hbnetw/mkr8PYLz8bf/NN1uOB3P42brrgY//jJN+LcN/0ddu4+hHanhd07tmP71t3Y+ewOHHh2Mw7uPQ6TE2P4ndediv/58Utx3U1r0emk2LJlB26+8hIsmxrDd6+7HeOdAi88OsGV19yJZdPjGOu2mYVE9jT12iqE5ouyYPGSYKCZJeVODvVXKUwMZsRCR7QQCyAIH42cHzacboJVDZOxoWS3g96PFxDZWW+qxtRkD8umxrA0sxsTvRTTU+VbfLPFg7jptkfwle/cix/+5GH0Z/dUwbAlPLPpaXzz+odx2TXr8ODju9Bup1Xkuyx7uHgQw8EC8oKQ5RrtdhubNj2DoyYWcPTKlVgcEo4/9hj01Aw2btqOXKf4jXOOx+yBHVizZh0uesNJ0FS+GfjQ/j0477QV+Pj7XoMTVk3h4o9ehgOHFrBz+1acc9oKtDpjKNDG2acfjT07NmN2ro/e+DJ00hzDhb1YsWIK472OjczbsdHlqOimsTVDZNbzuAo3VkHwL5lCPedfhL8JYgFU86pcCazPkNCrdOv71RQOLVHYWLVHDjZqbQvkrkWJQgN5nuPg7i0YDJbKCDspzB3YibUPbcYv1u5AigHecN4EtAYWF+bRGu7FW18+hTQF5hbauOyGBfSXsnJ1QBMGc/tw6727cNn3NmBqso1OJ8U1P3ocZ5zUwxc/fg4e3bgfZ5+2Evfc/xS+d8vjOPOUZfjIH56EL357He57dDe++Q+vwrZtx+CKm7ZiaWYX/uOqx/CV/9yAia5Cp5Og227hbz/3Y/ztxWfjiI+eg/5SjpeddTw+86+34cDMIpQiLM7P4uCeHcgLbVcXjPlv3y3gjZUGeW9DMuY9i7WYl43yuAs4yVaWRa10//eMHbITcHwMgBF+t/zmw03GMFzlk4b2o8sNW19rJ+PaCVrmTRThuKO62Ll/gMGgXBE4YWUX+2aGmF/MMT6WYMVUC1t39dHrKhy/cgxjnRREwGBY4Iktc9Wbe8oA27FHdrA0BA7NZ0io3PwzzArkucYZpyzDyuVt7Ni7hF9umoEiYNWRHbRbCpt3lFtkV0ymWLmiiye3zuPYI9oYZISDs0MoZRSyxmI/x/R4C7926jKkicL6jYewc98iemMp8lxj2WQLE2Mptu1eZK462QBeuIV41Dj5DzyxMW78vcyPpG32slxWJIDZyHcCRk8AE+NjbAtqHc5U9QmAw5j04bl15l753ZXEJ7d3/l31fZhptFIFqk4FGgw10oTK/QCFRpZptFvl4Z+DYW4FURGh205A5N5YnOXlWnyiSmvFvtGXCAv9HEVR7jMw+bJMIyuAsU550OkwA/JCo50SBll5dkCiqr5WGjhRClleYGEpBzTQ7SRl+/Ly+YKi0MgLoJUSV/7e6FifPdyODON5MWIOVl34yopfLPs9wh+k+hj7VuDoCcA/D8AoG64uAgrwIvjV1YYRrF2q7bN3WYlfQM2yrb67ihXIbsBpiJuh0BpzCzk6bUJRAK1Uod1S6C8VUApIkzJdkhD6gxyJIiSK0B8USBOFTlthsZ8hyzVarQSDYYFuu9p05LWZt9G5Q2Zfgm2vifRbgTWdd1rdW0ptIAD3iVsGdauMj2M9P8tX1Re7BSAxgMpUplBrVP6jSwV23ctezTnn/bt7/Pgup520hvdOe7dpqCpD+0UXJr4FDV0AWcUcLmhW3i9f7AEQKfzJW47B0Ss6mJsb4KY1+7BlVx9ve+VKbNndxyMbZ9HrEOYXc7z9t47GE1sXsO6JQ3j9rx+JpUGBO9YdwKvOXIaXn74Mew8todtOccNde3BwbggAdpef6Ztiwu8WS8w1Cqx0JqBs+7V9kIGb6Nx2hyMJT+ypPEcpSNpIUl4TeBkRQwhg5BwYpYW4hVlpYeujgs3EQKOZJ+u0Hx70Hndt+EREUApQpKAI1edyuy4Rqn8JiQIW+xm27V7EX73zBZgYb+GyG57F8Ue1UYAwGGqcdcokMq3x4FMzSBKFYa5x+knjODA7RH+gceoJPcwt5vjR3Xtx6gldrFzWwR0PHsBH3nUS1m/u4+6H9+DoFV2MVb69fYdAoVFooChKd8FYIeYZCD9uot3oGpO/7Cgze5ifEPw+noWGBiE3BBtYVMYC8V2PkRQRDYQAAPD3zDefXVdqPMB68ew73OQNzQSr2e2fOpgvXXM/NEAKaCUJWqlCKy3fBtRuJWi3EqQJ0GqnUCpBKwW275pDUSzg5GPbuPGe/di8dQ77DrUwMZYgTRXm+0PMzA8xu5hjrKMAEPI8Q57n0FkBBY1hlgNEWBrkGGYZ2ilhy/aDmOxqFJowNdnGqqMmMMwKZFmOYVaeMjzMNAbDAoNhUd7LC+R5gUJzA6jsp/2u+RjX4ya1yB0feUOo3g/pxs8dboJqbOtugYi/EECFEVPBi+JXU8+qf6aegkg0V1zmsxXupoCjZ7q6x46BMniWL2VY6PsrDKWGhdWyhdbotBKMj7XwzR/vxu+/egWOnFI4ekULt6+bxboN8+j3M7z69HEct5ywbe8Adzw8j58/dAgXnD2F41a0cOJRKW65fz863QT9pRzIh+gojX5/CEUFEkXYtnMOT2+dgSLzkI/x/6vXbjGPx4+g8HEKgnUVFBN0+wqwOh1Y4bcXif0sxvUwpBuQhBH8Uec6xobog4BTE73ygw3K1Y19N5HN5coX5duIA9S0eQPqQStmJPMAWZDJz+GmvhGYxUGB6fEEq4/p4OB8jp37htDQGO8mWDGZIlHAoYUMB2YLDIY5jl7exsplKTbvWsJ8vyiDhilh5bIWWi3CvkMD7DmYodMq942ROUZY++NiRy5cmw/kv+l8wbCfbvx8sqARY9SIhge9wtSyCiAEACAQfG18c+Ya8ExsRteJwakct/20/lLtZprhLeGPrQaBs/oSQfWx8nMJyHKNpWr5sJ2WYbK8Wo7TGkgTQpqU5Q6ycumx0yqXGk2sYphrL60OhKhpaY2PYcic5mxDTnw8Wb0MZzFxwgtPDm6E53a5g0JC+yt2AojeBfBE3AbsUF0xG4MCM5StSXvTyUSy4fJ7331+8MvkgcFayYElQSygxUxlu1O2KB/LHe/y8/TK9fskMf0yFgyhlQDtlGq80mm5XhpN7qIhrODAlw+vk62LC3t1cnDNO2fgUX+jzal+3x8nM0baa4sND4jj7yF6AjCwwbxAH/kag0/fenDL3oAvJMZPNl/sqsGI6V+3DhjxEBdKXU/DUHBhZB/t4SQu2OC4i7df+z41Fz6tWWJ3gQXe/P5YTc8tgoa+NztExCydBkLmX8jcr4+tvAqsDnkYKIB9JqBpshDgvSfIzNZA81s0bVPlaZktHWb3SMNPWroVtrwG89kaCl5rq1tGq5pc2rtu05F50bZmbODYISy19jEYQ/7ykloeBssr2lswdGSrUe1/GOU2lH2rvWtR0AghgLpBC6DR80ftElNOxjl2k077QacyZG81uTPB/UI9kQ2CiE50XZs1TLlsumv2PzHhY9rf1sOrCHfl8b6EbWLWB0HblQDeV/O/s5RYfcFQPj9J5Q9fGUJiddXckMPEFwQAxAWoQzvxqk2e0OyFIwpj3ro8zn/15371uJF2PrWvHLlww7cialuUbc2uPZ4MhgRjDXHYV54RfMG1/+h6/3n0PnB1KFjitGMQcKhzP9zIkHfduBABCVXJvS5p70PYWmaMEPhvxw5jQ+yIngDscVLMRzfzoqj5m4X97pnkRpqrvKFP7q8mkDddQxuDT8lSDhqsEI3g3AtHHXZHLfGyAkvCrkoYKdZVPZUVE+y0C4XcCF7dy9bVUPJnJ0zZPkG4LMGhH94oMIn3zAhz2/o6tj4+XPblKfVSBRXEBQCCWWOMbCci1lxvUhgeE/gaj1ur3OQN5zK32N2Vw0zYsA5iU1zXk9bM7eCK6Z9xJ1x/GrocXuDfK1Zym3jgCMNLx9rZtNfBuiw+HXqCrKneN629kTObk7TWKFBACwXUED0BOFfVPVjjT1gdTMQgSTCRnQyS03jkdGVNwwffTaK60PI6tFX3NaOXGtoW1OPOPKgLAtfE3IRWVVCvbIIGQnGy111OW6dxM7hbwt0eYz01RunJXg9L90maWTPajQHfLWn7aGMmQgTREwCXdnecthPm6obvK7tLjCe0Fchg+tsqmoSLf3ZcQrV7ze1mdbM2hZmbDBft9bvsu9em8l1ibOMOK5tpbddUnrum8msGUthn38H3++D1KxgQ+5ITY/8bV4YFK8mWY35foMEZiRLRxwAAM4kDI/R5rBlzga4ZlwSnoQM/PdT8NSvAPhzkarB5mh6M8VteI6BQNP3U7m/d3G9yA5wIe6cnBdaIe0LSqfqmPnh12TS6lsbEE0xZWsN7pNq1jqDNJiDWfj+WI+JvEL0FUJqmdX0Ee8UtsYUryzUtbgU+MFntEzJGax7mgSBOHEzEfWPE7YhvNuK1nf+NAl/d8ImBWQNe+0JycELIeVMHeT3LyNagnVtk22HKC2wQvtNR++Nu7vGjxNybi4tm4WbZRfgdorcAjHj5p8ebO2QnjtHko6aPZwEwbWbvM9c3fIhI176wskA1Iea1hZ6sW5WAp0VtusY+sK3NFDSkSk+hec7iJSElGm2tmavgGtHge48KONpifVvHkk3Tb6Hhbxf2+vT8rseE6AmgaReeh8PeDCYzn+naCSd/GSd3CdxErpc6qrpwctv05kEbqpu4Okg8skue5VIJnVn689X6iOY5NigfTIKXT/t/njMMx4Oy9uEsIsch1WDW3sLUFEsIWjoy5hAZxAUINGUJ7nvXDP0yBdvU7uZ09V07oXfr8vzYMb+mWpvg5ndwZGgwaSvTOCjE1VfpSS7Y5JdZO5Q0KMz63hpmsMBpy/jXxAijOTYROBPMQjIGfvhW5KAV8DY3eCYX4GImzwcjYh4RInoLoG58smfUqkkfGLJW4wQU4KWxd5nJ623qa/DOeamOBNj6t2WFKg25x1ytoAZP3z0vKyPY/eiPiran+oRxAd4Xa5IzgfT71QxvnImdNhxUNfrBYUcOtt/kYiTGevC7W9k44gIIARjUttR6TnzoVJoPbueb5wkQoGu2Op90nDqCo8CC6nz7g+ybhLnu1aRdRFw3aXHmcFgFHKSiulh7YQAYQQ9yVgLHH5vW3jjypDrYs2SW6Bi1UHUzzO25DsZJoTofmPExQUWR8cNCCMCatoA31T3NwSek20fO99s7wa67lk4TsWuBwHN/uGnO6oZPozsUaHSN6p2HmsfubNus4Gr/cWNelhE2W7Kx+KGtkeM248ASimYBUbPc6sbMGyE7RjaQya6V7XNpQyI1MIQyerOTtu0QCAFgdn7xV90EgeBXhuiDgAJBzBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEEQMIQCBIGIIAQgEEUMIQCCIGEIAAkHEEAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEEQMIQCBIGIIAQgEEUMIQCCIGEIAAkHEEAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEEQMIQCBIGIIAQgEEUMIQCCIGEIAAkHEEAIQCCKGEIBAEDGEAASCiCEEIBBEDCEAgSBiCAEIBBFDCEAgiBhCAAJBxBACEAgihhCAQBAxhAAEgoghBCAQRAwhAIEgYggBCAQRQwhAIIgYQgACQcQQAhAIIoYQgEAQMYQABIKIIQQgEESM/w9rGyP9rnSV2gAAAABJRU5ErkJggg==";
const ICON_512_B64 = "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";

app.get("/icons/icon-192.png", (_req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000");
  res.send(Buffer.from(ICON_192_B64, "base64"));
});
app.get("/icons/icon-512.png", (_req, res) => {
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000");
  res.send(Buffer.from(ICON_512_B64, "base64"));
});


// VENUE PHOTO PROXY (custom URLs or Google Places)
app.get("/api/venue-photo/:id", async (req, res) => {
  try {
    const venueId = parseInt(req.params.id);
    const idx = parseInt(req.query.idx) || 0; // photo index (0 = first)
    const w = parseInt(req.query.w) || 400;

    // Priority 1: Custom photos from venue_photos table
    const photos = await pool.query(
      `SELECT url FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]
    );
    if (photos.rowCount > 0 && photos.rows[idx]) {
      return res.redirect(photos.rows[idx].url);
    }

    // Priority 2: Google Places photo
    const vr = await pool.query(`SELECT google_place_id FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
    if (vr.rowCount === 0) return res.status(404).send("not found");
    const key = process.env.GOOGLE_MAPS_KEY || "";
    if (!key || !vr.rows[0].google_place_id) return res.status(404).send("no photo");
    const placeId = vr.rows[0].google_place_id;
    const https = require("https");
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=photos&key=${key}`;
    https.get(detailUrl, (resp) => {
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => {
        try {
          const j = JSON.parse(data);
          const ref = j?.result?.photos?.[0]?.photo_reference;
          if (!ref) return res.status(404).send("no photo ref");
          const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photo_reference=${ref}&key=${key}`;
          res.redirect(photoUrl);
        } catch(e) { res.status(500).send("parse err"); }
      });
    }).on("error", () => res.status(500).send("fetch err"));
  } catch(e) { res.status(500).send("error"); }
});


// GET /api/static-map — proxy for Google Static Maps API (bypasses referrer restrictions)
app.get("/api/static-map", async (req, res) => {
  try {
    const key = process.env.GOOGLE_MAPS_KEY || "";
    if (!key) return res.status(503).send("Maps key not configured");
    const venues = (req.query.venues || "").split("|").filter(Boolean).slice(0, 20);
    const markers = venues.map(v => `markers=color:0xFF8A00%7C${v}`).join("&");
    const center = req.query.center || "52.2297,21.0122";
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${center}&zoom=12&size=600x300&scale=2&maptype=roadmap&style=feature:all|element:geometry|color:0x0a0b14&style=feature:road|element:geometry|color:0x1a1b2e&style=feature:water|element:geometry|color:0x0d1020&style=feature:all|element:labels.text.fill|color:0x6a6a7a&style=feature:poi|visibility:off&style=feature:transit|visibility:off&${markers}&key=${key}`;
    const https = require("https");
    https.get(url, (proxyRes) => {
      res.setHeader("Content-Type", proxyRes.headers["content-type"] || "image/png");
      res.setHeader("Cache-Control", "public, max-age=300");
      proxyRes.pipe(res);
    }).on("error", () => res.status(500).send("map error"));
  } catch(e) { res.status(500).send("error"); }
});

// PUBLIC VENUE TEASER PAGE
app.get("/venue/:id", async (req, res) => {
  try {
    const venueId = parseInt(req.params.id);
    if (!venueId) return res.status(404).send("Not found");
    const vr = await pool.query(`SELECT id,name,city,address,venue_type,cuisine,tags,description,is_trial,discount_percent,opening_hours,status_temporary,google_place_id FROM fp1_venues WHERE id=$1 AND approved=TRUE LIMIT 1`, [venueId]);
    const v = vr.rows[0];
    if (!v) return res.status(404).send(pageShell("Nie znaleziono",'<div class="card"><h1>Lokal nie znaleziony</h1></div>'));
    const cv = await pool.query(`SELECT COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`,[venueId]);
    const uf = await pool.query(`SELECT COUNT(DISTINCT user_id)::int AS cnt FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`,[venueId]);
    const visits=cv.rows[0]?.cnt||0, foxes=uf.rows[0]?.cnt||0;
    const disc=parseFloat(v.discount_percent)||10;
    const tgs=v.tags?v.tags.split(",").map(t=>t.trim()).filter(Boolean):[];
    const vB=tgs.includes("vegan")?`<span style="background:#1a3a1a;color:#4ade80;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">Vegan</span>`:"";
    const gB=tgs.includes("gluten-free")?`<span style="background:#3a2a0a;color:#fbbf24;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">Gluten-free</span>`:"";
    const tpL=[v.venue_type,v.cuisine].filter(Boolean).join(" \u00b7 ");
    const stH=v.status_temporary?`<div class="card" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.06);padding:14px 16px"><div style="font-size:12px;font-weight:700;color:#FBBF24;margin-bottom:4px">Status</div><div style="font-size:13px;color:rgba(255,255,255,.6)">${escapeHtml(v.status_temporary)}</div></div>`:"";
    const hrH=v.opening_hours?`<div class="card" style="padding:14px 16px"><div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:4px">Godziny otwarcia</div><div style="font-size:13px;color:rgba(255,255,255,.7);line-height:1.6;white-space:pre-line">${escapeHtml(v.opening_hours)}</div></div>`:"";
    const allPhotos = await pool.query(`SELECT url FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC LIMIT 10`, [venueId]);
    const hasPhoto = allPhotos.rowCount > 0 || v.google_place_id;
    let phH = '';
    if (allPhotos.rowCount > 0) {
      phH = `<div style="display:flex;gap:8px;overflow-x:auto;margin:0 auto 16px;max-width:400px;scroll-snap-type:x mandatory">${allPhotos.rows.map(p =>
        `<div style="min-width:100%;height:200px;border-radius:18px;overflow:hidden;scroll-snap-align:start;background:rgba(255,255,255,.04)"><img src="${p.url}" style="width:100%;height:100%;object-fit:cover"/></div>`
      ).join('')}</div>${allPhotos.rowCount > 1 ? `<div style="text-align:center;margin-bottom:12px"><span style="font-size:11px;color:rgba(255,255,255,.3)">← przesuń aby zobaczyć więcej →</span></div>` : ''}`;
    } else if (v.google_place_id) {
      phH = `<div style="width:100%;max-width:400px;height:200px;border-radius:18px;overflow:hidden;margin:0 auto 16px;background:rgba(255,255,255,.04)"><img src="/api/venue-photo/${v.id}?w=400" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='&#129418;'"/></div>`;
    } else {
      phH = `<div style="font-size:48px;margin-bottom:12px">&#129418;</div>`;
    }
    res.send(pageShell(`${v.name} \u2014 The FoxPot Club`,`
      <div style="text-align:center;padding:32px 16px 16px">${phH}<div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,.4)">The FoxPot Club</div></div>
      <div class="card" style="text-align:center"><h1 style="font-size:24px;margin-bottom:6px">${escapeHtml(v.name)}</h1>${tpL?`<p style="color:rgba(255,255,255,.5);font-size:13px;margin-bottom:10px">${escapeHtml(tpL)}</p>`:""}<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:16px">${vB}${gB}</div><p style="font-size:14px;color:rgba(255,255,255,.7)">${escapeHtml(v.address||"")}${v.city?", "+escapeHtml(v.city):""}</p>${v.description?`<p style="font-size:13px;color:rgba(255,255,255,.5);margin-top:10px;line-height:1.5">${escapeHtml(v.description)}</p>`:""}</div>
      ${stH}${hrH}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:8px 0"><div class="card" style="text-align:center;padding:14px 8px"><div style="font-size:24px;font-weight:800;color:#f5a623">${disc}%</div><div style="font-size:11px;color:rgba(255,255,255,.4)">zni&#380;ka</div></div><div class="card" style="text-align:center;padding:14px 8px"><div style="font-size:24px;font-weight:800;color:#7c5cfc">${visits}</div><div style="font-size:11px;color:rgba(255,255,255,.4)">wizyt</div></div><div class="card" style="text-align:center;padding:14px 8px"><div style="font-size:24px;font-weight:800;color:#2ecc71">${foxes}</div><div style="font-size:11px;color:rgba(255,255,255,.4)">Fox'&#243;w</div></div></div>
      <div style="text-align:center;margin:4px 0 8px;font-size:12px;color:rgba(255,255,255,.4)">${visits > 0 ? `&#10003; ${visits} zweryfikowanych wizyt w tym lokalu` : 'Nowy lokal w FoxPot Club!'}</div>
      <div class="card" style="text-align:center;padding:24px 16px;border-color:rgba(245,166,35,.3);background:rgba(245,166,35,.06)"><div style="font-size:28px;margin-bottom:8px">&#128274;</div><h2 style="font-size:16px;margin-bottom:6px;color:#f5a623">Odblokuj zni&#380;k&#281; ${disc}% jako Fox</h2><p style="font-size:13px;color:rgba(255,255,255,.5);margin-bottom:16px;line-height:1.5">The FoxPot Club to prywatny klub dla smakoszy.<br/>Odwied&#378; ${escapeHtml(v.name)} i aktywuj dost&#281;p!</p><a href="https://t.me/thefoxpot_club_bot?start=venue_${v.id}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#f5a623,#e8842a);color:#000;font-weight:700;border-radius:14px;font-size:15px;text-decoration:none">&#129418; Do&#322;&#261;cz przez ${escapeHtml(v.name)}</a><p style="font-size:11px;color:rgba(255,255,255,.3);margin-top:12px">Masz 60 minut aby zrobi&#263; check-in i aktywowa&#263; konto Fox</p></div>
      <div style="text-align:center;padding:20px;font-size:11px;color:rgba(255,255,255,.25)"><a href="/" style="color:rgba(255,255,255,.35)">thefoxpot.club</a></div>
    `,`body{background:#0a0b14}.card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:18px}`));
  } catch(e) { console.error("venue teaser err:",e); res.status(500).send("Error"); }
});

// Public venue page by slug: /lokal/zloty-kebab
app.get("/lokal/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug).toLowerCase().trim();
    const vr = await pool.query(
      `SELECT id,name,slug,city,address,lat,lng,venue_type,cuisine,tags,description,is_trial,
              discount_percent,opening_hours,status_temporary,google_place_id,pioneer_number,
              instagram_url,facebook_url,tiktok_url,youtube_url,website_url,menu_file_url,phone
       FROM fp1_venues WHERE slug=$1 AND approved=TRUE LIMIT 1`, [slug]
    );
    if (vr.rowCount === 0) return res.status(404).send(pageShell("Nie znaleziono",'<div style="text-align:center;padding:60px 20px"><h1 style="font-size:24px;margin-bottom:12px">Lokal nie znaleziony</h1><a href="/" style="color:#E8751A">← Strona główna</a></div>'));
    const v = vr.rows[0];
    const e = escapeHtml;
    const disc = parseFloat(v.discount_percent) || 10;
    const cv = await pool.query(`SELECT COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`, [v.id]);
    const uf = await pool.query(`SELECT COUNT(DISTINCT user_id)::int AS cnt FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`, [v.id]);
    const visits = cv.rows[0]?.cnt || 0, foxes = uf.rows[0]?.cnt || 0;
    // Review stats for public page
    const pubReviewStats = await pool.query(`SELECT COUNT(rating)::int AS rated_cnt, COALESCE(AVG(rating),0)::numeric AS avg_rating, COUNT(*)::int AS total_cnt FROM fp1_reviews WHERE venue_id=$1`, [v.id]);
    const pubRated = pubReviewStats.rows[0].rated_cnt;
    const pubAvg = pubRated > 0 ? parseFloat(parseFloat(pubReviewStats.rows[0].avg_rating).toFixed(1)) : null;
    const photos = await pool.query(`SELECT url FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC LIMIT 10`, [v.id]);
    const menuItems = await pool.query(`SELECT name,category,price,photo_url FROM fp1_menu_items WHERE venue_id=$1 ORDER BY sort_order,name`, [v.id]);
    const menuFiles = await pool.query(`SELECT url FROM fp1_venue_menu_files WHERE venue_id=$1 ORDER BY sort_order ASC`, [v.id]);
    const tgs = v.tags ? v.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
    const firstPhoto = photos.rows[0]?.url || (v.google_place_id ? `/api/venue-photo/${v.id}?w=800` : null);
    const canonicalUrl = `${PUBLIC_URL}/lokal/${v.slug}`;
    const tpL = [v.venue_type, v.cuisine].filter(Boolean).join(" · ");
    const metaTitle = `${v.name}${tpL ? ' — ' + tpL : ''}, ${v.city || 'Warszawa'} | FoxPot Club`.slice(0, 60);
    const metaDesc = `Odkryj ${v.name} w ${e(v.address || v.city || 'Warszawa')}. ${tpL ? tpL + '. ' : ''}Sprawdź menu i dołącz do FoxPot Club — zniżka min. ${disc}%!`.slice(0, 160);

    // Group menu by category
    const menuCats = {};
    const catLabels = {main:'Dania główne',snack:'Przekąski',soup:'Zupy',dessert:'Desery',drink:'Napoje',alcohol:'Alkohole'};
    menuItems.rows.forEach(m => { const c = m.category || 'main'; if (!menuCats[c]) menuCats[c] = []; menuCats[c].push(m); });

    // Social links
    const socials = [
      v.instagram_url ? `<a href="${e(v.instagram_url)}" target="_blank" rel="noopener noreferrer" style="color:#E1306C;font-size:24px;text-decoration:none">📸</a>` : '',
      v.facebook_url ? `<a href="${e(v.facebook_url)}" target="_blank" rel="noopener noreferrer" style="color:#1877F2;font-size:24px;text-decoration:none">👍</a>` : '',
      v.tiktok_url ? `<a href="${e(v.tiktok_url)}" target="_blank" rel="noopener noreferrer" style="color:#00f2ea;font-size:24px;text-decoration:none">🎵</a>` : '',
      v.youtube_url ? `<a href="${e(v.youtube_url)}" target="_blank" rel="noopener noreferrer" style="color:#FF0000;font-size:24px;text-decoration:none">▶️</a>` : '',
      v.website_url ? `<a href="${e(v.website_url)}" target="_blank" rel="noopener noreferrer" style="color:#f5a623;font-size:24px;text-decoration:none">🌐</a>` : '',
    ].filter(Boolean).join(' ');

    // JSON-LD Schema
    const schema = JSON.stringify({
      "@context": "https://schema.org", "@type": "Restaurant",
      name: v.name, image: firstPhoto || undefined,
      address: { "@type": "PostalAddress", streetAddress: v.address || '', addressLocality: v.city || 'Warszawa', addressCountry: "PL" },
      geo: v.lat && v.lng ? { "@type": "GeoCoordinates", latitude: parseFloat(v.lat), longitude: parseFloat(v.lng) } : undefined,
      url: canonicalUrl,
      servesCuisine: v.cuisine || undefined,
      openingHours: v.opening_hours || undefined,
      aggregateRating: pubRated > 0 ? { "@type": "AggregateRating", ratingValue: pubAvg, reviewCount: pubRated, bestRating: 5, worstRating: 1 } : undefined,
    });

    // Menu HTML
    const menuH = Object.keys(menuCats).length > 0 ? `<div style="margin-bottom:24px">
      <h2 style="font-size:18px;font-weight:800;margin-bottom:12px">🍽 Menu</h2>
      ${Object.entries(menuCats).map(([cat, items]) => `
        <div style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#E8751A;margin-bottom:8px">${e(catLabels[cat] || cat)}</div>
          ${items.map(m => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
            ${m.photo_url ? `<img src="${m.photo_url}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0"/>` : ''}
            <div style="flex:1"><div style="font-size:14px;font-weight:600">${e(m.name)}</div></div>
            ${m.price ? `<div style="font-size:14px;font-weight:700;color:#E8751A;flex-shrink:0">${parseFloat(m.price).toFixed(0)} zł</div>` : ''}
          </div>`).join('')}
        </div>
      `).join('')}
    </div>` : '';
    const mfFiles = menuFiles.rows.length ? menuFiles.rows : (v.menu_file_url ? [{ url: v.menu_file_url }] : []);
    const mfImages = mfFiles.filter(f => !f.url.toLowerCase().endsWith('.pdf'));
    const mfPdfs = mfFiles.filter(f => f.url.toLowerCase().endsWith('.pdf'));
    const mfHeader = !menuH && mfFiles.length ? '<h2 style="font-size:18px;font-weight:800;margin-bottom:12px">🍽 Menu</h2>' : '';
    const menuFileH = mfFiles.length ? `<div style="margin-bottom:24px">${mfHeader}${mfImages.length ? `
      <div style="display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:8px">
        ${mfImages.map((f, i) => `<div style="flex:0 0 140px;scroll-snap-align:start;aspect-ratio:3/4;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);cursor:pointer;background:rgba(255,255,255,.04)" onclick="openMenuSlider(${i})"><img src="${e(f.url)}" style="width:100%;height:100%;object-fit:cover" loading="lazy"/></div>`).join('')}
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,.3);text-align:center;margin-top:4px">${mfImages.length > 1 ? 'Przewiń → lub kliknij aby powiększyć' : 'Kliknij aby powiększyć'}</div>` : ''}${mfPdfs.map(f => `<div style="margin-top:8px"><a href="${e(f.url)}" target="_blank" rel="noopener noreferrer" style="display:block;padding:10px;text-align:center;background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.2);border-radius:10px;color:#f5a623;font-weight:600;font-size:13px;text-decoration:none">📄 Otwórz menu (PDF)</a></div>`).join('')}
    </div>` : '';
    const menuFileUrls = JSON.stringify(mfImages.map(f => f.url));
    const galleryUrls = JSON.stringify(photos.rows.map(p => p.url));

    // Photos gallery
    const galleryH = photos.rowCount > 1 ? `<div style="margin-bottom:24px">
      <h2 style="font-size:18px;font-weight:800;margin-bottom:12px">📸 Zdjęcia</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">
        ${photos.rows.map((p, i) => `<div style="aspect-ratio:1;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.04);cursor:pointer" onclick="openGallerySlider(${i})"><img src="${p.url}" style="width:100%;height:100%;object-fit:cover" loading="lazy"/></div>`).join('')}
      </div>
    </div>` : '';

    // Map
    const mapH = v.lat && v.lng ? `<div style="margin-bottom:24px">
      <h2 style="font-size:18px;font-weight:800;margin-bottom:12px">📍 Lokalizacja</h2>
      <div style="border-radius:12px;overflow:hidden;height:200px;margin-bottom:8px">
        <iframe src="https://maps.google.com/maps?q=${v.lat},${v.lng}&z=16&output=embed" style="width:100%;height:100%;border:0" loading="lazy" allowfullscreen></iframe>
      </div>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}" target="_blank" rel="noopener noreferrer" style="display:block;padding:12px;text-align:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;font-weight:600;font-size:14px;text-decoration:none">🗺️ Otwórz w Mapach Google</a>
    </div>` : '';

    res.send(`<!DOCTYPE html><html lang="pl"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${e(metaTitle)}</title>
<meta name="description" content="${e(metaDesc)}"/>
<meta property="og:title" content="${e(metaTitle)}"/>
<meta property="og:description" content="${e(metaDesc)}"/>
<meta property="og:url" content="${canonicalUrl}"/>
<meta property="og:type" content="restaurant"/>
${firstPhoto ? `<meta property="og:image" content="${firstPhoto}"/>` : ''}
<meta name="twitter:card" content="summary_large_image"/>
<link rel="canonical" href="${canonicalUrl}"/>
<script type="application/ld+json">${schema}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#f0f0f5;line-height:1.6}
.wrap{max-width:640px;margin:0 auto}
.hero{position:relative;height:280px;overflow:hidden;background:#12121f}
.hero img{width:100%;height:100%;object-fit:cover}
.hero-overlay{position:absolute;inset:0;background:linear-gradient(transparent 40%,rgba(26,26,46,.95))}
.hero-text{position:absolute;bottom:20px;left:20px;right:20px;z-index:1}
.hero-text h1{font-size:28px;font-weight:800;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.hero-text p{font-size:14px;color:rgba(255,255,255,.7)}
.section{padding:16px 20px}
.badge-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.info-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:14px;color:rgba(255,255,255,.7)}
.cta-box{background:linear-gradient(135deg,rgba(232,117,26,.15),rgba(232,117,26,.05));border:1px solid rgba(232,117,26,.3);border-radius:16px;padding:24px 20px;text-align:center;margin:16px 20px 32px}
.cta-btn{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#E8751A,#f5a623);color:#000;font-weight:700;border-radius:12px;font-size:15px;text-decoration:none}
.nav-bar{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.06)}
.nav-bar a{color:#E8751A;text-decoration:none;font-weight:700;font-size:14px}
.verified{display:flex;align-items:center;gap:6px;padding:10px 16px;background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.15);border-radius:10px;font-size:13px;color:#2ecc71;font-weight:600}
</style></head><body>
<div class="wrap">
  <div class="nav-bar"><a href="/">🦊 FoxPot Club</a>${socials ? `<div style="display:flex;gap:12px">${socials}</div>` : ''}</div>
  <div class="hero">${firstPhoto ? `<img src="${firstPhoto}" alt="${e(v.name)}"/>` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:64px">🏪</div>`}<div class="hero-overlay"></div><div class="hero-text"><h1>${e(v.name)}</h1>${tpL ? `<p>${e(tpL)}</p>` : ''}${pubRated > 0 ? `<p style="margin-top:4px;font-size:15px;color:#f5a623;font-weight:700">⭐ ${pubAvg} <span style="color:rgba(255,255,255,.5);font-weight:400;font-size:13px">(${pubRated} opinii Fox'ów)</span></p>` : ''}</div></div>

  <div class="section">
    ${v.address ? `<div class="info-row">📍 ${e(v.address)}${v.city ? ', ' + e(v.city) : ''}</div>` : ''}
    ${v.opening_hours ? `<div class="info-row" style="white-space:pre-line">🕐 ${e(v.opening_hours)}</div>` : ''}
    ${v.status_temporary ? `<div class="info-row" style="color:#FBBF24">⚠️ ${e(v.status_temporary)}</div>` : ''}
    <div style="display:flex;gap:8px;margin:12px 0">
      ${v.lat && v.lng ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}" target="_blank" rel="noopener noreferrer" style="flex:1;padding:10px;text-align:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#fff;font-size:13px;font-weight:600;text-decoration:none">🗺️ Nawiguj</a>` : ''}
      ${v.phone ? `<a href="tel:${e(v.phone.replace(/\s/g,''))}" style="flex:1;padding:10px;text-align:center;background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.2);border-radius:8px;color:#2ecc71;font-size:13px;font-weight:600;text-decoration:none">📞 Zadzwoń</a>` : ''}
    </div>
  </div>

  <div class="section"><div class="verified">✓ ${visits > 0 ? `${visits} zweryfikowanych wizyt w FoxPot Club` : 'Nowy lokal w FoxPot Club!'}</div></div>

  <div class="section">
    <div class="badge-bar">
      <span class="badge" style="background:rgba(232,117,26,.15);color:#E8751A">🎁 ${disc}% zniżki</span>
      ${tgs.includes('vegan') ? '<span class="badge" style="background:#1a3a1a;color:#4ade80">🌱 Vegan</span>' : ''}
      ${tgs.includes('gluten-free') ? '<span class="badge" style="background:#3a2a0a;color:#fbbf24">Gluten-free</span>' : ''}
      ${v.pioneer_number ? `<span class="badge" style="background:rgba(255,215,0,.1);color:#ffd700">👑 Pionier #${v.pioneer_number}</span>` : ''}
    </div>
    ${v.description ? `<p style="font-size:14px;color:rgba(255,255,255,.7);line-height:1.7">${e(v.description)}</p>` : ''}
  </div>

  <div class="section">${menuH}${menuFileH}</div>
  <div class="section">${galleryH}</div>
  <div class="section">${mapH}</div>

  <div class="cta-box">
    <div style="font-size:28px;margin-bottom:8px">🦊</div>
    <h2 style="font-size:18px;font-weight:800;margin-bottom:8px;color:#E8751A">Dołącz do FoxPot Club</h2>
    <p style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:16px;line-height:1.5">Zniżki w najlepszych lokalach. Sprawdź ${e(v.name)} i oszczędzaj!</p>
    <a class="cta-btn" href="https://t.me/thefoxpot_club_bot?start=venue_${v.id}">🦊 Dołącz teraz</a>
  </div>

  <div style="text-align:center;padding:20px;font-size:11px;color:rgba(255,255,255,.2)">
    <a href="/" style="color:rgba(255,255,255,.3);text-decoration:none">thefoxpot.club</a> · <a href="/rules" style="color:rgba(255,255,255,.3);text-decoration:none">Regulamin</a> · <a href="/privacy" style="color:rgba(255,255,255,.3);text-decoration:none">Prywatność</a>
  </div>
<div id="foxLightbox" onclick="if(event.target===this)closeLightbox()" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);align-items:center;justify-content:center">
  <img id="foxLightboxImg" src="" style="max-width:92%;max-height:85vh;border-radius:12px;object-fit:contain"/>
  <div onclick="closeLightbox()" style="position:fixed;top:14px;right:18px;font-size:28px;color:#fff;font-weight:700;cursor:pointer;z-index:10000">✕</div>
  <div id="foxLbPrev" onclick="event.stopPropagation();lbNav(-1)" style="display:none;position:fixed;left:8px;top:50%;transform:translateY(-50%);font-size:36px;color:#fff;cursor:pointer;padding:12px;z-index:10000">‹</div>
  <div id="foxLbNext" onclick="event.stopPropagation();lbNav(1)" style="display:none;position:fixed;right:8px;top:50%;transform:translateY(-50%);font-size:36px;color:#fff;cursor:pointer;padding:12px;z-index:10000">›</div>
  <div id="foxLbCounter" style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.5);font-size:13px;z-index:10000"></div>
</div>
<script>
let _lbImages=[],_lbIdx=0;
function openMenuSlider(i){_lbImages=${menuFileUrls};_lbIdx=i;showLb();}
function openGallerySlider(i){_lbImages=${galleryUrls};_lbIdx=i;showLb();}
function openLbSingle(src){_lbImages=[src];_lbIdx=0;showLb();}
function showLb(){
  var lb=document.getElementById('foxLightbox'),img=document.getElementById('foxLightboxImg');
  img.src=_lbImages[_lbIdx];lb.style.display='flex';
  document.getElementById('foxLbPrev').style.display=_lbImages.length>1?'block':'none';
  document.getElementById('foxLbNext').style.display=_lbImages.length>1?'block':'none';
  var c=document.getElementById('foxLbCounter');
  c.textContent=_lbImages.length>1?(_lbIdx+1)+' / '+_lbImages.length:'';
}
function lbNav(d){_lbIdx=(_lbIdx+d+_lbImages.length)%_lbImages.length;showLb();}
function closeLightbox(){document.getElementById('foxLightbox').style.display='none';}
document.addEventListener('keydown',function(e){
  if(document.getElementById('foxLightbox').style.display!=='flex')return;
  if(e.key==='Escape')closeLightbox();
  if(e.key==='ArrowLeft')lbNav(-1);
  if(e.key==='ArrowRight')lbNav(1);
});
</script>
</div></body></html>`);
  } catch(e) { console.error("lokal page err:", e); res.status(500).send("Błąd"); }
});

// Dynamic sitemap
app.get("/sitemap.xml", async (_req, res) => {
  try {
    const venues = await pool.query(`SELECT slug FROM fp1_venues WHERE approved=TRUE AND slug IS NOT NULL ORDER BY id`);
    const urls = [
      `<url><loc>${PUBLIC_URL}/</loc><priority>1.0</priority></url>`,
      `<url><loc>${PUBLIC_URL}/faq</loc></url>`,
      `<url><loc>${PUBLIC_URL}/rules</loc></url>`,
      `<url><loc>${PUBLIC_URL}/privacy</loc></url>`,
      `<url><loc>${PUBLIC_URL}/partners</loc></url>`,
      ...venues.rows.map(v => `<url><loc>${PUBLIC_URL}/lokal/${v.slug}</loc></url>`)
    ];
    res.setHeader("Content-Type", "application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  } catch(e) { res.status(500).send("Error"); }
});

app.get("/robots.txt", (_req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(`User-agent: *\nAllow: /\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`);
});

app.get("/health", async (_req, res) => {
  try {
    const now = await dbNow(), spots = await founderSpotsLeft();
    res.json({ ok:true, db:true, tz:"Europe/Warsaw", day_warsaw:warsawDayKey(), now, founder_spots_left:spots });
  } catch (e) { res.status(500).json({ ok:false, db:false, error:String(e?.message||e) }); }
});

app.get("/pwa", (_req, res) => {
  res.sendFile(path.join(__dirname, "pwa.html"));
});

app.get("/webapp", (_req, res) => {
  res.sendFile(path.join(__dirname, "webapp.html"));
});

/* ── PWA Auth: Telegram Login Widget ── */
app.post("/api/pwa-auth", async (req, res) => {
  try {
    const data = req.body;
    const { hash, ...fields } = data;
    // BOT_TOKEN already defined at top of file
    if (!BOT_TOKEN) return res.status(500).json({ error: "Bot token not configured" });
    const checkString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n");
    const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
    if (expectedHash !== hash) return res.status(401).json({ error: "Nieprawidłowy podpis Telegram" });
    const authDate = parseInt(fields.auth_date);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) return res.status(401).json({ error: "Sesja wygasła. Zaloguj się ponownie." });
    const userId = String(fields.id);
    const fox = await pool.query("SELECT id FROM fp1_foxes WHERE user_id=$1", [userId]);
    if (!fox.rows.length) return res.status(403).json({ error: "Nie jesteś zarejestrowany w FoxPot. Otwórz bota @thefoxpot_club_bot i dołącz przez zaproszenie." });
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO fp1_pwa_sessions (tg_id, token, expires_at, created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (tg_id) DO UPDATE SET token=$2, expires_at=$3, created_at=NOW()`,
      [userId, token, expiresAt]
    );
    // Set PWA cookie — працює в iOS Safari PWA
    res.setHeader("Set-Cookie", `${PWA_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(PWA_TTL_MS / 1000)}`);
    res.json({ ok: true, token, user: { id: userId, first_name: fields.first_name, username: fields.username } });
  } catch(e) {
    console.error("[PWA Auth]", e.message);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   V20: API ROUTES
═══════════════════════════════════════════════════════════════ */

// GET /api/profile
app.get("/api/profile", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(404).json({ error: "nie zarejestrowany" });

    // On-demand trial expiry
    await checkTrialExpiry(userId);
    // Re-fetch after possible expiry update
    const foxRefresh = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    const f_orig = foxRefresh.rows[0];

    const f = f_orig;
    const totalVisits = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [userId]);
    const spunToday   = await hasSpunToday(userId);
    const savedStats = await pool.query(`SELECT COALESCE(SUM(discount_saved),0)::numeric AS total_saved, COUNT(*)::int AS receipt_count FROM fp1_receipts WHERE user_id=$1`, [userId]);
    const foxBadges = await getTopFoxBadges();
    const myTopBadge = foxBadges[userId] || null;

    // Stamps per venue
    const stampsQ = await pool.query(
      `SELECT s.venue_id, v.name AS venue_name, s.emoji, SUM(s.delta)::int AS balance
       FROM fp1_stamps s JOIN fp1_venues v ON v.id=s.venue_id
       WHERE s.user_id=$1 GROUP BY s.venue_id, v.name, s.emoji HAVING SUM(s.delta)>0
       ORDER BY v.name`, [userId]
    );

    res.json({
      user_id:                  f.user_id,
      username:                 f.username,
      rating:                   f.rating,
      invites:                  f.invites,
      city:                     f.city,
      district:                 f.district,
      country:                  f.country || "Polska",
      founder_number:           f.founder_number,
      streak_current:           f.streak_current || 0,
      streak_best:              f.streak_best    || 0,
      streak_freeze_available:  f.streak_freeze_available || 0,
      total_visits:             totalVisits.rows[0].c,
      spun_today:               !!spunToday,
      spin_prize:               spunToday?.prize_label || null,
      total_saved:              parseFloat(savedStats.rows[0].total_saved),
      receipt_count:            savedStats.rows[0].receipt_count,
      stamps:                   stampsQ.rows,
      data_contributions:       f.data_contributions || 0,
      is_demo:                  !!f.is_demo,
      demo_venue_id:            f.demo_venue_id || null,
      demo_expires_at:          f.demo_expires_at || null,
      // Trial system
      trial_active:             !!f.trial_active,
      trial_origin_venue_id:    f.trial_origin_venue_id || null,
      trial_expires_at:         f.trial_expires_at || null,
      trial_blocked_venue_id:   f.trial_blocked_venue_id || null,
      trial_blocked_until:      f.trial_blocked_until || null,
      join_source:              f.join_source || null,
      consent_given:            !!(f.consent_at && f.consent_version === CONSENT_VERSION),
      // Social subscriptions
      sub_instagram:            !!f.sub_instagram,
      sub_tiktok:               !!f.sub_tiktok,
      sub_youtube:              !!f.sub_youtube,
      sub_telegram:             !!f.sub_telegram,
      sub_facebook:             !!f.sub_facebook,
      sub_bonus_claimed:        !!f.sub_bonus_claimed,
      top_badge:                isAdmin(userId) ? null : myTopBadge,
      is_admin:                 isAdmin(userId),
    });
  } catch (e) {
    console.error("API_PROFILE_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});


// GET /api/maps-key — повертає Google Maps ключ тільки авторизованим юзерам
app.get("/api/maps-key", requireWebAppAuth, (_req, res) => {
  const key = process.env.GOOGLE_MAPS_KEY || "";
  if (!key) return res.status(503).json({ error: "Maps key not configured" });
  res.json({ key });
});

// GET /api/places-autocomplete — proxy for Google Places (no key exposure)
app.get("/api/places-autocomplete", async (req, res) => {
  try {
    const key = process.env.GOOGLE_MAPS_KEY || "";
    if (!key) return res.json({ predictions: [] });
    const input = String(req.query.input || "").trim();
    const city = String(req.query.city || "").trim();
    if (!input || input.length < 2) return res.json({ predictions: [] });
    if (rateLimit(`places:${req.ip}`, 30, 60*1000)) return res.status(429).json({ predictions: [] });
    const location = city ? `&locationbias=circle:30000@${encodeURIComponent(city)}` : "";
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=establishment&components=country:pl&language=pl&key=${key}${location}`;
    const resp = await fetch(url);
    const data = await resp.json();
    res.json({
      predictions: (data.predictions || []).slice(0, 5).map(p => ({
        place_id: p.place_id,
        name: p.structured_formatting?.main_text || p.description,
        address: p.structured_formatting?.secondary_text || "",
        description: p.description
      }))
    });
  } catch (e) { res.json({ predictions: [] }); }
});

// GET /api/venues
app.get("/api/venues", async (req, res) => {
  try {
    let userId = null;
    let isFox = false;
    let trialState = null;
    // Extract userId from TG initData or JWT
    try {
      const init = req.headers["x-telegram-init-data"];
      if (init) {
        const parsed = Object.fromEntries(new URLSearchParams(init));
        if (parsed.user) userId = String(JSON.parse(parsed.user).id);
      }
    } catch(_){}
    if (!userId) {
      try {
        const authH = req.headers.authorization || "";
        if (authH.startsWith("Bearer ")) {
          const decoded = jwt.verify(authH.slice(7), JWT_SECRET);
          if (decoded.fox_id) {
            const fq = await pool.query(`SELECT user_id FROM fp1_foxes WHERE id=$1 AND is_deleted=FALSE LIMIT 1`, [decoded.fox_id]);
            if (fq.rows.length) userId = String(fq.rows[0].user_id);
          }
        }
      } catch(_){}
    }
    if (userId) {
      const foxQ = await pool.query(`SELECT user_id, trial_active, trial_origin_venue_id, trial_expires_at, trial_blocked_venue_id, trial_blocked_until FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (foxQ.rowCount > 0) {
        isFox = true;
        const fx = foxQ.rows[0];
        // On-demand trial expiry
        await checkTrialExpiry(userId);
        if (fx.trial_active || fx.trial_blocked_venue_id) {
          const fresh = await pool.query(`SELECT trial_active, trial_origin_venue_id, trial_expires_at, trial_blocked_venue_id, trial_blocked_until FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
          const t = fresh.rows[0];
          trialState = {
            trial_active: !!t.trial_active,
            trial_origin_venue_id: t.trial_origin_venue_id || null,
            trial_expires_at: t.trial_expires_at || null,
            trial_blocked_venue_id: t.trial_blocked_venue_id || null,
            trial_blocked_until: t.trial_blocked_until || null,
          };
        }
      }
    }
    const r = await pool.query(
     `SELECT id, name, city, address, lat, lng, is_trial, discount_percent, description, recommended, venue_type, cuisine, monthly_visit_limit, tags, opening_hours, status_temporary, google_place_id, pioneer_number, promo_radius, promo_message, promo_active, promo_start, promo_end, phone, menu_file_url FROM fp1_venues WHERE approved=TRUE ORDER BY id ASC LIMIT 100`
    );
    let myVisits = {};
    let totalVisits = {};
    let myMonthlyCredited = {};
    if (userId) {
      const mv = await pool.query(
        `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE GROUP BY venue_id`, [userId]
      );
      mv.rows.forEach(r => myVisits[r.venue_id] = r.cnt);
      // Monthly credited visits per venue (for visit cap display)
      // Check by user_id OR visitor_phone (anti-cheat)
      const foxPhoneQ = await pool.query(`SELECT phone FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      const foxPhoneVal = foxPhoneQ.rows[0]?.phone;
      const mmcQuery = foxPhoneVal
        ? `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits
           WHERE (user_id=$1 OR visitor_phone=$2) AND is_credited=TRUE
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW()) AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW())
           GROUP BY venue_id`
        : `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits
           WHERE user_id=$1 AND is_credited=TRUE
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW()) AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW())
           GROUP BY venue_id`;
      const mmc = await pool.query(mmcQuery, foxPhoneVal ? [userId, foxPhoneVal] : [userId]);
      mmc.rows.forEach(r => myMonthlyCredited[r.venue_id] = r.cnt);
    }
    const tv = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE is_credited=TRUE GROUP BY venue_id`
    );
    tv.rows.forEach(r => totalVisits[r.venue_id] = r.cnt);

    // Trial: remaining slots this month
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const trialUsed = {};
    const tu = await pool.query(
      `SELECT venue_id, COUNT(DISTINCT user_id)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE GROUP BY venue_id`,
      [monthStart.toISOString()]
    );
    tu.rows.forEach(r => trialUsed[r.venue_id] = r.cnt);

    // Weekly visits (for TOP week)
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const wv = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE GROUP BY venue_id`,
      [weekAgo.toISOString()]
    );
    const weeklyVisits = {};
    wv.rows.forEach(r => weeklyVisits[r.venue_id] = r.cnt);

    // Monthly visits (for TOP month)
    const mv2 = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE GROUP BY venue_id`,
      [monthStart.toISOString()]
    );
    const monthlyVisits = {};
    mv2.rows.forEach(r => monthlyVisits[r.venue_id] = r.cnt);

    // Top category per venue
    const tc = await pool.query(
      `SELECT venue_id, category, COUNT(*)::int AS cnt FROM fp1_receipts WHERE category IS NOT NULL GROUP BY venue_id, category`
    );
    const topCategory = {};
    tc.rows.forEach(r => {
      if (!topCategory[r.venue_id] || r.cnt > topCategory[r.venue_id].cnt) topCategory[r.venue_id] = { cat: r.category, cnt: r.cnt };
    });

    // Top reason per venue
    const tr = await pool.query(
      `SELECT venue_id, reason, COUNT(*)::int AS cnt FROM fp1_receipts WHERE reason IS NOT NULL GROUP BY venue_id, reason`
    );
    const topReason = {};
    tr.rows.forEach(r => {
      if (!topReason[r.venue_id] || r.cnt > topReason[r.venue_id].cnt) topReason[r.venue_id] = { reason: r.reason, cnt: r.cnt };
    });

    // Top dish name per venue (from new choice system)
    const tdq = await pool.query(
      `SELECT r.venue_id, d.name, COUNT(*)::int AS cnt
       FROM fp1_receipts r JOIN fp1_venue_dishes d ON d.id = r.dish_id
       WHERE r.dish_id IS NOT NULL GROUP BY r.venue_id, d.name`
    );
    const topDish = {};
    tdq.rows.forEach(r => {
      if (!topDish[r.venue_id] || r.cnt > topDish[r.venue_id].cnt) topDish[r.venue_id] = { name: r.name, cnt: r.cnt };
    });
    // Flatten to just name
    Object.keys(topDish).forEach(k => topDish[k] = topDish[k].name);

    // TOP all-time > year > month > week (1 badge per venue, tiebreak: first to reach count)
    // Week starts Sunday 00:00 Warsaw, Month starts 1st 00:00 Warsaw, Year starts Jan 1
    const warsawNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
    const dayOfWeek = warsawNow.getDay(); // 0=Sunday
    const weekStart = new Date(warsawNow);
    weekStart.setDate(weekStart.getDate() - dayOfWeek);
    weekStart.setHours(0,0,0,0);

    // Recount weekly from Sunday
    const wv2 = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE GROUP BY venue_id`,
      [weekStart.toISOString()]
    );
    const weeklyData = {};
    wv2.rows.forEach(r => weeklyData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    // Recount monthly from 1st
    const monthStart2 = new Date(warsawNow);
    monthStart2.setDate(1); monthStart2.setHours(0,0,0,0);
    const mv3 = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE GROUP BY venue_id`,
      [monthStart2.toISOString()]
    );
    const monthlyData = {};
    mv3.rows.forEach(r => monthlyData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    // Recount yearly from Jan 1
    const yearStart = new Date(warsawNow);
    yearStart.setMonth(0, 1); yearStart.setHours(0,0,0,0);
    const yv = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE created_at >= $1 AND is_credited=TRUE GROUP BY venue_id`,
      [yearStart.toISOString()]
    );
    const yearlyData = {};
    yv.rows.forEach(r => yearlyData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    // All-time with first visit tiebreak
    const allData = {};
    const av = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE is_credited=TRUE GROUP BY venue_id`
    );
    av.rows.forEach(r => allData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    function findTop(data, excludeIds) {
      let topId = null, topCnt = 0, topFirst = null;
      Object.entries(data).forEach(([vid, d]) => {
        if (d.cnt < 1 || excludeIds.includes(Number(vid))) return;
        if (d.cnt > topCnt || (d.cnt === topCnt && (!topFirst || new Date(d.first) < new Date(topFirst)))) {
          topId = Number(vid); topCnt = d.cnt; topFirst = d.first;
        }
      });
      return topId;
    }

    // Exclusive TOP: each venue gets only its highest badge
    // Order: all-time > year > month > week (each excludes already-taken venues)
    const prevYearEnd = new Date(warsawNow); prevYearEnd.setMonth(0, 1); prevYearEnd.setHours(0,0,0,0);
    const hasPrevYear = await pool.query(
      `SELECT 1 FROM fp1_counted_visits WHERE created_at < $1 LIMIT 1`,
      [prevYearEnd.toISOString()]
    );
    const excludeIds = [];
    const topAllTimeId = hasPrevYear.rowCount > 0 ? findTop(allData, []) : null;
    if (topAllTimeId) excludeIds.push(topAllTimeId);
    const topYearId = findTop(yearlyData, excludeIds);
    if (topYearId) excludeIds.push(topYearId);
    const topMonthId = findTop(monthlyData, excludeIds);
    if (topMonthId) excludeIds.push(topMonthId);
    const topWeekId = findTop(weeklyData, excludeIds);

    // Get user's active reservations
    let myReservations = {};
    if (userId) {
      const mr = await pool.query(
        `SELECT venue_id, expires_at FROM fp1_reservations WHERE user_id=$1 AND used=FALSE AND expired=FALSE AND expires_at>NOW()`,
        [userId]
      );
      mr.rows.forEach(r => myReservations[r.venue_id] = r.expires_at);
    }
    // Count active reservations per trial venue (reduce remaining)
    const activeRes = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_reservations WHERE used=FALSE AND expired=FALSE AND expires_at>NOW() GROUP BY venue_id`
    );
    const activeResByVenue = {};
    activeRes.rows.forEach(r => activeResByVenue[r.venue_id] = r.cnt);

    // My stamps per venue
    let myStamps = {};
    if (userId) {
      const ms = await pool.query(
        `SELECT venue_id, emoji, SUM(delta)::int AS balance FROM fp1_stamps WHERE user_id=$1 GROUP BY venue_id, emoji HAVING SUM(delta)>0`,
        [userId]
      );
      ms.rows.forEach(r => myStamps[r.venue_id] = { emoji: r.emoji, balance: r.balance });
    }

    // Active venue statuses (reserve/limited)
    const vsQ = await pool.query(
      `SELECT venue_id, type, reason, ends_at FROM fp1_venue_status WHERE starts_at<=NOW() AND ends_at>NOW()`
    );
    const venueStatuses = {};
    vsQ.rows.forEach(r => venueStatuses[r.venue_id] = { type: r.type, reason: r.reason, ends_at: r.ends_at });

    // Venue photos counts
    const photoCounts = {};
    const pcQ = await pool.query(`SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_venue_photos GROUP BY venue_id`);
    pcQ.rows.forEach(r => photoCounts[r.venue_id] = r.cnt);

    // Review stats per venue (avg rating + count)
    const reviewStatsMap = {};
    const rsQ = await pool.query(`SELECT venue_id, COUNT(*)::int AS review_count, COALESCE(AVG(rating),0)::numeric AS avg_rating, COUNT(rating)::int AS rated_count FROM fp1_reviews GROUP BY venue_id`);
    rsQ.rows.forEach(r => reviewStatsMap[r.venue_id] = { review_count: r.review_count, avg_rating: r.rated_count > 0 ? parseFloat(parseFloat(r.avg_rating).toFixed(1)) : null, rated_count: r.rated_count });

    // Individual Fox discounts
    const foxDiscounts = {};
    if (userId) {
      const fdQ = await pool.query(`SELECT venue_id, discount_percent FROM fp1_fox_discounts WHERE user_id=$1 AND (is_temporary=FALSE OR expires_at > NOW())`, [userId]);
      fdQ.rows.forEach(r => foxDiscounts[r.venue_id] = parseFloat(r.discount_percent));
    }

    const venues = r.rows.map(v => {
      const tv_cnt = totalVisits[v.id] || 0;
      const usedSlots = (trialUsed[v.id] || 0) + (activeResByVenue[v.id] || 0);
      const trial_remaining = v.is_trial ? Math.max(0, (v.monthly_visit_limit || 20) - usedSlots) : null;
      return {
        ...v,
        discount_percent: Math.max(parseFloat(v.discount_percent) || 10, foxDiscounts[v.id] || 0),
        my_visits: myVisits[v.id] || 0,
        my_monthly_credited: myMonthlyCredited[v.id] || 0,
        total_visits: tv_cnt,
        weekly_visits: weeklyVisits[v.id] || 0,
        monthly_visits: monthlyVisits[v.id] || 0,
        trial_remaining,
        my_reservation: myReservations[v.id] || null,
        my_stamps: myStamps[v.id] || null,
        venue_status: venueStatuses[v.id] || null,
        top_category: topCategory[v.id]?.cat || null,
        top_reason: topReason[v.id]?.reason || null,
        top_dish_name: topDish[v.id] || null,
    has_photos: (photoCounts[v.id] || 0) > 0,
    review_count: reviewStatsMap[v.id]?.review_count || 0,
    avg_rating: reviewStatsMap[v.id]?.avg_rating || null,
    rated_count: reviewStatsMap[v.id]?.rated_count || 0,
    is_top_week: v.id === topWeekId,
        is_top_month: v.id === topMonthId,
        is_top_year: v.id === topYearId,
        is_top_alltime: v.id === topAllTimeId
      };
    });
    res.json({ venues, maps_key: isFox ? (process.env.GOOGLE_MAPS_KEY || "") : "", is_fox: isFox, trial_state: trialState });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/checkin
app.post("/api/checkin", requireWebAppAuth, async (req, res) => {
  try {
    const userId  = String(req.tgUser.id);
    // Rate limit: max 5 check-in requests per user per 10 min
    if (rateLimit(`checkin:${userId}`, 5, 10*60*1000)) {
      return res.status(429).json({ error: "Zbyt wiele prób. Poczekaj kilka minut." });
    }
    const venueId = Number(req.body.venue_id);
    if (!venueId) return res.status(400).json({ error: "Brak venue_id" });

    const v = await getVenue(venueId);
    if (!v)           return res.status(404).json({ error: "Lokal nie istnieje" });
    if (!v.approved)  return res.status(400).json({ error: "Lokal nieaktywny" });

    // Trial Partner: max monthly_visit_limit unique visitors/month
    if (v.is_trial) {
      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const mCount = await pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS c FROM fp1_counted_visits
         WHERE venue_id=$1 AND created_at >= $2`,
        [venueId, monthStart.toISOString()]
      );
      const limit = v.monthly_visit_limit || 20;
      if (mCount.rows[0].c >= limit) {
        return res.status(403).json({
          error: `Ten lokal osiągnął miesięczny limit (${limit} gości). Skontaktuj się z FoxPot.`,
          trial_limit_reached: true
        });
      }
    }

    const fox = await pool.query(`SELECT 1 FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(403).json({ error: "nie zarejestrowany" });
     if (!(await hasConsent(userId))) {
      return res.status(403).json({ error: "consent_required", consent_version: CONSENT_VERSION });
    }

    const alreadyToday = await hasCountedToday(venueId, userId);
    // Don't block! Fox can visit unlimited times per day for discount
    // alreadyToday is passed to webapp so it knows bonuses won't apply

    const debounce = await pool.query(
      `SELECT 1 FROM fp1_checkins WHERE user_id=$1 AND venue_id=$2
       AND created_at > NOW() - INTERVAL '15 minutes'
       AND confirmed_at IS NULL LIMIT 1`,
      [userId, venueId]
    );
    if (debounce.rowCount > 0) {
      const existing = await pool.query(
        `SELECT otp, expires_at FROM fp1_checkins
         WHERE user_id=$1 AND venue_id=$2 AND confirmed_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [userId, venueId]
      );
      if (existing.rowCount > 0) {
        return res.json({
          already_today: alreadyToday,
          otp: existing.rows[0].otp,
          expires_at: existing.rows[0].expires_at,
          venue_name: v.name,
          discount_percent: parseFloat(v.discount_percent) || 10,
        });
      }
    }

    const foxLat = parseFloat(req.body.lat) || null;
    const foxLng = parseFloat(req.body.lng) || null;
    const checkin = await createCheckin(venueId, userId, foxLat, foxLng);
    res.json({
      already_today: alreadyToday,
      otp:        checkin.otp,
      expires_at: checkin.expires_at,
      venue_name: v.name,
      discount_percent: parseFloat(v.discount_percent) || 10,
    });
  } catch (e) {
    console.error("API_CHECKIN_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/spin
app.post("/api/spin", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    if (rateLimit(`spin:${userId}`, 3, 60*1000)) {
      return res.status(429).json({ error: "Zbyt wiele prób." });
    }

    const fox = await pool.query(`SELECT 1 FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(403).json({ error: "nie zarejestrowany" });

    const alreadySpun = await hasSpunToday(userId);
    if (alreadySpun) {
      const now      = new Date();
      const tomorrow = new Date(`${warsawDayKey(new Date(now.getTime() + 86400000))}T00:00:00+01:00`);
      const diffMs   = tomorrow - now;
      const hours    = Math.floor(diffMs / 3600000);
      const mins     = Math.floor((diffMs % 3600000) / 60000);
      return res.json({
        already_spun:  true,
        next_spin_in:  `${hours}h ${mins}min`,
        prize: {
          type:  alreadySpun.prize_type,
          value: alreadySpun.prize_value,
          label: alreadySpun.prize_label,
          emoji: SPIN_PRIZES.find(p => p.label === alreadySpun.prize_label)?.emoji || "🎁",
        },
      });
    }

    const prize = pickPrize();
    await recordSpin(userId, prize);
    await applyPrize(userId, prize);
    await checkAchievements(userId);

    const updated = await pool.query(
      `SELECT rating, invites, streak_freeze_available FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]
    );
    const f = updated.rows[0];

    res.json({
      already_spun: false,
      prize: {
        type:  prize.type,
        value: prize.value,
        label: prize.label,
        emoji: prize.emoji,
      },
      stats: {
        rating:  f.rating,
        invites: f.invites,
        freeze:  f.streak_freeze_available,
      },
    });
  } catch (e) {
    console.error("API_SPIN_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/social/verify — Fox potwierdza subskrypcję kanału (Sprawdź)
// Telegram: real check via getChatMember. Others: trust-based (industry standard)
app.post("/api/social/verify", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    if (rateLimit(`social:${userId}`, 10, 5*60*1000)) {
      return res.status(429).json({ error: "Zbyt wiele prób. Poczekaj." });
    }
    const { platform } = req.body;
    const VALID_PLATFORMS = ["instagram", "tiktok", "youtube", "telegram", "facebook"];
    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "nieprawidłowa platforma" });
    }

    const col = `sub_${platform}`;
    const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 AND is_deleted=FALSE LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(404).json({ error: "nie znaleziono" });

    const f = fox.rows[0];

    // Already verified — return success but no new reward
    if (f[col]) {
      const count = [f.sub_instagram, f.sub_tiktok, f.sub_youtube, f.sub_telegram, f.sub_facebook].filter(Boolean).length;
      return res.json({
        ok: true,
        already_verified: true,
        platform,
        rating_added: 0,
        invite_bonus: false,
        sub_count: count,
        rating: f.rating,
        invites: f.invites,
        sub_instagram: !!f.sub_instagram,
        sub_tiktok: !!f.sub_tiktok,
        sub_youtube: !!f.sub_youtube,
        sub_telegram: !!f.sub_telegram,
        sub_facebook: !!f.sub_facebook,
        sub_bonus_claimed: !!f.sub_bonus_claimed,
      });
    }

    // Telegram: real verification via getChatMember (only for TG users with positive userId)
    if (platform === "telegram" && Number(userId) > 0) {
      try {
        const TG_CHANNEL = "@thefoxpotclub";
        const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${TG_CHANNEL}&user_id=${userId}`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        if (!data.ok || !["member", "administrator", "creator"].includes(data.result?.status)) {
          return res.json({
            ok: false,
            verified: false,
            platform,
            message: "Nie wykryto subskrypcji kanału Telegram. Subskrybuj i kliknij Sprawdź ponownie."
          });
        }
      } catch (tgErr) {
        console.error("[SOCIAL] Telegram getChatMember error:", tgErr);
        // API error (bot not admin of channel?) — reject, don't fallback to trust
        return res.json({
          ok: false,
          verified: false,
          platform,
          message: "Nie udało się zweryfikować subskrypcji. Spróbuj ponownie."
        });
      }
    }
    // SMS Fox'y (negative userId): Telegram verification is trust-based
    // (no TG user_id to check getChatMember)

    // Instagram/TikTok/YouTube: trust-based verification (industry standard)
    // Mark as verified + add +3 rating
    await pool.query(
      `UPDATE fp1_foxes SET ${col} = TRUE, rating = rating + 3 WHERE user_id=$1`,
      [userId]
    );

    let invite_bonus = false;

    // Check if all 4 are now subscribed → bonus +1 invite (one-time)
    if (!f.sub_bonus_claimed) {
      const updated = await pool.query(`SELECT sub_instagram, sub_tiktok, sub_youtube, sub_telegram, sub_facebook FROM fp1_foxes WHERE user_id=$1`, [userId]);
      const u = updated.rows[0];
      if (u.sub_instagram && u.sub_tiktok && u.sub_youtube && u.sub_telegram && u.sub_facebook) {
        await pool.query(
          `UPDATE fp1_foxes SET sub_bonus_claimed = TRUE, invites = invites + 1 WHERE user_id=$1`,
          [userId]
        );
        invite_bonus = true;
      }
    }

    // Get updated fox data
    const result = await pool.query(`SELECT rating, invites, sub_instagram, sub_tiktok, sub_youtube, sub_telegram, sub_facebook, sub_bonus_claimed FROM fp1_foxes WHERE user_id=$1`, [userId]);
    const r = result.rows[0];
    const count = [r.sub_instagram, r.sub_tiktok, r.sub_youtube, r.sub_telegram, r.sub_facebook].filter(Boolean).length;

    console.log(`[SOCIAL] Fox ${userId} verified ${platform} → +3 rating${invite_bonus ? ' + 1 invite (full set bonus)' : ''}`);

    res.json({
      ok: true,
      verified: true,
      already_verified: false,
      platform,
      rating_added: 3,
      invite_bonus,
      sub_count: count,
      rating: r.rating,
      invites: r.invites,
      sub_instagram: !!r.sub_instagram,
      sub_tiktok: !!r.sub_tiktok,
      sub_youtube: !!r.sub_youtube,
      sub_telegram: !!r.sub_telegram,
      sub_facebook: !!r.sub_facebook,
      sub_bonus_claimed: !!r.sub_bonus_claimed,
    });
  } catch (e) {
    console.error("API_SOCIAL_VERIFY_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/leave — Fox opuszcza klub (soft delete)
app.post("/api/leave", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const fox = await pool.query(`SELECT user_id, is_deleted, founder_number FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(404).json({ error: "nie zarejestrowany" });
    if (fox.rows[0].is_deleted) return res.status(400).json({ error: "konto już usunięte" });

    // Soft delete: reset stats, keep founder_number
    await pool.query(`
      UPDATE fp1_foxes SET
        is_deleted = TRUE,
        deleted_at = NOW(),
        rating = 0,
        invites = 0,
        streak_current = 0,
        streak_best = 0
      WHERE user_id = $1
    `, [userId]);

    // Delete achievements and spins (keep counted_visits for anti-cheat)
    await pool.query(`DELETE FROM fp1_achievements WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM fp1_daily_spins WHERE user_id = $1`, [userId]);

    // Notify admin
    if (ADMIN_TG_ID && bot) {
      try {
        const name = req.tgUser.first_name || req.tgUser.username || userId;
        await bot.telegram.sendMessage(Number(ADMIN_TG_ID),
          `🚪 Fox opuścił klub:\n👤 ${name}\n🆔 ${userId}\n${fox.rows[0].founder_number ? `👑 Pionier Fox #${fox.rows[0].founder_number}` : ""}`);
      } catch {}
    }

    res.json({
      success: true,
      message: "Konto usunięte. Możesz wrócić z nowym zaproszeniem.",
      founder_kept: !!fox.rows[0].founder_number
    });
  } catch (e) {
    console.error("API_LEAVE_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/achievements
app.get("/api/achievements", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const fox = await pool.query(`SELECT 1 FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(404).json({ error: "nie zarejestrowany" });

    const r = await pool.query(
      `SELECT achievement_code FROM fp1_achievements WHERE user_id=$1`, [userId]
    );
    res.json({ achievements: r.rows.map(row => row.achievement_code) });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/district — update city and/or district
app.post("/api/district", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const city = req.body.city ? String(req.body.city).trim() : null;
    const district = req.body.district ? String(req.body.district).trim() : null;

    if (city) {
      if (!POLISH_CITIES.includes(city)) return res.status(400).json({ error: "Nieprawidłowe miasto" });
      await pool.query("UPDATE fp1_foxes SET city=$1 WHERE user_id=$2", [city, userId]);
    }
    if (district) {
      if (!getAllValidDistricts().includes(district)) return res.status(400).json({ error: "Nieprawidłowa dzielnica" });
      await pool.query("UPDATE fp1_foxes SET district=$1 WHERE user_id=$2", [district, userId]);
    }
    // If city changed to non-big-city, clear district
    if (city && !CITY_DISTRICTS[city]) {
      await pool.query("UPDATE fp1_foxes SET district=NULL WHERE user_id=$1", [userId]);
    }

    const fox = await pool.query("SELECT city, district FROM fp1_foxes WHERE user_id=$1 LIMIT 1", [userId]);
    res.json({ ok: true, city: fox.rows[0]?.city, district: fox.rows[0]?.district });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/invite/create
app.post("/api/invite/create", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(403).json({ error: "nie zarejestrowany" });
    if (Number(fox.rows[0].invites) <= 0) return res.status(400).json({ error: "Brak zaproszeń", no_invites: true });

    const result = await createInviteCode(userId);
    if (!result.ok) {
      if (result.reason === "NO_INVITES") return res.status(400).json({ error: "Brak zaproszeń", no_invites: true });
      return res.status(500).json({ error: result.reason });
    }
    res.json({ ok: true, code: result.code, invites_left: result.invites_left });
  } catch (e) {
    console.error("API_INVITE_CREATE_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/invite/stats
app.get("/api/invite/stats", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const fox = await pool.query(`SELECT invites FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(404).json({ error: "nie zarejestrowany" });

    const invited = await pool.query(
      `SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE invited_by_user_id=$1`, [userId]
    );
    const active = await pool.query(
      `SELECT COUNT(DISTINCT cv.user_id)::int AS c FROM fp1_counted_visits cv
       WHERE cv.is_credited=TRUE AND cv.user_id IN (SELECT user_id FROM fp1_foxes WHERE invited_by_user_id=$1)`, [userId]
    );
    const codesGen = await pool.query(
      `SELECT COUNT(*)::int AS c FROM fp1_invites WHERE created_by_user_id=$1`, [userId]
    );
    const recent = await pool.query(
      `SELECT i.code, i.uses, i.max_uses, i.created_at
       FROM fp1_invites i WHERE i.created_by_user_id=$1
       ORDER BY i.created_at DESC LIMIT 5`, [userId]
    );

    res.json({
      invites_available: fox.rows[0].invites,
      invited_total:     invited.rows[0].c,
      invited_active:    active.rows[0].c,
      codes_generated:   codesGen.rows[0].c,
      recent_codes:      recent.rows,
    });
  } catch (e) {
    console.error("API_INVITE_STATS_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// GET /api/checkin/status — polling: чи OTP підтверджений?
app.get("/api/checkin/status", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const venueId = Number(req.query.venue_id);
    if (!venueId) return res.status(400).json({ error: "Brak venue_id" });
    const day = warsawDayKey();
    const r = await pool.query(
      `SELECT id, confirmed_at FROM fp1_checkins
       WHERE user_id=$1 AND venue_id=$2 AND war_day=$3 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, venueId, day]
    );
    if (r.rowCount === 0) return res.json({ status: "no_checkin" });
    const row = r.rows[0];
    if (row.confirmed_at) {
      const dup = await pool.query(`SELECT 1 FROM fp1_receipts WHERE user_id=$1 AND venue_id=$2 AND war_day=$3 LIMIT 1`, [userId, venueId, day]);
      return res.json({ status: "confirmed", receipt_done: dup.rowCount > 0, checkin_id: row.id });
    }
    return res.json({ status: "pending" });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
/* ═══════════════════════════════════════════════════════════════
   V26: POST /api/receipt — БОНУСИ ТІЛЬКИ ТУТ
═══════════════════════════════════════════════════════════════ */
app.post("/api/receipt", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id), venueId = Number(req.body.venue_id);
    const amountPaid = parseFloat(req.body.amount_paid);
    if (!venueId) return res.status(400).json({ error: "Brak venue_id" });
    if (isNaN(amountPaid) || amountPaid < 1 || amountPaid > 5000) return res.status(400).json({ error: "Kwota 1-5000 zł" });
    const fox = await pool.query(`SELECT 1 FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(403).json({ error: "nie zarejestrowany" });
    const v = await getVenue(venueId);
    if (!v) return res.status(404).json({ error: "Lokal nie istnieje" });
    // Check individual Fox discount (higher priority), then venue default
    let discountPct = parseFloat(v.discount_percent) || 10;
    const foxDisc = await pool.query(
      `SELECT discount_percent FROM fp1_fox_discounts WHERE venue_id=$1 AND user_id=$2
       AND (is_temporary=FALSE OR expires_at > NOW()) LIMIT 1`,
      [venueId, userId]
    );
    if (foxDisc.rowCount > 0) discountPct = Math.max(discountPct, parseFloat(foxDisc.rows[0].discount_percent));
    const day = warsawDayKey();

    // Duplicate check
    const dup = await pool.query(`SELECT 1 FROM fp1_receipts WHERE user_id=$1 AND venue_id=$2 AND war_day=$3 LIMIT 1`, [userId, venueId, day]);
    if (dup.rowCount > 0) return res.status(400).json({ error: "Rachunek już wpisany", already_submitted: true });

    // Must have confirmed check-in today
    const conf = await pool.query(`SELECT id FROM fp1_checkins WHERE user_id=$1 AND venue_id=$2 AND confirmed_at IS NOT NULL AND war_day=$3 ORDER BY confirmed_at DESC LIMIT 1`, [userId, venueId, day]);
    if (conf.rowCount === 0) return res.status(400).json({ error: "Najpierw zrób check-in", no_checkin: true });

    const amountOriginal = amountPaid / (1 - discountPct / 100);
    const discountSaved = amountOriginal - amountPaid;

    await pool.query(`INSERT INTO fp1_receipts(user_id,venue_id,checkin_id,amount_paid,amount_original,discount_percent,discount_saved,bonuses_awarded,war_day) VALUES($1,$2,$3,$4,$5,$6,$7,FALSE,$8)`,
      [userId, venueId, conf.rows[0].id, amountPaid.toFixed(2), amountOriginal.toFixed(2), discountPct, discountSaved.toFixed(2), day]);

    // ═══ БОНУСИ (перенесені з confirmOtp) ═══
    const already = await hasCountedToday(venueId, userId);
    let countedAdded = false, inviteAutoAdded = 0, isFirstEver = false, newAch = [], visitCapReached = false;
    if (!already) {
      const hasDK = COUNTED_DAY_COL === "day_key", hasWD = await hasColumn("fp1_counted_visits", "war_day");
      const cols = ["venue_id","user_id"], vals = [venueId, userId];
      if (hasDK) { cols.push("day_key"); vals.push(day); } if (hasWD) { cols.push("war_day"); vals.push(day); }
      // Save visitor phone for anti-cheat (persists after account deletion)
      const foxPhone = await pool.query(`SELECT phone FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (foxPhone.rows[0]?.phone) { cols.push("visitor_phone"); vals.push(foxPhone.rows[0].phone); }
      // Visit cap: max 3 credited visits per fox per venue per calendar month
      // Layer 1: counted_visits by user_id OR visitor_phone
      // Layer 2: confirmed checkins by visitor_phone (survives deletion)
      const phoneForCap = foxPhone.rows[0]?.phone;
      let creditCount = 0;
      if (phoneForCap) {
        const cv = await pool.query(
          `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE (user_id=$1 OR visitor_phone=$3) AND venue_id=$2 AND is_credited=TRUE
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW()) AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW())`,
          [userId, venueId, phoneForCap]
        );
        // Also count confirmed checkins by phone this month (in case counted_visits were deleted)
        const cc = await pool.query(
          `SELECT COUNT(DISTINCT war_day)::int AS c FROM fp1_checkins WHERE venue_id=$1 AND visitor_phone=$2 AND confirmed_at IS NOT NULL
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW()) AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW())`,
          [venueId, phoneForCap]
        );
        creditCount = Math.max(cv.rows[0].c, cc.rows[0].c);
      } else {
        const cv = await pool.query(
          `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND venue_id=$2 AND is_credited=TRUE
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW()) AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM NOW())`,
          [userId, venueId]
        );
        creditCount = cv.rows[0].c;
      }
      const isCredited = creditCount < 3;
      cols.push("is_credited"); vals.push(isCredited);
      await pool.query(`INSERT INTO fp1_counted_visits(${cols.join(",")}) VALUES(${cols.map((_,i)=>`$${i+1}`).join(",")})`, vals);
      if (isCredited) await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [userId]);
      visitCapReached = !isCredited;
      countedAdded = true;
      // Mark reservation as used (if any)
      await pool.query(
        `UPDATE fp1_reservations SET used=TRUE WHERE user_id=$1 AND venue_id=$2 AND used=FALSE AND expired=FALSE AND expires_at>NOW()`,
        [userId, venueId]
      );

      // ── DEMO FOX UPGRADE: first check-in at ANY venue → full Fox (no bonus, first check-in +10 handles it) ──
      const demoCheck = await pool.query(`SELECT is_demo FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (demoCheck.rows[0]?.is_demo) {
        await pool.query(
          `UPDATE fp1_foxes SET is_demo=FALSE, demo_venue_id=NULL, demo_expires_at=NULL, join_source='venue' WHERE user_id=$1`,
          [userId]
        );
        if (bot) {
          try { await bot.telegram.sendMessage(Number(userId),
            `🎉 Gratulacje! Aktywowałeś pełną wersję FoxPot!\n\nTeraz masz dostęp do wszystkich lokali i funkcji. 🦊`
          ); } catch {}
        }
      }

      // ── TRIAL FOX UPGRADE: check-in at trial venue → full Fox (no bonus) ──
      const trialCheck = await pool.query(`SELECT trial_active, trial_origin_venue_id, trial_expires_at FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      const tc = trialCheck.rows[0];
      if (tc?.trial_active && Number(tc.trial_origin_venue_id) === Number(venueId) && new Date(tc.trial_expires_at) > new Date()) {
        await pool.query(
          `UPDATE fp1_foxes SET trial_active=FALSE, trial_origin_venue_id=NULL, trial_expires_at=NULL,
           trial_blocked_venue_id=NULL, trial_blocked_until=NULL,
           join_source='venue' WHERE user_id=$1`,
          [userId]
        );
        if (bot) {
          try { await bot.telegram.sendMessage(Number(userId),
            `🎉 Gratulacje! Aktywowałeś pełną wersję FoxPot!\n\nTeraz masz dostęp do wszystkich lokali i funkcji. 🦊`
          ); } catch {}
        }
        console.log(`[Trial] User ${userId} activated full Fox via venue ${venueId}`);
      }

      // Bonuses only for credited visits
      if (isCredited) {
        // Check total credited visits by phone (anti-cheat: includes previous accounts)
        const tv = phoneForCap
          ? await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE (user_id=$1 OR visitor_phone=$2) AND is_credited=TRUE`, [userId, phoneForCap])
          : await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [userId]);
        isFirstEver = tv.rows[0].c === 1;
        if (isFirstEver) {
          await pool.query(`UPDATE fp1_foxes SET rating=rating+10 WHERE user_id=$1`, [userId]);
          const inv = await pool.query(`SELECT invited_by_user_id FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
          if (inv.rows[0]?.invited_by_user_id) {
            await pool.query(`UPDATE fp1_foxes SET rating=rating+5 WHERE user_id=$1`, [String(inv.rows[0].invited_by_user_id)]);
            if (bot) { try { await bot.telegram.sendMessage(Number(inv.rows[0].invited_by_user_id), `🎉 Twój znajomy zrobił pierwszą wizytę!\n+5 pkt dla Ciebie! 🦊`); } catch {} }
          }
        }
        inviteAutoAdded = await awardInvitesFrom5Visits(userId);
        await updateStreak(userId);
        const vvc = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`, [venueId]);
        const hour = warsawHour();
        newAch = await checkAchievements(userId, { is_pioneer:vvc.rows[0].c===1, is_night:hour>=23, is_morning:hour<8 });
      }
    }

    await pool.query(`UPDATE fp1_receipts SET bonuses_awarded=TRUE WHERE user_id=$1 AND venue_id=$2 AND war_day=$3`, [userId, venueId, day]);
    const ts = await pool.query(`SELECT COALESCE(SUM(discount_saved),0)::numeric AS total FROM fp1_receipts WHERE user_id=$1`, [userId]);
    const uf = await pool.query(`SELECT rating,invites,streak_current FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    const f = uf.rows[0];

    // TG notification
    if (bot && countedAdded) {
      try {
        let msg = `✅ Rachunek zapisany!\n🏪 ${v.name}\n💰 Zapłacono: ${amountPaid.toFixed(2)} zł\n💸 Zaoszczędzono: ${parseFloat(discountSaved).toFixed(2)} zł\n📊 Łącznie: ${parseFloat(ts.rows[0].total).toFixed(2)} zł`;
        if (isFirstEver) msg += `\n🎉 Pierwsza wizyta! +10 pkt`;
        if (inviteAutoAdded > 0) msg += `\n🎁 +${inviteAutoAdded} zaproszenie`;
        msg += formatAchievements(newAch);
        await bot.telegram.sendMessage(Number(userId), msg);
      } catch (e) { console.error("RECEIPT_TG_ERR", e?.message); }
    }

    res.json({ ok:true,
      receipt:{ amount_paid:parseFloat(amountPaid.toFixed(2)), amount_original:parseFloat(amountOriginal.toFixed(2)), discount_percent:discountPct, discount_saved:parseFloat(discountSaved.toFixed(2)), total_saved:parseFloat(ts.rows[0].total) },
      bonuses:{ counted:countedAdded, first_ever:isFirstEver, invites_added:inviteAutoAdded, visit_cap_reached:visitCapReached, achievements:newAch.map(a=>({code:a.code,emoji:a.emoji,label:a.label,rating:a.rating})) },
      stats:{ rating:f?.rating||0, invites:f?.invites||0, streak:f?.streak_current||0 },
    });
  } catch (e) { console.error("API_RECEIPT_ERR", e); res.status(500).json({ error: String(e?.message||e) }); }
});

// GET /api/receipt/stats
app.get("/api/receipt/stats", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const t = await pool.query(`SELECT COUNT(*)::int AS receipt_count, COALESCE(SUM(amount_paid),0)::numeric AS total_paid, COALESCE(SUM(amount_original),0)::numeric AS total_original, COALESCE(SUM(discount_saved),0)::numeric AS total_saved, COALESCE(AVG(amount_paid),0)::numeric AS avg_check FROM fp1_receipts WHERE user_id=$1`, [userId]);
    const bv = await pool.query(`SELECT v.name,v.discount_percent,COUNT(r.id)::int AS visits,COALESCE(SUM(r.discount_saved),0)::numeric AS saved,COALESCE(SUM(r.amount_paid),0)::numeric AS spent FROM fp1_receipts r JOIN fp1_venues v ON v.id=r.venue_id WHERE r.user_id=$1 GROUP BY v.id,v.name,v.discount_percent ORDER BY saved DESC LIMIT 10`, [userId]);
    const r = t.rows[0];
    res.json({ receipt_count:r.receipt_count, total_paid:parseFloat(r.total_paid), total_original:parseFloat(r.total_original), total_saved:parseFloat(r.total_saved), avg_check:parseFloat(parseFloat(r.avg_check).toFixed(2)), by_venue:bv.rows.map(x=>({name:x.name,discount_percent:parseFloat(x.discount_percent),visits:x.visits,saved:parseFloat(x.saved),spent:parseFloat(x.spent)})) });
  } catch (e) { res.status(500).json({ error: String(e?.message||e) }); }
});
/* ═══════════════════════════════════════════════════════════════
   V26: POST /api/receipt/category — категорія замовлення
═══════════════════════════════════════════════════════════════ */
// POST /api/consent — Fox приймає regulamin + privacy
app.post("/api/consent", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    await saveConsent(userId);
    res.json({ ok: true, consent_version: CONSENT_VERSION });
  } catch (e) {
    console.error("CONSENT_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
// POST /api/reserve — Fox резервує місце в trial локалі (24h, min rating +1)
app.post("/api/reserve", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    if (rateLimit(`reserve:${userId}`, 5, 5*60*1000)) {
      return res.status(429).json({ error: "Zbyt wiele prób." });
    }
    const venueId = Number(req.body.venue_id);
    if (!venueId) return res.status(400).json({ error: "Brak venue_id" });

    const v = await getVenue(venueId);
    if (!v || !v.is_trial) return res.status(400).json({ error: "Rezerwacja tylko dla lokali we współpracy testowej" });

    // Check min rating +1
    const fox = await pool.query(`SELECT rating FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(403).json({ error: "nie zarejestrowany" });
    if ((fox.rows[0].rating || 0) < 1) return res.status(403).json({ error: "Minimalny rating: 1 punkt" });

    // Check no active reservation for this user at this venue
    const existing = await pool.query(
      `SELECT 1 FROM fp1_reservations WHERE user_id=$1 AND venue_id=$2 AND used=FALSE AND expired=FALSE AND expires_at>NOW() LIMIT 1`,
      [userId, venueId]
    );
    if (existing.rowCount > 0) return res.status(400).json({ error: "Masz już aktywną rezerwację" });

    // Check trial remaining (include active reservations as used)
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const mCount = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND created_at >= $2`,
      [venueId, monthStart.toISOString()]
    );
    const activeReservations = await pool.query(
      `SELECT COUNT(*)::int AS c FROM fp1_reservations WHERE venue_id=$1 AND used=FALSE AND expired=FALSE AND expires_at>NOW()`,
      [venueId]
    );
    const limit = v.monthly_visit_limit || 20;
    const totalUsed = mCount.rows[0].c + activeReservations.rows[0].c;
    if (totalUsed >= limit) {
      return res.status(403).json({ error: "Brak wolnych miejsc w tym miesiącu", trial_limit_reached: true });
    }

    // Create reservation — expires end of today Warsaw time (23:59:59 Warsaw = proper UTC)
    const wNow = new Date();
    // Get current Warsaw date parts
    const wStr = wNow.toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" }); // YYYY-MM-DD
    // End of day Warsaw = YYYY-MM-DDT23:59:59+01:00 (or +02:00 summer)
    const endOfDayWarsaw = new Date(wStr + "T23:59:59.999");
    // Convert to UTC by using the offset
    const wOffset = new Date(wNow.toLocaleString("en-US", { timeZone: "Europe/Warsaw" })).getTime() - new Date(wNow.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const expiresAt = new Date(endOfDayWarsaw.getTime() - wOffset);

    await pool.query(
      `INSERT INTO fp1_reservations(user_id, venue_id, expires_at) VALUES($1,$2,$3)`,
      [userId, venueId, expiresAt.toISOString()]
    );
    res.json({ ok: true, expires_at: expiresAt.toISOString(), remaining: limit - totalUsed - 1 });
  } catch (e) {
    console.error("API_RESERVE_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/reserve — Fox скасовує резервацію
app.delete("/api/reserve", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const venueId = Number(req.body.venue_id);
    const del = await pool.query(
      `DELETE FROM fp1_reservations WHERE user_id=$1 AND venue_id=$2 AND used=FALSE AND expired=FALSE AND expires_at>NOW() RETURNING id`,
      [userId, venueId]
    );
    res.json({ ok: true, deleted: del.rowCount });
  } catch (e) {
    console.error("API_RESERVE_DEL_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/reservations — поточні резервації Fox
app.get("/api/reservations", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const r = await pool.query(
      `SELECT r.venue_id, r.expires_at, v.name FROM fp1_reservations r JOIN fp1_venues v ON v.id=r.venue_id
       WHERE r.user_id=$1 AND r.used=FALSE AND r.expired=FALSE AND r.expires_at>NOW() ORDER BY r.expires_at ASC`,
      [userId]
    );
    res.json({ reservations: r.rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/receipt/reason — "Dlaczego tu?" survey
app.post("/api/receipt/reason", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const venueId = Number(req.body.venue_id);
    const reason = String(req.body.reason || "").trim();
    const VALID = ["fast","tasty","cheap","chill","social"];
    if (!venueId || !VALID.includes(reason))
      return res.status(400).json({ error: "Nieprawidłowy powód" });
    const day = warsawDayKey();
    const receipt = await pool.query(
      `SELECT id FROM fp1_receipts WHERE user_id=$1 AND venue_id=$2 AND war_day=$3 LIMIT 1`,
      [userId, venueId, day]
    );
    if (receipt.rowCount === 0)
      return res.status(400).json({ error: "Najpierw wpisz rachunek" });
    await pool.query(
      `UPDATE fp1_receipts SET reason=$1 WHERE id=$2`,
      [reason, receipt.rows[0].id]
    );
    await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [userId]);
    res.json({ ok: true, bonus_points: 1 });
  } catch (e) {
    console.error("API_RECEIPT_REASON_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
app.post("/api/receipt/category", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const venueId = Number(req.body.venue_id);
    const category = String(req.body.category || "").trim();
    const VALID = ["main","snack","dessert","coffee","drink","alcohol","other"];
    if (!venueId || !VALID.includes(category))
      return res.status(400).json({ error: "Nieprawidłowa kategoria" });
    const day = warsawDayKey();
    const receipt = await pool.query(
      `SELECT id FROM fp1_receipts WHERE user_id=$1 AND venue_id=$2 AND war_day=$3 LIMIT 1`,
      [userId, venueId, day]
    );
    if (receipt.rowCount === 0)
      return res.status(400).json({ error: "Najpierw wpisz rachunek" });
    await pool.query(
      `UPDATE fp1_receipts SET category=$1 WHERE id=$2`,
      [category, receipt.rows[0].id]
    );
    // Bonus: +1 punkt za kategorię
    await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [userId]);
    res.json({ ok: true, bonus_points: 1 });
  } catch (e) {
    console.error("API_RECEIPT_CATEGORY_ERR", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
/* ═══════════════════════════════════════════════════════════════
   V24: VENUE QR SYSTEM
═══════════════════════════════════════════════════════════════ */

// Helper: штрафна логіка
async function applyViolation(client, user_id, obligation_id, new_violation_count) {
  let penaltyPoints = 0;
  let bannedUntil   = null;

  // Warsaw midnight = наступний ранок
  const warsawNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
  const warsawMidnight = new Date(warsawNow);
  warsawMidnight.setHours(24, 0, 0, 0);

  if (new_violation_count === 1) {
    penaltyPoints = -10;
    bannedUntil   = warsawMidnight;
  } else if (new_violation_count === 2) {
    penaltyPoints = -20;
    bannedUntil   = warsawMidnight;
  } else {
    penaltyPoints = -50;
    bannedUntil   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 днів
  }

  // Штраф до рейтингу
  await client.query(
    `UPDATE fp1_foxes SET rating = GREATEST(0, rating + $1) WHERE user_id = $2`,
    [penaltyPoints, String(user_id)]
  );

  // Оновити obligation
  await client.query(
    `UPDATE fp1_venue_obligations
     SET fulfilled = TRUE, fulfilled_at = NOW(),
         violation_count = $2, banned_until = $3,
         last_violation_at = NOW()
     WHERE id = $1`,
    [obligation_id, new_violation_count, bannedUntil]
  );

  // Повідомити Fox в Telegram
  if (bot) {
    try {
      const msg = new_violation_count >= 3
        ? `⛔ Порушення #${new_violation_count}!\n\n${penaltyPoints} балів\nБан: 7 днів\n\nЛічильник скинеться після відбуття бану.`
        : `⚠️ Порушення #${new_violation_count}!\n\n${penaltyPoints} балів\nБлок do rana (czas warszawski)`;
      await bot.telegram.sendMessage(Number(user_id), msg);
    } catch {}
  }
}

// POST /api/venue/scan — Fox сканує QR або вводить код локалу
// P0.1: obligation system вимкнено — scan дає бонуси без зобов'язань
app.post("/api/venue/scan", requireWebAppAuth, async (req, res) => {
  const user_id    = String(req.tgUser.id);
  const venue_id   = String(req.body.venue_id   || "").trim();
  const venue_name = String(req.body.venue_name || venue_id).trim();

  if (!venue_id) return res.status(400).json({ ok: false, error: "missing_venue_id" });

  try {
    // +1 rating, +5 invites
    await pool.query(
      `UPDATE fp1_foxes SET rating = rating + 1, invites = invites + 5 WHERE user_id = $1`,
      [user_id]
    );

    // Зберегти referred_by_venue
    await pool.query(
      `UPDATE fp1_foxes SET referred_by_venue = $2 WHERE user_id = $1`,
      [user_id, venue_id]
    );

    res.json({
      ok:      true,
      message: `+1 punkt, +5 zaproszeń! Odwiedź ${venue_name} i zrób check-in.`,
    });
  } catch (e) {
    console.error("API_VENUE_SCAN_ERR", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/venue/checkin — P0.1: obligation system вимкнено, endpoint повертає ok
app.post("/api/venue/checkin", requireWebAppAuth, async (req, res) => {
  try {
    res.json({ ok: true, message: "Check-in OK 🦊" });
  } catch (e) {
    console.error("API_VENUE_CHECKIN_ERR", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════════
   REVIEWS — Private feedback from Fox to Venue
═══════════════════════════════════════════════════════════════ */

// DEBUG: check review eligibility for a user at a venue (TEMP — delete after debugging)
app.get("/api/debug-review-state", async (req, res) => {
  try {
    const username = req.query.username;
    const venueName = req.query.venue;
    if (!username || !venueName) return res.json({ error: "need ?username=X&venue=Y" });
    const foxQ = await pool.query(`SELECT user_id FROM fp1_foxes WHERE username ILIKE $1 LIMIT 1`, [username]);
    if (!foxQ.rows.length) return res.json({ error: "fox not found" });
    const userId = foxQ.rows[0].user_id;
    const venueQ = await pool.query(`SELECT id, name FROM fp1_venues WHERE name ILIKE $1 LIMIT 1`, ['%'+venueName+'%']);
    if (!venueQ.rows.length) return res.json({ error: "venue not found" });
    const venueId = venueQ.rows[0].id;
    const checkins = await pool.query(
      `SELECT id, otp, confirmed_at, created_at, expires_at FROM fp1_checkins WHERE user_id=$1 AND venue_id=$2 ORDER BY created_at DESC LIMIT 5`,
      [userId, venueId]
    );
    const counted = await pool.query(
      `SELECT id, war_day, is_credited, created_at FROM fp1_counted_visits WHERE user_id=$1 AND venue_id=$2 ORDER BY created_at DESC LIMIT 5`,
      [userId, venueId]
    );
    const reviews = await pool.query(
      `SELECT id, checkin_id, rating, text, created_at FROM fp1_reviews WHERE user_id=$1 AND venue_id=$2 ORDER BY created_at DESC LIMIT 5`,
      [String(userId), venueId]
    );
    const statusCheck = await pool.query(
      `SELECT c.id FROM fp1_checkins c WHERE c.user_id=$1 AND c.venue_id=$2 AND c.confirmed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fp1_reviews rv WHERE rv.checkin_id=c.id) ORDER BY c.confirmed_at DESC LIMIT 1`,
      [userId, venueId]
    );
    res.json({
      user_id: userId, venue_id: venueId, venue_name: venueQ.rows[0].name,
      checkins: checkins.rows, counted_visits: counted.rows, reviews: reviews.rows,
      eligible_checkin_id: statusCheck.rows[0]?.id || null
    });
  } catch(e) { res.json({ error: String(e?.message || e) }); }
});

// GET /api/checkin/status?venue_id=X — last confirmed checkin for review linking
app.get("/api/checkin/status", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const venueId = req.query.venue_id ? Number(req.query.venue_id) : null;
    if (!venueId) return res.json({ last_confirmed_id: null });
    // Find latest confirmed checkin at this venue that doesn't have a review yet
    const r = await pool.query(
      `SELECT c.id FROM fp1_checkins c
       WHERE c.user_id=$1 AND c.venue_id=$2 AND c.confirmed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fp1_reviews rv WHERE rv.checkin_id=c.id)
       ORDER BY c.confirmed_at DESC LIMIT 1`,
      [userId, venueId]
    );
    res.json({ last_confirmed_id: r.rows[0]?.id || null });
  } catch(e) { res.json({ last_confirmed_id: null }); }
});

// POST /api/review — Fox leaves a review after credited check-in
app.post("/api/review", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const { checkin_id, rating, text } = req.body;
    if (!checkin_id) return res.status(400).json({ error: "Brak danych" });
    const r = rating != null ? parseInt(rating) : null;
    if (r !== null && (r < 1 || r > 5)) return res.status(400).json({ error: "Ocena musi być od 1 do 5" });
    const cleanText = text ? String(text).trim().slice(0, 500) : null;
    if (r === null && !cleanText) return res.status(400).json({ error: "Dodaj ocenę lub tekst" });
    // Verify: checkin belongs to this fox, is confirmed, is credited
    const ci = await pool.query(
      `SELECT c.id, c.venue_id FROM fp1_checkins c
       JOIN fp1_counted_visits cv ON cv.user_id = c.user_id AND cv.venue_id = c.venue_id AND cv.war_day = c.war_day AND cv.is_credited = TRUE
       WHERE c.id = $1 AND c.user_id = $2 AND c.confirmed_at IS NOT NULL LIMIT 1`,
      [checkin_id, userId]
    );
    if (ci.rowCount === 0) return res.status(403).json({ error: "Brak potwierdzonego check-inu" });
    // Check duplicate
    const dup = await pool.query(`SELECT 1 FROM fp1_reviews WHERE checkin_id=$1`, [checkin_id]);
    if (dup.rowCount > 0) return res.status(409).json({ error: "Opinia już wystawiona dla tej wizyty" });
    const ins = await pool.query(
      `INSERT INTO fp1_reviews(user_id, venue_id, checkin_id, rating, text) VALUES($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [userId, ci.rows[0].venue_id, checkin_id, r, cleanText]
    );
    res.json({ ok: true, review_id: ins.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// GET /api/my-reviews — Fox's own reviews + venue replies
app.get("/api/my-reviews", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const reviews = await pool.query(
      `SELECT r.id, r.venue_id, v.name AS venue_name, r.rating, r.text, r.venue_reply, r.venue_reply_at, r.created_at
       FROM fp1_reviews r JOIN fp1_venues v ON v.id = r.venue_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ reviews: reviews.rows });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// GET /api/venue/:id/reviews — venue reviews (for panel only, but no auth enforced — filtered by venue)
app.get("/api/venue/:id/reviews", async (req, res) => {
  try {
    const venueId = Number(req.params.id);
    const reviews = await pool.query(
      `SELECT r.id, f.username, r.rating, r.text, r.venue_reply, r.venue_reply_at, r.created_at
       FROM fp1_reviews r LEFT JOIN fp1_foxes f ON f.user_id::text = r.user_id
       WHERE r.venue_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [venueId]
    );
    const stats = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating),0)::numeric AS avg_rating FROM fp1_reviews WHERE venue_id=$1`,
      [venueId]
    );
    res.json({
      reviews: reviews.rows,
      review_count: stats.rows[0].count,
      avg_rating: parseFloat(parseFloat(stats.rows[0].avg_rating).toFixed(1)),
    });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// POST /panel/review/:id/reply — Venue replies to a review
app.post("/panel/review/:id/reply", requirePanelAuth, async (req, res) => {
  try {
    const venueId = Number(req.panel.venue_id);
    const reviewId = Number(req.params.id);
    const reply = String(req.body.reply || "").trim().slice(0, 500);
    if (!reply) return res.status(400).json({ error: "Treść odpowiedzi jest wymagana" });
    const r = await pool.query(
      `UPDATE fp1_reviews SET venue_reply=$1, venue_reply_at=NOW() WHERE id=$2 AND venue_id=$3 AND venue_reply IS NULL RETURNING id`,
      [reply, reviewId, venueId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Nie znaleziono opinii lub już odpowiedziano" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// P0.1: Obligation CRON вимкнено (штрафна система схована)
// setInterval(async () => { ... }, 15 * 60 * 1000);

// CRON: TOP reset — щонеділі 00:00 (TOP тижня), 1-го числа 00:00 (TOP місяця)
// Перевіряє кожні 5 хв, шле адміну повідомлення про переможців
let lastTopWeekReset = null;
let lastTopMonthReset = null;
let lastTopYearReset = null;

setInterval(async () => {
  try {
    if (!bot || !ADMIN_TG_ID) return;
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
    const dayOfWeek = now.getDay(); // 0=Sunday
    const dayOfMonth = now.getDate();
    const hour = now.getHours();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    // Sunday 00:xx — TOP тижня reset
    if (dayOfWeek === 0 && hour === 0 && lastTopWeekReset !== todayKey) {
      lastTopWeekReset = todayKey;
      // Get last week's winner (previous Sunday to Saturday)
      const weekEnd = new Date(now);
      weekEnd.setHours(0, 0, 0, 0);
      const weekStart = new Date(weekEnd);
      weekStart.setDate(weekStart.getDate() - 7);
      const topWeek = await pool.query(
        `SELECT v.name, COUNT(*)::int AS cnt FROM fp1_counted_visits cv
         JOIN fp1_venues v ON v.id = cv.venue_id
         WHERE cv.created_at >= $1 AND cv.created_at < $2 AND cv.is_credited=TRUE
         GROUP BY v.id, v.name ORDER BY cnt DESC LIMIT 1`,
        [weekStart.toISOString(), weekEnd.toISOString()]
      );
      if (topWeek.rowCount > 0) {
        const w = topWeek.rows[0];
        await bot.telegram.sendMessage(Number(ADMIN_TG_ID),
          `🏆 TOP tygodnia: ${w.name} (${w.cnt} wizyt)\n📅 ${weekStart.toLocaleDateString("pl-PL")} — ${weekEnd.toLocaleDateString("pl-PL")}`
        );
        console.log(`[TopCron] Week winner: ${w.name} (${w.cnt})`);
      } else {
        await bot.telegram.sendMessage(Number(ADMIN_TG_ID), `🏆 TOP tygodnia: brak wizyt w tym tygodniu`);
      }
    }

    // 1st of month 00:xx — TOP місяця reset
    if (dayOfMonth === 1 && hour === 0 && lastTopMonthReset !== todayKey) {
      lastTopMonthReset = todayKey;
      // Get last month's winner
      const monthEnd = new Date(now);
      monthEnd.setHours(0, 0, 0, 0);
      const monthStart = new Date(monthEnd);
      monthStart.setMonth(monthStart.getMonth() - 1);
      monthStart.setDate(1);
      const topMonth = await pool.query(
        `SELECT v.name, COUNT(*)::int AS cnt FROM fp1_counted_visits cv
         JOIN fp1_venues v ON v.id = cv.venue_id
         WHERE cv.created_at >= $1 AND cv.created_at < $2 AND cv.is_credited=TRUE
         GROUP BY v.id, v.name ORDER BY cnt DESC LIMIT 1`,
        [monthStart.toISOString(), monthEnd.toISOString()]
      );
      if (topMonth.rowCount > 0) {
        const m = topMonth.rows[0];
        const monthName = monthStart.toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
        await bot.telegram.sendMessage(Number(ADMIN_TG_ID),
          `👑 TOP miesiąca (${monthName}): ${m.name} (${m.cnt} wizyt)`
        );
        console.log(`[TopCron] Month winner: ${m.name} (${m.cnt})`);
      } else {
        await bot.telegram.sendMessage(Number(ADMIN_TG_ID), `👑 TOP miesiąca: brak wizyt w tym miesiącu`);
      }
    }

    // Jan 1 00:xx — TOP року reset
    if (dayOfMonth === 1 && now.getMonth() === 0 && hour === 0 && lastTopYearReset !== todayKey) {
      lastTopYearReset = todayKey;
      const yearEnd = new Date(now); yearEnd.setHours(0,0,0,0);
      const yearStartCron = new Date(yearEnd); yearStartCron.setFullYear(yearStartCron.getFullYear() - 1); yearStartCron.setMonth(0, 1);
      const topYear = await pool.query(
        `SELECT v.name, COUNT(*)::int AS cnt FROM fp1_counted_visits cv
         JOIN fp1_venues v ON v.id = cv.venue_id
         WHERE cv.created_at >= $1 AND cv.created_at < $2 AND cv.is_credited=TRUE
         GROUP BY v.id, v.name ORDER BY cnt DESC LIMIT 1`,
        [yearStartCron.toISOString(), yearEnd.toISOString()]
      );
      if (topYear.rowCount > 0) {
        const y = topYear.rows[0];
        await bot.telegram.sendMessage(Number(ADMIN_TG_ID),
          `🏆🔥 TOP ROKU ${yearStartCron.getFullYear()}: ${y.name} (${y.cnt} wizyt)!\nTo jest legenda FoxPot Club!`
        );
        console.log(`[TopCron] Year winner: ${y.name} (${y.cnt})`);
      }
    }
  } catch (e) {
    console.error("[TopCron] ERR", e?.message || e);
  }
}, 5 * 60 * 1000); // кожні 5 хвилин

// CRON: Leaderboard cache — update pre-computed results every 5 min
setInterval(async () => {
  try {
    const warsawNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
    const dayOfWeek = warsawNow.getDay();
    const weekStart = new Date(warsawNow); weekStart.setDate(weekStart.getDate() - dayOfWeek); weekStart.setHours(0,0,0,0);
    const monthStart = new Date(warsawNow); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const yearStart = new Date(warsawNow); yearStart.setMonth(0, 1); yearStart.setHours(0,0,0,0);
    const adminExclude = ADMIN_TG_ID ? ` AND f.user_id != '${ADMIN_TG_ID}'` : '';

    const upsertCache = async (key, period, data) => {
      await pool.query(`
        INSERT INTO fp1_leaderboard_cache(key,user_id,username,venue_id,venue_name,value,period,achieved_at,extra,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT(key) DO UPDATE SET user_id=$2,username=$3,venue_id=$4,venue_name=$5,value=$6,period=$7,achieved_at=$8,extra=$9,updated_at=NOW()`,
        [key, data.user_id||null, data.username||null, data.venue_id||null, data.venue_name||null, data.value, period, data.achieved_at||null, data.extra?JSON.stringify(data.extra):null]
      );
    };

    // Best savings Fox of the month (by credited receipts only)
    const savingsQ = await pool.query(`
      SELECT f.user_id, f.username, f.founder_number,
             SUM(r.discount_saved)::numeric AS total_saved,
             COUNT(DISTINCT r.venue_id)::int AS venues_count,
             MIN(r.created_at) AS first_receipt_at
      FROM fp1_receipts r
      JOIN fp1_counted_visits cv ON cv.user_id = r.user_id AND cv.venue_id = r.venue_id
        AND cv.war_day = r.war_day AND cv.is_credited = TRUE
      JOIN fp1_foxes f ON f.user_id = r.user_id AND f.is_deleted = FALSE${adminExclude}
      WHERE r.created_at >= $1
      GROUP BY f.user_id, f.username, f.founder_number
      HAVING SUM(r.discount_saved) > 0
      ORDER BY total_saved DESC, first_receipt_at ASC LIMIT 1
    `, [monthStart.toISOString()]);
    if (savingsQ.rowCount > 0) {
      const s = savingsQ.rows[0];
      await upsertCache('best_savings_month', 'month', {
        user_id: s.user_id, username: s.username, value: s.total_saved,
        achieved_at: s.first_receipt_at,
        extra: { venues_count: s.venues_count, founder_number: s.founder_number }
      });
    }

    // Top Fox by credited visits: week, month, year
    for (const [key, pLabel, start] of [['top_fox_week','week',weekStart],['top_fox_month','month',monthStart],['top_fox_year','year',yearStart]]) {
      const tq = await pool.query(`
        SELECT f.user_id, f.username, COUNT(*)::int AS cnt, MIN(cv.created_at) AS first_at
        FROM fp1_counted_visits cv
        JOIN fp1_foxes f ON f.user_id = cv.user_id AND f.is_deleted = FALSE${adminExclude}
        WHERE cv.created_at >= $1 AND cv.is_credited = TRUE
        GROUP BY f.user_id, f.username
        ORDER BY cnt DESC, first_at ASC LIMIT 1
      `, [start.toISOString()]);
      if (tq.rowCount > 0) {
        const t = tq.rows[0];
        await upsertCache(key, pLabel, { user_id: t.user_id, username: t.username, value: t.cnt, achieved_at: t.first_at });
      }
    }

    // Top venue: week, month, year
    for (const [key, pLabel, start] of [['top_venue_week','week',weekStart],['top_venue_month','month',monthStart],['top_venue_year','year',yearStart]]) {
      const vq = await pool.query(`
        SELECT cv.venue_id, v.name, COUNT(*)::int AS cnt, MIN(cv.created_at) AS first_at
        FROM fp1_counted_visits cv JOIN fp1_venues v ON v.id = cv.venue_id
        WHERE cv.created_at >= $1 AND cv.is_credited = TRUE
        GROUP BY cv.venue_id, v.name
        ORDER BY cnt DESC, first_at ASC LIMIT 1
      `, [start.toISOString()]);
      if (vq.rowCount > 0) {
        const v = vq.rows[0];
        await upsertCache(key, pLabel, { venue_id: v.venue_id, venue_name: v.name, value: v.cnt, achieved_at: v.first_at });
      }
    }
  } catch (e) { console.error("[LeaderboardCache] ERR", e?.message || e); }
}, 5 * 60 * 1000);

// CRON: Reservation expiry — штраф -5 за невикористану резервацію
setInterval(async () => {
  try {
    const expired = await pool.query(
      `SELECT id, user_id, venue_id FROM fp1_reservations
       WHERE used=FALSE AND expired=FALSE AND penalty_applied=FALSE AND expires_at < NOW()
       LIMIT 50`
    );
    for (const r of expired.rows) {
      await pool.query(`UPDATE fp1_reservations SET expired=TRUE, penalty_applied=TRUE WHERE id=$1`, [r.id]);
      await pool.query(`UPDATE fp1_foxes SET rating=GREATEST(0, rating-5) WHERE user_id=$1`, [String(r.user_id)]);
      console.log(`[ReserveCron] Penalty -5 user=${r.user_id} venue=${r.venue_id}`);
      if (bot) {
        try {
          const v = await pool.query(`SELECT name FROM fp1_venues WHERE id=$1`, [r.venue_id]);
          await bot.telegram.sendMessage(Number(r.user_id),
            `⚠️ Rezerwacja wygasła!\n🏪 ${v.rows[0]?.name || 'Lokal'}\n📉 -5 pkt rating\n\nNastępnym razem odwiedź lokal w dniu rezerwacji.`
          );
        } catch {}
      }
    }
  } catch (e) {
    console.error("[ReserveCron] ERR", e?.message || e);
  }
}, 10 * 60 * 1000); // кожні 10 хвилин

// CRON: Weekly backup — sends SQL backup to admin via Telegram (Sunday 03:00 Warsaw)
let lastBackupDay = null;
setInterval(async () => {
  try {
    if (!bot || !ADMIN_TG_ID) return;
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
    const day = now.toISOString().slice(0, 10);
    if (now.getDay() !== 0 || now.getHours() !== 3 || lastBackupDay === day) return;
    lastBackupDay = day;
    console.log("[BackupCron] Starting weekly backup...");
    const sql = await createBackupSQL();
    const buf = Buffer.from(sql, "utf-8");
    await bot.telegram.sendDocument(Number(ADMIN_TG_ID), {
      source: buf,
      filename: `foxpot_backup_${day}.sql`
    }, { caption: `💾 Automatyczny backup bazy\n📅 ${day}\n📊 ${(buf.length/1024).toFixed(0)} KB` });
    console.log(`[BackupCron] Backup sent to admin (${(buf.length/1024).toFixed(0)} KB)`);
  } catch (e) {
    console.error("[BackupCron] ERR", e?.message || e);
  }
}, 5 * 60 * 1000);

// Demo no-show cron removed — no penalties for venue join. Demo Fox stays until first check-in.

/* ═══════════════════════════════════════════════════════════════
   VENUE PHOTOS API (Panel + Cloudinary)
═══════════════════════════════════════════════════════════════ */
const CLOUDINARY_CLOUD = (process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const CLOUDINARY_KEY   = (process.env.CLOUDINARY_API_KEY || "").trim();
const CLOUDINARY_SECRET= (process.env.CLOUDINARY_API_SECRET || "").trim();

async function uploadToCloudinary(base64Data, folder) {
  const https = require("https");
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash("sha1").update(paramsToSign + CLOUDINARY_SECRET).digest("hex");

  const formData = JSON.stringify({
    file: base64Data,
    folder: folder,
    timestamp: timestamp,
    api_key: CLOUDINARY_KEY,
    signature: signature
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.cloudinary.com",
      path: `/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(formData) }
    }, (resp) => {
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Cloudinary parse error")); }
      });
    });
    req.on("error", reject);
    req.write(formData);
    req.end();
  });
}

// Increase body size limit for photo uploads (10MB)
app.use("/panel/venue/photos/upload", express.json({ limit: "10mb" }));

// GET /panel/venue/photos — get venue photos
app.get("/panel/venue/photos", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const photos = await pool.query(
    `SELECT id, url, sort_order FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]
  );
  res.json({ photos: photos.rows });
});

// POST /panel/venue/photos/upload — upload photo via Cloudinary
app.post("/panel/venue/photos/upload", requirePanelAuth, async (req, res) => {
  try {
    const venueId = Number(req.panel.venue_id);
    const { image } = req.body; // base64 data URL
    if (!image) return res.status(400).json({ error: "Brak zdjęcia" });
    if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
      return res.status(500).json({ error: "Cloudinary nie skonfigurowany" });
    }

    // Check count
    const existing = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_venue_photos WHERE venue_id=$1`, [venueId]);
    if (existing.rows[0].c >= 10) return res.status(400).json({ error: "Maksymalnie 10 zdjęć" });

    // Upload to Cloudinary
    const result = await uploadToCloudinary(image, `foxpot/venues/${venueId}`);
    if (result.error) return res.status(400).json({ error: result.error.message || "Błąd Cloudinary" });

    const url = result.secure_url;
    const nextOrder = existing.rows[0].c + 1;

    const ins = await pool.query(
      `INSERT INTO fp1_venue_photos(venue_id, url, sort_order) VALUES($1, $2, $3) RETURNING id`,
      [venueId, url, nextOrder]
    );

    res.json({ ok: true, id: ins.rows[0].id, url, sort_order: nextOrder });
    console.log(`[Photos] Venue ${venueId} uploaded photo #${nextOrder}: ${url}`);
  } catch (e) {
    console.error("PHOTO_UPLOAD_ERR", e);
    res.status(500).json({ error: "Błąd uploadu: " + (e.message || e) });
  }
});

// DELETE /panel/venue/photos/:id — delete a photo
app.delete("/panel/venue/photos/:id", requirePanelAuth, async (req, res) => {
  try {
    const venueId = Number(req.panel.venue_id);
    const photoId = Number(req.params.id);
    await pool.query(`DELETE FROM fp1_venue_photos WHERE id=$1 AND venue_id=$2`, [photoId, venueId]);
    // Re-number sort_order
    const remaining = await pool.query(`SELECT id FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]);
    for (let i = 0; i < remaining.rows.length; i++) {
      await pool.query(`UPDATE fp1_venue_photos SET sort_order=$1 WHERE id=$2`, [i + 1, remaining.rows[i].id]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("PHOTO_DELETE_ERR", e);
    res.status(500).json({ error: "Błąd" });
  }
});

// GET /api/venue/:id/photos — public photos list
app.get("/api/venue/:id/photos", async (req, res) => {
  const venueId = parseInt(req.params.id);
  const photos = await pool.query(
    `SELECT url, sort_order FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]
  );
  res.json({ photos: photos.rows });
});

/* ═══════════════════════════════════════════════════════════════
   POST /api/venue/:venue_id/start-trial — Trial activation (60 min)
═══════════════════════════════════════════════════════════════ */
app.post("/api/venue/:venue_id/start-trial", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    if (rateLimit(`trial:${userId}`, 5, 10*60*1000)) {
      return res.status(429).json({ error: "Zbyt wiele prób." });
    }
    const venueId = Number(req.params.venue_id);

    // Check venue exists
    const vq = await pool.query(`SELECT id, name FROM fp1_venues WHERE id=$1 AND approved=TRUE LIMIT 1`, [venueId]);
    if (vq.rowCount === 0) return res.status(404).json({ ok: false, code: "VENUE_NOT_FOUND" });

    // On-demand expiry check first
    await checkTrialExpiry(userId);

    // Ensure user is registered (exists in fp1_foxes)
    const foxQ = await pool.query(`SELECT user_id, trial_blocked_venue_id, trial_blocked_until FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
    if (foxQ.rowCount === 0) {
      // Not registered yet — create minimal Fox record for trial
      const username = tgDisplayName(req.tgUser);
      await pool.query(
        `INSERT INTO fp1_foxes(user_id, username, rating, invites, city, trial_active, trial_origin_venue_id, trial_expires_at)
         VALUES($1, $2, 0, 0, 'Warszawa', TRUE, $3, NOW() + INTERVAL '60 minutes')
         ON CONFLICT(user_id) DO NOTHING`,
        [userId, username, venueId]
      );
      console.log(`[Trial] New user ${userId} started trial at venue ${venueId}`);
      return res.json({ ok: true, trial_origin_venue_id: venueId, expires_in_minutes: 60 });
    }

    const fox = foxQ.rows[0];

    // Check if this venue is blocked for today
    if (Number(fox.trial_blocked_venue_id) === venueId && fox.trial_blocked_until && new Date(fox.trial_blocked_until) > new Date()) {
      return res.json({ ok: false, code: "VENUE_TRIAL_BLOCKED", blocked_until: fox.trial_blocked_until });
    }

    // Start/restart trial
    await pool.query(
      `UPDATE fp1_foxes SET trial_active=TRUE, trial_origin_venue_id=$1, trial_expires_at=NOW() + INTERVAL '60 minutes' WHERE user_id=$2`,
      [venueId, userId]
    );
    console.log(`[Trial] User ${userId} started trial at venue ${venueId}`);
    return res.json({ ok: true, trial_origin_venue_id: venueId, expires_in_minutes: 60 });
  } catch (e) {
    console.error("START_TRIAL_ERR", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ═══════════════════════════════════════════════════════════════
   NOMINATIONS — Venue voting system
═══════════════════════════════════════════════════════════════ */
const NOM_STATUSES = ["voting","threshold","review","contact","talking","added","rejected"];
const NOM_STATUS_LABELS = {
  voting:"Zbieranie głosów", threshold:"Próg osiągnięty", review:"Weryfikacja FoxPot",
  contact:"Kontakt z lokalem", talking:"W rozmowie", added:"Dodano", rejected:"Odrzucono"
};

app.get("/api/nominations", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const fp = req.query.fp || req.ip || "anon";

    const rows = await pool.query(`
      SELECT n.id, n.name, n.city, n.address, n.status, n.vote_threshold, n.created_at,
        (SELECT COUNT(*)::int FROM fp1_nomination_votes v WHERE v.nomination_id=n.id) AS votes
      FROM fp1_nominations n WHERE n.status NOT IN ('added','rejected')
      ORDER BY votes DESC, n.created_at ASC
    `);

    const myVotes = new Set();
    const voterPhone = await resolveVoterPhone(userId);
    // For authenticated users: check by userId/phone only (not fingerprint — shared across accounts on same device)
    // For anonymous: check by fingerprint
    if (userId) {
      const conditions = [`tg_user_id=$1`];
      const params = [String(userId)];
      if (voterPhone) { conditions.push(`voter_phone=$${params.length+1}`); params.push(voterPhone); }
      const mvQ = await pool.query(`SELECT nomination_id FROM fp1_nomination_votes WHERE ${conditions.join(' OR ')}`, params);
      mvQ.rows.forEach(r => myVotes.add(r.nomination_id));
    } else if (fp) {
      const mvQ = await pool.query(`SELECT nomination_id FROM fp1_nomination_votes WHERE fingerprint=$1`, [fp]);
      mvQ.rows.forEach(r => myVotes.add(r.nomination_id));
    }

    // Check cooldown for nomination votes (7 days)
    let canVoteAfter = null;
    const lastNomQ = voterPhone
      ? await pool.query(`SELECT created_at FROM fp1_nomination_votes WHERE voter_phone=$1 ORDER BY created_at DESC LIMIT 1`, [voterPhone])
      : userId
        ? await pool.query(`SELECT created_at FROM fp1_nomination_votes WHERE tg_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(userId)])
        : await pool.query(`SELECT created_at FROM fp1_nomination_votes WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1`, [fp]);
    if (lastNomQ.rowCount > 0) {
      const next = new Date(lastNomQ.rows[0].created_at);
      next.setDate(next.getDate() + NOM_VOTE_COOLDOWN_DAYS);
      if (next > new Date()) canVoteAfter = next.toISOString();
    }

    res.json({
      nominations: rows.rows.map(n => ({
        ...n, status_label: NOM_STATUS_LABELS[n.status] || n.status, my_vote: myVotes.has(n.id)
      })),
      can_vote_after: canVoteAfter
    });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.post("/api/nominations", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 100);
    const city = String(req.body.city || "Warszawa").trim().slice(0, 60);
    const address = String(req.body.address || "").trim().slice(0, 200);
    const place_id = req.body.place_id ? String(req.body.place_id).trim().slice(0, 200) : null;
    if (!name || name.length < 2) return res.status(400).json({ error: "Podaj nazwę lokalu (min. 2 znaki)" });
    const fp = req.body.fp || req.ip || "anon";
    if (rateLimit(`nom_create:${fp}`, 3, 60*60*1000)) return res.status(429).json({ error: "Zbyt wiele propozycji. Spróbuj za godzinę." });
    // Dedup by place_id or name+city
    if (place_id) {
      const dupP = await pool.query(`SELECT id FROM fp1_nominations WHERE place_id=$1 AND status NOT IN ('rejected') LIMIT 1`, [place_id]);
      if (dupP.rowCount > 0) return res.status(409).json({ error: "Ten lokal już został zaproponowany", nomination_id: dupP.rows[0].id });
    }
    const dup = await pool.query(`SELECT id FROM fp1_nominations WHERE LOWER(name)=LOWER($1) AND LOWER(city)=LOWER($2) AND status NOT IN ('rejected') LIMIT 1`, [name, city]);
    if (dup.rowCount > 0) return res.status(409).json({ error: "Ten lokal już został zaproponowany", nomination_id: dup.rows[0].id });
    const r = await pool.query(`INSERT INTO fp1_nominations(name,city,address,place_id) VALUES($1,$2,$3,$4) RETURNING id`, [name, city, address, place_id]);
    res.json({ ok: true, nomination_id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.post("/api/nominations/:id/vote", async (req, res) => {
  try {
    const nomId = Number(req.params.id);
    const rawFp = String(req.body.fp || req.ip || "anon").slice(0, 200);
    const userId = await resolveUserId(req);
    // Use user-based fingerprint for auth users to avoid UNIQUE conflict on shared devices
    const fp = userId ? `user_${userId}` : rawFp;
    let isMember = false;
    if (userId) { const fox = await pool.query(`SELECT user_id FROM fp1_foxes WHERE user_id=$1 AND is_deleted=FALSE LIMIT 1`, [userId]); isMember = fox.rowCount > 0; }
    if (rateLimit(`nom_vote:${fp}`, 20, 60*60*1000)) return res.status(429).json({ error: "Zbyt wiele głosów." });

    const voterPhone = await resolveVoterPhone(userId);

    // Lifetime check: already voted on THIS nomination (by phone/userId for auth users, fingerprint for anon)
    if (voterPhone) {
      const already = await pool.query(`SELECT id FROM fp1_nomination_votes WHERE nomination_id=$1 AND voter_phone=$2 LIMIT 1`, [nomId, voterPhone]);
      if (already.rowCount > 0) return res.status(409).json({ error: "Już głosowałeś za ten lokal" });
    } else if (userId) {
      const already = await pool.query(`SELECT id FROM fp1_nomination_votes WHERE nomination_id=$1 AND tg_user_id=$2 LIMIT 1`, [nomId, String(userId)]);
      if (already.rowCount > 0) return res.status(409).json({ error: "Już głosowałeś za ten lokal" });
    } else {
      const alreadyFp = await pool.query(`SELECT id FROM fp1_nomination_votes WHERE nomination_id=$1 AND fingerprint=$2 LIMIT 1`, [nomId, fp]);
      if (alreadyFp.rowCount > 0) return res.status(409).json({ error: "Już głosowałeś za ten lokal" });
    }

    // Cooldown: 7 days since last vote on ANY nomination
    const lastQ = voterPhone
      ? await pool.query(`SELECT created_at FROM fp1_nomination_votes WHERE voter_phone=$1 ORDER BY created_at DESC LIMIT 1`, [voterPhone])
      : userId
        ? await pool.query(`SELECT created_at FROM fp1_nomination_votes WHERE tg_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(userId)])
        : await pool.query(`SELECT created_at FROM fp1_nomination_votes WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1`, [fp]);
    if (lastQ.rowCount > 0) {
      const next = new Date(lastQ.rows[0].created_at);
      next.setDate(next.getDate() + NOM_VOTE_COOLDOWN_DAYS);
      if (next > new Date()) {
        const daysLeft = Math.ceil((next - new Date()) / 86400000);
        return res.status(429).json({ error: `Możesz zmienić głos za ${daysLeft} dni` });
      }
    }

    const nom = await pool.query(`SELECT id, status, vote_threshold FROM fp1_nominations WHERE id=$1 LIMIT 1`, [nomId]);
    if (nom.rowCount === 0) return res.status(404).json({ error: "Nie znaleziono" });
    if (!["voting","threshold"].includes(nom.rows[0].status)) return res.status(400).json({ error: "Głosowanie zakończone" });

    const ins = await pool.query(
      `INSERT INTO fp1_nomination_votes(nomination_id,fingerprint,tg_user_id,is_member,voter_phone) VALUES($1,$2,$3,$4,$5) ON CONFLICT(nomination_id,fingerprint) DO NOTHING RETURNING id`,
      [nomId, fp, userId || null, isMember, voterPhone]
    );
    if (ins.rowCount === 0) return res.status(409).json({ error: "Już głosowałeś za ten lokal" });
    const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_nomination_votes WHERE nomination_id=$1`, [nomId]);
    if (cnt.rows[0].c >= nom.rows[0].vote_threshold && nom.rows[0].status === "voting") {
      await pool.query(`UPDATE fp1_nominations SET status='threshold', updated_at=NOW() WHERE id=$1`, [nomId]);
    }
    res.json({ ok: true, votes: cnt.rows[0].c });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   CITY NOMINATIONS — City voting system
═══════════════════════════════════════════════════════════════ */
const CITY_NOM_STATUSES = ["voting","threshold","review","planned","not_now"];
const CITY_NOM_LABELS = {
  voting:"Zbieranie głosów", threshold:"Próg osiągnięty", review:"W analizie FoxPot",
  planned:"Planowane", not_now:"Nie teraz"
};
const BIG_CITY_THRESHOLD = 1000;
const SMALL_CITY_THRESHOLD = 1000;
const CITY_VOTE_COOLDOWN_DAYS = 30;
const NOM_VOTE_COOLDOWN_DAYS = 7;

// Resolve voter's phone number from userId (for anti-cheat voting checks)
async function resolveVoterPhone(userId) {
  if (!userId) return null;
  const q = await pool.query(`SELECT phone FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
  return q.rows[0]?.phone || null;
}

app.get("/api/city-nominations", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const fp = req.query.fp || req.ip || "anon";

    const rows = await pool.query(`
      SELECT n.id, n.name, n.country, n.status, n.vote_threshold, n.created_at,
        (SELECT COUNT(*)::int FROM fp1_city_votes v WHERE v.city_nomination_id=n.id) AS votes
      FROM fp1_city_nominations n
      ORDER BY votes DESC, n.created_at ASC LIMIT 50
    `);

    const myVotes = new Set();
    const voterPhone = await resolveVoterPhone(userId);
    // For authenticated users: check by userId/phone only (not fingerprint)
    if (userId) {
      const conditions = [`tg_user_id=$1`];
      const params = [String(userId)];
      if (voterPhone) { conditions.push(`voter_phone=$${params.length+1}`); params.push(voterPhone); }
      const mvQ = await pool.query(`SELECT city_nomination_id FROM fp1_city_votes WHERE ${conditions.join(' OR ')}`, params);
      mvQ.rows.forEach(r => myVotes.add(r.city_nomination_id));
    } else if (fp) {
      const mvQ = await pool.query(`SELECT city_nomination_id FROM fp1_city_votes WHERE fingerprint=$1`, [fp]);
      mvQ.rows.forEach(r => myVotes.add(r.city_nomination_id));
    }

    // Check cooldown: last vote time (by phone or fingerprint)
    let canVoteAfter = null;
    const lastQ = voterPhone
      ? await pool.query(`SELECT created_at FROM fp1_city_votes WHERE voter_phone=$1 ORDER BY created_at DESC LIMIT 1`, [voterPhone])
      : userId
        ? await pool.query(`SELECT created_at FROM fp1_city_votes WHERE tg_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(userId)])
        : await pool.query(`SELECT created_at FROM fp1_city_votes WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1`, [fp]);
    if (lastQ.rowCount > 0) {
      const next = new Date(lastQ.rows[0].created_at);
      next.setDate(next.getDate() + CITY_VOTE_COOLDOWN_DAYS);
      if (next > new Date()) canVoteAfter = next.toISOString();
    }

    res.json({
      cities: rows.rows.map(n => ({
        ...n, status_label: CITY_NOM_LABELS[n.status] || n.status, my_vote: myVotes.has(n.id)
      })),
      can_vote_after: canVoteAfter
    });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.post("/api/city-nominations", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 100);
    if (!name || name.length < 2) return res.status(400).json({ error: "Podaj nazwę miasta (min. 2 znaki)" });
    const fp = req.body.fp || req.ip || "anon";
    if (rateLimit(`citynom_create:${fp}`, 3, 60*60*1000)) return res.status(429).json({ error: "Zbyt wiele propozycji." });

    // Check if already exists
    const dup = await pool.query(`SELECT id FROM fp1_city_nominations WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]);
    if (dup.rowCount > 0) return res.status(409).json({ error: "To miasto już jest na liście", city_id: dup.rows[0].id });

    // Determine threshold based on population heuristic
    const bigCities = ["Warszawa","Kraków","Łódź","Wrocław","Poznań","Gdańsk","Szczecin","Bydgoszcz","Lublin","Białystok","Katowice"];
    const threshold = bigCities.some(c => c.toLowerCase() === name.toLowerCase()) ? BIG_CITY_THRESHOLD : SMALL_CITY_THRESHOLD;

    const r = await pool.query(`INSERT INTO fp1_city_nominations(name,vote_threshold) VALUES($1,$2) RETURNING id`, [name, threshold]);
    res.json({ ok: true, city_id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

app.post("/api/city-nominations/:id/vote", async (req, res) => {
  try {
    const cityId = Number(req.params.id);
    const rawFp = String(req.body.fp || req.ip || "anon").slice(0, 200);
    const userId = await resolveUserId(req);
    // Use user-based fingerprint for auth users to avoid UNIQUE conflict on shared devices
    const fp = userId ? `user_${userId}` : rawFp;

    let isMember = false;
    if (userId) { const fox = await pool.query(`SELECT user_id FROM fp1_foxes WHERE user_id=$1 AND is_deleted=FALSE LIMIT 1`, [userId]); isMember = fox.rowCount > 0; }

    if (rateLimit(`citynom_vote:${fp}`, 10, 60*60*1000)) return res.status(429).json({ error: "Zbyt wiele głosów." });

    const voterPhone = await resolveVoterPhone(userId);

    // Lifetime check: already voted on THIS city (by phone/userId for auth users, fingerprint for anon)
    if (voterPhone) {
      const already = await pool.query(`SELECT id FROM fp1_city_votes WHERE city_nomination_id=$1 AND voter_phone=$2 LIMIT 1`, [cityId, voterPhone]);
      if (already.rowCount > 0) return res.status(409).json({ error: "Już głosowałeś za to miasto" });
    } else if (userId) {
      const already = await pool.query(`SELECT id FROM fp1_city_votes WHERE city_nomination_id=$1 AND tg_user_id=$2 LIMIT 1`, [cityId, String(userId)]);
      if (already.rowCount > 0) return res.status(409).json({ error: "Już głosowałeś za to miasto" });
    } else {
      const alreadyFp = await pool.query(`SELECT id FROM fp1_city_votes WHERE city_nomination_id=$1 AND fingerprint=$2 LIMIT 1`, [cityId, fp]);
      if (alreadyFp.rowCount > 0) return res.status(409).json({ error: "Już głosowałeś za to miasto" });
    }

    // Cooldown: 30 days since last vote on ANY city
    const lastQ = voterPhone
      ? await pool.query(`SELECT created_at FROM fp1_city_votes WHERE voter_phone=$1 ORDER BY created_at DESC LIMIT 1`, [voterPhone])
      : userId
        ? await pool.query(`SELECT created_at FROM fp1_city_votes WHERE tg_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(userId)])
        : await pool.query(`SELECT created_at FROM fp1_city_votes WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1`, [fp]);
    if (lastQ.rowCount > 0) {
      const next = new Date(lastQ.rows[0].created_at);
      next.setDate(next.getDate() + CITY_VOTE_COOLDOWN_DAYS);
      if (next > new Date()) {
        const daysLeft = Math.ceil((next - new Date()) / 86400000);
        return res.status(429).json({ error: `Możesz zmienić głos za ${daysLeft} dni` });
      }
    }

    const nom = await pool.query(`SELECT id, status, vote_threshold FROM fp1_city_nominations WHERE id=$1 LIMIT 1`, [cityId]);
    if (nom.rowCount === 0) return res.status(404).json({ error: "Nie znaleziono" });
    if (!["voting","threshold"].includes(nom.rows[0].status)) return res.status(400).json({ error: "Głosowanie zakończone" });

    const ins = await pool.query(
      `INSERT INTO fp1_city_votes(city_nomination_id,fingerprint,tg_user_id,is_member,voter_phone) VALUES($1,$2,$3,$4,$5) ON CONFLICT(city_nomination_id,fingerprint) DO NOTHING RETURNING id`,
      [cityId, fp, userId || null, isMember, voterPhone]
    );
    if (ins.rowCount === 0) return res.status(409).json({ error: "Już głosowałeś za to miasto" });

    const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_city_votes WHERE city_nomination_id=$1`, [cityId]);
    if (cnt.rows[0].c >= nom.rows[0].vote_threshold && nom.rows[0].status === "voting") {
      await pool.query(`UPDATE fp1_city_nominations SET status='threshold', updated_at=NOW() WHERE id=$1`, [cityId]);
    }
    res.json({ ok: true, votes: cnt.rows[0].c });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// GET /api/promo — active promotion for webapp
app.get("/api/promo", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.venue_id, p.package, p.promo_text, p.ends_at,
             v.name AS venue_name, v.city, v.address, v.discount_percent
      FROM fp1_promotions p
      JOIN fp1_venues v ON v.id = p.venue_id
      WHERE p.status='active' AND p.starts_at <= NOW() AND p.ends_at > NOW()
      ORDER BY CASE p.package WHEN 'premium' THEN 0 WHEN 'boost' THEN 1 ELSE 2 END, p.created_at ASC
      LIMIT 1
    `);
    res.json({ promo: r.rows[0] || null });
  } catch (e) { res.json({ promo: null }); }
});

// GET /api/best-fox — Best Fox of the month (from leaderboard cache)
app.get("/api/best-fox", async (req, res) => {
  try {
    const cached = await pool.query(`SELECT * FROM fp1_leaderboard_cache WHERE key='best_savings_month' LIMIT 1`);
    if (cached.rowCount === 0 || !cached.rows[0].username) return res.json({ best_fox: null });
    const c = cached.rows[0];
    const extra = c.extra || {};
    const monthStart = new Date(); monthStart.setDate(1);
    const monthName = monthStart.toLocaleDateString("pl-PL", { month: "long" });
    res.json({
      best_fox: {
        username: c.username,
        total_saved: parseFloat(parseFloat(c.value).toFixed(2)),
        venues_count: extra.venues_count || 0,
        founder_number: extra.founder_number || null,
        month_name: monthName,
      }
    });
  } catch (e) { res.json({ best_fox: null }); }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/recommendation — Content Rotation Engine
   ?slot=profile|map  — controls paid promo probability
   ?exclude=ID        — exclude venue/card (so slot1 ≠ slot2)
   Returns: { type, card_type, title, name, text, discount,
              district, status_badge, venue_id, is_promo }
═══════════════════════════════════════════════════════════════ */
const REC_TITLES_VENUE = ["🦊 The FoxPot Club poleca dziś","🦊 FoxPot poleca dziś","🦊 Polecane dla Ciebie"];
const REC_TITLES_FOX   = ["🏆 Ranking Foxów"];
const REC_TITLES_VOTE  = ["🗳️ Aktywne głosowanie"];
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Per-Fox frequency cap (in-memory, resets on restart) ──
// Stores last N shown items per fox: Map<foxId, [{venue_id, card_type, ts}]>
const _recHistory = new Map();
const REC_HISTORY_SIZE = 12;        // remember last 12 shown cards
const REC_VENUE_MAX_IN_WINDOW = 2;  // same venue_id max 2 times in last 12
const REC_HISTORY_TTL = 30*60*1000; // 30 min TTL — after that, history entry expires

function getRecHistory(foxId) {
  if (!foxId) return [];
  const h = _recHistory.get(foxId) || [];
  const now = Date.now();
  // Prune expired entries
  const valid = h.filter(e => (now - e.ts) < REC_HISTORY_TTL);
  if (valid.length !== h.length) _recHistory.set(foxId, valid);
  return valid;
}

function pushRecHistory(foxId, card) {
  if (!foxId) return;
  const h = getRecHistory(foxId);
  h.push({ venue_id: card.venue_id, card_type: card.card_type, ts: Date.now() });
  if (h.length > REC_HISTORY_SIZE) h.shift();
  _recHistory.set(foxId, h);
}

function isBlocked(foxId, card) {
  const h = getRecHistory(foxId);
  if (!h.length) return false;
  // Rule 1: No same venue_id twice in a row
  const last = h[h.length - 1];
  if (card.venue_id && last.venue_id && card.venue_id === last.venue_id) return true;
  // Rule 2: No same card_type twice in a row
  if (last.card_type === card.card_type) return true;
  // Rule 3: Same venue_id max N times in window
  if (card.venue_id) {
    const cnt = h.filter(e => e.venue_id === card.venue_id).length;
    if (cnt >= REC_VENUE_MAX_IN_WINDOW) return true;
  }
  return false;
}

// Cleanup stale fox histories every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [fid, h] of _recHistory) {
    if (!h.length || (now - h[h.length-1].ts) > REC_HISTORY_TTL) _recHistory.delete(fid);
  }
}, 10*60*1000);

// ── Promo round-robin: equal rotation across active promotions ──
let _promoRoundRobinIdx = 0;

app.get("/api/recommendation", async (req, res) => {
  const FALLBACK = { type:"system", card_type:"fallback", title:"🦊 FoxPot poleca dziś", name:"FoxPot Club", text:"🦊 Odkrywaj lokale z FoxPot Club!", discount:null, district:null, status_badge:null, venue_id:null, is_promo:false };
  try {
    const foxId = await resolveUserId(req);
    const excludeVenueId = req.query.exclude ? parseInt(req.query.exclude) : null;
    const slot = req.query.slot === "map" ? "map" : "profile";

    // Fox district for "Blisko Ciebie"
    let foxDistrict = null;
    if (foxId) {
      const fq = await pool.query(`SELECT district FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [foxId]);
      foxDistrict = fq.rows[0]?.district || null;
    }

    // ── Step 0: Proximity promo (highest priority) ──
    const foxLat = parseFloat(req.query.lat) || null;
    const foxLng = parseFloat(req.query.lng) || null;
    let card = null;

    if (foxLat && foxLng) {
      const proxyQ = await pool.query(
        `SELECT id, name, discount_percent, promo_radius, promo_message FROM fp1_venues
         WHERE approved=TRUE AND promo_active=TRUE AND promo_start<=NOW() AND promo_end>NOW()
         AND lat IS NOT NULL AND lng IS NOT NULL
         ${excludeVenueId ? 'AND id != $1' : ''}
         LIMIT 20`,
        excludeVenueId ? [excludeVenueId] : []
      );
      for (const v of proxyQ.rows) {
        const dist = haversineKm(foxLat, foxLng, parseFloat(v.lat), parseFloat(v.lng));
        const radius = (v.promo_radius || 500) / 1000;
        if (dist !== null && dist <= radius) {
          card = {
            type: "proximity_promo", card_type: "proximity_promo",
            title: "📍 Promocja w pobliżu!",
            name: v.name,
            text: v.promo_message || `🦊 ${v.name} czeka na Ciebie! Sprawdź ofertę.`,
            discount: parseFloat(v.discount_percent) || 10,
            district: `📍 ${Math.round(dist*1000)} m od Ciebie`,
            status_badge: null, venue_id: v.id, is_promo: true
          };
          break;
        }
      }
    }

    // ── Step 1: Paid or system? ──
    const promoChance = slot === "map" ? 0.7 : 0.5;

    if (Math.random() < promoChance) {
      // Paid promo — round-robin for equal distribution
      const promoQ = await pool.query(`
        SELECT p.id, p.venue_id, p.promo_text, v.name AS venue_name, v.city,
               v.address, v.discount_percent, v.pioneer_number
        FROM fp1_promotions p
        JOIN fp1_venues v ON v.id = p.venue_id
        WHERE p.status='active' AND p.starts_at <= NOW() AND p.ends_at > NOW()
          ${excludeVenueId ? 'AND p.venue_id != $1' : ''}
        ORDER BY p.id ASC
      `, excludeVenueId ? [excludeVenueId] : []);
      if (promoQ.rows.length) {
        // Round-robin: cycle through all promos equally
        const startIdx = _promoRoundRobinIdx % promoQ.rows.length;
        _promoRoundRobinIdx++;
        for (let i = 0; i < promoQ.rows.length; i++) {
          const p = promoQ.rows[(startIdx + i) % promoQ.rows.length];
          const disc = parseFloat(p.discount_percent) || 10;
          const candidate = {
            type:"paid", card_type:"promo", title: pickOne(REC_TITLES_VENUE),
            name: p.venue_name,
            text: p.promo_text || `🦊 The FoxPot Club poleca: ${p.venue_name}`,
            discount: disc > 0 ? disc : null,
            district: null,
            status_badge: null,
            venue_id: p.venue_id, is_promo: true
          };
          if (!isBlocked(foxId, candidate)) { card = candidate; break; }
        }
      }
    }

    // ── Step 2: System info cards (if no paid card) ──
    if (!card) {
      const cards = [];

      // — Fox leaders (week/month/year) —
      const foxBadges = await getTopFoxBadges();
      for (const [uid, period] of Object.entries(foxBadges)) {
        if (excludeVenueId && String(excludeVenueId) === uid) continue;
        const fu = await pool.query(`SELECT username, founder_number FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [uid]);
        if (!fu.rows.length) continue;
        const f = fu.rows[0];
        const nick = f.username ? `@${f.username}` : `Fox`;
        const badge = f.founder_number ? (f.founder_number <= 50 ? "Założyciel" : "Pionier") : null;
        const periodLabel = {week:"tygodnia",month:"miesiąca",year:"roku"}[period];
        cards.push({
          type:"system", card_type:`lider_fox_${period}`, title: pickOne(REC_TITLES_FOX),
          name: nick, text: `🏆 Lider ${periodLabel}: ${nick}${badge ? ` — ${badge}` : ""} — czy już go znasz?`,
          discount: null, district: null, status_badge: badge, venue_id: null, is_promo: false
        });
      }

      // — Top venues (week/month) —
      const wNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
      const weekStart = new Date(wNow); weekStart.setDate(weekStart.getDate() - wNow.getDay()); weekStart.setHours(0,0,0,0);
      const monthStart = new Date(wNow); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
      const tvw = await pool.query(`SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at>=$1 AND is_credited=TRUE GROUP BY venue_id ORDER BY cnt DESC LIMIT 1`, [weekStart.toISOString()]);
      const tvm = await pool.query(`SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at>=$1 AND is_credited=TRUE GROUP BY venue_id ORDER BY cnt DESC LIMIT 1`, [monthStart.toISOString()]);

      for (const [row, period] of [[tvw.rows[0],"week"],[tvm.rows[0],"month"]]) {
        if (!row) continue;
        const vid = Number(row.venue_id);
        if (excludeVenueId && vid === excludeVenueId) continue;
        const vq = await pool.query(`SELECT name, city FROM fp1_venues WHERE id=$1`, [vid]);
        if (!vq.rows.length) continue;
        const label = period === "week" ? "🔥 Top tygodnia" : "🔥 Top miesiąca";
        cards.push({
          type:"system", card_type:`lider_lokal_${period}`, title: pickOne(REC_TITLES_VENUE),
          name: vq.rows[0].name, text: `${label}: ${vq.rows[0].name} — sprawdź!`,
          discount: null, district: null, status_badge: null, venue_id: vid, is_promo: false
        });
      }

      // — Active venue nominations (voting) —
      const nomQ = await pool.query(`
        SELECT n.id, n.name, n.vote_threshold,
               (SELECT COUNT(*)::int FROM fp1_nomination_votes v WHERE v.nomination_id=n.id) AS votes
        FROM fp1_nominations n WHERE n.status='voting' ORDER BY RANDOM() LIMIT 3
      `);
      for (const n of nomQ.rows) {
        const remaining = n.vote_threshold - n.votes;
        if (remaining > 0 && remaining <= Math.ceil(n.vote_threshold * 0.2)) {
          cards.push({
            type:"system", card_type:"glosowanie_blisko", title: pickOne(REC_TITLES_VOTE),
            name: n.name, text: `🗳️ Do aktywacji ${n.name} brakuje jeszcze ${remaining} głosów!`,
            discount: null, district: null, status_badge: null, venue_id: null, is_promo: false
          });
        } else {
          cards.push({
            type:"system", card_type:"glosowanie", title: pickOne(REC_TITLES_VOTE),
            name: n.name, text: `🗳️ Nowe głosowanie: zagłosuj na ${n.name}!`,
            discount: null, district: null, status_badge: null, venue_id: null, is_promo: false
          });
        }
      }

      // — City nominations —
      const cityNomQ = await pool.query(`
        SELECT name, vote_threshold,
               (SELECT COUNT(*)::int FROM fp1_city_votes v WHERE v.city_nomination_id=c.id) AS votes
        FROM fp1_city_nominations c WHERE c.status='voting' ORDER BY RANDOM() LIMIT 2
      `);
      for (const c of cityNomQ.rows) {
        cards.push({
          type:"system", card_type:"glosowanie_miasto", title: pickOne(REC_TITLES_VOTE),
          name: c.name, text: `🏙️ Głosowanie: ${c.name} — już ${c.votes}/${c.vote_threshold} głosów!`,
          discount: null, district: null, status_badge: null, venue_id: null, is_promo: false
        });
      }

      // — Venue-based cards (weighted selection pool) —
      // Fetch pool of 5, weighted: new 2x (capped), pioneer 1.5x, recommended 1.3x, discount 1.3x
      const venueQ = await pool.query(`
        SELECT id, name, city, discount_percent, recommended,
               pioneer_number, venue_type, cuisine, created_at
        FROM fp1_venues WHERE approved=TRUE
          ${excludeVenueId ? 'AND id != $1' : ''}
        ORDER BY (
          CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 2.0 ELSE 1.0 END
          * CASE WHEN pioneer_number IS NOT NULL THEN 1.5 ELSE 1.0 END
          * CASE WHEN COALESCE(recommended,'') != '' THEN 1.3 ELSE 1.0 END
          * CASE WHEN discount_percent > 10 THEN 1.3 ELSE 1.0 END
        ) * RANDOM() DESC
        LIMIT 5
      `, excludeVenueId ? [excludeVenueId] : []);

      for (const v of venueQ.rows) {
        const disc = parseFloat(v.discount_percent) || 10;
        const near = false; // venues don't have district column yet
        const isNew = v.created_at && (Date.now() - new Date(v.created_at).getTime()) < 7*24*60*60*1000;

        // 9. New venue (< 7 days)
        if (isNew) {
          cards.push({
            type:"system", card_type:"nowy_lokal", title: pickOne(REC_TITLES_VENUE),
            name: v.name, text: `🆕 Nowy partner w FoxPot: ${v.name}!`,
            discount: disc > 10 ? disc : null, district: near ? "📍 Blisko Ciebie!" : null,
            status_badge: null, venue_id: v.id, is_promo: false
          });
        }

        // 10. Fox hasn't visited
        if (foxId) {
          const myQ = await pool.query(`SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND user_id=$2 LIMIT 1`, [v.id, foxId]);
          if (!myQ.rows.length) {
            cards.push({
              type:"system", card_type:"nie_byles", title: pickOne(REC_TITLES_VENUE),
              name: v.name, text: `🦊 Jeszcze nie byłeś w ${v.name} — sprawdź!`,
              discount: disc > 10 ? disc : null, district: near ? "📍 Blisko Ciebie!" : null,
              status_badge: null, venue_id: v.id, is_promo: false
            });
          }
        }

        // 11. Top dish
        const dishQ = await pool.query(
          `SELECT d.name FROM fp1_venue_dishes d WHERE d.venue_id=$1 AND d.is_active=TRUE ORDER BY d.sort_order ASC LIMIT 1`, [v.id]
        );
        if (dishQ.rows.length) {
          cards.push({
            type:"system", card_type:"dish", title: pickOne(REC_TITLES_VENUE),
            name: v.name, text: `🦊 Czy wiesz, że Foxowie najczęściej wybierają w ${v.name}: ${dishQ.rows[0].name}?`,
            discount: disc > 10 ? disc : null, district: near ? "📍 Blisko Ciebie!" : null,
            status_badge: null, venue_id: v.id, is_promo: false
          });
        }

        // 12. Recommended by venue
        if (v.recommended && v.recommended.trim()) {
          cards.push({
            type:"system", card_type:"polecane", title: pickOne(REC_TITLES_VENUE),
            name: v.name, text: `🦊 ${v.name} poleca dziś: ${v.recommended.split('\n')[0].slice(0,80)}`,
            discount: disc > 10 ? disc : null, district: near ? "📍 Blisko Ciebie!" : null,
            status_badge: null, venue_id: v.id, is_promo: false
          });
        }

        // 13. Discount > 10%
        if (disc > 10) {
          cards.push({
            type:"system", card_type:"znizka", title: pickOne(REC_TITLES_VENUE),
            name: v.name, text: `🎁 ${v.name} oferuje ${disc}% zniżki dla Foxów!`,
            discount: disc, district: near ? "📍 Blisko Ciebie!" : null,
            status_badge: null, venue_id: v.id, is_promo: false
          });
        }

        // 14. Pioneer
        if (v.pioneer_number) {
          cards.push({
            type:"system", card_type:"pionier", title: pickOne(REC_TITLES_VENUE),
            name: v.name, text: `🌟 ${v.name} — jeden z pierwszych lokali w FoxPot!`,
            discount: disc > 10 ? disc : null, district: near ? "📍 Blisko Ciebie!" : null,
            status_badge: null, venue_id: v.id, is_promo: false
          });
        }

        // 15. Blisko Ciebie
        if (near && !cards.some(c => c.venue_id === v.id)) {
          cards.push({
            type:"system", card_type:"blisko", title: pickOne(REC_TITLES_VENUE),
            name: v.name, text: `📍 ${v.name} — partner FoxPot blisko Ciebie!`,
            discount: disc > 10 ? disc : null, district: "📍 Blisko Ciebie!",
            status_badge: null, venue_id: v.id, is_promo: false
          });
        }
      }

      // ── Step 3: Pick card respecting frequency cap ──
      // Shuffle cards, then pick first non-blocked
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      card = cards.find(c => !isBlocked(foxId, c)) || cards[0] || FALLBACK;
    }

    // Record shown card in fox history
    pushRecHistory(foxId, card);

    return res.json(card);
  } catch (e) {
    console.error("REC_ERR", e.message);
    res.json(FALLBACK);
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/top
═══════════════════════════════════════════════════════════════ */
app.get("/api/top", async (req, res) => {
  try {
    const myId = await resolveUserId(req);

    // Exclude admin from ranking list (parameterized)
    const adminExcludeSQL = ADMIN_TG_ID ? ` AND user_id != $1` : '';
    const topParams = ADMIN_TG_ID ? [ADMIN_TG_ID] : [];
    const top = await pool.query(
      `SELECT user_id, username, rating, founder_number
       FROM fp1_foxes WHERE is_deleted=FALSE${adminExcludeSQL} ORDER BY rating DESC LIMIT 10`,
      topParams
    );

    let myPosition = null, myRating = null;
    if (myId && !isAdmin(myId)) {
      const adminExcludePos = ADMIN_TG_ID ? ` AND user_id != $2` : '';
      const myRow = await pool.query(
        `SELECT rating,
         (SELECT COUNT(*)::int FROM fp1_foxes WHERE is_deleted=FALSE${adminExcludePos} AND rating > (SELECT rating FROM fp1_foxes WHERE user_id=$1 LIMIT 1)) + 1 AS pos
         FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, ADMIN_TG_ID ? [myId, ADMIN_TG_ID] : [myId]
      );
      if (myRow.rowCount > 0) {
        myPosition = myRow.rows[0].pos;
        myRating   = myRow.rows[0].rating;
      }
    }

    const foxBadges = await getTopFoxBadges();

    res.json({
      top:         top.rows.map(f => ({ ...f, top_badge: foxBadges[String(f.user_id)] || null })),
      my_position: myPosition,
      my_rating:   myRating,
      my_top_badge: myId ? (isAdmin(myId) ? null : (foxBadges[myId] || null)) : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTES — PANEL
═══════════════════════════════════════════════════════════════ */
app.get("/panel", (req, res) => {
  if (verifySession(getCookie(req))) return res.redirect("/panel/dashboard");
  const msg = req.query.msg ? `<div class="err">${escapeHtml(req.query.msg)}</div>` : "";
  res.send(pageShell("Panel lokalu", `
    <div class="card" style="max-width:400px;margin:60px auto">
      <h1>🦊 Panel lokalu</h1>${msg}
      <form method="POST" action="/panel/login">
        <label>ID lokalu</label>
        <input name="venue_id" type="number" min="1" required placeholder="np. 1" autocomplete="off"/>
        <label>PIN (6 cyfr)</label>
        <input name="pin" type="password" maxlength="6" required placeholder="••••••"/>
        <button type="submit" style="width:100%;margin-top:12px">Zaloguj →</button>
      </form>
    </div>`));
});

app.post("/panel/login", async (req, res) => {
  const ip = getIp(req);
  if (loginRate(ip).blocked) return res.redirect(`/panel?msg=${encodeURIComponent("Za dużo prób. Spróbuj za 15 minut.")}`);
  const venueId = String(req.body.venue_id || "").trim();
  const pin     = String(req.body.pin || "").trim();
  if (!venueId || !pin) { loginBad(ip); return res.redirect(`/panel?msg=${encodeURIComponent("Brak danych.")}`); }
  const v = await pool.query(`SELECT * FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
  if (v.rowCount === 0 || !v.rows[0].pin_salt) { loginBad(ip); return res.redirect(`/panel?msg=${encodeURIComponent("Nie znaleziono lokalu.")}`); }
  const venue = v.rows[0];
  if (pinHash(pin, venue.pin_salt) !== venue.pin_hash) { loginBad(ip); return res.redirect(`/panel?msg=${encodeURIComponent("Błędny PIN.")}`); }
  loginOk(ip);
  setCookie(res, signSession({ venue_id:String(venue.id), exp:Date.now()+SESSION_TTL_MS }));
  res.redirect("/panel/dashboard");
});

app.get("/panel/logout", (req, res) => { clearCookie(res); res.redirect("/panel"); });

app.get("/panel/dashboard", requirePanelAuth, async (req, res) => {
  try {
  const venueId = Number(req.panel.venue_id);
  if (!venueId || isNaN(venueId)) { clearCookie(res); return res.redirect("/panel"); }
  const venue   = await getVenue(venueId);
  if (!venue) { console.error("DASHBOARD: venue not found, venueId=", venueId, "typeof=", typeof venueId, "raw=", req.panel.venue_id); clearCookie(res); return res.redirect("/panel?msg=" + encodeURIComponent("Lokal nie znaleziony. Zaloguj ponownie.")); }
  const pending = await listPending(venueId);
  const status  = await currentVenueStatus(venueId);
  const reserveUsed = await reserveCountThisMonth(venueId);
  const limitedUsed = await limitedCountThisWeek(venueId);
  // Upcoming/active reservations
  const upcomingRes = await pool.query(
    `SELECT id, type, reason, starts_at, ends_at FROM fp1_venue_status
     WHERE venue_id=$1 AND ends_at > NOW() ORDER BY starts_at ASC LIMIT 10`, [venueId]
  );
  const newFoxMonth = await countNewFoxThisMonth(venueId);
  const newFoxTotal = await countNewFoxTotal(venueId);
  const growth  = await getGrowthLeaderboard(50);
  // Reviews
  const venueReviews = await pool.query(
    `SELECT r.id, f.username, r.rating, r.text, r.venue_reply, r.venue_reply_at, r.created_at
     FROM fp1_reviews r LEFT JOIN fp1_foxes f ON f.user_id::text = r.user_id
     WHERE r.venue_id = $1 ORDER BY r.created_at DESC LIMIT 30`, [venueId]
  );
  const reviewStats = await pool.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(AVG(rating),0)::numeric AS avg FROM fp1_reviews WHERE venue_id=$1`, [venueId]
  );
  // Rating distribution (5★ to 1★)
  const ratingDist = await pool.query(
    `SELECT rating, COUNT(*)::int AS cnt FROM fp1_reviews WHERE venue_id=$1 AND rating IS NOT NULL GROUP BY rating ORDER BY rating DESC`, [venueId]
  );
  const distMap = {5:0,4:0,3:0,2:0,1:0};
  ratingDist.rows.forEach(r => { distMap[r.rating] = r.cnt; });
  const totalRated = Object.values(distMap).reduce((a,b)=>a+b,0);
  const myPos   = growth.findIndex(g => Number(g.id) === Number(venueId)) + 1;

  let statusHtml = `<span class="badge badge-ok">● Aktywny</span>`;
  if (status) {
    const till = new Date(status.ends_at).toLocaleString("pl-PL", { timeZone:"Europe/Warsaw" });
    statusHtml = status.type === "reserve"
      ? `<span class="badge badge-err">📍 Rezerwacja do ${till}</span>`
      : `<span class="badge badge-warn">⚠️ Ograniczone (${escapeHtml(status.reason)}) do ${till}</span>`;
  }

  const foxBadges = await getTopFoxBadges();
  const pendingHtml = pending.length === 0
    ? `<div class="muted">Brak aktywnych check-inów</div>`
    : pending.map(p => {
        const min = Math.max(0, Math.ceil((new Date(p.expires_at) - Date.now()) / 60000));
        const foxName = p.username ? `@${escapeHtml(p.username)}` : `Fox #${String(p.user_id||'').slice(-4)}`;
        const isAdminUser = isAdmin(String(p.user_id));
        const badge = isAdminUser ? null : (foxBadges[String(p.user_id)] || null);
        const founderLabel = isAdminUser ? ` <span style="color:#FFD700;font-weight:700;font-size:12px">⭐ Założyciel</span>` : '';
        const badgeHtml = badge ? topFoxHtml(badge) : '';
        const nameColor = isAdminUser ? ` style="color:#FFD700;font-weight:700"` : (badge ? ` style="color:${TOP_FOX_COLORS[badge]};font-weight:700"` : '');
        const borderColor = isAdminUser ? '#FFD700' : (badge ? TOP_FOX_COLORS[badge] : null);
        return `<div style="margin:8px 0;padding:8px;border-radius:10px;border:1px solid ${borderColor ? borderColor+'40' : '#2a2f49'};background:${borderColor ? borderColor+'10' : 'transparent'}">
          <div>Kod wizyty: <b style="font-size:20px;letter-spacing:4px">${escapeHtml(p.otp)}</b> <span class="muted">· za ~${min} min</span></div>
          <div style="margin-top:4px;font-size:13px"><span${nameColor}>🦊 ${foxName}</span>${founderLabel}${badgeHtml}${p.founder_number && !isAdminUser ? ` <span style="color:#ffd700;font-size:11px">👑 #${p.founder_number}</span>` : ''} ${p.last_review_rating ? `<span style="color:#f5a623;font-size:12px">${'★'.repeat(p.last_review_rating)}${'☆'.repeat(5-p.last_review_rating)}</span>` : `<span style="font-size:11px;color:rgba(255,255,255,.3)">Pierwsza wizyta</span>`} <span class="muted">· ${p.rating||0} pkt · X/Y: ${p.fox_visits||0}/${p.total_visits||0}</span></div>
        </div>`;
      }).join("");

  const xy = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND is_credited=TRUE`, [venueId]);

  res.send(pageShell(`Panel — ${venue?.name || venueId}`, `
    <div class="card">
      <div class="topbar"><h1>🦊 ${escapeHtml(venue?.name||venueId)} ${statusHtml}</h1><a href="/panel/logout">Wyloguj</a></div>
      ${flash(req)}
      <div style="margin-top:10px;opacity:.7;font-size:13px">Kod lokalu: <b>${escapeHtml(venue.ref_code||'brak')}</b> | Łącznie wizyt: <b>${xy.rows[0].c}</b></div>
      ${venue.slug ? `<div style="margin-top:8px;display:flex;align-items:center;gap:6px"><a href="https://thefoxpot.club/lokal/${escapeHtml(venue.slug)}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:5px 12px;background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.25);border-radius:8px;color:#f5a623;font-size:12px;font-weight:700;text-decoration:none">🌐 Zobacz stronę</a><button onclick="navigator.clipboard.writeText('https://thefoxpot.club/lokal/${escapeHtml(venue.slug)}');this.textContent='✅';setTimeout(()=>this.textContent='📋',1500)" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:rgba(255,255,255,.5);padding:4px 8px;cursor:pointer;font-size:12px">📋</button></div>` : ''}
    </div>
    <div class="card">
      <h2>📊 Nowi Fox przez twój kod</h2>
      <div style="font-size:24px;font-weight:700;margin:10px 0">W tym miesiącu: ${newFoxMonth} Fox</div>
      <div class="muted">Łącznie przyciągniętych: ${newFoxTotal} Fox</div>
      ${myPos > 0 ? `<div class="muted" style="margin-top:8px">Jesteś na ${myPos} miejscu w rankingu! 🏆</div>` : ""}
    </div>
    <div class="grid2">
      <div class="card">
        <h2>Potwierdź kod wizyty</h2>
        <form method="POST" action="/panel/confirm">
          <input name="otp" placeholder="000000" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="off" autofocus style="font-size:28px;letter-spacing:10px;text-align:center"/>
          <button type="submit" style="width:100%;margin-top:10px">Potwierdź ✓</button>
        </form>
      </div>
      <div class="card">
        <h2>Oczekujące check-iny</h2>
        ${pendingHtml}
        <form method="GET" action="/panel/dashboard" style="margin-top:10px">
          <button type="submit" class="outline" style="width:100%">↻ Odśwież</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>Statusy lokalu</h2>
      <div class="grid2">
        <div>
          <b>📍 Rezerwacja</b> <span class="muted">(${reserveUsed}/2 w tym mies., min. 24h wcześniej)</span>
          <form method="POST" action="/panel/reserve" style="margin-top:8px">
            <label>Początek</label><input type="datetime-local" name="starts_at" required/>
            <label>Czas trwania</label>
            <select name="hours"><option value="1">1 godz.</option><option value="2">2 godz.</option><option value="4">4 godz.</option><option value="8">8 godz.</option><option value="24" selected>24 godz.</option></select>
            <button type="submit" style="margin-top:10px;width:100%">Ustaw rezerwację</button>
          </form>
        </div>
        <div>
          <b>⚠️ Dziś ograniczone</b> <span class="muted">(${limitedUsed}/2 w tym tyg., do 3h)</span>
          <form method="POST" action="/panel/limited" style="margin-top:8px">
            <label>Powód</label>
            <select name="reason"><option value="FULL">Brak miejsc</option><option value="PRIVATE EVENT">Wydarzenie prywatne</option><option value="KITCHEN LIMIT">Ograniczenie kuchni</option></select>
            <label>Czas trwania</label>
            <select name="hours"><option value="1">1 godz.</option><option value="2">2 godz.</option><option value="3" selected>3 godz.</option></select>
            <button type="submit" style="margin-top:10px;width:100%">Ustaw status</button>
          </form>
          ${status ? `<form method="POST" action="/panel/status/cancel" style="margin-top:8px"><button type="submit" class="danger" style="width:100%">Anuluj aktywny status</button></form>` : ""}
        </div>
      </div>
    </div>
    ${upcomingRes.rows.length > 0 ? `<div class="card">
      <h2>📋 Aktywne i nadchodzące</h2>
      ${upcomingRes.rows.map(r => {
        const start = new Date(r.starts_at).toLocaleString("pl-PL", { timeZone:"Europe/Warsaw", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
        const end = new Date(r.ends_at).toLocaleString("pl-PL", { timeZone:"Europe/Warsaw", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
        const isNow = new Date(r.starts_at) <= new Date() && new Date(r.ends_at) > new Date();
        const icon = r.type === "reserve" ? "📍" : "⚠️";
        const label = r.type === "reserve" ? "Rezerwacja" : `Ograniczone (${escapeHtml(r.reason || "")})`;
        return `<div style="padding:8px 12px;margin:4px 0;border-radius:8px;border:1px solid ${isNow ? 'rgba(239,68,68,.4)' : 'rgba(255,255,255,.1)'};background:${isNow ? 'rgba(239,68,68,.08)' : 'transparent'};display:flex;justify-content:space-between;align-items:center">
          <div>${icon} <b>${label}</b><br/><span class="muted" style="font-size:12px">${start} — ${end}${isNow ? ' <span style="color:#ef4444;font-weight:700">● TERAZ</span>' : ''}</span></div>
          <form method="POST" action="/panel/status/cancel/${r.id}" style="margin:0"><button type="submit" class="danger" style="font-size:12px;padding:4px 12px">Anuluj</button></form>
        </div>`;
      }).join("")}
    </div>` : ""}
    <div class="card">
      <h2>📸 Zdjęcia lokalu (max 10)</h2>
      <p class="muted" style="margin-bottom:12px">Wybierz zdjęcia z telefonu lub komputera. Automatycznie zostaną zapisane.</p>
      <div id="photosGrid" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px"></div>
      <div id="photosMsg" style="margin-bottom:8px"></div>
      <script>
        let venuePhotos = [];
        async function loadPhotos(){
          try{
            const r=await fetch('/panel/venue/photos',{credentials:'same-origin'});
            const d=await r.json();
            venuePhotos = d.photos || [];
            renderPhotos();
          }catch(e){console.error('loadPhotos',e)}
        }
        function renderPhotos(){
          const grid=document.getElementById('photosGrid');
          let html='';
          venuePhotos.forEach((p,i)=>{
            html+=\`<div style="position:relative;width:120px;height:120px;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.15)">
              <img src="\${p.url}" style="width:100%;height:100%;object-fit:cover"/>
              <button onclick="deletePhoto(\${p.id})" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,.7);border:none;color:#ef4444;font-size:16px;width:28px;height:28px;border-radius:50%;cursor:pointer">✕</button>
            </div>\`;
          });
          if(venuePhotos.length<10){
            html+=\`<label style="display:flex;align-items:center;justify-content:center;width:120px;height:120px;border-radius:12px;border:2px dashed rgba(255,255,255,.2);cursor:pointer;flex-direction:column;gap:4px">
              <input type="file" accept="image/jpeg,image/png,image/webp" onchange="uploadPhoto(this)" style="display:none"/>
              <span style="font-size:28px">+</span>
              <span style="font-size:11px;color:rgba(255,255,255,.4)">Dodaj</span>
            </label>\`;
          }
          grid.innerHTML=html;
        }
        async function uploadPhoto(input){
          const file=input.files[0];
          if(!file) return;
          if(file.size>5*1024*1024){document.getElementById('photosMsg').innerHTML='<span style="color:#ef4444">❌ Max 5 MB</span>';return}
          const msg=document.getElementById('photosMsg');
          msg.innerHTML='<span style="color:var(--fox)">⏳ Wysyłanie...</span>';
          const reader=new FileReader();
          reader.onload=async function(){
            try{
              const r=await fetch('/panel/venue/photos/upload',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:reader.result})});
              const d=await r.json();
              if(d.error){msg.innerHTML='<span style="color:#ef4444">❌ '+d.error+'</span>';return}
              msg.innerHTML='<span style="color:#2ecc71">✅ Zdjęcie dodane!</span>';
              venuePhotos.push({id:d.id,url:d.url,sort_order:d.sort_order});
              renderPhotos();
            }catch(e){msg.innerHTML='<span style="color:#ef4444">❌ Błąd uploadu</span>'}
          };
          reader.readAsDataURL(file);
        }
        async function deletePhoto(id){
          if(!confirm('Usunąć zdjęcie?')) return;
          try{
            await fetch('/panel/venue/photos/'+id,{method:'DELETE',credentials:'same-origin'});
            venuePhotos=venuePhotos.filter(p=>p.id!==id);
            renderPhotos();
            document.getElementById('photosMsg').innerHTML='<span style="color:#2ecc71">✅ Usunięto</span>';
          }catch(e){document.getElementById('photosMsg').innerHTML='<span style="color:#ef4444">❌ Błąd</span>'}
        }
        loadPhotos();
      </script>
    </div>
    <div class="card">
      <h2>🍽 Menu lokalu</h2>
      <p class="muted" style="margin-bottom:10px">Dodaj pozycje z menu — Fox'owie zobaczą je na kartce lokalu.</p>
      <div id="menuList"></div>
      <div style="margin-top:10px;padding:10px;border:1px dashed rgba(255,255,255,.15);border-radius:8px">
        <div class="grid2" style="margin-bottom:6px">
          <div><input id="menuName" maxlength="80" placeholder="Nazwa dania"/></div>
          <div><select id="menuCat"><option value="main">🍽 Danie główne</option><option value="snack">🥗 Przystawka</option><option value="soup">🍲 Zupa</option><option value="dessert">🍰 Deser</option><option value="drink">☕ Napój</option><option value="alcohol">🍺 Alkohol</option></select></div>
        </div>
        <div class="grid2">
          <div><input id="menuPrice" type="number" min="0" step="0.5" placeholder="Cena (zł)"/></div>
          <div><button type="button" onclick="addMenuItem()" style="width:100%;margin:0">+ Dodaj</button></div>
        </div>
        <div id="menuMsg" style="font-size:12px;margin-top:6px"></div>
      </div>
      <script>
        let menuItems=[];
        const menuCatNames={main:'🍽 Danie główne',snack:'🥗 Przystawka',soup:'🍲 Zupa',dessert:'🍰 Deser',drink:'☕ Napój',alcohol:'🍺 Alkohol'};
        async function loadMenu(){
          try{const r=await fetch('/panel/venue/menu',{credentials:'same-origin'});const d=await r.json();menuItems=d.items||[];renderMenu();}catch(e){console.error(e)}
        }
        function renderMenu(){
          const el=document.getElementById('menuList');
          if(!menuItems.length){el.innerHTML='<div class="muted">Brak pozycji w menu</div>';return}
          el.innerHTML=menuItems.map(m=>
            \`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
              <div style="flex:1;font-size:13px"><b>\${m.name}</b> <span class="muted" style="font-size:11px">\${menuCatNames[m.category]||m.category}</span></div>
              \${m.price?'<div style="font-size:13px;font-weight:700;color:var(--fox)">'+parseFloat(m.price).toFixed(0)+' zł</div>':''}
              <button onclick="deleteMenuItem(\${m.id})" style="background:transparent;border:1px solid rgba(239,68,68,.3);border-radius:6px;color:#ef4444;font-size:11px;padding:2px 8px;cursor:pointer">✕</button>
            </div>\`
          ).join('');
        }
        async function addMenuItem(){
          const name=document.getElementById('menuName').value.trim();
          const cat=document.getElementById('menuCat').value;
          const price=document.getElementById('menuPrice').value;
          if(!name){document.getElementById('menuMsg').innerHTML='<span style="color:#ef4444">Podaj nazwę</span>';return}
          try{
            const r=await fetch('/panel/venue/menu',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,category:cat,price:price||null})});
            const d=await r.json();
            if(d.error){document.getElementById('menuMsg').innerHTML='<span style="color:#ef4444">'+d.error+'</span>';return}
            document.getElementById('menuMsg').innerHTML='<span style="color:#2ecc71">✅ Dodano</span>';
            document.getElementById('menuName').value='';document.getElementById('menuPrice').value='';
            loadMenu();
          }catch(e){document.getElementById('menuMsg').innerHTML='<span style="color:#ef4444">Błąd</span>'}
        }
        async function deleteMenuItem(id){
          if(!confirm('Usunąć pozycję?')) return;
          try{await fetch('/panel/venue/menu/'+id,{method:'DELETE',credentials:'same-origin'});loadMenu();}catch(e){}
        }
        loadMenu();
      </script>
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08)">
        <div style="font-size:12px;font-weight:700;color:#f5a623;margin-bottom:8px">📄 Lub wgraj gotowe menu jako zdjęcia lub PDF (max 5)</div>
        <div id="menuFilesList"></div>
        <div id="menuFileUploadArea"></div>
        <div id="menuFileMsg" style="font-size:12px;margin-top:6px"></div>
      </div>
      <script>
        let _menuFiles=[];
        async function loadMenuFiles(){
          try{const r=await fetch('/panel/venue/menu-files',{credentials:'same-origin'});const d=await r.json();_menuFiles=d.files||[];renderMenuFiles();}catch(e){console.error(e)}
        }
        function renderMenuFiles(){
          const list=document.getElementById('menuFilesList');
          list.innerHTML=_menuFiles.map(f=>'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:8px;background:rgba(255,255,255,.04);border-radius:8px"><a href="'+f.url+'" target="_blank" style="color:#f5a623;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📎 Plik #'+(f.sort_order+1)+'</a><button onclick="deleteMenuFile('+f.id+')" style="background:transparent;border:1px solid rgba(239,68,68,.3);border-radius:6px;color:#ef4444;font-size:11px;padding:2px 10px;cursor:pointer">✕</button></div>').join('');
          const area=document.getElementById('menuFileUploadArea');
          if(_menuFiles.length<5){
            area.innerHTML='<label style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.15);border-radius:8px;cursor:pointer;font-size:13px;color:rgba(255,255,255,.6)"><input type="file" accept="image/jpeg,image/png,application/pdf" onchange="uploadMenuFile(this)" style="display:none"/>+ Dodaj plik (JPG, PNG, PDF, max 10 MB)</label>';
          } else { area.innerHTML='<div class="muted" style="font-size:12px">Osiągnięto limit 5 plików</div>'; }
        }
        async function uploadMenuFile(input){
          const file=input.files[0];if(!file)return;
          if(file.size>10*1024*1024){document.getElementById('menuFileMsg').innerHTML='<span style="color:#ef4444">Max 10 MB</span>';return}
          document.getElementById('menuFileMsg').innerHTML='<span style="color:var(--fox)">⏳ Wysyłanie...</span>';
          const reader=new FileReader();
          reader.onload=async function(){
            try{
              const r=await fetch('/panel/venue/menu-file',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:reader.result})});
              const d=await r.json();
              if(d.error){document.getElementById('menuFileMsg').innerHTML='<span style="color:#ef4444">'+d.error+'</span>';return}
              document.getElementById('menuFileMsg').innerHTML='<span style="color:#2ecc71">✅ Dodano!</span>';
              _menuFiles.push({id:d.id,url:d.url,sort_order:_menuFiles.length});
              renderMenuFiles();
            }catch(e){document.getElementById('menuFileMsg').innerHTML='<span style="color:#ef4444">Błąd</span>'}
          };
          reader.readAsDataURL(file);
        }
        async function deleteMenuFile(id){
          if(!confirm('Usunąć plik menu?'))return;
          try{
            await fetch('/panel/venue/menu-file/'+id,{method:'DELETE',credentials:'same-origin'});
            _menuFiles=_menuFiles.filter(f=>f.id!==id);
            renderMenuFiles();
            document.getElementById('menuFileMsg').innerHTML='<span style="color:#2ecc71">✅ Usunięto</span>';
          }catch(e){document.getElementById('menuFileMsg').innerHTML='<span style="color:#ef4444">Błąd</span>'}
        }
        loadMenuFiles();
      </script>
    </div>
    <div class="card">
      <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;color:var(--text);font-size:14px;font-weight:700;cursor:pointer;text-align:left">🎟️ Indywidualna zniżka dla Fox'a ▾</button>
      <div style="display:none;margin-top:12px">
        <p class="muted" style="margin-bottom:8px">Ustaw większą zniżkę dla konkretnego Fox'a. Minimum: ${parseFloat(venue.discount_percent)||10}% (domyślna).</p>
        <form method="POST" action="/panel/discount">
          <div class="grid2">
            <div><label>Telegram ID Fox'a</label><input name="user_id" type="number" required placeholder="np. 457874548"/></div>
            <div><label>Zniżka %</label><input name="discount_percent" type="number" min="${parseFloat(venue.discount_percent)||10}" max="100" step="1" required placeholder="np. 15" value="15"/></div>
          </div>
          <div style="margin-top:8px"><label>Czas trwania</label>
            <select name="is_temporary"><option value="0">Stała</option><option value="1">Tylko dziś</option></select>
          </div>
          <button type="submit" style="margin-top:10px;width:100%">💰 Ustaw zniżkę</button>
        </form>
      </div>
    </div>
    <div class="card">
      <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;color:var(--text);font-size:14px;font-weight:700;cursor:pointer;text-align:left">🎫 Program stempli ▾</button>
      <div style="display:none;margin-top:12px">
        <form method="POST" action="/panel/stamps">
          <div class="grid2">
            <div><label>Telegram ID gościa <a href="/faq#lq34" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;font-weight:400" title="Jak znaleźć ID?">(jak znaleźć?)</a></label><input name="user_id" type="number" required placeholder="np. 457874548"/></div>
            <div><label>Emoji</label>
              <select name="emoji"><option>⭐</option><option>🦊</option><option>🔥</option><option>🎁</option><option>💎</option><option>🏆</option><option>👑</option><option>❤️</option><option>🍕</option><option>🍔</option><option>🌭</option><option>🍟</option><option>🍣</option><option>🍱</option><option>🍜</option><option>🍝</option><option>🥩</option><option>🍗</option><option>🥗</option><option>🥪</option><option>🌮</option><option>🌯</option><option>🥐</option><option>🍰</option><option>🎂</option><option>🧁</option><option>🍩</option><option>🍪</option><option>🍦</option><option>🍫</option><option>🍺</option><option>🍻</option><option>🍷</option><option>🍸</option><option>☕</option><option>🧋</option><option>🥤</option><option>🍹</option></select>
            </div>
            <div><label>Akcja</label><select name="delta"><option value="1">+1 (dodaj)</option><option value="-1">-1 (użyj)</option><option value="-10">-10 (gratis / nagroda)</option></select></div>
            <div><label>Notatka (opcjonalnie)</label><input name="note" placeholder="np. darmowy deser"/></div>
          </div>
          <button type="submit" style="margin-top:10px">Zastosuj stempel</button>
        </form>
      </div>
    </div>
    <div class="card">
      <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;color:var(--text);font-size:14px;font-weight:700;cursor:pointer;text-align:left">📊 Statystyki Foxów ▾</button>
      <div id="foxChoiceStats" style="display:none;margin-top:12px"><span class="muted">Ładowanie...</span></div>
      <script>
        (async function(){
          try{
            const r=await fetch('/panel/venue/choice-stats',{credentials:'same-origin'});
            const d=await r.json();
            const el=document.getElementById('foxChoiceStats');
            if(!d.stats||d.stats.length===0){el.innerHTML='<span class="muted">Brak danych jeszcze</span>';return;}
            const catNames={main:'🍽 Główne',snack:'🥗 Przystawka',dessert:'🍰 Deser',drink:'☕ Napój',soup:'🍲 Zupa',alcohol:'🍺 Alkohol',other:'📦 Inne'};
            const total=d.stats.reduce((s,x)=>s+x.cnt,0);
            el.innerHTML=d.stats.map(s=>{
              const pct=total>0?Math.round(s.cnt/total*100):0;
              return '<div style="display:flex;align-items:center;gap:8px;margin:6px 0">'+
                '<div style="flex:1;font-size:13px">'+(catNames[s.agg_category]||s.agg_category)+'</div>'+
                '<div style="width:120px;height:8px;background:#1a1e2e;border-radius:4px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:#6e56ff;border-radius:4px"></div></div>'+
                '<div style="font-size:12px;color:#fff;font-weight:700;width:40px;text-align:right">'+pct+'%</div></div>';
            }).join('')+'<div class="muted" style="margin-top:8px">Łącznie odpowiedzi: '+total+'</div>';
            if(d.top_dishes&&d.top_dishes.length>0){
              el.innerHTML+='<div style="margin-top:12px;font-size:13px;font-weight:700">🏆 Najczęściej wybierane dania:</div>'+
                d.top_dishes.map((td,i)=>'<div style="font-size:13px;margin:4px 0">'+(i+1)+'. '+td.name+' <span class="muted">('+td.cnt+'×)</span></div>').join('');
            }
          }catch(e){document.getElementById('foxChoiceStats').innerHTML='<span class="muted">Błąd</span>';}
        })();
      </script>
    </div>
    <div class="card" style="border:1px solid rgba(255,138,0,.3);background:rgba(255,138,0,.06)">
      <h2>📣 Reklama w The FoxPot Club</h2>
      <p style="font-size:13px;color:rgba(255,255,255,.7);margin-bottom:12px">Promuj swój lokal wśród Fox'ów. Twój lokal pojawi się jako polecany w aplikacji The FoxPot Club.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
        <div>
          <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,138,0,.25);background:rgba(255,138,0,.06);cursor:pointer;text-align:left;color:var(--text);font-family:var(--font)">
            <span style="font-weight:800;color:var(--fox)">START</span> · <span style="font-weight:800">199 zł</span> · <span style="color:var(--muted);font-size:12px">3 dni</span>
          </button>
          <div style="display:none;padding:10px;font-size:12px;color:var(--muted);line-height:1.6">
            <div>✅ Wyróżnienie lokalu w sekcji „Polecane"</div>
            <div>✅ Widoczność na górze listy lokali przez 3 dni</div>
            <div>✅ Etykieta „Polecany" na kartce lokalu</div>
            <form method="POST" action="/panel/promo-order" style="margin-top:8px"><input type="hidden" name="package" value="start"/><button type="submit" style="width:100%;padding:10px;background:var(--fox);border:none;border-radius:var(--radius-sm);color:#000;font-weight:700;font-size:13px;cursor:pointer">📩 Zamów START</button></form>
          </div>
        </div>
        <div>
          <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(59,130,246,.3);background:rgba(59,130,246,.06);cursor:pointer;text-align:left;color:var(--text);font-family:var(--font)">
            <span style="font-weight:800;color:#3B82F6">BOOST</span> · <span style="font-weight:800">499 zł</span> · <span style="color:var(--muted);font-size:12px">5 dni</span>
          </button>
          <div style="display:none;padding:10px;font-size:12px;color:var(--muted);line-height:1.6">
            <div>✅ Wszystko z pakietu START</div>
            <div>✅ Promocja przez 5 dni</div>
            <div>✅ Wyróżniony kolor na mapie</div>
            <div>✅ Post na kanale Telegram FoxPot</div>
            <form method="POST" action="/panel/promo-order" style="margin-top:8px"><input type="hidden" name="package" value="boost"/><button type="submit" style="width:100%;padding:10px;background:#3B82F6;border:none;border-radius:var(--radius-sm);color:#fff;font-weight:700;font-size:13px;cursor:pointer">📩 Zamów BOOST</button></form>
          </div>
        </div>
        <div>
          <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(139,92,246,.3);background:rgba(139,92,246,.06);cursor:pointer;text-align:left;color:var(--text);font-family:var(--font)">
            <span style="font-weight:800;color:#8B5CF6">PREMIUM</span> · <span style="font-weight:800">799 zł</span> · <span style="color:var(--muted);font-size:12px">7 dni + wideo</span>
          </button>
          <div style="display:none;padding:10px;font-size:12px;color:var(--muted);line-height:1.6">
            <div>✅ Wszystko z pakietu BOOST</div>
            <div>✅ Promocja przez 7 dni</div>
            <div>✅ Profesjonalny materiał wideo (reels/TikTok)</div>
            <div>✅ Publikacja na Instagram, TikTok, YouTube FoxPot</div>
            <div>✅ Priorytetowe wsparcie</div>
            <form method="POST" action="/panel/promo-order" style="margin-top:8px"><input type="hidden" name="package" value="premium"/><button type="submit" style="width:100%;padding:10px;background:#8B5CF6;border:none;border-radius:var(--radius-sm);color:#fff;font-weight:700;font-size:13px;cursor:pointer">📩 Zamów PREMIUM</button></form>
          </div>
        </div>
      </div>
      <div id="promoOrderMsg"></div>
    </div>
    <div class="card">
      <h2>⭐ Twój rating od Fox'ów</h2>
      ${totalRated > 0 ? `<div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;padding:12px;background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.15);border-radius:10px">
        <div style="text-align:center;min-width:70px"><div style="font-size:32px;font-weight:800;color:#f5a623">${parseFloat(reviewStats.rows[0].avg).toFixed(1)}</div><div style="font-size:11px;color:rgba(255,255,255,.4)">${totalRated} ocen</div></div>
        <div style="flex:1">${[5,4,3,2,1].map(s => {const pct=totalRated>0?Math.round(distMap[s]/totalRated*100):0; return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="font-size:11px;color:rgba(255,255,255,.5);min-width:18px">${s}★</span><div style="flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:#f5a623;border-radius:4px"></div></div><span style="font-size:10px;color:rgba(255,255,255,.3);min-width:22px;text-align:right">${distMap[s]}</span></div>`;}).join('')}
        </div>
      </div>` : `<div class="muted" style="margin-bottom:8px">Brak ocen od Fox'ów</div>`}
    </div>
    <div class="card">
      <h2>💬 Opinie Fox'ów</h2>
      ${reviewStats.rows[0].cnt > 0 ? `<div style="margin-bottom:12px;padding:12px;background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.15);border-radius:10px;text-align:center"><span style="font-size:24px;font-weight:800;color:#f5a623">${parseFloat(reviewStats.rows[0].avg).toFixed(1)}</span><span style="font-size:14px;color:rgba(255,255,255,.5)"> / 5</span><div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:2px">Średnia ocena na podstawie ${reviewStats.rows[0].cnt} opinii</div></div>` : `<div class="muted" style="margin-bottom:8px">Brak opinii</div>`}
      ${venueReviews.rows.map(r => {
        const stars = r.rating ? ('★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)) : '';
        const date = new Date(r.created_at).toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw" });
        return `<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div><span style="font-weight:700">@${escapeHtml(r.username||'Fox')}</span>${stars ? ` <span style="color:#f5a623;font-size:13px">${stars}</span>` : ''}</div>
            <span style="font-size:11px;color:rgba(255,255,255,.3)">${date}</span>
          </div>
          ${r.text ? `<div style="font-size:13px;color:rgba(255,255,255,.6);line-height:1.5;margin-bottom:4px">${escapeHtml(r.text)}</div>` : ''}
          ${r.venue_reply ? `<div style="margin-top:6px;padding:8px;background:rgba(46,204,113,.08);border-left:2px solid rgba(46,204,113,.3);border-radius:0 6px 6px 0;font-size:12px;color:rgba(255,255,255,.5)"><span style="color:#2ecc71;font-weight:700">Odpowiedź:</span> ${escapeHtml(r.venue_reply)}</div>` : `<form method="POST" action="/panel/review/${r.id}/reply" style="margin-top:4px;display:flex;gap:4px"><input name="reply" placeholder="Odpowiedz..." maxlength="500" style="flex:1;padding:6px 8px;font-size:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:6px;color:#f0f0f5;font-family:inherit"/><button type="submit" style="padding:6px 12px;font-size:11px;background:rgba(46,204,113,.15);border:1px solid rgba(46,204,113,.3);color:#2ecc71;border-radius:6px;cursor:pointer;font-weight:700">Wyślij</button></form>`}
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <button type="button" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="width:100%;background:transparent;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;color:var(--text);font-size:14px;font-weight:700;cursor:pointer;text-align:left">⚙️ Ustawienia lokalu ▾</button>
      <form method="POST" action="/panel/settings" style="display:none">
        <div class="grid2">
          <div><label>Typ lokalu</label><select name="venue_type">
            <option value=""${!venue.venue_type?' selected':''}>— wybierz —</option>
            <option value="restauracja"${venue.venue_type==='restauracja'?' selected':''}>🍝 Restauracja</option>
            <option value="kawiarnia"${venue.venue_type==='kawiarnia'?' selected':''}>☕ Kawiarnia</option>
            <option value="bar"${venue.venue_type==='bar'?' selected':''}>🍺 Bar</option>
            <option value="fastfood"${venue.venue_type==='fastfood'?' selected':''}>🍔 Fast food</option>
            <option value="streetfood"${venue.venue_type==='streetfood'?' selected':''}>🥡 Street food</option>
            <option value="inne"${venue.venue_type==='inne'?' selected':''}>➕ Inne</option>
          </select></div>
          <div><label>Kuchnia (np. włoska, azjatycka)</label><input name="cuisine" value="${escapeHtml(venue.cuisine||'')}" maxlength="60"/></div>
        </div>
        <label>Opis lokalu (widoczny dla Fox)</label>
        <textarea name="description" rows="2" maxlength="300">${escapeHtml(venue.description||'')}</textarea>
        <label>Polecane dania / napoje (tekst wolny)</label>
        <textarea name="recommended" rows="2" maxlength="300">${escapeHtml(venue.recommended||'')}</textarea>
        <label>Godziny otwarcia (np. Pn-Pt: 10-22, Sob: 11-23)</label>
        <textarea name="opening_hours" rows="2" maxlength="300">${escapeHtml(venue.opening_hours||'')}</textarea>
        <label>Status chwilowy (np. "Dziś zamknięte od 18:00" — puste = brak)</label>
        <input name="status_temporary" value="${escapeHtml(venue.status_temporary||'')}" maxlength="120"/>
        <label>Numer telefonu</label>
        <input name="phone" value="${escapeHtml(venue.phone||'')}" maxlength="20" placeholder="+48 500 000 000" type="tel"/>
        <div class="grid2" style="margin-top:8px">
          <div><label>Tags (vegan, gluten-free)</label><input name="tags" value="${escapeHtml(venue.tags||'')}" maxlength="100"/></div>
          <div><label>Google Place ID</label><input name="google_place_id" value="${escapeHtml(venue.google_place_id||'')}" maxlength="100"/></div>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)">
          <div style="font-size:12px;font-weight:700;color:#f5a623;margin-bottom:8px">📱 Social media lokalu</div>
          <div class="grid2">
            <div><label>Instagram URL</label><input name="instagram_url" value="${escapeHtml(venue.instagram_url||'')}" maxlength="200" placeholder="https://instagram.com/..."/></div>
            <div><label>Facebook URL</label><input name="facebook_url" value="${escapeHtml(venue.facebook_url||'')}" maxlength="200" placeholder="https://facebook.com/..."/></div>
          </div>
          <div><label>TikTok URL</label><input name="tiktok_url" value="${escapeHtml(venue.tiktok_url||'')}" maxlength="200" placeholder="https://tiktok.com/@..."/></div>
          <div class="grid2">
            <div><label>YouTube URL</label><input name="youtube_url" value="${escapeHtml(venue.youtube_url||'')}" maxlength="200" placeholder="https://youtube.com/@..."/></div>
            <div><label>Website URL</label><input name="website_url" value="${escapeHtml(venue.website_url||'')}" maxlength="200" placeholder="https://..."/></div>
          </div>
        </div>
        <button type="submit" style="margin-top:12px;width:100%">💾 Zapisz ustawienia</button>
      </form>
    </div>
    `));
  } catch (e) {
    console.error("DASHBOARD ERROR:", e);
    res.status(500).send(pageShell("Panel — Błąd", `<div class="card"><h2>❌ Błąd ładowania panelu</h2><p class="muted">${escapeHtml(String(e?.message || e).slice(0, 200))}</p><a href="/panel/dashboard">Spróbuj ponownie</a></div>`));
  }
});

// ── PANEL: GET venue dishes (Top 3) ──
app.get("/panel/venue/dishes", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  try {
    const r = await pool.query(
      `SELECT id, name, category, sort_order, is_active FROM fp1_venue_dishes WHERE venue_id=$1 ORDER BY sort_order ASC`,
      [venueId]
    );
    res.json({ dishes: r.rows });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// ── PANEL: PUT venue dishes (upsert Top 3) ──
app.put("/panel/venue/dishes", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const AGG_WHITELIST = ["main","snack","dessert","drink","alcohol","other"];
  try {
    const dishes = req.body.dishes;
    if (!Array.isArray(dishes) || dishes.length > 3) return res.status(400).json({ error: "Podaj do 3 dań" });
    for (const d of dishes) {
      const name = String(d.name || "").trim();
      const cat = String(d.category || "").trim();
      const order = parseInt(d.sort_order);
      const active = d.is_active !== false;
      if (name.length < 2 || name.length > 40) return res.status(400).json({ error: `Nazwa "${name}" — 2-40 znaków` });
      if (!AGG_WHITELIST.includes(cat)) return res.status(400).json({ error: `Nieznana kategoria: ${cat}` });
      if (![1,2,3].includes(order)) return res.status(400).json({ error: `sort_order musi być 1, 2 lub 3` });
      await pool.query(
        `INSERT INTO fp1_venue_dishes(venue_id, name, category, sort_order, is_active, updated_at)
         VALUES($1,$2,$3,$4,$5,NOW())
         ON CONFLICT(venue_id, sort_order) DO UPDATE SET name=$2, category=$3, is_active=$5, updated_at=NOW()`,
        [venueId, name, cat, order, active]
      );
    }
    const r = await pool.query(`SELECT id, name, category, sort_order, is_active FROM fp1_venue_dishes WHERE venue_id=$1 ORDER BY sort_order`, [venueId]);
    res.json({ ok: true, dishes: r.rows });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// ── MINI APP: GET venue dishes for Fox ──
app.get("/api/venues/:venue_id/dishes", async (req, res) => {
  try {
    const venueId = parseInt(req.params.venue_id);
    const r = await pool.query(
      `SELECT id, name, category, sort_order FROM fp1_venue_dishes WHERE venue_id=$1 AND is_active=TRUE ORDER BY sort_order ASC LIMIT 3`,
      [venueId]
    );
    res.json({ dishes: r.rows });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// ── MINI APP: POST choice after check-in ──
app.post("/api/checkin/:checkin_id/choice", requireWebAppAuth, async (req, res) => {
  const AGG_WHITELIST = ["main","snack","dessert","drink","alcohol","other"];
  try {
    const userId = req.tgUser.id;
    const checkinId = parseInt(req.params.checkin_id);
    const { dish_id, agg_category, custom_text } = req.body;
    const rr = await pool.query(
      `SELECT id, venue_id, choice_source, bonus_awarded_base, bonus_awarded_mini
       FROM fp1_receipts WHERE checkin_id=$1 AND user_id=$2 AND amount_paid > 0
       ORDER BY id DESC LIMIT 1`, [checkinId, userId]);
    if (rr.rowCount === 0) return res.status(404).json({ error: "receipt_not_found" });
    const receipt = rr.rows[0];
    if (receipt.choice_source) return res.status(400).json({ error: "choice_already_made" });
    let source, aggCat, dishIdVal = null, customVal = null;
    if (dish_id) {
      const dr = await pool.query(`SELECT id, category FROM fp1_venue_dishes WHERE id=$1 AND venue_id=$2 AND is_active=TRUE LIMIT 1`, [dish_id, receipt.venue_id]);
      if (dr.rowCount === 0) return res.status(400).json({ error: "dish_not_found" });
      source = "top3"; aggCat = dr.rows[0].category; dishIdVal = dr.rows[0].id;
    } else if (custom_text) {
      const cat = String(agg_category || "").trim();
      if (!AGG_WHITELIST.includes(cat)) return res.status(400).json({ error: "agg_category_required" });
      const text = String(custom_text || "").trim();
      const valid = validateCustomText(text);
      if (!valid.ok) return res.json({ ok: false, error: valid.error, base_bonus: false, mini_bonus: false });
      const dupV = await pool.query(`SELECT 1 FROM fp1_receipts WHERE user_id=$1 AND venue_id=$2 AND custom_text=$3 LIMIT 1`, [userId, receipt.venue_id, text]);
      if (dupV.rowCount > 0) return res.json({ ok: false, error: "already_submitted_for_venue", base_bonus: false, mini_bonus: false });
      const dup7 = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_receipts WHERE user_id=$1 AND custom_text=$2 AND created_at > NOW()-INTERVAL '7 days'`, [userId, text]);
      if (dup7.rows[0].c >= 3) return res.json({ ok: false, error: "too_many_same_text", base_bonus: false, mini_bonus: false });
      source = "custom"; aggCat = cat; customVal = text;
    } else if (agg_category) {
      const cat = String(agg_category || "").trim();
      if (!AGG_WHITELIST.includes(cat)) return res.status(400).json({ error: "invalid_category" });
      source = "category"; aggCat = cat;
    } else { return res.status(400).json({ error: "no_choice" }); }
    // ATOMIC: save choice only if choice_source IS NULL
    const upd = await pool.query(
      `UPDATE fp1_receipts SET choice_source=$1, agg_category=$2, dish_id=$3, custom_text=$4
       WHERE id=$5 AND choice_source IS NULL RETURNING id`,
      [source, aggCat, dishIdVal, customVal, receipt.id]);
    if (upd.rowCount === 0) return res.status(400).json({ error: "choice_already_made" });
    let baseBonus = false, miniBonus = false;
    // ATOMIC: base bonus
    const bUpd = await pool.query(
      `UPDATE fp1_receipts SET bonus_awarded_base=TRUE WHERE id=$1 AND (bonus_awarded_base IS NULL OR bonus_awarded_base=FALSE) RETURNING id`, [receipt.id]);
    if (bUpd.rowCount > 0) { await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [userId]); baseBonus = true; }
    // ATOMIC: mini bonus (custom only)
    if (source === "custom" && customVal) {
      const mUpd = await pool.query(
        `UPDATE fp1_receipts SET bonus_awarded_mini=TRUE WHERE id=$1 AND (bonus_awarded_mini IS NULL OR bonus_awarded_mini=FALSE) RETURNING id`, [receipt.id]);
      if (mUpd.rowCount > 0) { await pool.query(`UPDATE fp1_foxes SET rating=rating+1, data_contributions=data_contributions+1 WHERE user_id=$1`, [userId]); miniBonus = true; await checkAchievements(userId); }
    }
    res.json({ ok: true, base_bonus: baseBonus, mini_bonus: miniBonus });
  } catch (e) { console.error("choice error:", e); res.status(500).json({ error: String(e?.message || e) }); }
});

// ── Antispam validator for custom text ──
// Antispam: pure text validation
function validateCustomText(text) {
  if (!text || typeof text !== "string") return { ok: false, error: "empty" };
  const t = text.trim();
  if (t.length < 3 || t.length > 30) return { ok: false, error: "length_3_30" };
  const words = t.split(/\s+/);
  if (words.length > 2) return { ok: false, error: "max_2_words" };
  if (!/^[\p{L}]+(\s[\p{L}]+)?$/u.test(t)) return { ok: false, error: "letters_only" };
  if (/^\d+$/.test(t)) return { ok: false, error: "no_digits_only" };
  if (/https?:|www\.|\.[a-z]{2,}/i.test(t)) return { ok: false, error: "no_urls" };
  return { ok: true };
}

// ── PANEL: Fox choice stats (what Foxes pick) ──
app.get("/panel/venue/choice-stats", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  try {
    const stats = await pool.query(
      `SELECT agg_category, COUNT(*)::int AS cnt FROM fp1_receipts
       WHERE venue_id=$1 AND agg_category IS NOT NULL GROUP BY agg_category ORDER BY cnt DESC`,
      [venueId]
    );
    const topDishes = await pool.query(
      `SELECT d.name, COUNT(*)::int AS cnt FROM fp1_receipts r
       JOIN fp1_venue_dishes d ON d.id = r.dish_id
       WHERE r.venue_id=$1 AND r.dish_id IS NOT NULL
       GROUP BY d.name ORDER BY cnt DESC LIMIT 5`,
      [venueId]
    );
    res.json({ stats: stats.rows, top_dishes: topDishes.rows });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

// ── PANEL: Menu items CRUD ──
app.get("/panel/venue/menu", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const items = await pool.query(`SELECT id,name,category,price,sort_order FROM fp1_menu_items WHERE venue_id=$1 ORDER BY sort_order,name`, [venueId]);
  res.json({ items: items.rows });
});

app.post("/panel/venue/menu", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const name = String(req.body.name || "").trim().slice(0, 80);
  const category = ["main","snack","soup","dessert","drink","alcohol"].includes(req.body.category) ? req.body.category : "main";
  const price = parseFloat(req.body.price) || null;
  if (!name || name.length < 1) return res.json({ error: "Podaj nazwę" });
  const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_menu_items WHERE venue_id=$1`, [venueId]);
  if (cnt.rows[0].c >= 100) return res.json({ error: "Limit 100 pozycji" });
  const sort = cnt.rows[0].c + 1;
  const r = await pool.query(`INSERT INTO fp1_menu_items(venue_id,name,category,price,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING id`, [venueId, name, category, price, sort]);
  res.json({ ok: true, id: r.rows[0].id });
});

app.put("/panel/venue/menu/:id", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const itemId = Number(req.params.id);
  const name = String(req.body.name || "").trim().slice(0, 80);
  const category = ["main","snack","soup","dessert","drink","alcohol"].includes(req.body.category) ? req.body.category : "main";
  const price = parseFloat(req.body.price) || null;
  if (!name) return res.json({ error: "Podaj nazwę" });
  await pool.query(`UPDATE fp1_menu_items SET name=$1,category=$2,price=$3 WHERE id=$4 AND venue_id=$5`, [name, category, price, itemId, venueId]);
  res.json({ ok: true });
});

app.delete("/panel/venue/menu/:id", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const itemId = Number(req.params.id);
  await pool.query(`DELETE FROM fp1_menu_items WHERE id=$1 AND venue_id=$2`, [itemId, venueId]);
  res.json({ ok: true });
});

// Panel: upload menu file (image or PDF)
app.post("/panel/venue/menu-file", requirePanelAuth, async (req, res) => {
  try {
    const venueId = Number(req.panel.venue_id);
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: "Brak pliku" });
    const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_venue_menu_files WHERE venue_id=$1`, [venueId]);
    if (cnt.rows[0].c >= 5) return res.status(400).json({ error: "Maksymalnie 5 plików menu" });
    const result = await uploadToCloudinary(file, `foxpot/venues/${venueId}/menu`);
    const url = result.secure_url || result.url;
    if (!url) return res.status(500).json({ error: "Błąd uploadu" });
    const nextOrder = cnt.rows[0].c;
    const ins = await pool.query(`INSERT INTO fp1_venue_menu_files(venue_id,url,sort_order) VALUES($1,$2,$3) RETURNING id`, [venueId, url, nextOrder]);
    // Keep legacy field in sync (first file)
    if (nextOrder === 0) await pool.query(`UPDATE fp1_venues SET menu_file_url=$1 WHERE id=$2`, [url, venueId]);
    res.json({ ok: true, id: ins.rows[0].id, url });
  } catch (e) { res.status(500).json({ error: String(e?.message || e).slice(0, 120) }); }
});

// Panel: delete menu file
app.delete("/panel/venue/menu-file/:id", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const fileId = Number(req.params.id);
  await pool.query(`DELETE FROM fp1_venue_menu_files WHERE id=$1 AND venue_id=$2`, [fileId, venueId]);
  // Update legacy field
  const first = await pool.query(`SELECT url FROM fp1_venue_menu_files WHERE venue_id=$1 ORDER BY sort_order ASC LIMIT 1`, [venueId]);
  await pool.query(`UPDATE fp1_venues SET menu_file_url=$1 WHERE id=$2`, [first.rows[0]?.url || null, venueId]);
  res.json({ ok: true });
});

// Panel: get menu files list
app.get("/panel/venue/menu-files", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const files = await pool.query(`SELECT id, url, sort_order FROM fp1_venue_menu_files WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]);
  res.json({ files: files.rows });
});

// Public: get menu for venue
app.get("/api/venue/:id/menu", async (req, res) => {
  const venueId = Number(req.params.id);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
  const offset = (page - 1) * limit;
  const items = await pool.query(`SELECT name,category,price FROM fp1_menu_items WHERE venue_id=$1 ORDER BY sort_order,name LIMIT $2 OFFSET $3`, [venueId, limit, offset]);
  const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_menu_items WHERE venue_id=$1`, [venueId]);
  const mf = await pool.query(`SELECT id, url FROM fp1_venue_menu_files WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]);
  const vq = await pool.query(`SELECT menu_file_url FROM fp1_venues WHERE id=$1`, [venueId]);
  res.json({ items: items.rows, total_count: cnt.rows[0].c, page, limit, menu_file_url: vq.rows[0]?.menu_file_url || null, menu_files: mf.rows });
});

// ── PANEL: Save venue settings ──
app.post("/panel/settings", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const b = req.body;
  try {
    await pool.query(
      `UPDATE fp1_venues SET venue_type=$1, cuisine=$2, description=$3, recommended=$4,
       opening_hours=$5, status_temporary=$6, tags=$7, google_place_id=$8,
       instagram_url=$10, facebook_url=$11, tiktok_url=$12,
       youtube_url=$13, website_url=$14, phone=$15 WHERE id=$9`,
      [
        String(b.venue_type||"").trim().slice(0,60),
        String(b.cuisine||"").trim().slice(0,60),
        String(b.description||"").trim().slice(0,300),
        String(b.recommended||"").trim().slice(0,300),
        String(b.opening_hours||"").trim().slice(0,300),
        String(b.status_temporary||"").trim().slice(0,120),
        String(b.tags||"").trim().slice(0,100),
        String(b.google_place_id||"").trim().slice(0,100),
        venueId,
        String(b.instagram_url||"").trim().slice(0,200),
        String(b.facebook_url||"").trim().slice(0,200),
        String(b.tiktok_url||"").trim().slice(0,200),
        String(b.youtube_url||"").trim().slice(0,200),
        String(b.website_url||"").trim().slice(0,200),
        String(b.phone||"").trim().slice(0,20) || null,
      ]
    );
    res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Ustawienia zapisane ✅")}`);
  } catch (e) {
    res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd: "+String(e?.message||e).slice(0,120))}`);
  }
});

app.post("/panel/confirm", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  // Rate limit: max 10 OTP attempts per venue per 5 min
  if (rateLimit(`otp_confirm:${venueId}`, 10, 5*60*1000)) {
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Zbyt wiele prób. Poczekaj 5 minut.")}`);
  }
  const otp = String(req.body.otp || "").trim();
  if (!/^\d{6}$/.test(otp)) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Kod wizyty musi mieć 6 cyfr.")}`);
  try {
    const r = await confirmOtp(venueId, otp);
    if (!r.ok) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Kod wizyty nie znaleziono lub wygasł.")}`);
    const venue = await getVenue(venueId);
    const xy    = await countXY(venueId, r.userId);
    if (bot) {
      try {
        let msg;
        if (r.debounce) msg = `⚠️ Wizyta już potwierdzona w ciągu 15 min\n🏪 ${venue.name}\n📊 X/Y: ${xy.X}/${xy.Y}`;
        else if (!r.countedAdded) msg = `DZIŚ JUŻ BYŁEŚ ✅\n🏪 ${venue.name}\n📅 ${r.day}\n📊 X/Y: ${xy.X}/${xy.Y}`;
        else {
          msg = `✅ Check-in potwierdzony!\n🏪 ${venue.name}\n\n💰 Wpisz kwotę rachunku w aplikacji FoxPot, aby otrzymać punkty i bonusy!`;
          if (r.isFirstEver) msg += `\n🎉 Pierwsza wizyta! +10 punktów`;
          if (r.inviteAutoAdded > 0) msg += `\n🎁 +${r.inviteAutoAdded} zaproszenie za 5 wizyt!`;
          msg += formatAchievements(r.newAch);
        }
        await bot.telegram.sendMessage(Number(r.userId), msg);
      } catch (e) { console.error("TG_SEND_ERR", e?.message); }
    }
    // P0.2: Show fox name + top badge in confirmation
    const foxQ = await pool.query(`SELECT username, founder_number FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [r.userId]);
    const foxName = foxQ.rows[0]?.username ? `@${foxQ.rows[0].username}` : `Fox #${String(r.userId).slice(-4)}`;
    const isAdminConfirm = isAdmin(String(r.userId));
    const foxBadgesConfirm = await getTopFoxBadges();
    const foxBadge = isAdminConfirm ? null : (foxBadgesConfirm[String(r.userId)] || null);
    const badgeEmoji = foxBadge === "year" ? "🟠" : foxBadge === "month" ? "🔵" : foxBadge === "week" ? "🟢" : "";
    const badgeText = isAdminConfirm ? " ⭐ Założyciel" : (foxBadge ? ` ${badgeEmoji} ${TOP_FOX_LABELS[foxBadge]}` : "");
    const founderText = (!isAdminConfirm && foxQ.rows[0]?.founder_number) ? ` 👑#${foxQ.rows[0].founder_number}` : "";
    // Fox's last review for this venue
    const foxReviewQ = await pool.query(`SELECT rating, text FROM fp1_reviews WHERE user_id=$1 AND venue_id=$2 ORDER BY created_at DESC LIMIT 1`, [String(r.userId), venueId]);
    const foxReview = foxReviewQ.rows[0];
    const reviewText = foxReview ? (foxReview.rating ? ' ⭐'.repeat(foxReview.rating) : ' 💬') : ' · Brak oceny';
    const label = r.debounce ? `Debounce ⚠️ · ${foxName}` : r.countedAdded ? `✅ ${foxName}${founderText}${badgeText}${reviewText} · X/Y ${xy.X}/${xy.Y}` : `DZIŚ JUŻ BYŁO ✅ · ${foxName}`;
    res.redirect(`/panel/dashboard?ok=${encodeURIComponent(label)}`);
  } catch (e) {
    console.error("CONFIRM_ERR", e);
    res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd: "+String(e?.message||e).slice(0,120))}`);
  }
});

app.post("/panel/reserve", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const startsRaw = String(req.body.starts_at || "").trim();
  const hours = Math.min(24, Math.max(1, Number(req.body.hours) || 24));
  if (!startsRaw) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Podaj datę i godzinę.")}`);
  const startsAt = new Date(startsRaw);
  if (isNaN(startsAt.getTime())) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Nieprawidłowa data.")}`);
  if (startsAt.getTime() - Date.now() < 24 * 3600 * 1000) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Rezerwacja minimum 24h wcześniej.")}`);
  const cnt = await reserveCountThisMonth(venueId);
  if (cnt >= 2) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Maksimum 2 rezerwacje miesięcznie.")}`);
  const endsAt = new Date(startsAt.getTime() + hours * 3600 * 1000);
  await pool.query(`INSERT INTO fp1_venue_status(venue_id,type,starts_at,ends_at) VALUES($1,'reserve',$2,$3)`, [venueId, startsAt.toISOString(), endsAt.toISOString()]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Rezerwacja ustawiona (${hours} godz.)`)}`);
});

app.post("/panel/limited", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const reason = ["FULL","PRIVATE EVENT","KITCHEN LIMIT"].includes(req.body.reason) ? req.body.reason : "FULL";
  const hours  = Math.min(3, Math.max(1, Number(req.body.hours) || 3));
  const cnt = await limitedCountThisWeek(venueId);
  if (cnt >= 2) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Maksimum 2× tygodniowo.")}`);
  const now = new Date(), endsAt = new Date(now.getTime() + hours * 3600 * 1000);
  await pool.query(`INSERT INTO fp1_venue_status(venue_id,type,reason,starts_at,ends_at) VALUES($1,'limited',$2,$3,$4)`, [venueId, reason, now.toISOString(), endsAt.toISOString()]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Status "${reason}" na ${hours} godz.`)}`);
});

app.post("/panel/status/cancel", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  await pool.query(`UPDATE fp1_venue_status SET ends_at=NOW() WHERE venue_id=$1 AND starts_at<=NOW() AND ends_at>NOW()`, [venueId]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Status anulowany.")}`);
});

app.post("/panel/status/cancel/:id", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const statusId = Number(req.params.id);
  await pool.query(`UPDATE fp1_venue_status SET ends_at=NOW() WHERE id=$1 AND venue_id=$2`, [statusId, venueId]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Anulowano.")}`);
});

app.post("/panel/stamps", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const userId  = String(req.body.user_id || "").trim();
  const emoji   = ["⭐","🦊","🔥","🎁","💎","🏆","👑","❤️","🍕","🍔","🌭","🍟","🍣","🍱","🍜","🍝","🥩","🍗","🥗","🥪","🌮","🌯","🥐","🍰","🎂","🧁","🍩","🍪","🍦","🍫","🍺","🍻","🍷","🍸","☕","🧋","🥤","🍹"].includes(req.body.emoji) ? req.body.emoji : "⭐";
  const delta   = [-10,-1,1].includes(Number(req.body.delta)) ? Number(req.body.delta) : 1;
  const note    = String(req.body.note || "").trim().slice(0, 100);
  if (!userId || isNaN(Number(userId))) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Nieprawidłowy Telegram ID.")}`);
  if (delta < 0) { const bal = await stampBalance(venueId, userId); if (bal < Math.abs(delta)) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Gość nie ma wystarczająco stempli (saldo: "+bal+").")}`); }
  await pool.query(`INSERT INTO fp1_stamps(venue_id,user_id,emoji,delta,note) VALUES($1,$2,$3,$4,$5)`, [venueId, userId, emoji, delta, note||null]);
  const newBal = await stampBalance(venueId, userId);
  if (bot) {
    try {
      const venue = await getVenue(venueId);
      const action = delta > 0 ? `+${delta} ${emoji}` : `${delta} ${emoji} (użyto)`;
      await bot.telegram.sendMessage(Number(userId), `${emoji} Stempel w ${venue?.name||venueId}\n${action}\nTwoje saldo: ${newBal}${note ? `\nNotatka: ${note}` : ""}`);
    } catch (e) { console.error("STAMP_TG_ERR", e?.message); }
  }
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Stempel ${delta > 0 ? "dodany" : "użyty"} ✅ (saldo: ${newBal})`)}`);
});

// POST /panel/discount — set individual Fox discount
app.post("/panel/discount", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const userId = String(req.body.user_id || "").trim();
  const pct = parseFloat(req.body.discount_percent);
  const temp = req.body.is_temporary === "1";
  if (!userId || isNaN(Number(userId))) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Nieprawidłowy Telegram ID.")}`);
  const venue = await getVenue(venueId);
  const minDiscount = parseFloat(venue?.discount_percent) || 10;
  if (isNaN(pct) || pct < minDiscount || pct > 100) return res.redirect(`/panel/dashboard?err=${encodeURIComponent(`Zniżka musi być ${minDiscount}%–100%.`)}`);
  // End of today Warsaw time
  let expiresAt = null;
  if (temp) {
    const wStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
    expiresAt = new Date(wStr + "T23:59:59.999Z");
  }
  await pool.query(
    `INSERT INTO fp1_fox_discounts(venue_id,user_id,discount_percent,is_temporary,expires_at)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(venue_id,user_id) DO UPDATE SET discount_percent=$3, is_temporary=$4, expires_at=$5, created_at=NOW()`,
    [venueId, userId, pct, temp, expiresAt]
  );
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Zniżka ${pct}% dla Fox #${userId.slice(-4)} ${temp ? "(dziś)" : "(stała)"} ✅`)}`);
});

// POST /panel/promo-order — venue orders a promotion package
app.post("/panel/promo-order", requirePanelAuth, async (req, res) => {
  const venueId = Number(req.panel.venue_id);
  const pkg = ["start","boost","premium"].includes(req.body.package) ? req.body.package : "start";
  const venue = await getVenue(venueId);
  await pool.query(`INSERT INTO fp1_promo_orders(venue_id,package) VALUES($1,$2)`, [venueId, pkg]);
  // Notify admin via Telegram
  if (bot && ADMIN_TG_ID) {
    try {
      await bot.telegram.sendMessage(Number(ADMIN_TG_ID),
        `📣 Nowe zamówienie promocji!\n\n🏪 ${venue?.name || venueId} (ID: ${venueId})\n📦 Pakiet: ${pkg.toUpperCase()}\n🕐 ${new Date().toLocaleString("pl-PL",{timeZone:"Europe/Warsaw"})}`
      );
    } catch (e) { console.error("PROMO_ORDER_TG_ERR", e?.message); }
  }
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Zamówienie ${pkg.toUpperCase()} wysłane! Skontaktujemy się wkrótce. ✅`)}`);
});

/* ═══════════════════════════════════════════════════════════════
   ROUTES — ADMIN
═══════════════════════════════════════════════════════════════ */
app.get("/admin/login", (req, res) => {
  const msg = req.query.msg ? `<div class="err">${escapeHtml(req.query.msg)}</div>` : "";
  res.send(pageShell("Admin", `
    <div class="card" style="max-width:360px;margin:60px auto">
      <h1>🛡️ Panel Admina</h1>${msg}
      <form method="POST" action="/admin/login">
        <label>Hasło admina</label>
        <input name="secret" type="password" required placeholder="••••••••"/>
        <button type="submit" style="width:100%;margin-top:12px">Zaloguj →</button>
      </form>
    </div>`));
});

app.post("/admin/login", (req, res) => {
  if (!ADMIN_SECRET) return res.redirect(`/admin/login?msg=${encodeURIComponent("Admin panel disabled. Set ADMIN_SECRET.")}`);
  const secret = String(req.body.secret || "").trim();
  if (secret !== ADMIN_SECRET) { loginBad(getIp(req)); return res.redirect(`/admin/login?msg=${encodeURIComponent("Błędne hasło.")}`); }
  loginOk(getIp(req));
  setCookie(res, signSession({ role:"admin", venue_id:"0", exp:Date.now()+SESSION_TTL_MS }));
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => { clearCookie(res); res.redirect("/admin/login"); });

app.get("/admin", requireAdminAuth, async (req, res) => {
  const pending = await pool.query(`SELECT * FROM fp1_venues WHERE approved=FALSE ORDER BY created_at ASC`);
  const venues  = await pool.query(`SELECT v.*,COUNT(cv.id)::int AS visits FROM fp1_venues v LEFT JOIN fp1_counted_visits cv ON cv.venue_id=v.id AND cv.is_credited=TRUE WHERE v.approved=TRUE GROUP BY v.id ORDER BY visits DESC LIMIT 50`);
  const foxes   = await pool.query(`SELECT f.user_id,f.username,f.rating,f.invites,f.city,f.district,f.founder_number,f.streak_current,f.streak_best,f.created_at,
    (SELECT COUNT(*)::int FROM fp1_counted_visits cv WHERE cv.user_id=f.user_id AND cv.is_credited=TRUE) AS visits_total
    FROM fp1_foxes f WHERE f.is_deleted=FALSE ORDER BY f.rating DESC LIMIT 50`);
  const growth  = await getGrowthLeaderboard(10);
  // Nominations
  const noms = await pool.query(`
    SELECT n.*,
      (SELECT COUNT(*)::int FROM fp1_nomination_votes v WHERE v.nomination_id=n.id) AS total_votes,
      (SELECT COUNT(*)::int FROM fp1_nomination_votes v WHERE v.nomination_id=n.id AND v.is_member=TRUE) AS member_votes,
      (SELECT COUNT(*)::int FROM fp1_nomination_votes v WHERE v.nomination_id=n.id AND v.is_member=FALSE) AS guest_votes
    FROM fp1_nominations n ORDER BY
      CASE n.status WHEN 'threshold' THEN 0 WHEN 'voting' THEN 1 WHEN 'review' THEN 2 WHEN 'contact' THEN 3 WHEN 'talking' THEN 4 ELSE 5 END,
      total_votes DESC
  `);
  const cityNoms = await pool.query(`
    SELECT n.*,
      (SELECT COUNT(*)::int FROM fp1_city_votes v WHERE v.city_nomination_id=n.id) AS total_votes,
      (SELECT COUNT(*)::int FROM fp1_city_votes v WHERE v.city_nomination_id=n.id AND v.is_member=TRUE) AS member_votes,
      (SELECT COUNT(*)::int FROM fp1_city_votes v WHERE v.city_nomination_id=n.id AND v.is_member=FALSE) AS guest_votes
    FROM fp1_city_nominations n ORDER BY total_votes DESC
  `);
  const promos = await pool.query(`
    SELECT p.*, v.name AS venue_name FROM fp1_promotions p
    JOIN fp1_venues v ON v.id=p.venue_id
    ORDER BY p.status='active' DESC, p.ends_at DESC LIMIT 20
  `);
  const promoOrders = await pool.query(`
    SELECT o.*, v.name AS venue_name FROM fp1_promo_orders o
    JOIN fp1_venues v ON v.id=o.venue_id
    ORDER BY o.created_at DESC LIMIT 20
  `);
  const spotsLeft = await founderSpotsLeft();
  const districtStats = await pool.query(`SELECT district,COUNT(*)::int AS cnt FROM fp1_foxes WHERE district IS NOT NULL GROUP BY district ORDER BY cnt DESC`);
  const achStats = await pool.query(`SELECT achievement_code,COUNT(*)::int AS cnt FROM fp1_achievements GROUP BY achievement_code ORDER BY cnt DESC LIMIT 10`);
  const spinStats = await pool.query(`SELECT prize_type,prize_label,COUNT(*)::int AS cnt FROM fp1_daily_spins GROUP BY prize_type,prize_label ORDER BY cnt DESC`);

  const pendingHtml = pending.rows.length === 0 ? `<div class="muted">Brak wniosków</div>`
    : pending.rows.map(v => `
      <div style="padding:10px 0;border-bottom:1px solid #2a2f49">
        <b>${escapeHtml(v.name)}</b> — ${escapeHtml(v.city)}
        ${v.address ? `<br><span class="muted">${escapeHtml(v.address)}</span>` : ""}
        ${v.fox_nick ? `<br><span class="muted">Fox: @${escapeHtml(v.fox_nick)}</span>` : ""}
        <br>
        <form method="POST" action="/admin/venues/${v.id}/approve" style="display:inline"><button type="submit" style="margin-top:6px;margin-right:6px">✅ Zatwierdź</button></form>
        <form method="POST" action="/admin/venues/${v.id}/reject" style="display:inline"><button type="submit" class="danger">❌ Odrzuć</button></form>
      </div>`).join("");

  const venuesHtml = venues.rows.map(v => `<tr><td>${v.id}</td><td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.city)}</td><td>${v.visits}</td><td><span class="badge badge-ok">Aktywny</span></td></tr>`).join("");
  const foxesHtml  = foxes.rows.map(f => `<tr><td>${escapeHtml(f.username||"—")}</td><td>${escapeHtml(f.city)}</td><td>${escapeHtml(f.district||"—")}</td><td><b>${f.rating}</b></td><td>${f.invites}</td><td>${f.founder_number?`<span style="color:#ffd700">👑 #${f.founder_number}</span>`:`<span class="muted">—</span>`}</td><td>${f.visits_total||0}</td><td>${new Date(f.created_at).toLocaleDateString("pl-PL",{timeZone:"Europe/Warsaw"})}</td></tr>`).join("");
  const growthHtml = growth.map((g,i) => `<tr><td>${i+1}</td><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.city)}</td><td><b>${g.new_fox}</b></td></tr>`).join("");
  const districtHtml = districtStats.rows.map(d => `<tr><td>${escapeHtml(d.district)}</td><td><b>${d.cnt}</b></td></tr>`).join("");
  const achHtml  = achStats.rows.map(a => { const ach = ACHIEVEMENTS[a.achievement_code]; return `<tr><td>${ach?ach.emoji:"?"} ${escapeHtml(a.achievement_code)}</td><td><b>${a.cnt}</b></td></tr>`; }).join("");
  const statusColors = {voting:"#3B82F6",threshold:"#22C55E",review:"#FF8A00",contact:"#8B5CF6",talking:"#EC4899",added:"#10B981",rejected:"#EF4444"};
  const nomsHtml = noms.rows.length === 0 ? `<div class="muted">Brak nominacji</div>` : noms.rows.map(n => {
    const sc = statusColors[n.status] || "#888";
    const pct = Math.min(100, Math.round(n.total_votes / n.vote_threshold * 100));
    return `<div style="padding:10px;margin:6px 0;border-radius:10px;border:1px solid ${sc}40;background:${sc}08">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${escapeHtml(n.name)}</b> · ${escapeHtml(n.city)}${n.address?` · <span class="muted">${escapeHtml(n.address)}</span>`:""}</div>
        <span style="font-size:11px;color:${sc};font-weight:700;border:1px solid ${sc}40;border-radius:12px;padding:2px 8px">${NOM_STATUS_LABELS[n.status]}</span>
      </div>
      <div style="margin-top:6px;font-size:12px">
        📊 <b>${n.total_votes}</b> głosów (🦊 <b>${n.member_votes}</b> członków · 👤 <b>${n.guest_votes}</b> spoza klubu) · próg: ${n.vote_threshold}
        <div style="height:4px;background:#1a1f35;border-radius:2px;margin-top:4px"><div style="width:${pct}%;height:100%;background:${sc};border-radius:2px"></div></div>
      </div>
      <form method="POST" action="/admin/nominations/${n.id}/status" style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">
        ${NOM_STATUSES.filter(s=>s!==n.status).map(s=>`<button name="status" value="${s}" style="font-size:11px;padding:3px 8px;background:${statusColors[s]}20;border:1px solid ${statusColors[s]}40;color:${statusColors[s]};border-radius:6px;cursor:pointer">${NOM_STATUS_LABELS[s]}</button>`).join("")}
      </form>
    </div>`;
  }).join("");
  const cityStatusColors = {voting:"#3B82F6",threshold:"#22C55E",review:"#FF8A00",planned:"#8B5CF6",not_now:"#EF4444"};
  const cityNomsHtml = cityNoms.rows.length === 0 ? `<div class="muted">Brak głosów na miasta</div>` : cityNoms.rows.map(n => {
    const sc = cityStatusColors[n.status] || "#888";
    const pct = Math.min(100, Math.round(n.total_votes / n.vote_threshold * 100));
    return `<div style="padding:8px;margin:4px 0;border-radius:8px;border:1px solid ${sc}30;background:${sc}06">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${escapeHtml(n.name)}</b>
        <span style="font-size:11px;color:${sc};font-weight:700;border:1px solid ${sc}40;border-radius:12px;padding:2px 8px">${CITY_NOM_LABELS[n.status]}</span>
      </div>
      <div style="margin-top:4px;font-size:12px">
        📊 <b>${n.total_votes}</b>/${n.vote_threshold} (🦊 ${n.member_votes} · 👤 ${n.guest_votes})
        <div style="height:4px;background:#1a1f35;border-radius:2px;margin-top:3px"><div style="width:${pct}%;height:100%;background:${sc};border-radius:2px"></div></div>
      </div>
      <form method="POST" action="/admin/city-nominations/${n.id}/status" style="margin-top:6px;display:flex;gap:3px;flex-wrap:wrap">
        ${CITY_NOM_STATUSES.filter(s=>s!==n.status).map(s=>`<button name="status" value="${s}" style="font-size:10px;padding:2px 6px;background:${cityStatusColors[s]}20;border:1px solid ${cityStatusColors[s]}40;color:${cityStatusColors[s]};border-radius:4px;cursor:pointer">${CITY_NOM_LABELS[s]}</button>`).join("")}
      </form>
    </div>`;
  }).join("");
  const promoStatusColors = {active:'#22C55E',ended:'#6B7280',cancelled:'#EF4444'};
  const promoHtml = promos.rows.length === 0 ? '<div class="muted">Brak promocji</div>' : promos.rows.map(p => {
    const isActive = p.status === 'active' && new Date(p.ends_at) > new Date();
    const sc = isActive ? promoStatusColors.active : promoStatusColors[p.status] || '#6B7280';
    const start = new Date(p.starts_at).toLocaleDateString("pl-PL",{timeZone:"Europe/Warsaw"});
    const end = new Date(p.ends_at).toLocaleDateString("pl-PL",{timeZone:"Europe/Warsaw"});
    return `<div style="padding:8px;margin:4px 0;border-radius:8px;border:1px solid ${sc}40;background:${sc}08">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b>${escapeHtml(p.venue_name)}</b> · <span style="color:${sc};font-weight:700;font-size:12px">${p.package.toUpperCase()}</span></div>
        <span style="font-size:11px;color:${sc};font-weight:700">${isActive?'● Aktywna':'Zakończona'}</span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">${start} — ${end}${p.promo_text?' · '+escapeHtml(p.promo_text):''}</div>
      ${isActive?`<form method="POST" action="/admin/promo/${p.id}/deactivate" style="margin-top:6px"><button type="submit" class="danger" style="font-size:11px;padding:3px 10px">Dezaktywuj</button></form>`:''}
    </div>`;
  }).join("");
  const orderStatusColors = {pending:'#FF8A00',confirmed:'#22C55E',rejected:'#EF4444'};
  const promoOrdersHtml = promoOrders.rows.length === 0 ? '<div class="muted">Brak zamówień</div>' : promoOrders.rows.map(o => {
    const sc = orderStatusColors[o.status] || '#6B7280';
    const date = new Date(o.created_at).toLocaleString("pl-PL",{timeZone:"Europe/Warsaw"});
    return `<div style="padding:6px;margin:3px 0;border-radius:6px;border:1px solid ${sc}30;background:${sc}06;display:flex;justify-content:space-between;align-items:center">
      <div><b>${escapeHtml(o.venue_name)}</b> · <span style="color:${sc};font-weight:700;font-size:12px">${o.package.toUpperCase()}</span> · <span class="muted" style="font-size:11px">${date}</span></div>
      <div style="display:flex;gap:4px">
        ${o.status==='pending'?`<form method="POST" action="/admin/promo-order/${o.id}/confirm" style="margin:0"><button type="submit" style="font-size:10px;padding:2px 8px;background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#22C55E;border-radius:4px;cursor:pointer">✅</button></form><form method="POST" action="/admin/promo-order/${o.id}/reject" style="margin:0"><button type="submit" style="font-size:10px;padding:2px 8px;background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.4);color:#ef4444;border-radius:4px;cursor:pointer">❌</button></form>`:`<span style="font-size:11px;color:${sc};font-weight:700">${o.status==='confirmed'?'Potwierdzone':'Odrzucone'}</span>`}
      </div>
    </div>`;
  }).join("");
  const spinHtml = spinStats.rows.map(s => `<tr><td>${escapeHtml(s.prize_label||s.prize_type)}</td><td><b>${s.cnt}</b></td></tr>`).join("");

  res.send(pageShell("Admin — FoxPot", `
    <div class="card">
      <div class="topbar"><h1>🛡️ Panel Admina</h1><a href="/admin/logout">Wyloguj</a></div>
      ${flash(req)}
      <div class="muted" style="margin-top:8px">👑 Pionier Fox: pozostało <b>${spotsLeft}</b> / ${FOUNDER_LIMIT} miejsc</div>
      <a href="/admin/backup" style="display:inline-block;margin-top:8px;padding:8px 16px;background:rgba(124,92,252,.15);border:1px solid rgba(124,92,252,.3);border-radius:8px;color:#7c5cfc;font-size:12px;font-weight:700;text-decoration:none">💾 Pobierz backup bazy</a>
    </div>
    <div class="card"><h2>Wnioski do zatwierdzenia (${pending.rows.length})</h2>${pendingHtml}</div>
    <div class="card"><h2>🗳️ Głosowanie na lokale (${noms.rows.length})</h2>${nomsHtml}</div>
    <div class="card"><h2>🏙️ Głosowanie na miasta (${cityNoms.rows.length})</h2>${cityNomsHtml}</div>
    <div class="card">
      <h2>📣 Promocje lokali (${promos.rows.length})</h2>
      ${promoHtml}
      <div style="margin-top:12px;padding:10px;border:1px dashed rgba(255,138,0,.3);border-radius:8px">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px">➕ Nowa promocja</div>
        <form method="POST" action="/admin/promo/create">
          <div class="grid2" style="margin-bottom:6px">
            <div><label>Lokal</label><select name="venue_id" required>${venues.rows.map(v=>`<option value="${v.id}">${escapeHtml(v.name)} (ID:${v.id})</option>`).join("")}</select></div>
            <div><label>Pakiet</label><select name="package" id="promoPackSel" onchange="var d={start:3,boost:5,premium:7};document.getElementById('promoEndDate').value=new Date(Date.now()+d[this.value]*86400000).toISOString().slice(0,10)"><option value="start">START (3 dni)</option><option value="boost">BOOST (5 dni)</option><option value="premium">PREMIUM (7 dni)</option></select></div>
          </div>
          <div class="grid2" style="margin-bottom:6px">
            <div><label>Od</label><input name="starts_at" type="date" required value="${new Date().toISOString().slice(0,10)}"/></div>
            <div><label>Do</label><input name="ends_at" id="promoEndDate" type="date" required value="${new Date(Date.now()+3*86400000).toISOString().slice(0,10)}"/></div>
          </div>
          <label>Tekst promocyjny (opcjonalnie)</label>
          <input name="promo_text" maxlength="200" placeholder="np. Nowe menu na lato!" style="margin-bottom:8px"/>
          <button type="submit" style="width:100%">📣 Aktywuj promocję</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>📋 Zamówienia promocji (${promoOrders.rows.length})</h2>
      ${promoOrdersHtml}
    </div>
    <div class="card">
      <h2>🚀 Ranking wzrostu</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>#</th><th>Nazwa</th><th>Miasto</th><th>Nowych Fox</th></tr>${growthHtml}
      </table>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>📍 Gęstość według dzielnic</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="opacity:.6"><th>Dzielnica</th><th>Fox</th></tr>
          ${districtHtml||'<tr><td colspan="2" class="muted">Brak danych</td></tr>'}
        </table>
      </div>
      <div class="card">
        <h2>🏆 Top osiągnięcia</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="opacity:.6"><th>Osiągnięcie</th><th>Fox</th></tr>
          ${achHtml||'<tr><td colspan="2" class="muted">Brak danych</td></tr>'}
        </table>
      </div>
    </div>
    <div class="card">
      <h2>🎰 Statystyki Daily Spin</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>Nagroda</th><th>Ilość</th></tr>
        ${spinHtml||'<tr><td colspan="2" class="muted">Brak spinów</td></tr>'}
      </table>
    </div>
    <div class="card">
      <h2>Aktywne lokale</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>ID</th><th>Nazwa</th><th>Miasto</th><th>Wizyty</th><th>Status</th></tr>${venuesHtml}
      </table>
    </div>
    <div class="card">
      <h2>Fox (top 50)</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>Nick</th><th>Miasto</th><th>Dzielnica</th><th>Rating</th><th>Zapr.</th><th>Pionier</th><th>Wizyty</th><th>Rejestracja</th></tr>${foxesHtml}
      </table>
    </div>
    <div class="card" style="border:1px solid rgba(124,92,252,.3);background:rgba(124,92,252,.06)">
      <h2>📥 Eksport danych</h2>
      <p class="muted" style="margin-bottom:12px">Pobierz dane w formacie CSV (gotowe do Excel).</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><label>Okres</label><select id="csvPeriod" onchange="updateCsvDates()">
          <option value="7">Ostatnie 7 dni</option><option value="30" selected>Ostatnie 30 dni</option><option value="month">Ten miesiąc</option><option value="year">Ten rok</option><option value="custom">Własny zakres</option>
        </select></div>
        <div><label>Dzielnica</label><select id="csvDistrict"><option value="">— wszystkie —</option>${districtStats.rows.map(d=>`<option value="${escapeHtml(d.district)}">${escapeHtml(d.district)} (${d.cnt})</option>`).join("")}</select></div>
        <div id="csvFromWrap" style="display:none"><label>Od</label><input type="date" id="csvFrom" value="${new Date(Date.now()-30*86400000).toISOString().slice(0,10)}"/></div>
        <div id="csvToWrap" style="display:none"><label>Do</label><input type="date" id="csvTo" value="${new Date().toISOString().slice(0,10)}"/></div>
        <div><label>Lokal</label><select id="csvVenue"><option value="">— wszystkie —</option>${venues.rows.map(v=>`<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
        <button type="button" onclick="downloadCsv('visits')" style="background:rgba(124,92,252,.8);font-size:12px;padding:10px">📥 Wizyty CSV</button>
        <button type="button" onclick="downloadCsv('dishes')" style="background:rgba(46,204,113,.7);font-size:12px;padding:10px">📥 Dania CSV</button>
        <button type="button" onclick="downloadCsv('foxes')" style="background:rgba(255,138,0,.7);font-size:12px;padding:10px">📥 Foxy CSV</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <button type="button" onclick="previewData('visits')" style="background:rgba(124,92,252,.2);border:1px solid rgba(124,92,252,.4);font-size:12px;padding:10px;color:#7c5cfc">👁 Podgląd wizyt</button>
        <button type="button" onclick="previewData('dishes')" style="background:rgba(46,204,113,.15);border:1px solid rgba(46,204,113,.3);font-size:12px;padding:10px;color:#2ecc71">👁 Podgląd dań</button>
        <button type="button" onclick="previewData('foxes')" style="background:rgba(255,138,0,.15);border:1px solid rgba(255,138,0,.3);font-size:12px;padding:10px;color:#ff8a00">👁 Podgląd Fox</button>
      </div>
      <div id="previewTable" style="margin-top:12px;max-height:400px;overflow:auto;display:none"></div>
      <script>
        function updateCsvDates(){
          const p=document.getElementById('csvPeriod').value;
          const show=p==='custom';
          document.getElementById('csvFromWrap').style.display=show?'':'none';
          document.getElementById('csvToWrap').style.display=show?'':'none';
        }
        function getCsvDates(){
          const p=document.getElementById('csvPeriod').value;
          const today=new Date().toISOString().slice(0,10);
          if(p==='custom') return {from:document.getElementById('csvFrom').value,to:document.getElementById('csvTo').value};
          if(p==='month'){const d=new Date();return{from:d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0')+'-01',to:today};}
          if(p==='year') return{from:new Date().getFullYear()+'-01-01',to:today};
          const days=parseInt(p)||30;
          return{from:new Date(Date.now()-days*86400000).toISOString().slice(0,10),to:today};
        }
        function downloadCsv(type){
          const dt=getCsvDates();
          const d=document.getElementById('csvDistrict').value;
          const v=document.getElementById('csvVenue').value;
          let url='/admin/export-csv?type='+type+'&from='+dt.from+'&to='+dt.to;
          if(d) url+='&district='+encodeURIComponent(d);
          if(v) url+='&venue_id='+v;
          window.location.href=url;
        }
        async function previewData(type){
          const dt=getCsvDates();
          const d=document.getElementById('csvDistrict').value;
          const v=document.getElementById('csvVenue').value;
          let url='/admin/export-csv?type='+type+'&from='+dt.from+'&to='+dt.to+'&format=html';
          if(d) url+='&district='+encodeURIComponent(d);
          if(v) url+='&venue_id='+v;
          const box=document.getElementById('previewTable');
          box.style.display='block';box.innerHTML='<div style="text-align:center;padding:20px;color:#888">Ładowanie...</div>';
          try{const r=await fetch(url);box.innerHTML=await r.text();}catch(e){box.innerHTML='<div style="color:#e74c3c">Błąd</div>';}
        }
      </script>
    </div>`, `table th,table td{padding:6px 8px;text-align:left;border-bottom:1px solid #1a1f35}`));
});

/* ═══════════════════════════════════════════════════════════════
   ADMIN CSV EXPORT
═══════════════════════════════════════════════════════════════ */
app.get("/admin/export-csv", requireAdminAuth, async (req, res) => {
  try {
    const { type, from, to, district, venue_id } = req.query;
    const dateFrom = from || "2020-01-01";
    const dateTo = to || "2099-12-31";
    const esc_csv = (s) => String(s ?? "").replace(/[,"\n\r]/g, " ");
    const fmtDate = (d) => new Date(d).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" });

    // Build shared filter params
    let pi = 3;
    const params = [dateFrom, dateTo];
    let distFilter = "", venueFilter = "";
    if (district) { distFilter = ` AND f.district = $${pi}`; params.push(district); pi++; }
    if (venue_id) { venueFilter = ` AND cv.venue_id = $${pi}`; params.push(Number(venue_id)); pi++; }

    let header, csvRows, filename;

    if (type === "dishes") {
      // ── Dania CSV ──
      const dp = [dateFrom, dateTo]; let dpi = 3; let df = "", vf = "";
      if (district) { df = ` AND f.district = $${dpi}`; dp.push(district); dpi++; }
      if (venue_id) { vf = ` AND ch.venue_id = $${dpi}`; dp.push(Number(venue_id)); dpi++; }
      const rows = await pool.query(`
        SELECT ch.created_at, ch.dish_name, ch.agg_category, ch.is_custom_dish,
               v.name AS venue_name, v.city, f.district
        FROM fp1_checkin_choices ch
        LEFT JOIN fp1_checkins c ON c.id = ch.checkin_id
        LEFT JOIN fp1_venues v ON v.id = ch.venue_id
        LEFT JOIN fp1_foxes f ON f.user_id = c.user_id
        WHERE ch.created_at >= $1 AND ch.created_at < ($2::date + INTERVAL '1 day')${df}${vf}
        ORDER BY ch.created_at DESC LIMIT 10000
      `, dp);
      header = "data,danie,kategoria,custom,lokal,miasto,dzielnica_fox\n";
      csvRows = rows.rows.map(r => [fmtDate(r.created_at),esc_csv(r.dish_name),r.agg_category||"",r.is_custom_dish?"tak":"nie",esc_csv(r.venue_name),r.city||"",r.district||""].join(",")).join("\n");
      filename = `foxpot_dania_${dateFrom}_${dateTo}.csv`;

    } else if (type === "foxes") {
      // ── Aktywność Fox'ów CSV ──
      const fp = [dateFrom, dateTo]; let fpi = 3; let fdf = "";
      if (district) { fdf = ` AND f.district = $${fpi}`; fp.push(district); fpi++; }
      const rows = await pool.query(`
        SELECT f.user_id, f.username, f.city, f.district, f.rating, f.invites,
               f.founder_number, f.streak_current, f.streak_best, f.created_at,
               (SELECT COUNT(*)::int FROM fp1_counted_visits cv WHERE cv.user_id=f.user_id AND cv.is_credited=TRUE AND cv.created_at >= $1 AND cv.created_at < ($2::date + INTERVAL '1 day')) AS visits_period,
               (SELECT COUNT(*)::int FROM fp1_counted_visits cv2 WHERE cv2.user_id=f.user_id AND cv2.is_credited=TRUE) AS visits_total
        FROM fp1_foxes f
        WHERE f.is_deleted=FALSE${fdf}
        ORDER BY f.rating DESC LIMIT 5000
      `, fp);
      header = "user_id,nick,miasto,dzielnica,rating,zaproszenia,pionier_nr,streak,streak_best,rejestracja,wizyty_okres,wizyty_total\n";
      csvRows = rows.rows.map(r => [r.user_id,esc_csv(r.username),r.city||"",r.district||"",r.rating,r.invites,r.founder_number||"",r.streak_current||0,r.streak_best||0,fmtDate(r.created_at),r.visits_period,r.visits_total].join(",")).join("\n");
      filename = `foxpot_foxy_${dateFrom}_${dateTo}.csv`;

    } else {
      // ── Wizyty CSV (default) ──
      const rows = await pool.query(`
        SELECT cv.created_at, cv.user_id, f.username, f.rating, f.district, f.founder_number,
               cv.venue_id, v.name AS venue_name, v.city, v.venue_type, v.cuisine,
               r.amount_paid, r.discount_saved
        FROM fp1_counted_visits cv
        LEFT JOIN fp1_foxes f ON f.user_id = cv.user_id
        LEFT JOIN fp1_venues v ON v.id = cv.venue_id
        LEFT JOIN fp1_receipts r ON r.user_id = cv.user_id AND r.venue_id = cv.venue_id AND r.created_at::date = cv.created_at::date
        WHERE cv.created_at >= $1 AND cv.created_at < ($2::date + INTERVAL '1 day')${distFilter}${venueFilter}
        ORDER BY cv.created_at DESC LIMIT 10000
      `, params);
      header = "data,user_id,nick,rating,dzielnica,pionier_nr,venue_id,lokal,miasto,typ,kuchnia,rachunek,zniżka\n";
      csvRows = rows.rows.map(r => [fmtDate(r.created_at),r.user_id,esc_csv(r.username),r.rating||0,r.district||"",r.founder_number||"",r.venue_id,esc_csv(r.venue_name),r.city||"",r.venue_type||"",esc_csv(r.cuisine),r.amount_paid||"",r.discount_saved||""].join(",")).join("\n");
      filename = `foxpot_wizyty_${dateFrom}_${dateTo}.csv`;
    }

    if (req.query.format === 'html') {
      // HTML table preview for admin panel
      const cols = header.replace(/\n$/, '').split(',');
      const dataRows = csvRows.split('\n').filter(r => r.trim());
      let html = `<div style="font-size:11px;color:#888;margin-bottom:8px">${dataRows.length} wierszy</div>`;
      html += `<table style="width:100%;border-collapse:collapse;font-size:11px"><tr style="background:#1a1f35;position:sticky;top:0">${cols.map(c=>`<th style="padding:5px 6px;text-align:left;white-space:nowrap;color:#aaa">${c}</th>`).join('')}</tr>`;
      html += dataRows.slice(0, 200).map(row => `<tr>${row.split(',').map(c=>`<td style="padding:4px 6px;border-bottom:1px solid #1a1f35;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis">${c}</td>`).join('')}</tr>`).join('');
      if (dataRows.length > 200) html += `<tr><td colspan="${cols.length}" style="padding:8px;text-align:center;color:#888">...i ${dataRows.length-200} więcej (pobierz CSV)</td></tr>`;
      html += '</table>';
      return res.send(html);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + header + csvRows);
  } catch (e) {
    console.error("CSV_EXPORT_ERR", e);
    res.status(500).send("Błąd eksportu: " + String(e?.message || e).slice(0, 200));
  }
});

app.post("/admin/nominations/:id/status", requireAdminAuth, async (req, res) => {
  const nomId = Number(req.params.id);
  const status = String(req.body.status || "").trim();
  if (!NOM_STATUSES.includes(status)) return res.redirect(`/admin?err=${encodeURIComponent("Nieprawidłowy status")}`);
  await pool.query(`UPDATE fp1_nominations SET status=$1, updated_at=NOW() WHERE id=$2`, [status, nomId]);
  res.redirect(`/admin?ok=${encodeURIComponent(`Status zmieniony na: ${NOM_STATUS_LABELS[status]}`)}`);
});

// ── DATABASE BACKUP ──
async function createBackupSQL() {
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'fp1_%' ORDER BY tablename`);
  let sql = `-- FoxPot Club Database Backup\n-- ${new Date().toISOString()}\n\n`;
  for (const t of tables.rows) {
    const name = t.tablename;
    // Schema
    const cols = await pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [name]);
    sql += `-- Table: ${name} (${cols.rows.length} columns)\n`;
    // Data
    const data = await pool.query(`SELECT * FROM ${name}`);
    for (const row of data.rows) {
      const vals = cols.rows.map(c => {
        const v = row[c.column_name];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (v instanceof Date) return `'${v.toISOString()}'`;
        return `'${String(v).replace(/'/g, "''")}'`;
      });
      sql += `INSERT INTO ${name}(${cols.rows.map(c=>c.column_name).join(',')}) VALUES(${vals.join(',')}) ON CONFLICT DO NOTHING;\n`;
    }
    sql += `\n`;
  }
  return sql;
}

app.get("/admin/backup", requireAdminAuth, async (req, res) => {
  try {
    const sql = await createBackupSQL();
    const date = new Date().toISOString().slice(0,10);
    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename="foxpot_backup_${date}.sql"`);
    res.send(sql);
  } catch (e) {
    console.error("BACKUP_ERR", e);
    res.status(500).send("Błąd backupu: " + String(e?.message || e).slice(0, 200));
  }
});

app.post("/admin/city-nominations/:id/status", requireAdminAuth, async (req, res) => {
  const cityId = Number(req.params.id);
  const status = String(req.body.status || "").trim();
  if (!CITY_NOM_STATUSES.includes(status)) return res.redirect(`/admin?err=${encodeURIComponent("Nieprawidłowy status")}`);
  await pool.query(`UPDATE fp1_city_nominations SET status=$1, updated_at=NOW() WHERE id=$2`, [status, cityId]);
  res.redirect(`/admin?ok=${encodeURIComponent(`Status miasta zmieniony na: ${CITY_NOM_LABELS[status]}`)}`);
});

app.post("/admin/promo/create", requireAdminAuth, async (req, res) => {
  const venueId = Number(req.body.venue_id);
  const pkg = ["start","boost","premium"].includes(req.body.package) ? req.body.package : "start";
  const text = String(req.body.promo_text || "").trim().slice(0, 200);
  const startsAt = req.body.starts_at || new Date().toISOString().slice(0,10);
  const endsAt = req.body.ends_at;
  if (!venueId || !endsAt) return res.redirect(`/admin?err=${encodeURIComponent("Brak danych")}`);
  await pool.query(
    `INSERT INTO fp1_promotions(venue_id,package,promo_text,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,'active')`,
    [venueId, pkg, text, startsAt, endsAt]
  );
  res.redirect(`/admin?ok=${encodeURIComponent(`Promocja ${pkg.toUpperCase()} aktywowana ✅`)}`);
});

app.post("/admin/promo/:id/deactivate", requireAdminAuth, async (req, res) => {
  await pool.query(`UPDATE fp1_promotions SET status='cancelled' WHERE id=$1`, [Number(req.params.id)]);
  res.redirect(`/admin?ok=${encodeURIComponent("Promocja dezaktywowana")}`);
});

app.post("/admin/promo-order/:id/confirm", requireAdminAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await pool.query(`SELECT venue_id, package FROM fp1_promo_orders WHERE id=$1 LIMIT 1`, [orderId]);
  if (order.rowCount === 0) return res.redirect(`/admin?err=${encodeURIComponent("Nie znaleziono zamówienia")}`);
  const o = order.rows[0];
  const days = {start:3, boost:5, premium:7}[o.package] || 3;
  const startsAt = new Date().toISOString().slice(0,10);
  const endsAt = new Date(Date.now() + days * 86400000).toISOString().slice(0,10);
  await pool.query(`UPDATE fp1_promo_orders SET status='confirmed' WHERE id=$1`, [orderId]);
  await pool.query(
    `INSERT INTO fp1_promotions(venue_id,package,promo_text,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,'active')`,
    [o.venue_id, o.package, '', startsAt, endsAt]
  );
  const venue = await getVenue(o.venue_id);
  res.redirect(`/admin?ok=${encodeURIComponent(`Zamówienie potwierdzone ✅ Promocja ${o.package.toUpperCase()} dla ${venue?.name||o.venue_id} aktywna do ${endsAt}`)}`);
});

app.post("/admin/promo-order/:id/reject", requireAdminAuth, async (req, res) => {
  await pool.query(`UPDATE fp1_promo_orders SET status='rejected' WHERE id=$1`, [Number(req.params.id)]);
  res.redirect(`/admin?ok=${encodeURIComponent("Zamówienie odrzucone")}`);
});

app.post("/admin/venues/:id/approve", requireAdminAuth, async (req, res) => {
  const venueId = Number(req.params.id);
  await pool.query(`UPDATE fp1_venues SET approved=TRUE WHERE id=$1`, [venueId]);
  const v = await getVenue(venueId);
  if (v?.fox_nick) {
    const foxRow = await pool.query(`SELECT user_id,city FROM fp1_foxes WHERE username=$1 LIMIT 1`, [v.fox_nick.replace(/^@/,"")]);
    if (foxRow.rowCount > 0) {
      const fox = foxRow.rows[0];
      const sameCity = (fox.city||"Warszawa").toLowerCase() === (v.city||"Warszawa").toLowerCase();
      const invBonus = sameCity ? 5 : 10, ratBonus = sameCity ? 1 : 2;
      await pool.query(`UPDATE fp1_foxes SET invites=invites+$1,rating=rating+$2 WHERE user_id=$3`, [invBonus, ratBonus, fox.user_id]);
      if (bot) { try { await bot.telegram.sendMessage(Number(fox.user_id), `🎉 Lokal "${v.name}" został zatwierdzony!\n+${invBonus} zaproszeń, +${ratBonus} punktów`); } catch {} }
    }
  }
  res.redirect(`/admin?ok=${encodeURIComponent("Zatwierdzono: "+(v?.name||venueId))}`);
});

app.post("/admin/venues/:id/reject", requireAdminAuth, async (req, res) => {
  const venueId = Number(req.params.id);
  const v = await getVenue(venueId);
  await pool.query(`DELETE FROM fp1_venues WHERE id=$1 AND approved=FALSE`, [venueId]);
  res.redirect(`/admin?warn=${encodeURIComponent("Odrzucono: "+(v?.name||venueId))}`);
});

/* ═══════════════════════════════════════════════════════════════
   SUPPORT API (webapp)
═══════════════════════════════════════════════════════════════ */
app.post("/api/support/status-check", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const { category, problem_key } = req.body;
    const { runStatusCheck } = require("./fox_support");
    if (typeof runStatusCheck === "function") {
      const result = await runStatusCheck(pool, userId, category, problem_key);
      return res.json({ ok: true, result });
    }
    // Fallback if runStatusCheck not exported — inline basic checks
    const lines = [];
    if (category === "checkin" || category === "otp") {
      const lc = await pool.query(`SELECT venue_id, otp, created_at, confirmed_at, expires_at FROM fp1_checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
      if (lc.rowCount === 0) { lines.push("Brak check-in w systemie."); }
      else {
        const c = lc.rows[0];
        if (c.confirmed_at) lines.push("✅ Ostatni check-in: potwierdzony");
        else if (new Date(c.expires_at) < new Date()) lines.push("❌ Ostatni check-in: kod wygasł");
        else lines.push("⏳ Ostatni check-in: oczekuje na potwierdzenie lokalu");
      }
    }
    if (category === "subscription") {
      const f = await pool.query(`SELECT sub_instagram, sub_tiktok, sub_youtube, sub_telegram, sub_facebook FROM fp1_foxes WHERE user_id=$1`, [userId]);
      if (f.rowCount > 0) {
        const r = f.rows[0];
        lines.push(`Instagram: ${r.sub_instagram?"✅":"❌"}`);
        lines.push(`TikTok: ${r.sub_tiktok?"✅":"❌"}`);
        lines.push(`YouTube: ${r.sub_youtube?"✅":"❌"}`);
        lines.push(`Telegram: ${r.sub_telegram?"✅":"❌"}`);
        lines.push(`Facebook: ${r.sub_facebook?"✅":"❌"}`);
      }
    }
    res.json({ ok: true, result: lines.join("\n") || "Sprawdź ponownie za chwilę." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/support/ticket", requireWebAppAuth, async (req, res) => {
  try {
    const userId = String(req.tgUser.id);
    const { category, problem_key, message } = req.body;
    if (!category || !problem_key || !message) return res.status(400).json({ error: "missing_fields" });

    // Rate limit: max 2 per 24h
    const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_support_tickets WHERE telegram_user_id=$1 AND created_at > NOW()-INTERVAL '24 hours'`, [userId]);
    if (cnt.rows[0].c >= 2) return res.status(429).json({ error: "limit_exceeded" });

    // Check spam block
    const block = await pool.query(`SELECT support_block_until FROM fp1_foxes WHERE user_id=$1 AND support_block_until > NOW()`, [userId]);
    if (block.rowCount > 0) return res.status(429).json({ error: "blocked" });

    const fox = await pool.query(`SELECT id, username, rating, district, trial_active, is_demo, banned_until, created_at FROM fp1_foxes WHERE user_id=$1`, [userId]);
    const f = fox.rows[0] || {};
    const username = f.username || String(userId);

    const visits = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [userId]);
    const lastCheckin = await pool.query(`SELECT venue_id, otp, created_at, confirmed_at, expires_at FROM fp1_checkins WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
    const lc = lastCheckin.rows[0];

    // Detect priority
    const { SUPPORT_CATEGORIES } = require("./fox_support");
    const prob = SUPPORT_CATEGORIES?.[category]?.problems?.[problem_key];
    const priority = prob?.priority || "medium";

    const ticket = await pool.query(
      `INSERT INTO fp1_support_tickets(fox_id, telegram_user_id, username, category, problem_key, venue_id, short_message, status, priority) VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8) RETURNING *`,
      [f.id || null, userId, username, category, problem_key, lc?.venue_id || null, String(message).slice(0,1000), priority]
    );
    const t = ticket.rows[0];

    // Fill venue name
    if (t.venue_id) {
      const v = await pool.query(`SELECT name FROM fp1_venues WHERE id=$1`, [t.venue_id]);
      if (v.rowCount) await pool.query(`UPDATE fp1_support_tickets SET venue_name=$1 WHERE id=$2`, [v.rows[0].name, t.id]);
    }

    // Log event
    await pool.query(`INSERT INTO fp1_support_events(ticket_id, event_type, payload) VALUES($1,'created',$2)`, [t.id, JSON.stringify({ source: "webapp" })]);

    // Forward to admin
    if (ADMIN_TG_ID && bot) {
      try {
        const PRIO = { high:"🟥 Wysoki", medium:"🟧 Średni", low:"🟩 Niski" };
        const memberDate = f.created_at ? new Date(f.created_at).toLocaleDateString("pl-PL",{timeZone:"Europe/Warsaw"}) : "?";
        const daysAgo = f.created_at ? Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000) : "?";
        let adminMsg = `🦊 FOX SUPPORT TICKET #${t.id}\n\n`;
        adminMsg += `👤 Fox: @${username}\n🆔 Fox ID: ${userId}\n`;
        adminMsg += `📂 Kategoria: ${category}\n❓ Problem: ${prob?.label || problem_key}\n`;
        adminMsg += `🔑 Problem key: ${problem_key}\n⚡ Priorytet: ${PRIO[priority]||priority}\n`;
        adminMsg += `\n💬 Wiadomość:\n${String(message).slice(0,1000)}\n`;
        adminMsg += `\n─── Kontekst ───\n📊 Rating: ${f.rating??'?'} | Wizyty: ${visits.rows[0]?.c??'?'}\n📍 Dzielnica: ${f.district||'?'}\n📅 Fox od: ${memberDate} (${daysAgo} dni)\n`;
        if (lc) {
          adminMsg += `\n🔑 Ostatni check-in:\n  Lokal: ${lc.venue_id} | Kod wizyty: ${lc.otp}\n  Status: ${lc.confirmed_at?"✅":"⏳"}\n`;
        }
        adminMsg += `\n🕐 ${new Date().toLocaleString("pl-PL",{timeZone:"Europe/Warsaw"})}\n📱 Źródło: webapp`;

        const sent = await bot.telegram.sendMessage(Number(ADMIN_TG_ID), adminMsg, {
          reply_markup: { inline_keyboard: [
            [{ text:"✅ Zamknięte", callback_data:`sup_admin_close_${t.id}` },{ text:"↩️ Odpowiedz", callback_data:`sup_admin_reply_${t.id}` }],
            [{ text:"⚠️ Do sprawdzenia", callback_data:`sup_admin_check_${t.id}` },{ text:"🚫 Błąd lokalu", callback_data:`sup_admin_venue_error_${t.id}` }],
            [{ text:"👤 Więcej danych", callback_data:`sup_admin_need_info_${t.id}` },{ text:"🚫 Ogranicz", callback_data:`sup_admin_block_${t.id}` }],
          ]}
        });
        await pool.query(`UPDATE fp1_support_tickets SET admin_message_id=$1 WHERE id=$2`, [sent.message_id, t.id]);
      } catch(e) { console.error("SUPPORT_API_ADMIN_ERR", e.message); }
    }

    res.json({ ok: true, ticket_id: t.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   TELEGRAM BOT
═══════════════════════════════════════════════════════════════ */
let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  // ── /id — wyświetl Telegram ID użytkownika (przed innymi handlerami) ──
  bot.command("id", async (ctx) => {
    try {
      const userId = ctx.from.id;
      const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "Fox");
      console.log(`[/id] User ${userId} (${username}) requested their Telegram ID`);
      await ctx.reply(
        `🦊 <b>Twój Telegram ID:</b>\n\n` +
        `<code>${userId}</code>\n\n` +
        `👤 ${username}\n\n` +
        `<i>Kliknij na numer powyżej, aby go skopiować.</i>\n` +
        `<i>Ten numer jest też widoczny w zakładce Profil w aplikacji.</i>`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("[/id] Error:", err);
      try { await ctx.reply(`🦊 Twój Telegram ID: ${ctx.from.id}`); } catch (_) {}
    }
  });

  // ── FOX SUPPORT SYSTEM ──
  const { getSupportTextHandler } = setupSupport(bot, pool, { ADMIN_TG_ID, PUBLIC_URL });

  bot.start(async (ctx) => {
    try {
      const text = String(ctx.message?.text || "").trim();
      const parts = text.split(/\s+/);
      const codeOrInv = parts[1] || "";
      const userId = String(ctx.from.id);
      const username = tgDisplayName(ctx.from);

      const exists = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (exists.rowCount > 0) {
        const f = exists.rows[0];

        // ── RETURNING DELETED FOX — re-register with new invite code ──
        if (f.is_deleted && codeOrInv) {
          // Reset all data, keep founder_number
          await pool.query(`
            UPDATE fp1_foxes SET
              is_deleted = FALSE,
              deleted_at = NULL,
              username = $2,
              rating = 5,
              invites = 3,
              streak_current = 0,
              streak_best = 0,
              is_demo = FALSE,
              demo_venue_id = NULL,
              consent_at = NULL,
              consent_version = NULL,
              banned_until = NULL,
              trial_active = FALSE
            WHERE user_id = $1
          `, [userId, username]);

          const founderNum = await assignFounderNumber(userId);
          const badge = founderBadge(founderNum);
          let msg = `🦊 Witaj ponownie w The FoxPot Club!\n\n`;
          msg += `Twoje konto zostało odtworzone od zera.\n`;
          if (badge) msg += `\n${badge}\n(Twój status Pionier Fox zachowany! 👑)\n`;
          msg += `\nPunkty: 5\nZaproszenia: 3\n`;
          msg += `\n/settings — ustawienia\n/venues — lokale`;
          const webAppUrl = `${PUBLIC_URL}/webapp`;
          return ctx.reply(msg, Markup.inlineKeyboard([
            [Markup.button.webApp("🦊 Otwórz FoxPot App", webAppUrl)]
          ]));
        }

        // ── DELETED FOX without code ──
        if (f.is_deleted) {
          return ctx.reply(
            `🦊 Twoje konto w The FoxPot Club zostało usunięte.\n\n` +
            `Aby wrócić, potrzebujesz nowego zaproszenia.\n` +
            `Napisz: /start <KOD>`
          );
        }

        const tot = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1 AND is_credited=TRUE`, [userId]);
        const badge = founderBadge(f.founder_number);
        const spotsLeft = await founderSpotsLeft();
        const alreadySpun = await hasSpunToday(userId);

        let msg = `🦊 Twój profil\n\n`;
        if (badge) msg += `${badge}\n\n`;
        msg += `Punkty: ${f.rating}\n`;
        msg += `Zaproszenia: ${f.invites}\n`;
        msg += `Miasto: ${f.city}\n`;
        msg += `Dzielnica: ${f.district || "nie podano"}\n`;
        msg += `Wizyty: ${tot.rows[0].c}\n`;
        msg += `🔥 Streak: ${f.streak_current || 0} dni (rekord: ${f.streak_best || 0})\n`;
        msg += `🎰 Spin dziś: ${alreadySpun ? `✅ ${alreadySpun.prize_label}` : "❌ nie kręciłeś"}\n`;
        if (!f.founder_number && spotsLeft > 0) msg += `\n⚡ Miejsc Pionier Fox: ${spotsLeft}`;
        msg += `\n\nKomendy:\n/checkin <venue_id>\n/invite\n/refer\n/spin\n/top\n/achievements\n/venues\n/stamps <venue_id>\n/streak\n/id\n/settings\n/pomoc\n/leave`;

        // Streak updates only on check-in, not on /start

        const webAppUrl = `${PUBLIC_URL}/webapp`;
        return ctx.reply(msg, Markup.inlineKeyboard([
          [Markup.button.webApp("🦊 Otwórz FoxPot App", webAppUrl)]
        ]));
      }

      if (!codeOrInv) {
        const spotsLeft = await founderSpotsLeft();
        let msg = `🦊 THE FOXPOT CLUB\n\nAby się zarejestrować, potrzebujesz zaproszenia od Fox lub kodu lokalu.\n\nNapisz: /start <KOD>`;
        if (spotsLeft > 0) msg += `\n\n👑 Pierwsze 1000 Fox otrzymuje status Pionier Fox!\nPozostało miejsc: ${spotsLeft}`;
        return ctx.reply(msg);
      }

      // ── VENUE LINK: /start venue_4 → demo registration ──
      const venueMatch = codeOrInv.match(/^venue_(\d+)$/i);
      if (venueMatch) {
        const venueId = parseInt(venueMatch[1]);
        const vq = await pool.query(`SELECT id, name FROM fp1_venues WHERE id=$1 AND approved=TRUE LIMIT 1`, [venueId]);
        if (vq.rowCount > 0) {
          const v = vq.rows[0];

          await pool.query(
            `INSERT INTO fp1_foxes(user_id,username,rating,invites,city,is_demo,demo_venue_id,join_source,referred_by_venue)
             VALUES($1,$2,0,0,'Warszawa',TRUE,$3,'venue',$3) ON CONFLICT(user_id) DO NOTHING`,
            [userId, username, v.id]
          );
          const founderNum = await assignFounderNumber(userId);
          let msg = `🦊 Witaj w The FoxPot Club.\n\nZrób pierwszy check-in w lokalu,\naby aktywować status Fox.`;
          if (founderNum) msg += `\n\n👑 Jesteś Pionier Fox #${founderNum}!`;

          const webAppUrl = `${PUBLIC_URL}/webapp`;
          await ctx.reply(msg, Markup.inlineKeyboard([
            [Markup.button.webApp("🦊 Otwórz FoxPot App", webAppUrl)]
          ]));
          await sendCityKeyboard(ctx, "register");
          return;
        }
      }

      const venue = await pool.query(`SELECT * FROM fp1_venues WHERE ref_code=$1 AND approved=TRUE LIMIT 1`, [codeOrInv.toUpperCase()]);
      if (venue.rowCount > 0) {
        const v = venue.rows[0];
        // Venue code = demo Fox (same as venue link). No rating, no invites, no counted visit.
        // Must do check-in to activate full Fox.
        await pool.query(
          `INSERT INTO fp1_foxes(user_id,username,rating,invites,city,is_demo,demo_venue_id,join_source,referred_by_venue)
           VALUES($1,$2,0,0,'Warszawa',TRUE,$3,'venue',$3) ON CONFLICT(user_id) DO NOTHING`,
          [userId, username, v.id]
        );
        const founderNum = await assignFounderNumber(userId);
        let msg = `🦊 Witaj w The FoxPot Club.\n\nZrób pierwszy check-in w lokalu,\naby aktywować status Fox.`;
        if (founderNum) msg += `\n\n👑 Jesteś Pionier Fox #${founderNum}!`;

        const webAppUrl = `${PUBLIC_URL}/webapp`;
        await ctx.reply(msg, Markup.inlineKeyboard([
          [Markup.button.webApp("🦊 Otwórz FoxPot App", webAppUrl)]
        ]));
        await sendCityKeyboard(ctx, "register");
        return;
      }

      const result = await redeemInviteCode(userId, codeOrInv);
      if (!result.ok) return ctx.reply("❌ Nieprawidłowy kod. Potrzebujesz zaproszenia od Fox lub kodu lokalu.");

      await pool.query(`INSERT INTO fp1_foxes(user_id,username,rating,invites,city) VALUES($1,$2,3,3,'Warszawa') ON CONFLICT(user_id) DO NOTHING`, [userId, username]);
      const founderNum = await assignFounderNumber(userId);
     let msg = `🦊 Zostałeś zaproszony do The FoxPot Club.\n\nTwój status Fox jest już aktywny.\nZrób pierwszy check-in w lokalu, aby zdobyć pierwszą wizytę i zwiększyć swój rating.`;
      if (founderNum) msg += `\n\n👑 Pionier Fox #${founderNum}`;

      const webAppUrl = `${PUBLIC_URL}/webapp`;
      await ctx.reply(msg, Markup.inlineKeyboard([
        [Markup.button.webApp("🦊 Otwórz FoxPot App", webAppUrl)]
      ]));
      await sendCityKeyboard(ctx, "register");
    } catch (e) { console.error("START_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.command("spin", async (ctx) => {
    try { await doSpin(ctx); }
    catch (e) { console.error("SPIN_ERR", e); await ctx.reply("Błąd spinu. Spróbuj ponownie."); }
  });

  bot.command("streak", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT streak_current,streak_best,streak_freeze_available,streak_last_date FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (fox.rowCount === 0 || fox.rows[0].is_deleted) return ctx.reply("❌ Najpierw zarejestruj się przez /start <KOD>");
      const f = fox.rows[0];
      const cur = f.streak_current || 0, best = f.streak_best || 0, freeze = f.streak_freeze_available || 0;
      const last = f.streak_last_date ? String(f.streak_last_date).slice(0, 10) : "nigdy";
      let msg = `🔥 Twój Streak\n\nAktualny: ${cur} ${cur > 0 ? "🔥".repeat(Math.min(cur, 5)) : ""}\nRekord: ${best} dni\n❄️ Freeze: ${freeze} (chroni przed resetem)\nOstatni dzień: ${last}\n\n`;
      if (cur < 7)        msg += `Do bonusu +5 pkt: ${7 - cur} dni`;
      else if (cur < 30)  msg += `Do bonusu +15 pkt: ${30 - cur} dni`;
      else if (cur < 90)  msg += `Do bonusu +50 pkt: ${90 - cur} dni`;
      else if (cur < 365) msg += `Do bonusu +200 pkt: ${365 - cur} dni`;
      else                msg += `🏆 Osiągnąłeś maksymalny streak!`;
      await ctx.reply(msg);
    } catch (e) { console.error("STREAK_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.command("settings", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT district,city,is_deleted FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (fox.rowCount === 0 || fox.rows[0].is_deleted) return ctx.reply("❌ Najpierw zarejestruj się przez /start <KOD>");
      const f = fox.rows[0];
      await ctx.reply(`⚙️ Ustawienia\n\n🏙️ Miasto: ${f.city||"Warszawa"}\n📍 Dzielnica: ${f.district||"nie podano"}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🏙️ Zmień miasto", "change_city"), Markup.button.callback("📍 Zmień dzielnicę", "change_district")],
          [Markup.button.callback("🚪 Opuść klub", "leave_club_ask")]
        ]));
    } catch (e) { console.error("SETTINGS_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.command("leave", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT user_id, is_deleted FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (fox.rowCount === 0 || fox.rows[0].is_deleted) return ctx.reply("❌ Nie jesteś członkiem klubu.");
      await ctx.reply(
        `⚠️ Czy na pewno chcesz opuścić The FoxPot Club?\n\n` +
        `Utracisz:\n• Wszystkie wizyty\n• Punkty i rating\n• Osiągnięcia i streak\n• Zaproszenia\n\n` +
        `❗ Tej operacji nie można cofnąć.\n` +
        `Możesz dołączyć ponownie z nowym zaproszeniem — ale zaczniesz od zera.\n\n` +
        `🦊 Pionier Fox — Twój status pozostaje na zawsze.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("❌ Tak, opuszczam klub", "leave_club_confirm")],
          [Markup.button.callback("← Wróć", "leave_club_cancel")]
        ])
      );
    } catch (e) { console.error("LEAVE_CMD_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.action("leave_club_ask", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT user_id, is_deleted FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (fox.rowCount === 0 || fox.rows[0].is_deleted) return ctx.editMessageText("❌ Nie jesteś członkiem klubu.");
      await ctx.editMessageText(
        `⚠️ Czy na pewno chcesz opuścić The FoxPot Club?\n\n` +
        `Utracisz:\n• Wszystkie wizyty\n• Punkty i rating\n• Osiągnięcia i streak\n• Zaproszenia\n\n` +
        `❗ Tej operacji nie można cofnąć.\n` +
        `Możesz dołączyć ponownie z nowym zaproszeniem — ale zaczniesz od zera.\n\n` +
        `🦊 Pionier Fox — Twój status pozostaje na zawsze.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("❌ Tak, opuszczam klub", "leave_club_confirm")],
          [Markup.button.callback("← Wróć", "leave_club_cancel")]
        ])
      );
    } catch (e) { console.error("LEAVE_ASK_ERR", e); await ctx.answerCbQuery("❌ Błąd."); }
  });

  bot.action("leave_club_confirm", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const userId = String(ctx.from.id);

      // Soft delete: mark as deleted, reset stats, keep founder_number
      await pool.query(`
        UPDATE fp1_foxes SET
          is_deleted = TRUE,
          deleted_at = NOW(),
          rating = 0,
          invites = 0,
          streak_current = 0,
          streak_best = 0
        WHERE user_id = $1
      `, [userId]);

      // Delete achievements and spins (keep counted_visits for anti-cheat)
      await pool.query(`DELETE FROM fp1_achievements WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM fp1_daily_spins WHERE user_id = $1`, [userId]);

      // Notify admin
      if (ADMIN_TG_ID) {
        try {
          const name = tgDisplayName(ctx.from);
          await bot.telegram.sendMessage(Number(ADMIN_TG_ID),
            `🚪 Fox opuścił klub:\n👤 ${name}\n🆔 ${userId}`);
        } catch {}
      }

      await ctx.editMessageText(
        `🚪 Opuściłeś The FoxPot Club.\n\n` +
        `Wszystkie Twoje dane zostały zresetowane.\n` +
        `Możesz wrócić w każdej chwili z nowym zaproszeniem — ale zaczniesz od zera.\n\n` +
        `🦊 Jeśli byłeś Pionier Fox — Twój status pozostaje na zawsze.\n\n` +
        `Do zobaczenia! 👋`
      );
    } catch (e) {
      console.error("LEAVE_CONFIRM_ERR", e);
      await ctx.answerCbQuery("❌ Błąd. Spróbuj ponownie.");
    }
  });

  bot.action("leave_club_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery("✅ Zostałeś w klubie!");
      await ctx.editMessageText("✅ Dobrze, zostajesz w The FoxPot Club! 🦊\n\n/settings — wróć do ustawień");
    } catch (e) { console.error("LEAVE_CANCEL_ERR", e); }
  });

  bot.command("panel", async (ctx) => {
    await ctx.reply(`Panel lokalu: ${PUBLIC_URL}/panel`);
  });

  bot.command("venues", async (ctx) => {
    const r = await pool.query(`SELECT id,name,city FROM fp1_venues WHERE approved=TRUE ORDER BY id ASC LIMIT 50`);
    if (r.rows.length === 0) return ctx.reply("Brak aktywnych lokali.");
    const lines = r.rows.map(v => `• ID ${v.id}: ${v.name} (${v.city})`);
    await ctx.reply(`🏪 Lokale partnerskie:\n${lines.join("\n")}\n\n/checkin <ID>`);
  });

  bot.command("invite", async (ctx) => {
    try {
      await upsertFox(ctx);
      const r = await createInviteCode(String(ctx.from.id));
      if (!r.ok) return ctx.reply(r.reason === "NO_INVITES" ? "❌ Brak zaproszeń. +1 za każde 5 potwierdzonych wizyt." : `❌ Błąd: ${r.reason}`);
      await ctx.reply(`✅ Kod zaproszenia (1 użycie):\n${r.code}\n\nNowy Fox wpisuje:\n/start ${r.code}\n\nPozostałe zaproszenia: ${r.invites_left}`);
    } catch (e) { console.error("INVITE_ERR", e); await ctx.reply("❌ Błąd tworzenia zaproszenia."); }
  });

  bot.command("checkin", async (ctx) => {
    try {
      const parts = String(ctx.message?.text || "").trim().split(/\s+/);
      const venueId = parts[1];
      if (!venueId) return ctx.reply("Użycie: /checkin <venue_id>");
      const v = await getVenue(venueId);
      if (!v) return ctx.reply("Nie znaleziono lokalu.");
      if (!v.approved) return ctx.reply("Lokal oczekuje na zatwierdzenie.");
      await upsertFox(ctx);
      const userId = String(ctx.from.id);
       if (!(await hasConsent(userId))) {
        return ctx.reply(
          `🦊 Zanim zrobisz check-in, zaakceptuj regulamin:\n\n` +
          `📋 Regulamin: ${PUBLIC_URL}/rules\n` +
          `🔒 Polityka Prywatności: ${PUBLIC_URL}/privacy\n\n` +
          `Otwórz aplikację i zaakceptuj warunki.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Akceptuję Regulamin i Politykę Prywatności", "accept_consent")]
          ])
        );
      }
      const status = await currentVenueStatus(venueId);
      let statusWarn = "";
      if (status?.type === "limited") statusWarn = `\n⚠️ Status "${status.reason}" do ${new Date(status.ends_at).toLocaleTimeString("pl-PL",{timeZone:"Europe/Warsaw"})}`;
      const already = await hasCountedToday(venueId, userId);
      let repeatNote = '';
      if (already) {
        repeatNote = '\nℹ️ Wizyta już zaliczona dziś. Zniżka nadal obowiązuje!';
      }
      const c = await createCheckin(venueId, userId);
      await ctx.reply(`✅ Check-in (10 min)\n\n🏪 ${v.name}${statusWarn}${repeatNote}\n🔐 Kod wizyty: ${c.otp}\n\nPokaż personelowi.\nPanel: ${PUBLIC_URL}/panel`);
    } catch (e) { console.error("CHECKIN_ERR", e); await ctx.reply("Błąd check-inu."); }
  });

  bot.command("stamps", async (ctx) => {
    try {
      const parts = String(ctx.message?.text || "").trim().split(/\s+/);
      const venueId = parts[1];
      if (!venueId) return ctx.reply("Użycie: /stamps <venue_id>");
      const v = await getVenue(venueId);
      if (!v) return ctx.reply("Nie znaleziono lokalu.");
      const userId = String(ctx.from.id);
      const balance = await stampBalance(venueId, userId);
      const hist = await stampHistory(venueId, userId, 5);
      const histTxt = hist.map(h => `${h.delta>0?"+":""}${h.delta} ${h.emoji}${h.note?" — "+h.note:""}`).join("\n");
      await ctx.reply(`${v.name} — Stemple\nSaldo: ${balance}\n\nOstatnie:\n${histTxt||"Brak historii"}`);
    } catch (e) { console.error("STAMPS_ERR", e); await ctx.reply("Błąd stempli."); }
  });

  bot.command("addvenue", async (ctx) => {
    await upsertFox(ctx);
    await ctx.reply(`Aby dodać lokal, wyślij dane w formacie:\n\n/newvenue Nazwa | Miasto | Adres | PIN (6 cyfr)\n\nPrzykład:\n/newvenue Pizza Roma | Warszawa | ul. Nowy Świat 5 | 654321\n\nLokal będzie aktywny po zatwierdzeniu przez admina.`);
  });

  bot.command("newvenue", async (ctx) => {
    try {
      await upsertFox(ctx);
      const text = String(ctx.message?.text || "").replace("/newvenue","").trim();
      const parts = text.split("|").map(s => s.trim());
      if (parts.length < 4) return ctx.reply("Nieprawidłowy format.\n/newvenue Nazwa | Miasto | Adres | PIN (6 cyfr)");
      const [name, city, address, pin] = parts;
      if (!name||!city||!address||!pin) return ctx.reply("Wszystkie pola są wymagane.");
      if (!/^\d{6}$/.test(pin)) return ctx.reply("PIN musi mieć dokładnie 6 cyfr.");
      const foxNick = tgDisplayName(ctx.from);
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = pinHash(pin, salt);
      await pool.query(`INSERT INTO fp1_venues(name,city,address,pin_hash,pin_salt,approved,fox_nick) VALUES($1,$2,$3,$4,$5,FALSE,$6)`, [name, city, address, hash, salt, foxNick]);
      await ctx.reply(`✅ Wniosek wysłany!\n\n🏪 ${name}\n📍 ${address}, ${city}\n\nAdmin sprawdzi i powiadomi Cię po zatwierdzeniu.`);
    } catch (e) { console.error("NEWVENUE_ERR", e); await ctx.reply("Błąd rejestracji lokalu."); }
  });

  bot.command("achievements", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT is_deleted FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (fox.rowCount === 0 || fox.rows[0].is_deleted) return ctx.reply("❌ Najpierw zarejestruj się przez /start <KOD>");

      const existing = await pool.query(`SELECT achievement_code FROM fp1_achievements WHERE user_id=$1`, [userId]);
      const have = new Set(existing.rows.map(r => r.achievement_code));
      const total   = Object.keys(ACHIEVEMENTS).length;
      const unlocked = have.size;

      let msg = `🏆 Twoje osiągnięcia (${unlocked}/${total})\n\n`;
      const categories = [
        { label: "🗺️ Odkrywca",    keys: ["explorer_1","explorer_10","explorer_30","explorer_100"] },
        { label: "🤝 Społeczność", keys: ["social_1","social_10","social_50","social_100"] },
        { label: "🔥 Streak",      keys: ["streak_7","streak_30","streak_90","streak_365"] },
        { label: "🏪 Wizyty",      keys: ["visits_1","visits_10","visits_50","visits_100"] },
        { label: "🎰 Spin",        keys: ["spin_10","spin_30"] },
        { label: "⭐ Specjalne",   keys: ["pioneer","night_fox","morning_fox","vip_diamond"] },
      ];
      for (const cat of categories) {
        msg += `${cat.label}\n`;
        for (const key of cat.keys) {
          const ach = ACHIEVEMENTS[key];
          if (!ach) continue;
          msg += have.has(key) ? `✅ ${ach.emoji} ${ach.label}\n` : `🔒 ${ach.label} (+${ach.rating} pkt)\n`;
        }
        msg += "\n";
      }
      await ctx.reply(msg);
    } catch (e) { console.error("ACHIEVEMENTS_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.command("top", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const adminExcludeSQL = ADMIN_TG_ID ? ` AND user_id != $1` : '';
      const top = await pool.query(`SELECT user_id, username, rating, founder_number FROM fp1_foxes WHERE is_deleted=FALSE${adminExcludeSQL} ORDER BY rating DESC LIMIT 10`, ADMIN_TG_ID ? [ADMIN_TG_ID] : []);
      const adminExcludePos = ADMIN_TG_ID ? ` AND user_id != $2` : '';
      const myPos = await pool.query(
        `SELECT COUNT(*)::int AS pos FROM fp1_foxes WHERE is_deleted=FALSE${adminExcludePos} AND rating > (SELECT rating FROM fp1_foxes WHERE user_id=$1 LIMIT 1)`, ADMIN_TG_ID ? [userId, ADMIN_TG_ID] : [userId]
      );
      const myRating = await pool.query(`SELECT rating FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      const foxBadgesTop = await getTopFoxBadges();
      const badgeEmojis = { year: "🟠", month: "🔵", week: "🟢" };
      const medals = ["🥇","🥈","🥉"];
      let msg = `🦊 Top Fox\n\n`;
      for (let i = 0; i < top.rows.length; i++) {
        const f = top.rows[i];
        const isMe = String(f.user_id) === userId;
        const medal = medals[i] || `${i+1}.`;
        const nick  = f.username ? `@${f.username}` : `Fox#${String(f.user_id).slice(-4)}`;
        const founder = f.founder_number ? ` 👑#${f.founder_number}` : "";
        const badge = foxBadgesTop[String(f.user_id)];
        const badgeStr = badge ? ` ${badgeEmojis[badge]} ${TOP_FOX_LABELS[badge]}` : "";
        const me = isMe ? " ← Ty!" : "";
        msg += `${medal} ${nick}${founder}${badgeStr} — ${f.rating} pkt${me}\n`;
      }
      if (!isAdmin(userId)) {
        const pos = (myPos.rows[0]?.pos || 0) + 1;
        if (pos > 10 && myRating.rowCount > 0) {
          const myBadge = foxBadgesTop[userId];
          const myBadgeStr = myBadge ? ` ${badgeEmojis[myBadge]} ${TOP_FOX_LABELS[myBadge]}` : "";
          msg += `\n...\n${pos}. Ty${myBadgeStr} — ${myRating.rows[0].rating} pkt`;
        }
      }
      await ctx.reply(msg);
    } catch (e) { console.error("TOP_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.command("refer", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (fox.rowCount === 0 || fox.rows[0].is_deleted) return ctx.reply("❌ Najpierw zarejestruj się przez /start <KOD>");
      const invited  = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE invited_by_user_id=$1`, [userId]);
      const active   = await pool.query(`SELECT COUNT(DISTINCT cv.user_id)::int AS c FROM fp1_counted_visits cv WHERE cv.is_credited=TRUE AND cv.user_id IN (SELECT user_id FROM fp1_foxes WHERE invited_by_user_id=$1)`, [userId]);
      const codesGen = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_invites WHERE created_by_user_id=$1`, [userId]);
      const f = fox.rows[0];
      const invitedCount = invited.rows[0].c, activeCount = active.rows[0].c;
      let msg = `🦊 Twoje zaproszenia\n\n`;
      msg += `👥 Zaproszonych Fox: ${invitedCount}\n`;
      msg += `✅ Aktywnych (min. 1 wizyta): ${activeCount}\n`;
      msg += `🎟️ Dostępne zaproszenia: ${f.invites}\n`;
      msg += `📋 Wygenerowanych kodów: ${codesGen.rows[0].c}\n\n`;
      if (invitedCount === 0) msg += `Jeszcze nikogo nie zaprosiłeś!\n\nUżyj /invite aby wygenerować kod.`;
      else if (activeCount === 0) msg += `Zaprosiłeś ${invitedCount} Fox, ale nikt jeszcze nie zrobił check-inu.\nZachęć ich! 💪`;
      else {
        const percent = Math.round((activeCount / invitedCount) * 100);
        msg += `${percent}% twoich Fox jest aktywnych! `;
        if (percent === 100) msg += `🏆 Idealny wynik!`;
        else if (percent >= 50) msg += `👍 Dobry wynik!`;
        else msg += `💪 Zachęć więcej Fox!`;
      }
      msg += `\n\n+1 pkt gdy ktoś użyje kodu\n+5 pkt gdy zaproszony zrobi 1. wizytę`;
      await ctx.reply(msg);
    } catch (e) { console.error("REFER_ERR", e); await ctx.reply("Błąd. Spróbuj ponownie."); }
  });

  bot.action("accept_consent", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      await saveConsent(userId);
      await ctx.answerCbQuery("✅ Zaakceptowano!");
      await ctx.editMessageText(
        `✅ Regulamin i Polityka Prywatności zaakceptowane!\n\n` +
        `Wersja: ${CONSENT_VERSION}\n` +
        `Możesz teraz korzystać z programu. 🦊`
      );
    } catch (e) {
      console.error("ACCEPT_CONSENT_ERR", e);
      await ctx.answerCbQuery("❌ Błąd. Spróbuj ponownie.");
    }
  });
   // ── City selection ──
  bot.action(/^city_(.+)$/, async (ctx) => {
    try {
      const city = ctx.match[1];
      if (city === "other_list") { await ctx.answerCbQuery(); return sendOtherCitiesKeyboard(ctx); }
      if (city === "back_main") { await ctx.answerCbQuery(); const text = "🏙️ Wybierz swoje miasto:"; const buttons = []; for (let i=0;i<BIG_CITIES.length;i+=2){const row=[Markup.button.callback(BIG_CITIES[i],`city_${BIG_CITIES[i]}`)];if(BIG_CITIES[i+1])row.push(Markup.button.callback(BIG_CITIES[i+1],`city_${BIG_CITIES[i+1]}`));buttons.push(row);}buttons.push([Markup.button.callback("📋 Inne miasto →","city_other_list")]);return ctx.editMessageText(text,Markup.inlineKeyboard(buttons)); }
      if (!POLISH_CITIES.includes(city)) { await ctx.answerCbQuery("❌ Nieprawidłowe miasto"); return; }
      const userId = String(ctx.from.id);
      await pool.query(`UPDATE fp1_foxes SET city=$1 WHERE user_id=$2`, [city, userId]);
      await ctx.answerCbQuery(`✅ ${city}`);
      // If big city — ask district
      if (CITY_DISTRICTS[city]) {
        try { await ctx.editMessageText(`✅ Miasto: ${city}`); } catch {}
        await sendDistrictKeyboard(ctx, city, "register");
      } else {
        try { await ctx.editMessageText(`✅ Miasto: ${city}\n\nZmień: /settings`); }
        catch { await ctx.reply(`✅ Miasto: ${city}\n\nZmień: /settings`); }
      }
    } catch (e) { console.error("CITY_ACTION_ERR", e); await ctx.answerCbQuery("❌ Błąd."); }
  });

  // ── Change city/district from /settings ──
  bot.action("change_city", async (ctx) => {
    try { await ctx.answerCbQuery(); await sendCityKeyboard(ctx, "change"); }
    catch (e) { console.error("CHANGE_CITY_ERR", e); }
  });

  bot.action("change_district", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const userId = String(ctx.from.id);
      const fox = await pool.query(`SELECT city FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      const city = fox.rows[0]?.city || "Warszawa";
      if (CITY_DISTRICTS[city]) {
        await sendDistrictKeyboard(ctx, city, "change");
      } else {
        await ctx.reply("📍 Dzielnice dostępne tylko dla dużych miast.\nZmień miasto: /settings");
      }
    }
    catch (e) { console.error("CHANGE_DISTRICT_ERR", e); }
  });

  bot.action(/^district_(.+)$/, async (ctx) => {
    try {
      const district = ctx.match[1];
      if (!getAllValidDistricts().includes(district)) { await ctx.answerCbQuery("❌ Nieprawidłowa dzielnica"); return; }
      const userId = String(ctx.from.id);
      await pool.query(`UPDATE fp1_foxes SET district=$1 WHERE user_id=$2`, [district, userId]);
      await ctx.answerCbQuery(`✅ Zapisano: ${district}`);
      try { await ctx.editMessageText(`✅ Dzielnica zapisana!\n\n📍 ${district}\n\nZmień: /settings`); }
      catch { await ctx.reply(`✅ Dzielnica: ${district}\n\nZmień: /settings`); }
    } catch (e) { console.error("DISTRICT_ACTION_ERR", e); await ctx.answerCbQuery("❌ Błąd."); }
  });

  // ── FOX SUPPORT: intercept escalation messages before main text handler ──
  bot.on("text", getSupportTextHandler());

  // ── Handle plain text messages as invite/venue codes ──
  bot.on("text", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const text = (ctx.message.text || "").trim();

      // Skip commands
      if (text.startsWith("/")) return;

      // Check if already registered
      const existing = await pool.query(`SELECT user_id FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
      if (existing.rowCount > 0) return; // Already Fox, ignore

      // Try as venue ref_code
      const venue = await pool.query(`SELECT * FROM fp1_venues WHERE ref_code=$1 AND approved=TRUE LIMIT 1`, [text.toUpperCase()]);
      if (venue.rowCount > 0) {
        // Redirect to /start with code
        return ctx.reply(`✅ Kod rozpoznany! Kliknij aby się zarejestrować:`, {
          reply_markup: { inline_keyboard: [[{ text: "🦊 Zarejestruj się", url: `https://t.me/thefoxpot_club_bot?start=${text.toUpperCase()}` }]] }
        });
      }

      // Try as invite code
      const inv = await pool.query(`SELECT code FROM fp1_invites WHERE code=$1 AND uses < max_uses LIMIT 1`, [text.toUpperCase()]);
      if (inv.rowCount > 0) {
        return ctx.reply(`✅ Kod zaproszenia rozpoznany! Kliknij aby się zarejestrować:`, {
          reply_markup: { inline_keyboard: [[{ text: "🦊 Zarejestruj się", url: `https://t.me/thefoxpot_club_bot?start=${text.toUpperCase()}` }]] }
        });
      }

      // Unknown code
      ctx.reply(`❌ Nieprawidłowy kod.\n\nWpisz poprawny kod zaproszenia lub kod lokalu.\nPrzykład: /start ABC123`);
    } catch (e) {
      console.error("TEXT_HANDLER_ERR", e);
    }
  });

  app.use(bot.webhookCallback(`/${WEBHOOK_SECRET}`));
  app.get(`/${WEBHOOK_SECRET}`, (_req, res) => res.type("text/plain").send("WEBHOOK_OK"));
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════ */
(async () => {
  try {
    await migrate();
    if (bot && PUBLIC_URL) {
      const hookUrl = `${PUBLIC_URL}/${WEBHOOK_SECRET}`;
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates:true });
        await bot.telegram.setWebhook(hookUrl);
        console.log("✅ Webhook:", hookUrl);
      } catch (e) { console.error("WEBHOOK_ERR", e?.message||e); }
    }
    app.listen(PORT, () => console.log(`✅ Server V28 listening on ${PORT}`));
  } catch (e) { console.error("BOOT_ERR", e); process.exit(1); }
})();
