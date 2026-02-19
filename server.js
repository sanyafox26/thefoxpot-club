"use strict";

/**
 * THE FOXPOT CLUB — Phase 1 MVP — server.js V14.0
 *
 * НОВИНКИ V14:
 *  ✅ Referral bonuses — +10 rating після першого check-in, +5 інвайтеру
 *  ✅ Streak — щоденний вхід, бонуси за 7/30/90/365 днів
 *  ✅ Зал Слави — 20 досягнень, автоматична перевірка
 *  ✅ /streak — команда для перегляду streak
 *  ✅ Повідомлення про нові досягнення після check-in
 *
 * V13 (залишається без змін):
 *  ✅ Район проживання (district) при реєстрації
 *  ✅ /settings — перегляд і зміна району
 *
 * V12 (залишається без змін):
 *  ✅ Founder Fox (#1–1000)
 *
 * V11 (залишається без змін):
 *  ✅ Referral system (Fox invite + Restaurant code)
 *  ✅ Restaurant code → +5 invites + +1 Y
 *  ✅ New Fox tracker в панелі
 *  ✅ Growth Leaderboard
 */

const express  = require("express");
const crypto   = require("crypto");
const { Telegraf, Markup } = require("telegraf");
const { Pool }             = require("pg");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ═══════════════════════════════════════════════════════════════
   ENV
═══════════════════════════════════════════════════════════════ */
const BOT_TOKEN      = (process.env.BOT_TOKEN      || "").trim();
const DATABASE_URL   = (process.env.DATABASE_URL   || "").trim();
const PUBLIC_URL     = (process.env.PUBLIC_URL     || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "wh").trim();
const COOKIE_SECRET  = (process.env.COOKIE_SECRET  || `${WEBHOOK_SECRET}_cookie`).trim();
const ADMIN_SECRET   = (process.env.ADMIN_SECRET   || "admin_foxpot_2025").trim();
const PORT           = process.env.PORT || 8080;

if (!DATABASE_URL) console.error("❌ DATABASE_URL missing");
if (!BOT_TOKEN)    console.error("❌ BOT_TOKEN missing");
if (!PUBLIC_URL)   console.error("❌ PUBLIC_URL missing");
if (!process.env.COOKIE_SECRET) console.warn("⚠️  COOKIE_SECRET not set!");
if (!process.env.ADMIN_SECRET)  console.warn("⚠️  ADMIN_SECRET not set — using default!");

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
   V13: РАЙОНИ ВАРШАВИ
═══════════════════════════════════════════════════════════════ */
const WARSAW_DISTRICTS = [
  "Śródmieście",
  "Praga-Południe",
  "Mokotów",
  "Żoliborz",
  "Wola",
  "Ursynów",
  "Praga-Północ",
  "Targówek",
  "Bielany",
  "Bemowo",
  "Białołęka",
  "Wilanów",
  "Інший район",
];

