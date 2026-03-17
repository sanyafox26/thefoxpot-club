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

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "12mb" }));

/* ═══════════════════════════════════════════════════════════════
   ENV
═══════════════════════════════════════════════════════════════ */
const BOT_TOKEN      = (process.env.BOT_TOKEN      || "").trim();
const DATABASE_URL   = (process.env.DATABASE_URL   || "").trim();
const PUBLIC_URL     = (process.env.PUBLIC_URL     || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || require("crypto").randomBytes(32).toString("hex")).trim();
const COOKIE_SECRET  = (process.env.COOKIE_SECRET  || require("crypto").randomBytes(32).toString("hex")).trim();
const ADMIN_SECRET   = (process.env.ADMIN_SECRET   || "").trim();
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
  await ensureColumn("fp1_counted_visits", "war_day",               "TEXT");
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
      place_id TEXT,
      status TEXT NOT NULL DEFAULT 'voting',
      vote_threshold INT NOT NULL DEFAULT 10,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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
      vote_threshold INT NOT NULL DEFAULT 500,
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
  await ensureColumn("fp1_foxes",          "sub_bonus_claimed",     "BOOLEAN NOT NULL DEFAULT FALSE");

  // Fix fp1_invite_uses if created with wrong schema
  await ensureColumn("fp1_invite_uses",    "invite_id",             "BIGINT");
  await ensureColumn("fp1_invite_uses",    "used_by_user_id",       "BIGINT");
  await ensureColumn("fp1_invite_uses",    "code",                  "TEXT");
  await ensureColumn("fp1_invite_uses",    "used_by_tg",            "BIGINT");
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

  if (ADMIN_TG_ID) {
    await pool.query(
      `UPDATE fp1_foxes SET founder_number=NULL, founder_registered_at=NULL WHERE user_id=$1`,
      [ADMIN_TG_ID]
    );
    console.log(`✅ Founder number скинуто для адміна (TG ID: ${ADMIN_TG_ID})`);
  }

  await ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_foxes_founder_number ON fp1_foxes(founder_number) WHERE founder_number IS NOT NULL`);
  await ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_venues_pioneer_number ON fp1_venues(pioneer_number) WHERE pioneer_number IS NOT NULL`);

  // Auto-assign pioneer_number for first 50 venues in Warsaw
  await pool.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
      FROM fp1_venues
      WHERE pioneer_number IS NULL AND approved=TRUE AND LOWER(city) IN ('warsaw','warszawa')
    )
    UPDATE fp1_venues SET pioneer_number=ranked.rn
    FROM ranked WHERE fp1_venues.id=ranked.id AND ranked.rn <= 50
  `);
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

  await pool.query(`
    WITH ranked AS (
      SELECT user_id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
      FROM fp1_foxes
      WHERE founder_number IS NULL AND ($1 = '' OR user_id != $1::bigint)
    )
    UPDATE fp1_foxes SET founder_number=ranked.rn, founder_registered_at=NOW()
    FROM ranked WHERE fp1_foxes.user_id=ranked.user_id AND ranked.rn <= 1000
  `, [ADMIN_TG_ID || ""]);

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

  await migrateSupport(pool);
  console.log("✅ Migrations OK (V25 + Support)");
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

  const totalVisits  = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [uid]);
  const uniqueVenues = await pool.query(`SELECT COUNT(DISTINCT venue_id)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [uid]);
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
    pool.query(`SELECT user_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1${adminExclude} GROUP BY user_id ORDER BY cnt DESC, MIN(created_at) ASC LIMIT 1`, mkParams(weekStart.toISOString())),
    pool.query(`SELECT user_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1${adminExclude} GROUP BY user_id ORDER BY cnt DESC, MIN(created_at) ASC LIMIT 1`, mkParams(monthStart.toISOString())),
    pool.query(`SELECT user_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1${adminExclude} GROUP BY user_id ORDER BY cnt DESC, MIN(created_at) ASC LIMIT 1`, mkParams(yearStart.toISOString())),
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
    `INSERT INTO fp1_foxes(user_id,username,rating,invites,city) VALUES($1,$2,1,3,'Warszawa')
     ON CONFLICT(user_id) DO UPDATE SET username=COALESCE(EXCLUDED.username,fp1_foxes.username)`,
    [tgId, username]
  );
  const r = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [tgId]);
  return r.rows[0];
}

async function hasCountedToday(venueId, userId) {
  const day = warsawDayKey();
  const r = await pool.query(
    `SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND ${COUNTED_DAY_COL}=$2 AND user_id=$3 LIMIT 1`,
    [venueId, day, String(userId)]
  );
  return r.rowCount > 0;
}

async function countXY(venueId, userId) {
  const x = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND user_id=$2`, [venueId, String(userId)]);
  const y = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]);
  return { X: x.rows[0].c, Y: y.rows[0].c };
}

async function createCheckin(venueId, userId) {
  const otp = otp6(), now = new Date(), warDay = warsawDayKey(now);
  const expires = new Date(now.getTime() + 10 * 60 * 1000);
  const r = await pool.query(
    `INSERT INTO fp1_checkins(venue_id,user_id,otp,expires_at,war_day) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [venueId, String(userId), otp, expires.toISOString(), warDay]
  );
  return r.rows[0];
}