async function sendDistrictKeyboard(ctx, mode = "register") {
  const text = mode === "register"
    ? `📍 Останній крок!\n\nВ якому районі Варшави ти живеш?\n\n(Це допомагає нам знаходити заклади поруч з тобою)`
    : `📍 Вибери свій район:`;

  const buttons = [];
  const main = WARSAW_DISTRICTS.slice(0, -1);
  for (let i = 0; i < main.length; i += 2) {
    const row = [Markup.button.callback(main[i], `district_${main[i]}`)];
    if (main[i + 1]) row.push(Markup.button.callback(main[i + 1], `district_${main[i + 1]}`));
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("🗺️ Інший район", `district_Інший район`)]);
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

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'", "&#039;");
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
  // ── Venues ──────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venues (
      id           BIGSERIAL PRIMARY KEY,
      name         TEXT        NOT NULL DEFAULT 'Venue',
      city         TEXT        NOT NULL DEFAULT 'Warsaw',
      address      TEXT        NOT NULL DEFAULT '',
      pin_hash     TEXT,
      pin_salt     TEXT,
      status       TEXT        NOT NULL DEFAULT 'active',
      approved     BOOLEAN     NOT NULL DEFAULT FALSE,
      fox_nick     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Foxes ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_foxes (
      id                   BIGSERIAL PRIMARY KEY,
      user_id              BIGINT UNIQUE,
      username             TEXT,
      rating               INT         NOT NULL DEFAULT 1,
      invites              INT         NOT NULL DEFAULT 3,
      invites_from_5visits INT         NOT NULL DEFAULT 0,
      city                 TEXT        NOT NULL DEFAULT 'Warsaw',
      invited_by_user_id   BIGINT,
      invite_code_used     TEXT,
      invite_used_at       TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Check-ins ────────────────────────────────────────────────
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

  // ── Counted visits ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_counted_visits (
      id         BIGSERIAL PRIMARY KEY,
      venue_id   BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      user_id    BIGINT NOT NULL,
      war_day    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Invites ──────────────────────────────────────────────────
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

  // ── Venue statuses ───────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_venue_status (
      id           BIGSERIAL PRIMARY KEY,
      venue_id     BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
      type         TEXT        NOT NULL,
      reason       TEXT,
      starts_at    TIMESTAMPTZ NOT NULL,
      ends_at      TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── Emoji-stamps ─────────────────────────────────────────────
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

  // ── V14: Досягнення ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_achievements (
      id               BIGSERIAL PRIMARY KEY,
      user_id          BIGINT      NOT NULL,
      achievement_code TEXT        NOT NULL,
      unlocked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, achievement_code)
    )
  `);

  // ── V14: Daily Spin (підготовка для V15) ─────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp1_daily_spins (
      id             BIGSERIAL PRIMARY KEY,
      user_id        BIGINT    NOT NULL,
      spin_date      DATE      NOT NULL,
      prize_type     TEXT      NOT NULL,
      prize_value    INT       NOT NULL DEFAULT 0,
      prize_venue_id BIGINT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, spin_date)
    )
  `);

  // ── Ensure columns (backward compat) ────────────────────────
  await ensureColumn("fp1_checkins",        "war_day",               "TEXT");
  await ensureColumn("fp1_counted_visits",  "war_day",               "TEXT");
  await ensureColumn("fp1_foxes",           "invites_from_5visits",  "INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes",           "invited_by_user_id",    "BIGINT");
  await ensureColumn("fp1_foxes",           "invite_code_used",      "TEXT");
  await ensureColumn("fp1_foxes",           "invite_used_at",        "TIMESTAMPTZ");
  await ensureColumn("fp1_venues",          "address",               "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("fp1_venues",          "fox_nick",              "TEXT");
  await ensureColumn("fp1_venues",          "approved",              "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_venues",          "ref_code",              "TEXT UNIQUE");
  await ensureColumn("fp1_venues",          "staff_bonus_enabled",   "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("fp1_venues",          "staff_bonus_amount",    "INT NOT NULL DEFAULT 2");
  await ensureColumn("fp1_foxes",           "referred_by_venue",     "BIGINT");

  // ── V12: Founder Fox ─────────────────────────────────────────
  await ensureColumn("fp1_foxes", "founder_number",        "INT");
  await ensureColumn("fp1_foxes", "founder_registered_at", "TIMESTAMPTZ");

  // ── V13: Район ───────────────────────────────────────────────
  await ensureColumn("fp1_foxes", "district", "TEXT");

  // ── V14: Streak ──────────────────────────────────────────────
  await ensureColumn("fp1_foxes", "streak_current",         "INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes", "streak_last_date",       "DATE");
  await ensureColumn("fp1_foxes", "streak_freeze_available","INT NOT NULL DEFAULT 0");
  await ensureColumn("fp1_foxes", "streak_best",            "INT NOT NULL DEFAULT 0");

  // Індекси
  await ensureIndex(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fp1_foxes_founder_number
     ON fp1_foxes(founder_number) WHERE founder_number IS NOT NULL`
  );
  await ensureIndex(
    `CREATE INDEX IF NOT EXISTS idx_fp1_achievements_user
     ON fp1_achievements(user_id)`
  );
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_otp      ON fp1_checkins(otp)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_expires   ON fp1_checkins(expires_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_invites_code       ON fp1_invites(code)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_venue_status_vid   ON fp1_venue_status(venue_id, type, ends_at)`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS idx_fp1_stamps_venue_user  ON fp1_stamps(venue_id, user_id)`);

  // Generate ref_codes для існуючих venues
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

  // Backfill war_day
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

  // Backfill founder_number
  await pool.query(`
    WITH ranked AS (
      SELECT user_id,
             ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
      FROM fp1_foxes
      WHERE founder_number IS NULL
    )
    UPDATE fp1_foxes
    SET founder_number = ranked.rn,
        founder_registered_at = NOW()
    FROM ranked
    WHERE fp1_foxes.user_id = ranked.user_id
      AND ranked.rn <= 1000
  `);

  // Detect day column
  const hasDayKey = await hasColumn("fp1_counted_visits", "day_key");
  COUNTED_DAY_COL  = hasDayKey ? "day_key" : "war_day";
  console.log("✅ COUNTED_DAY_COL =", COUNTED_DAY_COL);

  // Seed test venues if empty
  const vc = await pool.query("SELECT COUNT(*)::int AS c FROM fp1_venues");
  if (vc.rows[0].c === 0) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = pinHash("123456", salt);
    await pool.query(
      `INSERT INTO fp1_venues(name, city, pin_hash, pin_salt, approved)
       VALUES
         ('Test Kebab #1','Warsaw',$1,$2,TRUE),
         ('Test Pizza #2','Warsaw',$1,$2,TRUE)`,
      [hash, salt]
    );
    console.log("✅ Seeded test venues (PIN: 123456)");
  }

  console.log("✅ Migrations OK (V14)");
}

/* ═══════════════════════════════════════════════════════════════
   V14: STREAK
═══════════════════════════════════════════════════════════════ */
async function updateStreak(userId) {
  const today = warsawDayKey();
  const fox = await pool.query(
    `SELECT streak_current, streak_last_date, streak_freeze_available, streak_best
     FROM fp1_foxes WHERE user_id=$1 LIMIT 1`,
    [String(userId)]
  );
  if (fox.rowCount === 0) return null;
  const f = fox.rows[0];

  const last = f.streak_last_date ? String(f.streak_last_date).slice(0, 10) : null;

  // Вже заходив сьогодні
  if (last === today) return null;

  const yesterday = warsawDayKey(new Date(Date.now() - 86400000));
  let newStreak   = f.streak_current || 0;
  let newFreeze   = f.streak_freeze_available || 0;
  let bonusRating = 0;
  let bonusFreeze = 0;

  if (last === yesterday) {
    newStreak += 1;
  } else if (last) {
    if (newFreeze > 0) {
      newStreak += 1;
      newFreeze -= 1;
    } else {
      newStreak = 1;
    }
  } else {
    newStreak = 1;
  }

  // Бонуси
  if (newStreak < 7)                                  bonusRating = 1;
  if (newStreak % 7 === 0 && newStreak % 30 !== 0)   bonusRating = 5;
  if (newStreak === 30)  { bonusRating = 15; bonusFreeze = 1; }
  if (newStreak === 90)  bonusRating = 50;
  if (newStreak === 365) bonusRating = 200;

  const newBest = Math.max(newStreak, f.streak_best || 0);

  await pool.query(
    `UPDATE fp1_foxes
     SET streak_current=$1, streak_last_date=$2,
         streak_freeze_available=$3, streak_best=$4,
         rating=rating+$5
     WHERE user_id=$6`,
    [newStreak, today, newFreeze + bonusFreeze, newBest, bonusRating, String(userId)]
  );

  return { newStreak, bonusRating, bonusFreeze };
}

/* ═══════════════════════════════════════════════════════════════
   V14: ЗАЛ СЛАВИ (ДОСЯГНЕННЯ)
═══════════════════════════════════════════════════════════════ */
const ACHIEVEMENTS = {
  // ДОСЛІДНИК
  explorer_1:   { label: "Перший крок",  emoji: "🐾", rating: 5,   check: (s) => s.venues >= 1   },
  explorer_10:  { label: "Турист",       emoji: "🗺️", rating: 10,  check: (s) => s.venues >= 10  },
  explorer_30:  { label: "Мандрівник",   emoji: "✈️", rating: 30,  check: (s) => s.venues >= 30  },
  explorer_100: { label: "Легенда",      emoji: "🌍", rating: 100, check: (s) => s.venues >= 100 },

  // СОЦІАЛЬНИЙ
  social_1:     { label: "Друг",         emoji: "🤝", rating: 5,   check: (s) => s.invites_sent >= 1   },
  social_10:    { label: "Рекрутер",     emoji: "📣", rating: 50,  check: (s) => s.invites_sent >= 10  },
  social_50:    { label: "Амбасадор",    emoji: "⭐", rating: 200, check: (s) => s.invites_sent >= 50  },
  social_100:   { label: "Легенда",      emoji: "👑", rating: 500, check: (s) => s.invites_sent >= 100 },

  // МАРАФОНЕЦЬ
  streak_7:     { label: "7 днів поспіль",  emoji: "🔥", rating: 10,  check: (s) => s.streak_best >= 7   },
  streak_30:    { label: "30 днів поспіль", emoji: "💪", rating: 50,  check: (s) => s.streak_best >= 30  },
  streak_90:    { label: "90 днів поспіль", emoji: "🏅", rating: 150, check: (s) => s.streak_best >= 90  },
  streak_365:   { label: "365 днів!",       emoji: "🏆", rating: 500, check: (s) => s.streak_best >= 365 },

  // ВІЗИТИ
  visits_1:     { label: "Перший візит",  emoji: "🎉", rating: 5,   check: (s) => s.total_visits >= 1   },
  visits_10:    { label: "10 візитів",    emoji: "🥈", rating: 10,  check: (s) => s.total_visits >= 10  },
  visits_50:    { label: "50 візитів",    emoji: "🥇", rating: 50,  check: (s) => s.total_visits >= 50  },
  visits_100:   { label: "100 візитів",   emoji: "💫", rating: 100, check: (s) => s.total_visits >= 100 },

  // СПЕЦІАЛЬНІ
  pioneer:      { label: "Піонер",        emoji: "🚀", rating: 20,  check: (s) => s.is_pioneer  },
  night_fox:    { label: "Нічний Fox",    emoji: "🌙", rating: 10,  check: (s) => s.is_night    },
  morning_fox:  { label: "Ранковий Fox",  emoji: "🌅", rating: 10,  check: (s) => s.is_morning  },
  vip_diamond:  { label: "VIP Diamond",   emoji: "💎", rating: 200, check: (s) => s.total_visits >= 301 },
};

async function checkAchievements(userId, extraStats = {}) {
  const uid = String(userId);

  const fox = await pool.query(
    `SELECT streak_best FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [uid]
  );
  if (fox.rowCount === 0) return [];

  const totalVisits = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [uid]
  );
  const uniqueVenues = await pool.query(
    `SELECT COUNT(DISTINCT venue_id)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [uid]
  );
  const invitesSent = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_invites WHERE created_by_user_id=$1`, [uid]
  );

  const stats = {
    total_visits: totalVisits.rows[0].c,
    venues:       uniqueVenues.rows[0].c,
    invites_sent: invitesSent.rows[0].c,
    streak_best:  fox.rows[0].streak_best || 0,
    is_pioneer:   extraStats.is_pioneer  || false,
    is_night:     extraStats.is_night    || false,
    is_morning:   extraStats.is_morning  || false,
  };

  const existing = await pool.query(
    `SELECT achievement_code FROM fp1_achievements WHERE user_id=$1`, [uid]
  );
  const have = new Set(existing.rows.map(r => r.achievement_code));

  const newOnes = [];
  let totalBonus = 0;

  for (const [code, ach] of Object.entries(ACHIEVEMENTS)) {
    if (have.has(code)) continue;
    if (!ach.check(stats)) continue;
    try {
      await pool.query(
        `INSERT INTO fp1_achievements(user_id, achievement_code)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [uid, code]
      );
      totalBonus += ach.rating;
      newOnes.push({ code, ...ach });
    } catch (e) {
      console.error("ACH_INSERT_ERR", e?.message);
    }
  }

  if (totalBonus > 0) {
    await pool.query(
      `UPDATE fp1_foxes SET rating=rating+$1 WHERE user_id=$2`,
      [totalBonus, uid]
    );
  }

  return newOnes;
}

function formatAchievements(newOnes) {
  if (!newOnes || newOnes.length === 0) return "";
  const lines = newOnes.map(a => `${a.emoji} ${a.label} +${a.rating} rating`);
  return `\n\n🏆 Нові досягнення!\n${lines.join("\n")}`;
}

/* ═══════════════════════════════════════════════════════════════
   V12: FOUNDER FOX
═══════════════════════════════════════════════════════════════ */
const FOUNDER_LIMIT = 1000;

async function assignFounderNumber(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const check = await client.query(
      `SELECT founder_number FROM fp1_foxes WHERE user_id=$1 LIMIT 1`,
      [String(userId)]
    );
    if (check.rows[0]?.founder_number) {
      await client.query("ROLLBACK");
      return check.rows[0].founder_number;
    }
    const nextNum = await client.query(`
      SELECT n AS num
      FROM generate_series(1, $1) AS n
      WHERE n NOT IN (
        SELECT founder_number FROM fp1_foxes WHERE founder_number IS NOT NULL
      )
      ORDER BY n ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    `, [FOUNDER_LIMIT]);
    if (nextNum.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const num = nextNum.rows[0].num;
    await client.query(
      `UPDATE fp1_foxes SET founder_number=$1, founder_registered_at=NOW() WHERE user_id=$2`,
      [num, String(userId)]
    );
    await client.query("COMMIT");
    return num;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("FOUNDER_ERR", e?.message || e);
    return null;
  } finally {
    client.release();
  }
}

function founderBadge(num) {
  if (!num) return "";
  return `👑 FOUNDER FOX #${num}`;
}

async function founderSpotsLeft() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE founder_number IS NOT NULL`
  );
  return Math.max(0, FOUNDER_LIMIT - r.rows[0].c);
}

/* ═══════════════════════════════════════════════════════════════
   SESSION — HMAC-signed cookie
═══════════════════════════════════════════════════════════════ */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME    = "fp1_panel_session";

function signSession(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig      = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("base64url");
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
    const sb = Buffer.from(sig);
    const eb = Buffer.from(expSig);
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
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requirePanelAuth(req, res, next) {
  const sess = verifySession(getCookie(req));
  if (!sess) return res.redirect("/panel");
  req.panel = sess;
  next();
}

function requireAdminAuth(req, res, next) {
  const sess = verifySession(getCookie(req));
  if (!sess || sess.role !== "admin") return res.redirect("/admin/login");
  req.admin = sess;
  next();
}

/* ═══════════════════════════════════════════════════════════════
   RATE LIMIT
═══════════════════════════════════════════════════════════════ */
const loginFail = new Map();

function getIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
}

function loginRate(ip) {
  const x = loginFail.get(ip) || { fails: 0, until: 0 };
  if (x.until && Date.now() < x.until) return { blocked: true };
  return { blocked: false };
}
function loginBad(ip) {
  const x = loginFail.get(ip) || { fails: 0, until: 0 };
  x.fails += 1;
  if (x.fails >= 10) { x.until = Date.now() + 15 * 60 * 1000; x.fails = 0; }
  loginFail.set(ip, x);
}
function loginOk(ip) { loginFail.delete(ip); }

/* ═══════════════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════════════ */
function pageShell(title, body, extraCss = "") {
  return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui;background:#0f1220;color:#fff}
.wrap{max-width:960px;margin:0 auto;padding:16px}
.card{background:#14182b;border:1px solid #2a2f49;border-radius:14px;padding:16px;margin:12px 0}
h1{font-size:18px;margin:0 0 10px}
h2{font-size:15px;margin:0 0 8px;opacity:.85}
label{display:block;font-size:12px;opacity:.8;margin:10px 0 5px}
input,select,textarea{width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0b0e19;color:#fff;font-size:14px}
input:focus,select:focus,textarea:focus{outline:none;border-color:#6e56ff}
button{padding:10px 16px;border-radius:10px;border:none;background:#6e56ff;color:#fff;font-weight:700;cursor:pointer;font-size:14px}
button:hover{background:#5a44e0}
button.danger{background:#8b1a1a}
button.outline{background:transparent;border:1px solid #2a2f49;color:#ccc}
.muted{opacity:.6;font-size:12px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
a{color:#c6baff;text-decoration:none}
a:hover{text-decoration:underline}
.err{background:#2a0f16;border:1px solid #6b1a2b;border-radius:12px;padding:10px;margin:10px 0;font-size:14px}
.ok{background:#102a1a;border:1px solid #1f6b3a;border-radius:12px;padding:10px;margin:10px 0;font-size:14px}
.warn{background:#2a200a;border:1px solid #6b4a0a;border-radius:12px;padding:10px;margin:10px 0;font-size:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}
.badge-ok{background:#1a4a2a;color:#6fffaa}
.badge-warn{background:#3a2a0a;color:#ffcc44}
.badge-err{background:#3a0a0a;color:#ff7777}
@media(max-width:600px){.grid2{grid-template-columns:1fr}}
${extraCss}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function flash(req) {
  const ok   = req.query.ok   ? `<div class="ok">${escapeHtml(req.query.ok)}</div>`     : "";
  const err  = req.query.err  ? `<div class="err">${escapeHtml(req.query.err)}</div>`   : "";
  const warn = req.query.warn ? `<div class="warn">${escapeHtml(req.query.warn)}</div>` : "";
  return ok + err + warn;
}

/* ═══════════════════════════════════════════════════════════════
   CORE DB FUNCTIONS
═══════════════════════════════════════════════════════════════ */
async function getVenue(venueId) {
  const r = await pool.query(`SELECT * FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
  return r.rows[0] || null;
}

async function upsertFox(ctx) {
  const tgId    = String(ctx.from.id);
  const username = ctx.from.username || null;
  await pool.query(
    `INSERT INTO fp1_foxes(user_id, username, rating, invites, city)
     VALUES ($1,$2,1,3,'Warsaw')
     ON CONFLICT (user_id) DO UPDATE SET username=COALESCE(EXCLUDED.username, fp1_foxes.username)`,
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
  const x = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND user_id=$2`,
    [venueId, String(userId)]
  );
  const y = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]
  );
  return { X: x.rows[0].c, Y: y.rows[0].c };
}

async function createCheckin(venueId, userId) {
  const otp     = otp6();
  const now     = new Date();
  const warDay  = warsawDayKey(now);
  const expires = new Date(now.getTime() + 10 * 60 * 1000);
  const r = await pool.query(
    `INSERT INTO fp1_checkins(venue_id, user_id, otp, expires_at, war_day)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [venueId, String(userId), otp, expires.toISOString(), warDay]
  );
  return r.rows[0];
}

async function listPending(venueId) {
  const now = await dbNow();
  const r = await pool.query(
    `SELECT otp, expires_at FROM fp1_checkins
     WHERE venue_id=$1 AND confirmed_at IS NULL AND expires_at > $2
     ORDER BY created_at DESC LIMIT 20`,
    [venueId, now]
  );
  return r.rows;
}

async function awardInvitesFrom5Visits(userId) {
  const tot = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [String(userId)]
  );
  const fox = await pool.query(
    `SELECT invites_from_5visits AS earned FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [String(userId)]
  );
  const total      = tot.rows[0].c;
  const earned     = fox.rows[0]?.earned || 0;
  const shouldEarn = Math.floor(total / 5);
  if (shouldEarn > earned) {
    const delta = shouldEarn - earned;
    await pool.query(
      `UPDATE fp1_foxes SET invites=invites+$1, invites_from_5visits=$2 WHERE user_id=$3`,
      [delta, shouldEarn, String(userId)]
    );
    return delta;
  }
  return 0;
}

async function confirmOtp(venueId, otp) {
  const now     = await dbNow();
  const pending = await pool.query(
    `SELECT * FROM fp1_checkins
     WHERE venue_id=$1 AND otp=$2 AND confirmed_at IS NULL AND expires_at > $3
     ORDER BY created_at DESC LIMIT 1`,
    [venueId, String(otp), now]
  );
  if (pending.rowCount === 0) return { ok: false, code: "NOT_FOUND" };

  const row    = pending.rows[0];
  const userId = String(row.user_id);
  const day    = row.war_day || warsawDayKey();

  // Debounce 15 хв
  const debounce = await pool.query(
    `SELECT 1 FROM fp1_checkins
     WHERE user_id=$1 AND venue_id=$2
       AND confirmed_at IS NOT NULL
       AND confirmed_at > NOW() - INTERVAL '15 minutes'
     LIMIT 1`,
    [userId, venueId]
  );
  if (debounce.rowCount > 0) {
    await pool.query(`UPDATE fp1_checkins SET confirmed_at=NOW() WHERE id=$1`, [row.id]);
    return { ok: true, userId, day, countedAdded: false, debounce: true,
             inviteAutoAdded: 0, isFirstEver: false, newAch: [] };
  }

  const already = await hasCountedToday(venueId, userId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE fp1_checkins SET confirmed_at=NOW(), confirmed_by_venue_id=$1 WHERE id=$2`,
      [venueId, row.id]
    );

    let countedAdded    = false;
    let inviteAutoAdded = 0;
    let isFirstEver     = false;
    let newAch          = [];

    if (!already) {
      const hasDK = COUNTED_DAY_COL === "day_key";
      const hasWD = await hasColumn("fp1_counted_visits", "war_day");
      const cols  = ["venue_id", "user_id"];
      const vals  = [venueId, userId];
      if (hasDK) { cols.push("day_key"); vals.push(day); }
      if (hasWD) { cols.push("war_day"); vals.push(day); }
      const ph = cols.map((_, i) => `$${i + 1}`).join(",");
      await client.query(
        `INSERT INTO fp1_counted_visits(${cols.join(",")}) VALUES (${ph})`, vals
      );
      await client.query(
        `UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`, [userId]
      );
      countedAdded = true;
    }
    await client.query("COMMIT");

    if (countedAdded) {
      inviteAutoAdded = await awardInvitesFrom5Visits(userId);

      // Перший візит взагалі → +10 новому Fox + +5 інвайтеру
      const totalVisits = await pool.query(
        `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [userId]
      );
      isFirstEver = totalVisits.rows[0].c === 1;

      if (isFirstEver) {
        await pool.query(
          `UPDATE fp1_foxes SET rating=rating+10 WHERE user_id=$1`, [userId]
        );
        const inviter = await pool.query(
          `SELECT invited_by_user_id FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]
        );
        if (inviter.rows[0]?.invited_by_user_id) {
          await pool.query(
            `UPDATE fp1_foxes SET rating=rating+5 WHERE user_id=$1`,
            [String(inviter.rows[0].invited_by_user_id)]
          );
          // Повідомлення інвайтеру
          if (bot) {
            try {
              await bot.telegram.sendMessage(
                Number(inviter.rows[0].invited_by_user_id),
                `🎉 Твій друг зробив перший check-in!\n+5 rating тобі за запрошення!`
              );
            } catch (e) { console.error("INVITER_NOTIFY_ERR", e?.message); }
          }
        }
      }

      // Перевіряємо чи Fox перший в цьому закладі (pioneer)
      const venueVisitCount = await pool.query(
        `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]
      );
      const isPioneer = venueVisitCount.rows[0].c === 1;

      // Streak + досягнення
      await updateStreak(userId);
      const hour = warsawHour();
      newAch = await checkAchievements(userId, {
        is_pioneer: isPioneer,
        is_night:   hour >= 23,
        is_morning: hour < 8,
      });
    }

    return { ok: true, userId, day, countedAdded, debounce: false,
             inviteAutoAdded, isFirstEver, newAch };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/* ═══════════════════════════════════════════════════════════════
   VENUE STATUS HELPERS
═══════════════════════════════════════════════════════════════ */
async function reserveCountThisMonth(venueId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_venue_status
     WHERE venue_id=$1 AND type='reserve'
       AND date_trunc('month', starts_at AT TIME ZONE 'Europe/Warsaw')
           = date_trunc('month', NOW() AT TIME ZONE 'Europe/Warsaw')
       AND ends_at > NOW()`,
    [venueId]
  );
  return r.rows[0].c;
}

async function limitedCountThisWeek(venueId) {
  const { mon, sun } = warsawWeekBounds();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_venue_status
     WHERE venue_id=$1 AND type='limited'
       AND (starts_at AT TIME ZONE 'Europe/Warsaw')::date BETWEEN $2::date AND $3::date`,
    [venueId, mon, sun]
  );
  return r.rows[0].c;
}

async function currentVenueStatus(venueId) {
  const r = await pool.query(
    `SELECT * FROM fp1_venue_status
     WHERE venue_id=$1 AND starts_at <= NOW() AND ends_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [venueId]
  );
  return r.rows[0] || null;
}

/* ═══════════════════════════════════════════════════════════════
   STAMPS HELPERS
═══════════════════════════════════════════════════════════════ */
async function stampBalance(venueId, userId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(delta),0)::int AS balance FROM fp1_stamps
     WHERE venue_id=$1 AND user_id=$2`,
    [venueId, String(userId)]
  );
  return r.rows[0].balance;
}

async function stampHistory(venueId, userId, limit = 10) {
  const r = await pool.query(
    `SELECT emoji, delta, note, created_at FROM fp1_stamps
     WHERE venue_id=$1 AND user_id=$2
     ORDER BY created_at DESC LIMIT $3`,
    [venueId, String(userId), limit]
  );
  return r.rows;
}

/* ═══════════════════════════════════════════════════════════════
   INVITE HELPERS
═══════════════════════════════════════════════════════════════ */
async function redeemInviteCode(userId, codeRaw) {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!code) return { ok: false, reason: "NO_CODE" };
  const inv = await pool.query(`SELECT * FROM fp1_invites WHERE code=$1 LIMIT 1`, [code]);
  if (inv.rowCount === 0) return { ok: false, reason: "NOT_FOUND" };
  const invite = inv.rows[0];
  const used = await pool.query(
    `SELECT 1 FROM fp1_invite_uses WHERE invite_id=$1 AND used_by_user_id=$2 LIMIT 1`,
    [invite.id, String(userId)]
  );
  if (used.rowCount > 0) return { ok: false, reason: "ALREADY_USED" };
  if (Number(invite.uses) >= Number(invite.max_uses)) return { ok: false, reason: "EXHAUSTED" };

  await pool.query(`INSERT INTO fp1_invite_uses(invite_id, used_by_user_id) VALUES ($1,$2)`,
    [invite.id, String(userId)]);
  await pool.query(`UPDATE fp1_invites SET uses=uses+1 WHERE id=$1`, [invite.id]);
  await pool.query(
    `UPDATE fp1_foxes
     SET invited_by_user_id=COALESCE(invited_by_user_id,$1),
         invite_code_used=COALESCE(invite_code_used,$2),
         invite_used_at=COALESCE(invite_used_at,NOW())
     WHERE user_id=$3`,
    [invite.created_by_user_id ? String(invite.created_by_user_id) : null, code, String(userId)]
  );
  if (invite.created_by_user_id) {
    await pool.query(`UPDATE fp1_foxes SET rating=rating+1 WHERE user_id=$1`,
      [String(invite.created_by_user_id)]);
  }
  return { ok: true };
}

async function createInviteCode(tgUserId) {
  const userId = String(tgUserId);
  const fox    = await pool.query(`SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]);
  if (fox.rowCount === 0) return { ok: false, reason: "NO_FOX" };
  if (Number(fox.rows[0].invites) <= 0) return { ok: false, reason: "NO_INVITES" };

  let code = null;
  for (let i = 0; i < 20; i++) {
    const c  = genInviteCode(10);
    const ex = await pool.query(`SELECT 1 FROM fp1_invites WHERE code=$1 LIMIT 1`, [c]);
    if (ex.rowCount === 0) { code = c; break; }
  }
  if (!code) return { ok: false, reason: "CODE_GEN_FAIL" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dec = await client.query(
      `UPDATE fp1_foxes SET invites=invites-1 WHERE user_id=$1 AND invites>0 RETURNING invites`,
      [userId]
    );
    if (dec.rowCount === 0) { await client.query("ROLLBACK"); return { ok: false, reason: "NO_INVITES" }; }
    await client.query(
      `INSERT INTO fp1_invites(code, max_uses, uses, created_by_user_id) VALUES ($1,1,0,$2)`,
      [code, Number(userId)]
    );
    await client.query("COMMIT");
    return { ok: true, code, invites_left: dec.rows[0].invites };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/* ═══════════════════════════════════════════════════════════════
   NEW FOX TRACKING
═══════════════════════════════════════════════════════════════ */
async function countNewFoxThisMonth(venueId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_foxes
     WHERE referred_by_venue=$1
       AND date_trunc('month', created_at AT TIME ZONE 'Europe/Warsaw')
           = date_trunc('month', NOW() AT TIME ZONE 'Europe/Warsaw')`,
    [venueId]
  );
  return r.rows[0].c;
}

async function countNewFoxTotal(venueId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_foxes WHERE referred_by_venue=$1`, [venueId]
  );
  return r.rows[0].c;
}