async function listPending(venueId) {
  const now = await dbNow();
  const r = await pool.query(
    `SELECT c.otp, c.expires_at, c.user_id, f.username, f.rating, f.founder_number
     FROM fp1_checkins c LEFT JOIN fp1_foxes f ON f.user_id=c.user_id
     WHERE c.venue_id=$1 AND c.confirmed_at IS NULL AND c.expires_at>$2
     ORDER BY c.created_at DESC LIMIT 20`,
    [venueId, now]
  );
  return r.rows;
}

async function awardInvitesFrom5Visits(userId) {
  const tot = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [String(userId)]);
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

  return res.status(401).json({ error: "Unauthorized" });
}

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
app.get("/version", (_req, res) => res.type("text/plain").send("FP_SERVER_V26_0_OK"));;

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
const ICON_192_B64 = "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";
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


// PUBLIC VENUE TEASER PAGE
app.get("/venue/:id", async (req, res) => {
  try {
    const venueId = parseInt(req.params.id);
    if (!venueId) return res.status(404).send("Not found");
    const vr = await pool.query(`SELECT id,name,city,address,venue_type,cuisine,tags,description,is_trial,discount_percent,opening_hours,status_temporary,google_place_id FROM fp1_venues WHERE id=$1 AND approved=TRUE LIMIT 1`, [venueId]);
    const v = vr.rows[0];
    if (!v) return res.status(404).send(pageShell("Nie znaleziono",'<div class="card"><h1>Lokal nie znaleziony</h1></div>'));
    const cv = await pool.query(`SELECT COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE venue_id=$1`,[venueId]);
    const uf = await pool.query(`SELECT COUNT(DISTINCT user_id)::int AS cnt FROM fp1_counted_visits WHERE venue_id=$1`,[venueId]);
    const visits=cv.rows[0]?.cnt||0, foxes=uf.rows[0]?.cnt||0;
    const disc=parseFloat(v.discount_percent)||10;
    const tgs=v.tags?v.tags.split(",").map(t=>t.trim()).filter(Boolean):[];
    const vB=tgs.includes("vegan")?`<span style="background:#1a3a1a;color:#4ade80;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">Vegan</span>`:"";
    const gB=tgs.includes("gluten-free")?`<span style="background:#3a2a0a;color:#fbbf24;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600">Gluten-free</span>`:"";
    const tpL=[v.venue_type,v.cuisine].filter(Boolean).join(" \u00b7 ");
    const stH=v.status_temporary?`<div class="card" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.06);padding:14px 16px"><div style="font-size:12px;font-weight:700;color:#FBBF24;margin-bottom:4px">Status</div><div style="font-size:13px;color:rgba(255,255,255,.6)">${escapeHtml(v.status_temporary)}</div></div>`:"";
    const hrH=v.opening_hours?`<div class="card" style="padding:14px 16px"><div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:4px">Godziny otwarcia</div><div style="font-size:13px;color:rgba(255,255,255,.7);line-height:1.6;white-space:pre-line">${escapeHtml(v.opening_hours)}</div></div>`:"";
    const allPhotos = await pool.query(`SELECT url FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC LIMIT 3`, [venueId]);
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
      <div class="card" style="text-align:center;padding:24px 16px;border-color:rgba(245,166,35,.3);background:rgba(245,166,35,.06)"><div style="font-size:28px;margin-bottom:8px">&#128274;</div><h2 style="font-size:16px;margin-bottom:6px;color:#f5a623">Odblokuj zni&#380;k&#281; ${disc}% jako Fox</h2><p style="font-size:13px;color:rgba(255,255,255,.5);margin-bottom:16px;line-height:1.5">The FoxPot Club to prywatny klub dla smakoszy.<br/>Odwied&#378; ${escapeHtml(v.name)} i aktywuj dost&#281;p!</p><a href="https://t.me/thefoxpot_club_bot?start=venue_${v.id}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#f5a623,#e8842a);color:#000;font-weight:700;border-radius:14px;font-size:15px;text-decoration:none">&#129418; Do&#322;&#261;cz przez ${escapeHtml(v.name)}</a><p style="font-size:11px;color:rgba(255,255,255,.3);margin-top:12px">Masz 60 minut aby zrobi&#263; check-in i aktywowa&#263; konto Fox</p></div>
      <div style="text-align:center;padding:20px;font-size:11px;color:rgba(255,255,255,.25)"><a href="/" style="color:rgba(255,255,255,.35)">thefoxpot.club</a></div>
    `,`body{background:#0a0b14}.card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:18px}`));
  } catch(e) { console.error("venue teaser err:",e); res.status(500).send("Error"); }
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
    const totalVisits = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [userId]);
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
    try {
      const init = req.headers["x-telegram-init-data"];
      if (init) {
        const parsed = Object.fromEntries(new URLSearchParams(init));
        if (parsed.user) userId = String(JSON.parse(parsed.user).id);
      }
    } catch(_){}
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
     `SELECT id, name, city, address, lat, lng, is_trial, discount_percent, description, recommended, venue_type, cuisine, monthly_visit_limit, tags, opening_hours, status_temporary, google_place_id, pioneer_number FROM fp1_venues WHERE approved=TRUE ORDER BY id ASC LIMIT 100`
    );
    let myVisits = {};
    let totalVisits = {};
    if (userId) {
      const mv = await pool.query(
        `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE user_id=$1 GROUP BY venue_id`, [userId]
      );
      mv.rows.forEach(r => myVisits[r.venue_id] = r.cnt);
    }
    const tv = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits GROUP BY venue_id`
    );
    tv.rows.forEach(r => totalVisits[r.venue_id] = r.cnt);

    // Trial: remaining slots this month
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const trialUsed = {};
    const tu = await pool.query(
      `SELECT venue_id, COUNT(DISTINCT user_id)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 GROUP BY venue_id`,
      [monthStart.toISOString()]
    );
    tu.rows.forEach(r => trialUsed[r.venue_id] = r.cnt);

    // Weekly visits (for TOP week)
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const wv = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 GROUP BY venue_id`,
      [weekAgo.toISOString()]
    );
    const weeklyVisits = {};
    wv.rows.forEach(r => weeklyVisits[r.venue_id] = r.cnt);

    // Monthly visits (for TOP month)
    const mv2 = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt FROM fp1_counted_visits WHERE created_at >= $1 GROUP BY venue_id`,
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
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE created_at >= $1 GROUP BY venue_id`,
      [weekStart.toISOString()]
    );
    const weeklyData = {};
    wv2.rows.forEach(r => weeklyData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    // Recount monthly from 1st
    const monthStart2 = new Date(warsawNow);
    monthStart2.setDate(1); monthStart2.setHours(0,0,0,0);
    const mv3 = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE created_at >= $1 GROUP BY venue_id`,
      [monthStart2.toISOString()]
    );
    const monthlyData = {};
    mv3.rows.forEach(r => monthlyData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    // Recount yearly from Jan 1
    const yearStart = new Date(warsawNow);
    yearStart.setMonth(0, 1); yearStart.setHours(0,0,0,0);
    const yv = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits WHERE created_at >= $1 GROUP BY venue_id`,
      [yearStart.toISOString()]
    );
    const yearlyData = {};
    yv.rows.forEach(r => yearlyData[r.venue_id] = { cnt: r.cnt, first: r.first_at });

    // All-time with first visit tiebreak
    const allData = {};
    const av = await pool.query(
      `SELECT venue_id, COUNT(*)::int AS cnt, MIN(created_at) AS first_at FROM fp1_counted_visits GROUP BY venue_id`
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

    // P0.2: Each period finds its own top independently (venue can have multiple badges)
    const prevYearEnd = new Date(warsawNow); prevYearEnd.setMonth(0, 1); prevYearEnd.setHours(0,0,0,0);
    const hasPrevYear = await pool.query(
      `SELECT 1 FROM fp1_counted_visits WHERE created_at < $1 LIMIT 1`,
      [prevYearEnd.toISOString()]
    );
    const topAllTimeId = hasPrevYear.rowCount > 0 ? findTop(allData, []) : null;
    const topYearId = findTop(yearlyData, []);
    const topMonthId = findTop(monthlyData, []);
    const topWeekId = findTop(weeklyData, []);

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

    const venues = r.rows.map(v => {
      const tv_cnt = totalVisits[v.id] || 0;
      const usedSlots = (trialUsed[v.id] || 0) + (activeResByVenue[v.id] || 0);
      const trial_remaining = v.is_trial ? Math.max(0, (v.monthly_visit_limit || 20) - usedSlots) : null;
      return {
        ...v,
        discount_percent: parseFloat(v.discount_percent) || 10,
        my_visits: myVisits[v.id] || 0,
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

    const checkin = await createCheckin(venueId, userId);
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
    const VALID_PLATFORMS = ["instagram", "tiktok", "youtube", "telegram"];
    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "nieprawidłowa platforma" });
    }

    const col = `sub_${platform}`;
    const fox = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 AND is_deleted=FALSE LIMIT 1`, [userId]);
    if (fox.rowCount === 0) return res.status(404).json({ error: "nie znaleziono" });

    const f = fox.rows[0];

    // Already verified — return success but no new reward
    if (f[col]) {
      const count = [f.sub_instagram, f.sub_tiktok, f.sub_youtube, f.sub_telegram].filter(Boolean).length;
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
        sub_bonus_claimed: !!f.sub_bonus_claimed,
      });
    }

    // Telegram: real verification via getChatMember
    if (platform === "telegram") {
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
        // If API fails, fall through to trust-based (graceful degradation)
      }
    }

    // Instagram/TikTok/YouTube: trust-based verification (industry standard)
    // Mark as verified + add +3 rating
    await pool.query(
      `UPDATE fp1_foxes SET ${col} = TRUE, rating = rating + 3 WHERE user_id=$1`,
      [userId]
    );

    let invite_bonus = false;

    // Check if all 4 are now subscribed → bonus +1 invite (one-time)
    if (!f.sub_bonus_claimed) {
      const updated = await pool.query(`SELECT sub_instagram, sub_tiktok, sub_youtube, sub_telegram FROM fp1_foxes WHERE user_id=$1`, [userId]);
      const u = updated.rows[0];
      if (u.sub_instagram && u.sub_tiktok && u.sub_youtube && u.sub_telegram) {
        await pool.query(
          `UPDATE fp1_foxes SET sub_bonus_claimed = TRUE, invites = invites + 1 WHERE user_id=$1`,
          [userId]
        );
        invite_bonus = true;
      }
    }

    // Get updated fox data
    const result = await pool.query(`SELECT rating, invites, sub_instagram, sub_tiktok, sub_youtube, sub_telegram, sub_bonus_claimed FROM fp1_foxes WHERE user_id=$1`, [userId]);
    const r = result.rows[0];
    const count = [r.sub_instagram, r.sub_tiktok, r.sub_youtube, r.sub_telegram].filter(Boolean).length;

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

    // Delete achievements, counted visits, daily spins
    await pool.query(`DELETE FROM fp1_achievements WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM fp1_counted_visits WHERE user_id = $1`, [userId]);
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
       WHERE cv.user_id IN (SELECT user_id FROM fp1_foxes WHERE invited_by_user_id=$1)`, [userId]
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
    const discountPct = parseFloat(v.discount_percent) || 10;
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
    let countedAdded = false, inviteAutoAdded = 0, isFirstEver = false, newAch = [];
    if (!already) {
      const hasDK = COUNTED_DAY_COL === "day_key", hasWD = await hasColumn("fp1_counted_visits", "war_day");
      const cols = ["venue_id","user_id"], vals = [venueId, userId];
      if (hasDK) { cols.push("day_key"); vals.push(day); } if (hasWD) { cols.push("war_day"); vals.push(day); }
      await pool.query(`INSERT INTO fp1_counted_visits(${cols.join(",")}) VALUES(${cols.map((_,i)=>`$${i+1}`).join(",")})`, vals);
      await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [userId]);
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

      const tv = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [userId]);
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
      const vvc = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]);
      const hour = warsawHour();
      newAch = await checkAchievements(userId, { is_pioneer:vvc.rows[0].c===1, is_night:hour>=23, is_morning:hour<8 });
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
      bonuses:{ counted:countedAdded, first_ever:isFirstEver, invites_added:inviteAutoAdded, achievements:newAch.map(a=>({code:a.code,emoji:a.emoji,label:a.label,rating:a.rating})) },
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
         WHERE cv.created_at >= $1 AND cv.created_at < $2
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
         WHERE cv.created_at >= $1 AND cv.created_at < $2
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
         WHERE cv.created_at >= $1 AND cv.created_at < $2
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
  const venueId = String(req.panel.venue_id);
  const photos = await pool.query(
    `SELECT id, url, sort_order FROM fp1_venue_photos WHERE venue_id=$1 ORDER BY sort_order ASC`, [venueId]
  );
  res.json({ photos: photos.rows });
});