async function getGrowthLeaderboard(limit = 10) {
  const r = await pool.query(
    `SELECT v.id, v.name, v.city, COUNT(f.id)::int AS new_fox
     FROM fp1_venues v
     LEFT JOIN fp1_foxes f ON f.referred_by_venue=v.id
       AND date_trunc('month', f.created_at AT TIME ZONE 'Europe/Warsaw')
           = date_trunc('month', NOW() AT TIME ZONE 'Europe/Warsaw')
     WHERE v.approved=TRUE
     GROUP BY v.id, v.name, v.city
     ORDER BY new_fox DESC, v.name ASC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/* ═══════════════════════════════════════════════════════════════
   ROUTES — HEALTH
═══════════════════════════════════════════════════════════════ */
app.get("/",        (_req, res) => res.send("OK"));
app.get("/version", (_req, res) => res.type("text/plain").send("FP_SERVER_V14_0_OK"));

app.get("/health", async (_req, res) => {
  try {
    const now   = await dbNow();
    const spots = await founderSpotsLeft();
    res.json({ ok: true, db: true, tz: "Europe/Warsaw",
               day_warsaw: warsawDayKey(), now, founder_spots_left: spots });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
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
      <h1>🦊 Panel lokalu</h1>
      ${msg}
      <form method="POST" action="/panel/login">
        <label>Venue ID</label>
        <input name="venue_id" type="number" min="1" required placeholder="np. 1" autocomplete="off"/>
        <label>PIN (6 cyfr)</label>
        <input name="pin" type="password" maxlength="6" required placeholder="••••••"/>
        <button type="submit" style="width:100%;margin-top:12px">Zaloguj →</button>
      </form>
    </div>`));
});

app.post("/panel/login", async (req, res) => {
  const ip = getIp(req);
  if (loginRate(ip).blocked)
    return res.redirect(`/panel?msg=${encodeURIComponent("Za dużo prób. Spróbuj za 15 minut.")}`);
  const venueId = String(req.body.venue_id || "").trim();
  const pin     = String(req.body.pin || "").trim();
  if (!venueId || !pin) { loginBad(ip); return res.redirect(`/panel?msg=${encodeURIComponent("Brak danych.")}`); }
  const v = await pool.query(`SELECT * FROM fp1_venues WHERE id=$1 LIMIT 1`, [venueId]);
  if (v.rowCount === 0 || !v.rows[0].pin_salt) {
    loginBad(ip);
    return res.redirect(`/panel?msg=${encodeURIComponent("Nie znaleziono lokalu.")}`);
  }
  const venue = v.rows[0];
  if (pinHash(pin, venue.pin_salt) !== venue.pin_hash) {
    loginBad(ip);
    return res.redirect(`/panel?msg=${encodeURIComponent("Błędny PIN.")}`);
  }
  loginOk(ip);
  setCookie(res, signSession({ venue_id: String(venue.id), exp: Date.now() + SESSION_TTL_MS }));
  res.redirect("/panel/dashboard");
});

app.get("/panel/logout", (req, res) => { clearCookie(res); res.redirect("/panel"); });

app.get("/panel/dashboard", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const venue   = await getVenue(venueId);
  const pending = await listPending(venueId);
  const status  = await currentVenueStatus(venueId);
  const newFoxMonth = await countNewFoxThisMonth(venueId);
  const newFoxTotal = await countNewFoxTotal(venueId);
  const growth  = await getGrowthLeaderboard(50);
  const myPos   = growth.findIndex(g => Number(g.id) === Number(venueId)) + 1;

  let statusHtml = `<span class="badge badge-ok">● Aktywny</span>`;
  if (status) {
    const till = new Date(status.ends_at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" });
    statusHtml = status.type === "reserve"
      ? `<span class="badge badge-err">📍 Rezerwa do ${till}</span>`
      : `<span class="badge badge-warn">⚠️ Ograniczone (${escapeHtml(status.reason)}) do ${till}</span>`;
  }

  const pendingHtml = pending.length === 0
    ? `<div class="muted">Brak aktywnych check-inów</div>`
    : pending.map(p => {
        const min = Math.max(0, Math.ceil((new Date(p.expires_at) - Date.now()) / 60000));
        return `<div style="margin:6px 0">OTP: <b style="font-size:20px;letter-spacing:4px">${escapeHtml(p.otp)}</b>
                <span class="muted"> · za ~${min} min</span></div>`;
      }).join("");

  const xy = await pool.query(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`, [venueId]
  );

  res.send(pageShell(`Panel — ${venue?.name || venueId}`, `
    <div class="card">
      <div class="topbar">
        <h1>🦊 ${escapeHtml(venue?.name || venueId)} ${statusHtml}</h1>
        <a href="/panel/logout">Wyloguj</a>
      </div>
      ${flash(req)}
      <div style="margin-top:10px;opacity:.7;font-size:13px">
        Код закладу: <b>${escapeHtml(venue.ref_code || 'brak')}</b> | Total visits: <b>${xy.rows[0].c}</b>
      </div>
    </div>

    <div class="card">
      <h2>📊 Nowi Fox przez twój kod</h2>
      <div style="font-size:24px;font-weight:700;margin:10px 0">Цього місяця: ${newFoxMonth} Fox</div>
      <div class="muted">Всього приведено: ${newFoxTotal} Fox</div>
      ${myPos > 0 ? `<div class="muted" style="margin-top:8px">Ти на ${myPos} місці в Growth топі! 🏆</div>` : ""}
    </div>

    <div class="grid2">
      <div class="card">
        <h2>Potwierdź OTP</h2>
        <form method="POST" action="/panel/confirm">
          <input name="otp" placeholder="000000" maxlength="6" inputmode="numeric"
                 pattern="[0-9]{6}" required autocomplete="off" autofocus
                 style="font-size:28px;letter-spacing:10px;text-align:center"/>
          <button type="submit" style="width:100%;margin-top:10px">Confirm ✓</button>
        </form>
      </div>
      <div class="card">
        <h2>Pending check-iny</h2>
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
          <b>📍 Rezerwa</b> <span class="muted">(maks. 2×/mies., min. 24h wcześniej)</span>
          <form method="POST" action="/panel/reserve" style="margin-top:8px">
            <label>Початок</label>
            <input type="datetime-local" name="starts_at" required/>
            <label>Тривалість</label>
            <select name="hours">
              <option value="1">1 год.</option><option value="2">2 год.</option>
              <option value="4">4 год.</option><option value="8">8 год.</option>
              <option value="24" selected>24 год.</option>
            </select>
            <button type="submit" style="margin-top:10px;width:100%">Встановити резерв</button>
          </form>
        </div>
        <div>
          <b>⚠️ Dziś ograniczone</b> <span class="muted">(maks. 2×/tydz., do 3h)</span>
          <form method="POST" action="/panel/limited" style="margin-top:8px">
            <label>Причина</label>
            <select name="reason">
              <option>FULL</option><option>PRIVATE EVENT</option><option>KITCHEN LIMIT</option>
            </select>
            <label>Тривалість</label>
            <select name="hours">
              <option value="1">1 год.</option><option value="2">2 год.</option>
              <option value="3" selected>3 год.</option>
            </select>
            <button type="submit" style="margin-top:10px;width:100%">Встановити статус</button>
          </form>
          ${status ? `<form method="POST" action="/panel/status/cancel" style="margin-top:8px">
            <button type="submit" class="danger" style="width:100%">Скасувати статус</button>
          </form>` : ""}
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Emoji-stamps</h2>
      <form method="POST" action="/panel/stamps">
        <div class="grid2">
          <div>
            <label>Telegram ID гостя</label>
            <input name="user_id" type="number" required placeholder="np. 123456789"/>
          </div>
          <div>
            <label>Emoji</label>
            <select name="emoji">
              <option>⭐</option><option>🦊</option><option>🔥</option><option>🎁</option><option>💎</option><option>🏆</option><option>👑</option><option>❤️</option>
              <option>🍕</option><option>🍔</option><option>🌭</option><option>🍟</option><option>🍣</option><option>🍱</option><option>🍜</option><option>🍝</option>
              <option>🥩</option><option>🍗</option><option>🥗</option><option>🥪</option><option>🌮</option><option>🌯</option><option>🥐</option><option>🍰</option>
              <option>🎂</option><option>🧁</option><option>🍩</option><option>🍪</option><option>🍦</option><option>🍫</option>
              <option>🍺</option><option>🍻</option><option>🍷</option><option>🍸</option><option>☕</option><option>🧋</option><option>🥤</option><option>🍹</option>
            </select>
          </div>
          <div>
            <label>Дія</label>
            <select name="delta">
              <option value="1">+1 (додати)</option>
              <option value="-1">-1 (використати)</option>
            </select>
          </div>
          <div>
            <label>Нотатка (опціонально)</label>
            <input name="note" placeholder="напр. безкоштовний десерт"/>
          </div>
        </div>
        <button type="submit" style="margin-top:10px">Застосувати штамп</button>
      </form>
    </div>`
  ));
});

app.post("/panel/confirm", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const otp     = String(req.body.otp || "").trim();
  if (!/^\d{6}$/.test(otp))
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("OTP musi mieć 6 cyfr.")}`);
  try {
    const r = await confirmOtp(venueId, otp);
    if (!r.ok)
      return res.redirect(`/panel/dashboard?err=${encodeURIComponent("OTP nie znaleziono lub wygasł.")}`);
    const venue = await getVenue(venueId);
    const xy    = await countXY(venueId, r.userId);
    if (bot) {
      try {
        let msg;
        if (r.debounce) {
          msg = `⚠️ Wizyta już potwierdzona w ciągu 15 min\n🏪 ${venue.name}\n📊 X/Y: ${xy.X}/${xy.Y}`;
        } else if (!r.countedAdded) {
          msg = `DZIŚ JUŻ BYŁO ✅\n🏪 ${venue.name}\n📅 ${r.day}\n📊 X/Y: ${xy.X}/${xy.Y}`;
        } else {
          msg = `✅ Confirm OK\n🏪 ${venue.name}\n📅 ${r.day}\n📊 X/Y: ${xy.X}/${xy.Y}`;
          if (r.isFirstEver) msg += `\n🎉 Перший візит! +10 rating`;
          if (r.inviteAutoAdded > 0) msg += `\n🎁 +${r.inviteAutoAdded} invite за 5 візитів!`;
          msg += formatAchievements(r.newAch);
        }
        await bot.telegram.sendMessage(Number(r.userId), msg);
      } catch (e) { console.error("TG_SEND_ERR", e?.message); }
    }
    const label = r.debounce ? "Debounce ⚠️ (15 хв)"
      : r.countedAdded ? `Confirm OK ✅  X/Y ${xy.X}/${xy.Y}`
      : `DZIŚ JUŻ BYŁO ✅  X/Y ${xy.X}/${xy.Y}`;
    res.redirect(`/panel/dashboard?ok=${encodeURIComponent(label)}`);
  } catch (e) {
    console.error("CONFIRM_ERR", e);
    res.redirect(`/panel/dashboard?err=${encodeURIComponent("Błąd: " + String(e?.message || e).slice(0, 120))}`);
  }
});