// POST /panel/venue/photos/upload — upload photo via Cloudinary
app.post("/panel/venue/photos/upload", requirePanelAuth, async (req, res) => {
  try {
    const venueId = String(req.panel.venue_id);
    const { image } = req.body; // base64 data URL
    if (!image) return res.status(400).json({ error: "Brak zdjęcia" });
    if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
      return res.status(500).json({ error: "Cloudinary nie skonfigurowany" });
    }

    // Check count
    const existing = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_venue_photos WHERE venue_id=$1`, [venueId]);
    if (existing.rows[0].c >= 3) return res.status(400).json({ error: "Maksymalnie 3 zdjęcia" });

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
    const venueId = String(req.panel.venue_id);
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
    const initData = req.headers["x-telegram-init-data"] || "";
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? String(tgUser.id) : null;
    const fp = req.query.fp || req.ip || "anon";

    const rows = await pool.query(`
      SELECT n.id, n.name, n.city, n.address, n.status, n.vote_threshold, n.created_at,
        (SELECT COUNT(*)::int FROM fp1_nomination_votes v WHERE v.nomination_id=n.id) AS votes
      FROM fp1_nominations n WHERE n.status NOT IN ('added','rejected')
      ORDER BY votes DESC, n.created_at ASC
    `);

    const myVotes = new Set();
    if (userId || fp) {
      const mv = await pool.query(`SELECT nomination_id FROM fp1_nomination_votes WHERE fingerprint=$1 OR tg_user_id=$2`, [fp, userId || ""]);
      mv.rows.forEach(r => myVotes.add(r.nomination_id));
    }

    res.json({
      nominations: rows.rows.map(n => ({
        ...n, status_label: NOM_STATUS_LABELS[n.status] || n.status, my_vote: myVotes.has(n.id)
      }))
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
    const fp = String(req.body.fp || req.ip || "anon").slice(0, 200);
    const initData = req.headers["x-telegram-init-data"] || "";
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? String(tgUser.id) : null;
    let isMember = false;
    if (userId) { const fox = await pool.query(`SELECT user_id FROM fp1_foxes WHERE user_id=$1 AND is_deleted=FALSE LIMIT 1`, [userId]); isMember = fox.rowCount > 0; }
    if (rateLimit(`nom_vote:${fp}`, 20, 60*60*1000)) return res.status(429).json({ error: "Zbyt wiele głosów." });
    const nom = await pool.query(`SELECT id, status, vote_threshold FROM fp1_nominations WHERE id=$1 LIMIT 1`, [nomId]);
    if (nom.rowCount === 0) return res.status(404).json({ error: "Nie znaleziono" });
    if (!["voting","threshold"].includes(nom.rows[0].status)) return res.status(400).json({ error: "Głosowanie zakończone" });
    await pool.query(`INSERT INTO fp1_nomination_votes(nomination_id,fingerprint,tg_user_id,is_member) VALUES($1,$2,$3,$4) ON CONFLICT(nomination_id,fingerprint) DO NOTHING`, [nomId, fp, userId || null, isMember]);
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
const SMALL_CITY_THRESHOLD = 500;
const CITY_VOTE_COOLDOWN_DAYS = 30;

app.get("/api/city-nominations", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] || "";
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? String(tgUser.id) : null;
    const fp = req.query.fp || req.ip || "anon";

    const rows = await pool.query(`
      SELECT n.id, n.name, n.country, n.status, n.vote_threshold, n.created_at,
        (SELECT COUNT(*)::int FROM fp1_city_votes v WHERE v.city_nomination_id=n.id) AS votes
      FROM fp1_city_nominations n
      ORDER BY votes DESC, n.created_at ASC LIMIT 50
    `);

    const myVotes = new Set();
    if (userId || fp) {
      const mv = await pool.query(`SELECT city_nomination_id FROM fp1_city_votes WHERE fingerprint=$1 OR tg_user_id=$2`, [fp, userId || ""]);
      mv.rows.forEach(r => myVotes.add(r.city_nomination_id));
    }

    // Check cooldown: last vote time
    let canVoteAfter = null;
    if (fp) {
      const lastVote = await pool.query(`SELECT created_at FROM fp1_city_votes WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1`, [fp]);
      if (lastVote.rowCount > 0) {
        const next = new Date(lastVote.rows[0].created_at);
        next.setDate(next.getDate() + CITY_VOTE_COOLDOWN_DAYS);
        if (next > new Date()) canVoteAfter = next.toISOString();
      }
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
    const fp = String(req.body.fp || req.ip || "anon").slice(0, 200);
    const initData = req.headers["x-telegram-init-data"] || "";
    const tgUser = verifyTelegramInitData(initData);
    const userId = tgUser ? String(tgUser.id) : null;

    let isMember = false;
    if (userId) { const fox = await pool.query(`SELECT user_id FROM fp1_foxes WHERE user_id=$1 AND is_deleted=FALSE LIMIT 1`, [userId]); isMember = fox.rowCount > 0; }

    if (rateLimit(`citynom_vote:${fp}`, 10, 60*60*1000)) return res.status(429).json({ error: "Zbyt wiele głosów." });

    // Check already voted on THIS city (lifetime)
    const already = await pool.query(`SELECT id FROM fp1_city_votes WHERE city_nomination_id=$1 AND fingerprint=$2 LIMIT 1`, [cityId, fp]);
    if (already.rowCount > 0) return res.status(409).json({ error: "Już zagłosowałeś na to miasto" });

    // Check cooldown (30 days since last vote on ANY city)
    const lastVote = await pool.query(`SELECT created_at FROM fp1_city_votes WHERE fingerprint=$1 ORDER BY created_at DESC LIMIT 1`, [fp]);
    if (lastVote.rowCount > 0) {
      const next = new Date(lastVote.rows[0].created_at);
      next.setDate(next.getDate() + CITY_VOTE_COOLDOWN_DAYS);
      if (next > new Date()) {
        const daysLeft = Math.ceil((next - new Date()) / 86400000);
        return res.status(429).json({ error: `Możesz zmienić głos za ${daysLeft} dni` });
      }
    }

    const nom = await pool.query(`SELECT id, status, vote_threshold FROM fp1_city_nominations WHERE id=$1 LIMIT 1`, [cityId]);
    if (nom.rowCount === 0) return res.status(404).json({ error: "Nie znaleziono" });
    if (!["voting","threshold"].includes(nom.rows[0].status)) return res.status(400).json({ error: "Głosowanie zakończone" });

    await pool.query(`INSERT INTO fp1_city_votes(city_nomination_id,fingerprint,tg_user_id,is_member) VALUES($1,$2,$3,$4)`, [cityId, fp, userId || null, isMember]);

    const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_city_votes WHERE city_nomination_id=$1`, [cityId]);
    if (cnt.rows[0].c >= nom.rows[0].vote_threshold && nom.rows[0].status === "voting") {
      await pool.query(`UPDATE fp1_city_nominations SET status='threshold', updated_at=NOW() WHERE id=$1`, [cityId]);
    }
    res.json({ ok: true, votes: cnt.rows[0].c });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/top
═══════════════════════════════════════════════════════════════ */
app.get("/api/top", async (req, res) => {
  try {
    const initData = req.headers["x-telegram-init-data"] || "";
    const tgUser   = verifyTelegramInitData(initData);
    const myId     = tgUser ? String(tgUser.id) : null;

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
  const venueId = String(req.panel.venue_id);
  const venue   = await getVenue(venueId);
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
          <div style="margin-top:4px;font-size:13px"><span${nameColor}>🦊 ${foxName}</span>${founderLabel}${badgeHtml}${p.founder_number && !isAdminUser ? ` <span style="color:#ffd700;font-size:11px">👑 #${p.founder_number}</span>` : ''} <span class="muted">· ${p.rating||0} pkt</span></div>
        </div>`;
      }).join("");

  const xy = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]);

  res.send(pageShell(`Panel — ${venue?.name || venueId}`, `
    <div class="card">
      <div class="topbar"><h1>🦊 ${escapeHtml(venue?.name||venueId)} ${statusHtml}</h1><a href="/panel/logout">Wyloguj</a></div>
      ${flash(req)}
      <div style="margin-top:10px;opacity:.7;font-size:13px">Kod lokalu: <b>${escapeHtml(venue.ref_code||'brak')}</b> | Łącznie wizyt: <b>${xy.rows[0].c}</b></div>
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
            <select name="reason"><option>FULL</option><option>PRIVATE EVENT</option><option>KITCHEN LIMIT</option></select>
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
      <h2>📸 Zdjęcia lokalu (max 3)</h2>
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
          if(venuePhotos.length<3){
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
      <h2>🍽 Top 3 dania (promowane)</h2>
      <p class="muted" style="margin-bottom:12px">Te dania zobaczą Foxy po check-inie. Wybierz swoje najlepsze!</p>
      <div id="dishesForm">
        <div id="dish1Row" class="grid2" style="margin-bottom:8px"><div><label>#1 Nazwa</label><input id="dish1name" maxlength="40" placeholder="np. Burger wołowy"/></div><div><label>Kategoria</label><select id="dish1cat"><option value="main">🍽 Główne</option><option value="snack">🥗 Przystawka</option><option value="dessert">🍰 Deser</option><option value="drink">☕ Napój</option><option value="soup">🍲 Zupa</option><option value="alcohol">🍺 Alkohol</option><option value="other">📦 Inne</option></select></div></div>
        <div id="dish2Row" class="grid2" style="margin-bottom:8px"><div><label>#2 Nazwa</label><input id="dish2name" maxlength="40" placeholder="np. Latte"/></div><div><label>Kategoria</label><select id="dish2cat"><option value="main">🍽 Główne</option><option value="snack">🥗 Przystawka</option><option value="dessert">🍰 Deser</option><option value="drink">☕ Napój</option><option value="soup">🍲 Zupa</option><option value="alcohol">🍺 Alkohol</option><option value="other">📦 Inne</option></select></div></div>
        <div id="dish3Row" class="grid2" style="margin-bottom:8px"><div><label>#3 Nazwa</label><input id="dish3name" maxlength="40" placeholder="np. Tiramisu"/></div><div><label>Kategoria</label><select id="dish3cat"><option value="main">🍽 Główne</option><option value="snack">🥗 Przystawka</option><option value="dessert">🍰 Deser</option><option value="drink">☕ Napój</option><option value="soup">🍲 Zupa</option><option value="alcohol">🍺 Alkohol</option><option value="other">📦 Inne</option></select></div></div>
        <button type="button" onclick="saveDishes()" style="width:100%;margin-top:6px">💾 Zapisz dania</button>
        <div id="dishesMsg" style="margin-top:8px"></div>
      </div>
      <script>
        async function loadDishes(){
          try{
            const r=await fetch('/panel/venue/dishes',{credentials:'same-origin'});
            const d=await r.json();
            if(d.dishes) d.dishes.forEach(dish=>{
              const n=document.getElementById('dish'+dish.sort_order+'name');
              const c=document.getElementById('dish'+dish.sort_order+'cat');
              if(n) n.value=dish.name||'';
              if(c) c.value=dish.category||'main';
            });
          }catch(e){console.error(e)}
        }
        async function saveDishes(){
          const dishes=[];
          for(let i=1;i<=3;i++){
            const n=document.getElementById('dish'+i+'name').value.trim();
            const c=document.getElementById('dish'+i+'cat').value;
            if(n) dishes.push({sort_order:i,name:n,category:c,is_active:true});
          }
          if(dishes.length===0){document.getElementById('dishesMsg').innerHTML='<div class="err">Podaj co najmniej 1 danie</div>';return;}
          try{
            const r=await fetch('/panel/venue/dishes',{method:'PUT',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({dishes})});
            const d=await r.json();
            document.getElementById('dishesMsg').innerHTML=d.ok?'<div class="ok">✅ Zapisano!</div>':'<div class="err">'+d.error+'</div>';
          }catch(e){document.getElementById('dishesMsg').innerHTML='<div class="err">Błąd: '+e.message+'</div>';}
        }
        loadDishes();
      </script>
    </div>
    <div class="card">
      <h2>Emoji-stemple</h2>
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
    <div class="card">
      <h2>📊 Co wybierają Foxy</h2>
      <div id="foxChoiceStats"><span class="muted">Ładowanie...</span></div>
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
      <h2>📣 Reklama w FoxPot</h2>
      <p style="font-size:13px;color:rgba(255,255,255,.7);margin-bottom:12px">Chcesz więcej gości? Zamów promowanie lokalu w aplikacji FoxPot — wyróżnienie w mapie, powiadomienia dla Fox'ów w okolicy i więcej.</p>
      <a href="https://t.me/thefoxpot" target="_blank" style="display:block;text-align:center;background:var(--fox);color:#000;font-weight:700;padding:12px;border-radius:var(--radius-sm);text-decoration:none;font-size:14px">📩 Zamów reklamę</a>
    </div>
    <div class="card">
      <h2>⚙️ Ustawienia lokalu</h2>
      <form method="POST" action="/panel/settings">
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
        <div class="grid2" style="margin-top:8px">
          <div><label>Tags (vegan, gluten-free)</label><input name="tags" value="${escapeHtml(venue.tags||'')}" maxlength="100"/></div>
          
        </div>
        <button type="submit" style="margin-top:12px;width:100%">💾 Zapisz ustawienia</button>
      </form>
    </div>`));
});

// ── PANEL: GET venue dishes (Top 3) ──
app.get("/panel/venue/dishes", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
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
  const venueId = String(req.panel.venue_id);
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
  const venueId = String(req.panel.venue_id);
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

// ── PANEL: Save venue settings ──
app.post("/panel/settings", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const b = req.body;
  try {
    await pool.query(
      `UPDATE fp1_venues SET venue_type=$1, cuisine=$2, description=$3, recommended=$4,
       opening_hours=$5, status_temporary=$6, tags=$7, google_place_id=$8 WHERE id=$9`,
      [
        String(b.venue_type||"").trim().slice(0,60),
        String(b.cuisine||"").trim().slice(0,60),
        String(b.description||"").trim().slice(0,300),
        String(b.recommended||"").trim().slice(0,300),
        String(b.opening_hours||"").trim().slice(0,300),
        String(b.status_temporary||"").trim().slice(0,120),
        String(b.tags||"").trim().slice(0,100),
        String(b.google_place_id||"").trim().slice(0,100),
        venueId
      ]
    );
    res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Ustawienia zapisane ✅")}`);
  } catch (e) {
    res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd: "+String(e?.message||e).slice(0,120))}`);
  }
});

app.post("/panel/confirm", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
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
    const label = r.debounce ? `Debounce ⚠️ · ${foxName}` : r.countedAdded ? `✅ ${foxName}${founderText}${badgeText} · X/Y ${xy.X}/${xy.Y}` : `DZIŚ JUŻ BYŁO ✅ · ${foxName}`;
    res.redirect(`/panel/dashboard?ok=${encodeURIComponent(label)}`);
  } catch (e) {
    console.error("CONFIRM_ERR", e);
    res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd: "+String(e?.message||e).slice(0,120))}`);
  }
});

app.post("/panel/reserve", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
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
  const venueId = String(req.panel.venue_id);
  const reason = ["FULL","PRIVATE EVENT","KITCHEN LIMIT"].includes(req.body.reason) ? req.body.reason : "FULL";
  const hours  = Math.min(3, Math.max(1, Number(req.body.hours) || 3));
  const cnt = await limitedCountThisWeek(venueId);
  if (cnt >= 2) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Maksimum 2× tygodniowo.")}`);
  const now = new Date(), endsAt = new Date(now.getTime() + hours * 3600 * 1000);
  await pool.query(`INSERT INTO fp1_venue_status(venue_id,type,reason,starts_at,ends_at) VALUES($1,'limited',$2,$3,$4)`, [venueId, reason, now.toISOString(), endsAt.toISOString()]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Status "${reason}" na ${hours} godz.`)}`);
});

app.post("/panel/status/cancel", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  await pool.query(`UPDATE fp1_venue_status SET ends_at=NOW() WHERE venue_id=$1 AND starts_at<=NOW() AND ends_at>NOW()`, [venueId]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Status anulowany.")}`);
});

app.post("/panel/status/cancel/:id", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const statusId = Number(req.params.id);
  await pool.query(`UPDATE fp1_venue_status SET ends_at=NOW() WHERE id=$1 AND venue_id=$2`, [statusId, venueId]);
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Anulowano.")}`);
});