app.post("/panel/reserve", requirePanelAuth, async (req, res) => {
  const venueId   = String(req.panel.venue_id);
  const startsRaw = String(req.body.starts_at || "").trim();
  const hours     = Math.min(24, Math.max(1, Number(req.body.hours) || 24));
  if (!startsRaw) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Введіть дату і час.")}`);
  const startsAt = new Date(startsRaw);
  if (isNaN(startsAt.getTime())) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Невірна дата.")}`);
  if (startsAt.getTime() - Date.now() < 24 * 3600 * 1000)
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Мінімум за 24 год.")}`);
  const cnt = await reserveCountThisMonth(venueId);
  if (cnt >= 2) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Максимум 2 резерви на місяць.")}`);
  const endsAt = new Date(startsAt.getTime() + hours * 3600 * 1000);
  await pool.query(
    `INSERT INTO fp1_venue_status(venue_id, type, starts_at, ends_at) VALUES ($1,'reserve',$2,$3)`,
    [venueId, startsAt.toISOString(), endsAt.toISOString()]
  );
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Резерв встановлено (${hours} год.)`)}`);
});

app.post("/panel/limited", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const reason  = ["FULL","PRIVATE EVENT","KITCHEN LIMIT"].includes(req.body.reason) ? req.body.reason : "FULL";
  const hours   = Math.min(3, Math.max(1, Number(req.body.hours) || 3));
  const cnt = await limitedCountThisWeek(venueId);
  if (cnt >= 2) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Максимум 2× на тиждень.")}`);
  const now    = new Date();
  const endsAt = new Date(now.getTime() + hours * 3600 * 1000);
  await pool.query(
    `INSERT INTO fp1_venue_status(venue_id, type, reason, starts_at, ends_at) VALUES ($1,'limited',$2,$3,$4)`,
    [venueId, reason, now.toISOString(), endsAt.toISOString()]
  );
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Статус "${reason}" на ${hours} год.`)}`);
});

app.post("/panel/status/cancel", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  await pool.query(
    `UPDATE fp1_venue_status SET ends_at=NOW()
     WHERE venue_id=$1 AND starts_at <= NOW() AND ends_at > NOW()`,
    [venueId]
  );
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent("Статус скасовано.")}`);
});

app.post("/panel/stamps", requirePanelAuth, async (req, res) => {
  const venueId = String(req.panel.venue_id);
  const userId  = String(req.body.user_id || "").trim();
  const emoji   = ["⭐","🦊","🔥","🎁","💎","🏆","👑","❤️","🍕","🍔","🌭","🍟","🍣","🍱","🍜","🍝","🥩","🍗","🥗","🥪","🌮","🌯","🥐","🍰","🎂","🧁","🍩","🍪","🍦","🍫","🍺","🍻","🍷","🍸","☕","🧋","🥤","🍹"].includes(req.body.emoji) ? req.body.emoji : "⭐";
  const delta   = Number(req.body.delta) === -1 ? -1 : 1;
  const note    = String(req.body.note || "").trim().slice(0, 100);
  if (!userId || isNaN(Number(userId)))
    return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Невірний Telegram ID.")}`);
  if (delta === -1) {
    const bal = await stampBalance(venueId, userId);
    if (bal <= 0) return res.redirect(`/panel/dashboard?err=${encodeURIComponent("Немає штампів.")}`);
  }
  await pool.query(
    `INSERT INTO fp1_stamps(venue_id, user_id, emoji, delta, note) VALUES ($1,$2,$3,$4,$5)`,
    [venueId, userId, emoji, delta, note || null]
  );
  const newBal = await stampBalance(venueId, userId);
  if (bot) {
    try {
      const venue  = await getVenue(venueId);
      const action = delta > 0 ? `+${delta} ${emoji}` : `${delta} ${emoji} (використано)`;
      await bot.telegram.sendMessage(Number(userId),
        `${emoji} Штамп у ${venue?.name || venueId}\n${action}\nБаланс: ${newBal}${note ? `\nНотатка: ${note}` : ""}`
      );
    } catch (e) { console.error("STAMP_TG_ERR", e?.message); }
  }
  res.redirect(`/panel/dashboard?ok=${encodeURIComponent(`Штамп ${delta > 0 ? "додано" : "використано"} ✅ (баланс: ${newBal})`)}`);
});

/* ═══════════════════════════════════════════════════════════════
   ROUTES — ADMIN
═══════════════════════════════════════════════════════════════ */
app.get("/admin/login", (req, res) => {
  const msg = req.query.msg ? `<div class="err">${escapeHtml(req.query.msg)}</div>` : "";
  res.send(pageShell("Admin", `
    <div class="card" style="max-width:360px;margin:60px auto">
      <h1>🛡️ Admin Panel</h1>${msg}
      <form method="POST" action="/admin/login">
        <label>Admin Secret</label>
        <input name="secret" type="password" required placeholder="••••••••"/>
        <button type="submit" style="width:100%;margin-top:12px">Увійти →</button>
      </form>
    </div>`));
});