app.post("/panel/stamps", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
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
  const venues  = await pool.query(`SELECT v.*,COUNT(cv.id)::int AS visits FROM fp1_venues v LEFT JOIN fp1_counted_visits cv ON cv.venue_id=v.id WHERE v.approved=TRUE GROUP BY v.id ORDER BY visits DESC LIMIT 50`);
  const foxes   = await pool.query(`SELECT user_id,username,rating,invites,city,district,founder_number,streak_current,streak_best,created_at FROM fp1_foxes ORDER BY rating DESC LIMIT 50`);
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
  const foxesHtml  = foxes.rows.map(f => `<tr><td>${f.user_id}</td><td>${escapeHtml(f.username||"—")}</td><td>${f.rating}</td><td>${f.invites}</td><td>${escapeHtml(f.city)}</td><td>${escapeHtml(f.district||"—")}</td><td>${f.streak_current||0} 🔥 (rek: ${f.streak_best||0})</td><td>${f.founder_number?`<span style="color:#ffd700">👑 #${f.founder_number}</span>`:`<span class="muted">—</span>`}</td></tr>`).join("");
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
  const spinHtml = spinStats.rows.map(s => `<tr><td>${escapeHtml(s.prize_label||s.prize_type)}</td><td><b>${s.cnt}</b></td></tr>`).join("");

  res.send(pageShell("Admin — FoxPot", `
    <div class="card">
      <div class="topbar"><h1>🛡️ Panel Admina</h1><a href="/admin/logout">Wyloguj</a></div>
      ${flash(req)}
      <div class="muted" style="margin-top:8px">👑 Pionier Fox: pozostało <b>${spotsLeft}</b> / ${FOUNDER_LIMIT} miejsc</div>
    </div>
    <div class="card"><h2>Wnioski do zatwierdzenia (${pending.rows.length})</h2>${pendingHtml}</div>
    <div class="card"><h2>🗳️ Głosowanie na lokale (${noms.rows.length})</h2>${nomsHtml}</div>
    <div class="card"><h2>🏙️ Głosowanie na miasta (${cityNoms.rows.length})</h2>${cityNomsHtml}</div>
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
        <tr style="opacity:.6"><th>TG ID</th><th>Nick</th><th>Punkty</th><th>Zapr.</th><th>Miasto</th><th>Dzielnica</th><th>Streak</th><th>Pionier</th></tr>${foxesHtml}
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
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <button type="button" onclick="downloadCsv('visits')" style="background:rgba(124,92,252,.8);font-size:12px;padding:10px">📊 Wizyty CSV</button>
        <button type="button" onclick="downloadCsv('dishes')" style="background:rgba(46,204,113,.7);font-size:12px;padding:10px">🍽 Dania CSV</button>
        <button type="button" onclick="downloadCsv('foxes')" style="background:rgba(255,138,0,.7);font-size:12px;padding:10px">🦊 Foxy CSV</button>
      </div>
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
               (SELECT COUNT(*)::int FROM fp1_counted_visits cv WHERE cv.user_id=f.user_id AND cv.created_at >= $1 AND cv.created_at < ($2::date + INTERVAL '1 day')) AS visits_period,
               (SELECT COUNT(*)::int FROM fp1_counted_visits cv2 WHERE cv2.user_id=f.user_id) AS visits_total
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
               r.amount, r.discount_saved
        FROM fp1_counted_visits cv
        LEFT JOIN fp1_foxes f ON f.user_id = cv.user_id
        LEFT JOIN fp1_venues v ON v.id = cv.venue_id
        LEFT JOIN fp1_receipts r ON r.user_id = cv.user_id AND r.venue_id = cv.venue_id AND r.created_at::date = cv.created_at::date
        WHERE cv.created_at >= $1 AND cv.created_at < ($2::date + INTERVAL '1 day')${distFilter}${venueFilter}
        ORDER BY cv.created_at DESC LIMIT 10000
      `, params);
      header = "data,user_id,nick,rating,dzielnica,pionier_nr,venue_id,lokal,miasto,typ,kuchnia,rachunek,zniżka\n";
      csvRows = rows.rows.map(r => [fmtDate(r.created_at),r.user_id,esc_csv(r.username),r.rating||0,r.district||"",r.founder_number||"",r.venue_id,esc_csv(r.venue_name),r.city||"",r.venue_type||"",esc_csv(r.cuisine),r.amount||"",r.discount_saved||""].join(",")).join("\n");
      filename = `foxpot_wizyty_${dateFrom}_${dateTo}.csv`;
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

app.post("/admin/city-nominations/:id/status", requireAdminAuth, async (req, res) => {
  const cityId = Number(req.params.id);
  const status = String(req.body.status || "").trim();
  if (!CITY_NOM_STATUSES.includes(status)) return res.redirect(`/admin?err=${encodeURIComponent("Nieprawidłowy status")}`);
  await pool.query(`UPDATE fp1_city_nominations SET status=$1, updated_at=NOW() WHERE id=$2`, [status, cityId]);
  res.redirect(`/admin?ok=${encodeURIComponent(`Status miasta zmieniony na: ${CITY_NOM_LABELS[status]}`)}`);
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
      const f = await pool.query(`SELECT sub_instagram, sub_tiktok, sub_youtube, sub_telegram FROM fp1_foxes WHERE user_id=$1`, [userId]);
      if (f.rowCount > 0) {
        const r = f.rows[0];
        lines.push(`Instagram: ${r.sub_instagram?"✅":"❌"}`);
        lines.push(`TikTok: ${r.sub_tiktok?"✅":"❌"}`);
        lines.push(`YouTube: ${r.sub_youtube?"✅":"❌"}`);
        lines.push(`Telegram: ${r.sub_telegram?"✅":"❌"}`);
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

    const visits = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [userId]);
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

        const tot = await pool.query(`SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [userId]);
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
            `INSERT INTO fp1_foxes(user_id,username,rating,invites,city,is_demo,demo_venue_id,join_source)
             VALUES($1,$2,0,0,'Warszawa',TRUE,$3,'venue') ON CONFLICT(user_id) DO NOTHING`,
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
          `INSERT INTO fp1_foxes(user_id,username,rating,invites,city,is_demo,demo_venue_id,join_source)
           VALUES($1,$2,0,0,'Warszawa',TRUE,$3,'venue') ON CONFLICT(user_id) DO NOTHING`,
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

      // Delete achievements
      await pool.query(`DELETE FROM fp1_achievements WHERE user_id = $1`, [userId]);

      // Delete counted visits
      await pool.query(`DELETE FROM fp1_counted_visits WHERE user_id = $1`, [userId]);

      // Delete daily spins
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
      const active   = await pool.query(`SELECT COUNT(DISTINCT cv.user_id)::int AS c FROM fp1_counted_visits cv WHERE cv.user_id IN (SELECT user_id FROM fp1_foxes WHERE invited_by_user_id=$1)`, [userId]);
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