app.post("/admin/login", (req, res) => {
  const secret = String(req.body.secret || "").trim();
  if (secret !== ADMIN_SECRET) { loginBad(getIp(req)); return res.redirect(`/admin/login?msg=${encodeURIComponent("Невірний secret.")}`); }
  loginOk(getIp(req));
  setCookie(res, signSession({ role: "admin", venue_id: "0", exp: Date.now() + SESSION_TTL_MS }));
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => { clearCookie(res); res.redirect("/admin/login"); });

app.get("/admin", requireAdminAuth, async (req, res) => {
  const pending = await pool.query(`SELECT * FROM fp1_venues WHERE approved=FALSE ORDER BY created_at ASC`);
  const venues  = await pool.query(
    `SELECT v.*, COUNT(cv.id)::int AS visits
     FROM fp1_venues v LEFT JOIN fp1_counted_visits cv ON cv.venue_id=v.id
     WHERE v.approved=TRUE GROUP BY v.id ORDER BY visits DESC LIMIT 50`
  );
  const foxes = await pool.query(
    `SELECT user_id, username, rating, invites, city, district,
            founder_number, streak_current, streak_best, created_at
     FROM fp1_foxes ORDER BY rating DESC LIMIT 50`
  );
  const growth = await getGrowthLeaderboard(10);
  const spotsLeft = await founderSpotsLeft();

  const districtStats = await pool.query(
    `SELECT district, COUNT(*)::int AS cnt FROM fp1_foxes
     WHERE district IS NOT NULL GROUP BY district ORDER BY cnt DESC`
  );

  const achStats = await pool.query(
    `SELECT achievement_code, COUNT(*)::int AS cnt FROM fp1_achievements
     GROUP BY achievement_code ORDER BY cnt DESC LIMIT 10`
  );

  const pendingHtml = pending.rows.length === 0
    ? `<div class="muted">Немає заявок</div>`
    : pending.rows.map(v => `
      <div style="padding:10px 0;border-bottom:1px solid #2a2f49">
        <b>${escapeHtml(v.name)}</b> — ${escapeHtml(v.city)}
        ${v.address ? `<br><span class="muted">${escapeHtml(v.address)}</span>` : ""}
        ${v.fox_nick ? `<br><span class="muted">Fox: @${escapeHtml(v.fox_nick)}</span>` : ""}
        <br>
        <form method="POST" action="/admin/venues/${v.id}/approve" style="display:inline">
          <button type="submit" style="margin-top:6px;margin-right:6px">✅ Approve</button>
        </form>
        <form method="POST" action="/admin/venues/${v.id}/reject" style="display:inline">
          <button type="submit" class="danger">❌ Reject</button>
        </form>
      </div>`).join("");

  const venuesHtml  = venues.rows.map(v => `
    <tr><td>${v.id}</td><td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.city)}</td>
    <td>${v.visits}</td><td><span class="badge badge-ok">Active</span></td></tr>`).join("");

  const foxesHtml   = foxes.rows.map(f => `
    <tr>
      <td>${f.user_id}</td><td>${escapeHtml(f.username || "—")}</td>
      <td>${f.rating}</td><td>${f.invites}</td><td>${escapeHtml(f.city)}</td>
      <td>${escapeHtml(f.district || "—")}</td>
      <td>${f.streak_current || 0} 🔥 (best: ${f.streak_best || 0})</td>
      <td>${f.founder_number ? `<span style="color:#ffd700">👑 #${f.founder_number}</span>` : `<span class="muted">—</span>`}</td>
    </tr>`).join("");

  const growthHtml  = growth.map((g, i) => `
    <tr><td>${i+1}</td><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.city)}</td><td><b>${g.new_fox}</b></td></tr>`).join("");

  const districtHtml = districtStats.rows.map(d => `
    <tr><td>${escapeHtml(d.district)}</td><td><b>${d.cnt}</b></td></tr>`).join("");

  const achHtml = achStats.rows.map(a => {
    const ach = ACHIEVEMENTS[a.achievement_code];
    return `<tr><td>${ach ? ach.emoji : "?"} ${escapeHtml(a.achievement_code)}</td><td><b>${a.cnt}</b></td></tr>`;
  }).join("");

  res.send(pageShell("Admin — FoxPot", `
    <div class="card">
      <div class="topbar"><h1>🛡️ Admin Panel</h1><a href="/admin/logout">Вийти</a></div>
      ${flash(req)}
      <div class="muted" style="margin-top:8px">👑 Founder: залишилось <b>${spotsLeft}</b> / ${FOUNDER_LIMIT}</div>
    </div>

    <div class="card"><h2>Заявки (${pending.rows.length})</h2>${pendingHtml}</div>

    <div class="card">
      <h2>🚀 Growth Leaderboard</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>#</th><th>Назва</th><th>Місто</th><th>Нових Fox</th></tr>
        ${growthHtml}
      </table>
    </div>

    <div class="grid2">
      <div class="card">
        <h2>📍 Density по районах</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="opacity:.6"><th>Район</th><th>Fox</th></tr>
          ${districtHtml || '<tr><td colspan="2" class="muted">Немає даних</td></tr>'}
        </table>
      </div>
      <div class="card">
        <h2>🏆 Топ досягнень</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="opacity:.6"><th>Досягнення</th><th>Fox</th></tr>
          ${achHtml || '<tr><td colspan="2" class="muted">Немає даних</td></tr>'}
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Активні заклади</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>ID</th><th>Назва</th><th>Місто</th><th>Візити</th><th>Статус</th></tr>
        ${venuesHtml}
      </table>
    </div>

    <div class="card">
      <h2>Fox (топ 50)</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.6"><th>TG ID</th><th>Нік</th><th>Рейтинг</th><th>Інвайти</th><th>Місто</th><th>Район</th><th>Streak</th><th>Founder</th></tr>
        ${foxesHtml}
      </table>
    </div>`, `
    table th,table td{padding:6px 8px;text-align:left;border-bottom:1px solid #1a1f35}
  `));
});

app.post("/admin/venues/:id/approve", requireAdminAuth, async (req, res) => {
  const venueId = Number(req.params.id);
  await pool.query(`UPDATE fp1_venues SET approved=TRUE WHERE id=$1`, [venueId]);
  const v = await getVenue(venueId);
  if (v?.fox_nick) {
    const foxRow = await pool.query(
      `SELECT user_id, city FROM fp1_foxes WHERE username=$1 LIMIT 1`,
      [v.fox_nick.replace(/^@/, "")]
    );
    if (foxRow.rowCount > 0) {
      const fox      = foxRow.rows[0];
      const sameCity = (fox.city || "Warsaw").toLowerCase() === (v.city || "Warsaw").toLowerCase();
      const invBonus = sameCity ? 5 : 10;
      const ratBonus = sameCity ? 1 : 2;
      await pool.query(
        `UPDATE fp1_foxes SET invites=invites+$1, rating=rating+$2 WHERE user_id=$3`,
        [invBonus, ratBonus, fox.user_id]
      );
      if (bot) {
        try {
          await bot.telegram.sendMessage(Number(fox.user_id),
            `🎉 Заклад "${v.name}" затверджено!\n+${invBonus} інвайтів, +${ratBonus} рейтинг`);
        } catch (e) { console.error("TG_APPROVE_ERR", e?.message); }
      }
    }
  }
  res.redirect(`/admin?ok=${encodeURIComponent("Затверджено: " + (v?.name || venueId))}`);
});

app.post("/admin/venues/:id/reject", requireAdminAuth, async (req, res) => {
  const venueId = Number(req.params.id);
  const v = await getVenue(venueId);
  await pool.query(`DELETE FROM fp1_venues WHERE id=$1 AND approved=FALSE`, [venueId]);
  res.redirect(`/admin?warn=${encodeURIComponent("Відхилено: " + (v?.name || venueId))}`);
});

/* ═══════════════════════════════════════════════════════════════
   TELEGRAM BOT
═══════════════════════════════════════════════════════════════ */
let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  // ── /start ────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    try {
      const text      = String(ctx.message?.text || "").trim();
      const parts     = text.split(/\s+/);
      const codeOrInv = parts[1] || "";
      const userId    = String(ctx.from.id);
      const username  = ctx.from.username || null;

      // Існуючий Fox → профіль
      const exists = await pool.query(
        `SELECT * FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]
      );
      if (exists.rowCount > 0) {
        const f   = exists.rows[0];
        const tot = await pool.query(
          `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE user_id=$1`, [userId]
        );
        const badge     = founderBadge(f.founder_number);
        const spotsLeft = await founderSpotsLeft();

        let msg = `🦊 Твій профіль\n\n`;
        if (badge) msg += `${badge}\n\n`;
        msg += `Рейтинг: ${f.rating}\n`;
        msg += `Інвайти: ${f.invites}\n`;
        msg += `Місто: ${f.city}\n`;
        msg += `Район: ${f.district || "не вказано"}\n`;
        msg += `Візити: ${tot.rows[0].c}\n`;
        msg += `🔥 Streak: ${f.streak_current || 0} днів (рекорд: ${f.streak_best || 0})\n`;
        if (!f.founder_number && spotsLeft > 0)
          msg += `\n⚡ Founder місць: ${spotsLeft}`;
        msg += `\n\nКоманди:\n/checkin <venue_id>\n/invite\n/venues\n/stamps <venue_id>\n/streak\n/settings`;

        // Streak при кожному відкритті профілю
        await updateStreak(userId);
        return ctx.reply(msg);
      }

      // Новий Fox — потрібен код
      if (!codeOrInv) {
        const spotsLeft = await founderSpotsLeft();
        let msg = `🦊 THE FOXPOT CLUB\n\nЩоб зареєструватись потрібен інвайт від Fox або код ресторану.\n\nНапиши: /start <КОД>`;
        if (spotsLeft > 0) msg += `\n\n👑 Перших 1000 Fox — статус FOUNDER!\nЗалишилось: ${spotsLeft}`;
        return ctx.reply(msg);
      }

      // Код ресторану?
      const venue = await pool.query(
        `SELECT * FROM fp1_venues WHERE ref_code=$1 AND approved=TRUE LIMIT 1`,
        [codeOrInv.toUpperCase()]
      );
      if (venue.rowCount > 0) {
        const v = venue.rows[0];
        await pool.query(
          `INSERT INTO fp1_foxes(user_id, username, rating, invites, city, referred_by_venue)
           VALUES ($1,$2,1,5,'Warsaw',$3)`,
          [userId, username, v.id]
        );
        const day = warsawDayKey();
        await pool.query(
          `INSERT INTO fp1_counted_visits(venue_id, user_id, war_day) VALUES ($1,$2,$3)`,
          [v.id, userId, day]
        );
        const founderNum = await assignFounderNumber(userId);
        let msg = `✅ Зареєстровано через ${v.name}!\n\n+5 інвайтів\n`;
        if (founderNum) msg += `\n👑 Ти FOUNDER FOX #${founderNum}!\n`;
        else msg += `\n(Founder місця закінчились)\n`;
        msg += `\n/checkin ${v.id} — перший візит!`;
        await ctx.reply(msg);
        await sendDistrictKeyboard(ctx, "register");
        return;
      }

      // Інвайт-код від Fox?
      const result = await redeemInviteCode(userId, codeOrInv);
      if (!result.ok)
        return ctx.reply("❌ Невірний код. Потрібен інвайт від Fox або код ресторану.");

      await pool.query(
        `INSERT INTO fp1_foxes(user_id, username, rating, invites, city)
         VALUES ($1,$2,1,3,'Warsaw') ON CONFLICT (user_id) DO NOTHING`,
        [userId, username]
      );
      const founderNum = await assignFounderNumber(userId);
      let msg = `✅ Зареєстровано!\n\n+3 інвайти\n`;
      if (founderNum) msg += `\n👑 Ти FOUNDER FOX #${founderNum}!\n`;
      else msg += `\n(Founder місця закінчились)\n`;
      await ctx.reply(msg);
      await sendDistrictKeyboard(ctx, "register");

    } catch (e) {
      console.error("START_ERR", e);
      await ctx.reply("Помилка. Спробуй ще раз.");
    }
  });

  // ── /streak ───────────────────────────────────────────────────
  bot.command("streak", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(
        `SELECT streak_current, streak_best, streak_freeze_available, streak_last_date
         FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]
      );
      if (fox.rowCount === 0)
        return ctx.reply("❌ Спочатку зареєструйся через /start <КОД>");

      const f    = fox.rows[0];
      const cur  = f.streak_current  || 0;
      const best = f.streak_best     || 0;
      const freeze = f.streak_freeze_available || 0;
      const last = f.streak_last_date
        ? String(f.streak_last_date).slice(0, 10)
        : "ніколи";

      let msg = `🔥 Твій Streak\n\n`;
      msg += `Поточний: ${cur} ${cur > 0 ? "🔥".repeat(Math.min(cur, 5)) : ""}\n`;
      msg += `Рекорд: ${best} днів\n`;
      msg += `❄️ Freeze: ${freeze} (рятує від скидання)\n`;
      msg += `Останній день: ${last}\n\n`;

      // Наступний бонус
      if (cur < 7)        msg += `До бонусу +5 rating: ${7 - cur} днів`;
      else if (cur < 30)  msg += `До бонусу +15 rating: ${30 - cur} днів`;
      else if (cur < 90)  msg += `До бонусу +50 rating: ${90 - cur} днів`;
      else if (cur < 365) msg += `До бонусу +200 rating: ${365 - cur} днів`;
      else                msg += `🏆 Ти досяг максимального streak!`;

      await ctx.reply(msg);
    } catch (e) {
      console.error("STREAK_ERR", e);
      await ctx.reply("Помилка. Спробуй ще раз.");
    }
  });

  // ── /settings ─────────────────────────────────────────────────
  bot.command("settings", async (ctx) => {
    try {
      const userId = String(ctx.from.id);
      const fox = await pool.query(
        `SELECT district, city FROM fp1_foxes WHERE user_id=$1 LIMIT 1`, [userId]
      );
      if (fox.rowCount === 0)
        return ctx.reply("❌ Спочатку зареєструйся через /start <КОД>");
      const f = fox.rows[0];
      await ctx.reply(
        `⚙️ Налаштування\n\n📍 Район: ${f.district || "не вказано"}\n🏙️ Місто: ${f.city || "Warsaw"}`,
        Markup.inlineKeyboard([[Markup.button.callback("📍 Змінити район", "change_district")]])
      );
    } catch (e) {
      console.error("SETTINGS_ERR", e);
      await ctx.reply("Помилка. Спробуй ще раз.");
    }
  });

  // ── /panel ────────────────────────────────────────────────────
  bot.command("panel", async (ctx) => {
    await ctx.reply(`Панель закладу: ${PUBLIC_URL}/panel`);
  });

  // ── /venues ───────────────────────────────────────────────────
  bot.command("venues", async (ctx) => {
    const r = await pool.query(
      `SELECT id, name, city FROM fp1_venues WHERE approved=TRUE ORDER BY id ASC LIMIT 50`
    );
    const lines = r.rows.map(v => `• ID ${v.id}: ${v.name} (${v.city})`);
    await ctx.reply(`🏪 Заклади:\n${lines.join("\n")}\n\n/checkin <ID>`);
  });

  // ── /invite ───────────────────────────────────────────────────
  bot.command("invite", async (ctx) => {
    try {
      await upsertFox(ctx);
      const r = await createInviteCode(String(ctx.from.id));
      if (!r.ok)
        return ctx.reply(r.reason === "NO_INVITES"
          ? "❌ Немає інвайтів. +1 за кожні 5 підтверджених візитів."
          : `❌ Помилка: ${r.reason}`);
      await ctx.reply(
        `✅ Інвайт-код (1 раз):\n${r.code}\n\nНовий Fox пише:\n/start ${r.code}\n\nЗалишилось інвайтів: ${r.invites_left}`
      );
    } catch (e) {
      console.error("INVITE_ERR", e);
      await ctx.reply("❌ Помилка створення інвайту.");
    }
  });

  // ── /checkin ──────────────────────────────────────────────────
  bot.command("checkin", async (ctx) => {
    try {
      const parts   = String(ctx.message?.text || "").trim().split(/\s+/);
      const venueId = parts[1];
      if (!venueId) return ctx.reply("Використання: /checkin <venue_id>");
      const v = await getVenue(venueId);
      if (!v) return ctx.reply("Заклад не знайдено.");
      if (!v.approved) return ctx.reply("Заклад очікує на затвердження.");
      await upsertFox(ctx);
      const userId = String(ctx.from.id);
      const status = await currentVenueStatus(venueId);
      let statusWarn = "";
      if (status?.type === "limited")
        statusWarn = `\n⚠️ Статус "${status.reason}" до ${new Date(status.ends_at).toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw" })}`;
      const already = await hasCountedToday(venueId, userId);
      if (already) {
        const xy  = await countXY(venueId, userId);
        return ctx.reply(`СЬОГОДНІ ВЖЕ БУЛО ✅\n🏪 ${v.name}\n📅 ${warsawDayKey()}\n📊 X/Y: ${xy.X}/${xy.Y}`);
      }
      const c = await createCheckin(venueId, userId);
      await ctx.reply(`✅ Чек-ін (10 хв)\n\n🏪 ${v.name}${statusWarn}\n🔐 OTP: ${c.otp}\n\nПокажи персоналу.\nПанель: ${PUBLIC_URL}/panel`);
    } catch (e) {
      console.error("CHECKIN_ERR", e);
      await ctx.reply("Помилка чек-іну.");
    }
  });

  // ── /stamps ───────────────────────────────────────────────────
  bot.command("stamps", async (ctx) => {
    try {
      const parts   = String(ctx.message?.text || "").trim().split(/\s+/);
      const venueId = parts[1];
      if (!venueId) return ctx.reply("Використання: /stamps <venue_id>");
      const v = await getVenue(venueId);
      if (!v) return ctx.reply("Заклад не знайдено.");
      const userId  = String(ctx.from.id);
      const balance = await stampBalance(venueId, userId);
      const hist    = await stampHistory(venueId, userId, 5);
      const histTxt = hist.map(h =>
        `${h.delta > 0 ? "+" : ""}${h.delta} ${h.emoji}${h.note ? " — " + h.note : ""}`
      ).join("\n");
      await ctx.reply(`${v.name} — Штампи\nБаланс: ${balance}\n\nОстанні:\n${histTxt || "Немає"}`);
    } catch (e) {
      console.error("STAMPS_ERR", e);
      await ctx.reply("Помилка штампів.");
    }
  });

  // ── /addvenue ─────────────────────────────────────────────────
  bot.command("addvenue", async (ctx) => {
    await upsertFox(ctx);
    await ctx.reply(`Щоб підключити заклад:\n\n/newvenue Назва | Місто | Адреса | PIN (6 цифр)\n\nПриклад:\n/newvenue Pizza Roma | Warsaw | ul. Nowy Świat 5 | 654321`);
  });

  // ── /newvenue ─────────────────────────────────────────────────
  bot.command("newvenue", async (ctx) => {
    try {
      await upsertFox(ctx);
      const text  = String(ctx.message?.text || "").replace("/newvenue", "").trim();
      const parts = text.split("|").map(s => s.trim());
      if (parts.length < 4)
        return ctx.reply("Невірний формат.\n/newvenue Назва | Місто | Адреса | PIN (6 цифр)");
      const [name, city, address, pin] = parts;
      if (!name || !city || !address || !pin)
        return ctx.reply("Всі поля обов'язкові.");
      if (!/^\d{6}$/.test(pin))
        return ctx.reply("PIN — рівно 6 цифр.");
      const foxNick = ctx.from.username || String(ctx.from.id);
      const salt    = crypto.randomBytes(16).toString("hex");
      const hash    = pinHash(pin, salt);
      await pool.query(
        `INSERT INTO fp1_venues(name, city, address, pin_hash, pin_salt, approved, fox_nick)
         VALUES ($1,$2,$3,$4,$5,FALSE,$6)`,
        [name, city, address, hash, salt, foxNick]
      );
      await ctx.reply(`✅ Заявку надіслано!\n\n🏪 ${name}\n📍 ${address}, ${city}\n\nАдмін перевірить і повідомить тебе.`);
    } catch (e) {
      console.error("NEWVENUE_ERR", e);
      await ctx.reply("Помилка реєстрації закладу.");
    }
  });

  // ── Inline actions: район ─────────────────────────────────────
  bot.action("change_district", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await sendDistrictKeyboard(ctx, "change");
    } catch (e) { console.error("CHANGE_DISTRICT_ERR", e); }
  });

  bot.action(/^district_(.+)$/, async (ctx) => {
    try {
      const district = ctx.match[1];
      if (!WARSAW_DISTRICTS.includes(district)) {
        await ctx.answerCbQuery("❌ Невірний район");
        return;
      }
      const userId = String(ctx.from.id);
      await pool.query(`UPDATE fp1_foxes SET district=$1 WHERE user_id=$2`, [district, userId]);
      await ctx.answerCbQuery(`✅ Збережено: ${district}`);
      try {
        await ctx.editMessageText(
          `✅ Район збережено!\n\n📍 ${district}\n\nЗмінити: /settings`
        );
      } catch {
        await ctx.reply(`✅ Район: ${district}\n\nЗмінити: /settings`);
      }
    } catch (e) {
      console.error("DISTRICT_ACTION_ERR", e);
      await ctx.answerCbQuery("❌ Помилка.");
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
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.telegram.setWebhook(hookUrl);
        console.log("✅ Webhook:", hookUrl);
      } catch (e) {
        console.error("WEBHOOK_ERR", e?.message || e);
      }
    }
    app.listen(PORT, () => console.log(`✅ Server V14 listening on ${PORT}`));
  } catch (e) {
    console.error("BOOT_ERR", e);
    process.exit(1);
  }
})();
