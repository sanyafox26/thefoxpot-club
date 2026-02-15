const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ENV =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}
if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length < 8) {
  console.error("❌ WEBHOOK_SECRET missing/too short");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}
if (!ADMIN_USER_ID) {
  console.error("❌ ADMIN_USER_ID not set (Railway Variables)");
}

function panelLink() {
  if (!PUBLIC_URL) return null;
  return `${PUBLIC_URL}/panel`;
}

// ===== POSTGRES =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===== TIME (Warsaw) =====
function warsawDateISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}
function warsawNow() {
  // Date object in real UTC, but we will only use it for DB NOW() mostly.
  return new Date();
}

function randomOtp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ===== SECURITY HELPERS =====
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(pin, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}$${hash}`;
}
function verifyPin(pin, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes("$")) return false;
  const [salt, hash] = stored.split("$");
  const calc = crypto.pbkdf2Sync(pin, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(calc, "hex"));
}
function hmac(data) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(data).digest("hex");
}

// ===== DB INIT =====
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foxes (
      user_id BIGINT PRIMARY KEY,
      invites INT NOT NULL DEFAULT 3,
      rating INT NOT NULL DEFAULT 1,
      visits INT NOT NULL DEFAULT 0,
      earned_invites INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT 'Warsaw',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pin_hash TEXT;`);

  // === STATUS CONTROLS (LOCKED) ===
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS reserve_until TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS limited_until TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS limited_reason TEXT;`);

  // events for enforcing limits
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_status_events (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'reserve' | 'limited'
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      otp TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | expired
      fox_username TEXT, -- @username (може бути null)
      fox_name TEXT,     -- first_name (може бути null)
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // якщо таблиця була давно і не мала цих колонок — додамо
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS fox_username TEXT;`);
  await pool.query(`ALTER TABLE checkins ADD COLUMN IF NOT EXISTS fox_name TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS counted_visits (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      day_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, venue_id, day_date)
    );
  `);

  // === EMOJI STAMPS (LOCKED) ===
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_stamps (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      balance INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(venue_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_stamp_events (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      delta INT NOT NULL, -- + / -
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const c = await pool.query("SELECT COUNT(*)::int AS n FROM venues");
  if ((c.rows[0]?.n || 0) === 0) {
    await pool.query(
      "INSERT INTO venues (name, city) VALUES ($1,$2), ($3,$4)",
      ["Test Kebab #1", "Warsaw", "Test Pizza #2", "Warsaw"]
    );
    console.log("✅ DB: seeded test venues (2)");
  }

  await ensureVenuePins();
  console.log("✅ DB ready");
}

async function ensureVenuePins() {
  const r = await pool.query(
    "SELECT id FROM venues WHERE pin_hash IS NULL OR pin_hash = '' ORDER BY id ASC"
  );
  for (const row of r.rows) {
    const newPin = String(Math.floor(100000 + Math.random() * 900000));
    const ph = hashPin(newPin);
    await pool.query("UPDATE venues SET pin_hash = $2 WHERE id = $1", [row.id, ph]);
    console.log(`✅ Venue ${row.id}: PIN generated (use /resetpin ${row.id} in Telegram to rotate)`);
  }
}

async function getFox(userId) {
  const { rows } = await pool.query(
    "SELECT user_id, invites, rating, visits, earned_invites FROM foxes WHERE user_id = $1",
    [userId]
  );
  return rows[0] || null;
}

async function createFoxIfMissing(userId) {
  await pool.query(
    `
    INSERT INTO foxes (user_id, invites, rating, visits, earned_invites)
    VALUES ($1, 3, 1, 0, 0)
    ON CONFLICT (user_id) DO NOTHING
  `,
    [userId]
  );
  return getFox(userId);
}

async function getVenueById(venueId) {
  const { rows } = await pool.query(
    "SELECT id, name, city, reserve_until, limited_until, limited_reason FROM venues WHERE id = $1",
    [venueId]
  );
  return rows[0] || null;
}

async function getVenueWithPin(venueId) {
  const { rows } = await pool.query(
    "SELECT id, name, city, pin_hash, reserve_until, limited_until, limited_reason FROM venues WHERE id = $1",
    [venueId]
  );
  return rows[0] || null;
}

async function listVenues() {
  const { rows } = await pool.query(
    "SELECT id, name, city, reserve_until, limited_until, limited_reason FROM venues ORDER BY id ASC LIMIT 200"
  );
  return rows;
}

// ===== OWNER RULES =====
const OWNER_INVITES = 999999999;
const OWNER_RATING_GAP = 1000;

function isAdminId(userId) {
  if (!ADMIN_USER_ID) return false;
  return String(userId) === String(ADMIN_USER_ID);
}
function isAdmin(ctx) {
  return isAdminId(ctx.from.id);
}

async function getMaxRatingExcludingAdmin() {
  if (!ADMIN_USER_ID) return 0;
  const r = await pool.query(
    "SELECT COALESCE(MAX(rating), 0) AS max FROM foxes WHERE user_id <> $1",
    [ADMIN_USER_ID]
  );
  return Number(r.rows[0].max || 0);
}

async function ownerEnsure(userId) {
  if (!isAdminId(userId)) return;
  await createFoxIfMissing(userId);
  const maxOther = await getMaxRatingExcludingAdmin();
  const wantedRating = maxOther + OWNER_RATING_GAP;

  await pool.query(
    `
    UPDATE foxes
    SET
      invites = $2,
      rating  = CASE
                  WHEN rating <= 0 THEN 1
                  WHEN rating < $3 THEN $3
                  ELSE rating
                END,
      updated_at = NOW()
    WHERE user_id = $1
  `,
    [userId, OWNER_INVITES, wantedRating]
  );
}

// ===== X/Y helpers =====
async function getXYForVenue(venueId, userId) {
  const xq = await pool.query(
    "SELECT COUNT(*)::int AS x FROM counted_visits WHERE venue_id = $1 AND user_id = $2",
    [venueId, userId]
  );
  const yq = await pool.query("SELECT COUNT(*)::int AS y FROM counted_visits WHERE venue_id = $1", [
    venueId,
  ]);
  return { X: xq.rows[0].x || 0, Y: yq.rows[0].y || 0 };
}

async function expireOldCheckins() {
  await pool.query(`
    UPDATE checkins
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < NOW()
  `);
}

function last4(userId) {
  const s = String(userId || "");
  return s.length >= 4 ? s.slice(-4) : s;
}

function displayNick(u) {
  const username = (u.fox_username || "").trim();
  const name = (u.fox_name || "").trim();
  if (username) return `@${username.replace(/^@/, "")}`;
  if (name) return name;
  return `Fox****${last4(u.user_id)}`;
}

// ===== CONFIRM LOGIC =====
async function applyCountedAndRewards({ venueId, userId }) {
  const dayISO = warsawDateISO();

  const ins = await pool.query(
    `
    INSERT INTO counted_visits (user_id, venue_id, day_date)
    VALUES ($1, $2, $3::date)
    ON CONFLICT (user_id, venue_id, day_date) DO NOTHING
    RETURNING id
  `,
    [userId, venueId, dayISO]
  );

  const countedAdded = ins.rowCount === 1;

  await createFoxIfMissing(userId);

  if (countedAdded) {
    await pool.query(
      "UPDATE foxes SET visits = visits + 1, rating = rating + 1, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );

    const fox = await getFox(userId);
    const progress = fox.visits % 5;

    if (progress === 0) {
      if (isAdminId(userId)) {
        await pool.query(
          "UPDATE foxes SET earned_invites = earned_invites + 1, updated_at = NOW() WHERE user_id = $1",
          [userId]
        );
      } else {
        await pool.query("UPDATE foxes SET invites = invites + 1, updated_at = NOW() WHERE user_id = $1", [
          userId,
        ]);
      }
    }
  }

  const { X, Y } = await getXYForVenue(venueId, userId);
  return { dayISO, countedAdded, X, Y };
}

async function confirmByOtp({ venueId, otp }) {
  await expireOldCheckins();

  const venue = await getVenueById(venueId);
  if (!venue) return { ok: false, reason: "NO_VENUE" };

  const q = await pool.query(
    `
    SELECT id, user_id
    FROM checkins
    WHERE venue_id = $1
      AND otp = $2
      AND status = 'pending'
      AND expires_at > NOW()
    ORDER BY id DESC
    LIMIT 1
  `,
    [venueId, otp]
  );

  const row = q.rows[0];
  if (!row) return { ok: false, reason: "NO_PENDING" };

  await pool.query("UPDATE checkins SET status='confirmed' WHERE id = $1", [row.id]);

  const userId = Number(row.user_id);
  const r = await applyCountedAndRewards({ venueId, userId });

  return { ok: true, venueName: venue.name, userId, ...r };
}

async function confirmByCheckinId({ venueId, checkinId }) {
  await expireOldCheckins();

  const venue = await getVenueById(venueId);
  if (!venue) return { ok: false, reason: "NO_VENUE" };

  const q = await pool.query(
    `
    SELECT id, user_id
    FROM checkins
    WHERE id = $1
      AND venue_id = $2
      AND status = 'pending'
      AND expires_at > NOW()
    LIMIT 1
  `,
    [checkinId, venueId]
  );

  const row = q.rows[0];
  if (!row) return { ok: false, reason: "NO_PENDING" };

  await pool.query("UPDATE checkins SET status='confirmed' WHERE id = $1", [row.id]);

  const userId = Number(row.user_id);
  const r = await applyCountedAndRewards({ venueId, userId });

  return { ok: true, venueName: venue.name, userId, ...r };
}

// ===== STATUS RULES (LOCKED) =====
// Reserve: 2 times/month, duration up to 24h, must set 24h before
// Limited: 2 times/week, duration up to 3h, reason: FULL / PRIVATE EVENT / KITCHEN LIMIT
const LIMITED_REASONS = ["FULL", "PRIVATE_EVENT", "KITCHEN_LIMIT"];

async function countReserveThisMonth(venueId) {
  // count events from start of current month (Warsaw time) - approximate via DATE_TRUNC in DB timezone
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM venue_status_events
    WHERE venue_id = $1
      AND type = 'reserve'
      AND starts_at >= date_trunc('month', NOW())
  `,
    [venueId]
  );
  return r.rows[0].n || 0;
}

async function countLimitedThisWeek(venueId) {
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS n
    FROM venue_status_events
    WHERE venue_id = $1
      AND type = 'limited'
      AND starts_at >= date_trunc('week', NOW())
  `,
    [venueId]
  );
  return r.rows[0].n || 0;
}

async function setReserve(venueId, startsAtISO, durationHours) {
  // Validation in code (simple)
  const duration = Number(durationHours);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24) {
    return { ok: false, reason: "BAD_DURATION" };
  }

  const startsAt = new Date(startsAtISO);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, reason: "BAD_START" };

  // must be at least 24h from now
  const now = Date.now();
  if (startsAt.getTime() < now + 24 * 60 * 60 * 1000) {
    return { ok: false, reason: "TOO_SOON" };
  }

  const used = await countReserveThisMonth(venueId);
  if (used >= 2) return { ok: false, reason: "LIMIT_MONTH" };

  const endsAt = new Date(startsAt.getTime() + duration * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO venue_status_events (venue_id, type, starts_at, ends_at)
     VALUES ($1, 'reserve', $2, $3)`,
    [venueId, startsAt.toISOString(), endsAt.toISOString()]
  );

  await pool.query("UPDATE venues SET reserve_until = $2 WHERE id = $1", [venueId, endsAt.toISOString()]);
  return { ok: true, startsAt, endsAt };
}

async function clearReserve(venueId) {
  await pool.query("UPDATE venues SET reserve_until = NULL WHERE id = $1", [venueId]);
  return { ok: true };
}

async function setLimited(venueId, durationHours, reason) {
  const duration = Number(durationHours);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3) {
    return { ok: false, reason: "BAD_DURATION" };
  }
  const r = String(reason || "").trim().toUpperCase();
  if (!LIMITED_REASONS.includes(r)) return { ok: false, reason: "BAD_REASON" };

  const used = await countLimitedThisWeek(venueId);
  if (used >= 2) return { ok: false, reason: "LIMIT_WEEK" };

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + duration * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO venue_status_events (venue_id, type, starts_at, ends_at, reason)
     VALUES ($1, 'limited', $2, $3, $4)`,
    [venueId, startsAt.toISOString(), endsAt.toISOString(), r]
  );

  await pool.query("UPDATE venues SET limited_until = $2, limited_reason = $3 WHERE id = $1", [
    venueId,
    endsAt.toISOString(),
    r,
  ]);

  return { ok: true, startsAt, endsAt, reason: r };
}

async function clearLimited(venueId) {
  await pool.query("UPDATE venues SET limited_until = NULL, limited_reason = NULL WHERE id = $1", [venueId]);
  return { ok: true };
}

function isActiveUntil(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() > Date.now();
}

// ===== STAMPS =====
async function getStampBalance(venueId, userId) {
  const r = await pool.query(
    "SELECT balance::int AS balance FROM venue_stamps WHERE venue_id = $1 AND user_id = $2",
    [venueId, userId]
  );
  return r.rows[0]?.balance ?? 0;
}

async function applyStampDelta(venueId, userId, delta, note) {
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0 || d < -100 || d > 100) {
    return { ok: false, reason: "BAD_DELTA" };
  }

  // Upsert balance
  await pool.query(
    `
    INSERT INTO venue_stamps (venue_id, user_id, balance)
    VALUES ($1, $2, GREATEST(0, $3))
    ON CONFLICT (venue_id, user_id)
    DO UPDATE SET balance = GREATEST(0, venue_stamps.balance + $3), updated_at = NOW()
  `,
    [venueId, userId, d]
  );

  await pool.query(
    "INSERT INTO venue_stamp_events (venue_id, user_id, delta, note) VALUES ($1,$2,$3,$4)",
    [venueId, userId, d, (note || "").slice(0, 140) || null]
  );

  const balance = await getStampBalance(venueId, userId);
  return { ok: true, balance };
}

// ===== BOT =====
const bot = new Telegraf(BOT_TOKEN);

function panelButton() {
  const link = panelLink();
  if (!link) return null;
  return Markup.inlineKeyboard([Markup.button.url("Otwórz Panel", link)]);
}

bot.command("panel", async (ctx) => {
  const link = panelLink();
  if (!link) {
    return ctx.reply(
      "❌ Brak PUBLIC_URL.\n" +
        "Dodaj w Railway Variables:\n" +
        "PUBLIC_URL = https://twoj-domen.up.railway.app\n" +
        "Potem Deploy."
    );
  }
  return ctx.reply(`🔗 Panel lokalu:\n${link}`, panelButton());
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Ти не адмін. (Перевір ADMIN_USER_ID у Railway Variables)");
  await ownerEnsure(ctx.from.id);
  return ctx.reply("👑 Ти АДМІН (owner mode).");
});

async function replyMe(ctx) {
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const fox = await getFox(userId);
  if (!fox) return ctx.reply("❌ Użyj /start");

  const progress = fox.visits % 5;
  const remaining = progress === 0 ? 0 : 5 - progress;

  if (isAdmin(ctx)) {
    const maxOther = await getMaxRatingExcludingAdmin();
    return ctx.reply(
      "👑 OWNER STATUS\n\n" +
        `🎟 Invites: ${fox.invites}\n` +
        `⭐ Rating: ${fox.rating}\n` +
        `👣 Counted Visits (total): ${fox.visits}\n` +
        `🏁 Earned Invites: ${fox.earned_invites}\n\n` +
        (remaining === 0
          ? "✅ Next earned invite on multiple of 5.\n"
          : `📈 To next earned invite: ${remaining} counted visit(s).\n`) +
        `📌 OWNER = MAX_others(${maxOther}) + ${OWNER_RATING_GAP}`
    );
  }

  return ctx.reply(
    "🦊 Twój status\n\n" +
      `🎟 Invites: ${fox.invites}\n` +
      `⭐ Rating: ${fox.rating}\n` +
      `👣 Counted Visits: ${fox.visits}\n\n` +
      (remaining === 0
        ? "✅ Następny invite na wielokrotności 5."
        : `📈 Do następnego invite: ${remaining} counted visit(s).`)
  );
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await createFoxIfMissing(userId);
  await ownerEnsure(userId);

  const link = panelLink();

  const text =
    "🦊 THE FOX POT CLUB\n\n" +
    "Komendy:\n" +
    "• /venues — lista lokali\n" +
    "• /venue 1 — strona lokalu + X/Y\n" +
    "• /checkin 1 — check-in + OTP\n" +
    "• /me — status Foxa\n" +
    "• /panel — Panel lokalu\n\n" +
    (link ? `Panel: ${link}\n\n` : "Panel: (dodaj PUBLIC_URL w Railway Variables)\n\n") +
    "Test (tylko OWNER):\n" +
    "• /confirm 1 123456\n" +
    "• /resetpin 1";

  if (link) return ctx.reply(text, panelButton());
  return ctx.reply(text);
});

bot.command("me", replyMe);
bot.command("visit", replyMe);

bot.command("id", (ctx) => ctx.reply(`Twój Telegram ID: ${ctx.from.id}`));

bot.command("venues", async (ctx) => {
  await expireOldCheckins();
  const rows = await listVenues();
  if (!rows.length) return ctx.reply("Brak lokali.");

  let text = "🗺 Lokale (test)\n\n";
  for (const v of rows) {
    const reserveActive = isActiveUntil(v.reserve_until);
    const limitedActive = isActiveUntil(v.limited_until);
    const flags = [
      reserveActive ? "📍RESERVE" : null,
      limitedActive ? `⚠️LIMIT:${v.limited_reason || "?"}` : null,
    ].filter(Boolean);
    text += `• ID ${v.id}: ${v.name} (${v.city})${flags.length ? " — " + flags.join(" ") : ""}\n`;
  }
  text += "\nStrona: /venue 1\nPanel: /panel";
  return ctx.reply(text, panelButton());
});

bot.command("venue", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Napisz tak: /venue 1");

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Brak takiego lokalu. Zobacz /venues");

  const { X, Y } = await getXYForVenue(venueId, userId);

  const reserveActive = isActiveUntil(venue.reserve_until);
  const limitedActive = isActiveUntil(venue.limited_until);

  const statusLines = [];
  if (reserveActive) statusLines.push(`📍Reserve aktywne do: ${String(venue.reserve_until)}`);
  if (limitedActive) statusLines.push(`⚠️Dziś ograniczone do: ${String(venue.limited_until)} (${venue.limited_reason || "?"})`);
  if (!reserveActive && !limitedActive) statusLines.push("Status: OK");

  const msg =
    `🏪 ${venue.name} (${venue.city})\n\n` +
    `📊 X/Y: ${X}/${Y}\n` +
    `${statusLines.map((s) => `• ${s}`).join("\n")}\n\n` +
    `Check-in: /checkin ${venueId}\n` +
    `Panel: /panel`;

  return ctx.reply(msg, panelButton());
});

bot.command("checkin", async (ctx) => {
  await expireOldCheckins();
  const userId = ctx.from.id;
  await ownerEnsure(userId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Napisz tak: /checkin 1");

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Brak takiego lokalu. Zobacz /venues");

  const otp = randomOtp6();

  const fox_username = (ctx.from.username || "").trim() || null;
  const fox_name = (ctx.from.first_name || "").trim() || null;

  // TTL 10 хв
  await pool.query(
    `
    INSERT INTO checkins (user_id, venue_id, otp, status, fox_username, fox_name, expires_at)
    VALUES ($1, $2, $3, 'pending', $4, $5, NOW() + INTERVAL '10 minutes')
  `,
    [userId, venueId, otp, fox_username, fox_name]
  );

  const link = panelLink();
  const text =
    `✅ Check-in utworzony (10 min)\n\n` +
    `🏪 ${venue.name}\n` +
    `🔐 OTP: ${otp}\n\n` +
    `Personel potwierdza w Panelu.\n` +
    (link ? `Panel: ${link}\n\n` : `Panel: (dodaj PUBLIC_URL w Railway)\n\n`) +
    `Test (OWNER): /confirm ${venueId} ${otp}`;

  if (link) return ctx.reply(text, panelButton());
  return ctx.reply(text);
});

bot.command("resetpin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Tylko OWNER.");
  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  if (!Number.isInteger(venueId) || venueId <= 0) return ctx.reply("❌ Napisz tak: /resetpin 1");

  const venue = await getVenueById(venueId);
  if (!venue) return ctx.reply("❌ Brak takiego lokalu.");

  const newPin = String(Math.floor(100000 + Math.random() * 900000));
  const ph = hashPin(newPin);
  await pool.query("UPDATE venues SET pin_hash = $2 WHERE id = $1", [venueId, ph]);

  return ctx.reply(`🔐 PIN dla "${venue.name}" (ID ${venueId}): ${newPin}`);
});

bot.command("confirm", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Confirm tylko OWNER (test).");
  const parts = ctx.message.text.trim().split(/\s+/);
  const venueId = Number(parts[1]);
  const otp = (parts[2] || "").trim();
  if (!Number.isInteger(venueId) || venueId <= 0 || otp.length !== 6) {
    return ctx.reply("❌ Napisz tak: /confirm 1 123456");
  }

  const r = await confirmByOtp({ venueId, otp });
  if (!r.ok) {
    if (r.reason === "NO_VENUE") return ctx.reply("❌ Brak takiego lokalu.");
    return ctx.reply("❌ Brak pending check-in (OTP wygasł lub już potwierdzony).");
  }

  if (!r.countedAdded) {
    return ctx.reply(
      `✅ Confirm OK\n` +
        `Lokal: ${r.venueName}\n\n` +
        `Dzień (Warszawa): ${r.dayISO}\n\n` +
        `DZIŚ JUŻ BYŁO ✅\n` +
        `Spróbuj jutro po 00:00 (Warszawa).\n` +
        `X/Y: ${r.X}/${r.Y}`
    );
  }

  return ctx.reply(
    `✅ Confirm OK\n` +
      `Lokal: ${r.venueName}\n\n` +
      `Dzień (Warszawa): ${r.dayISO}\n\n` +
      `ZALICZONO ✅\n` +
      `X/Y: ${r.X}/${r.Y}`
  );
});

bot.hears(/test/i, (ctx) => ctx.reply("Test OK ✅"));

// ===== PANEL (PL/EN/UA) =====
const T = {
  pl: {
    title: "Panel lokalu",
    chooseVenue: "Wybierz lokal",
    pin: "PIN",
    login: "Zaloguj",
    wrongPin: "Błędny PIN.",
    hintReset: "Jeśli to test: OWNER w Telegram → /resetpin 1",
    otp: "OTP (6 cyfr)",
    confirm: "Potwierdź",
    pending: "Pending check-ins (10 min)",
    logout: "Wyloguj",
    todayAlready: "DZIŚ JUŻ BYŁO ✅",
    tryTomorrow: "Spróbuj jutro po 00:00 (Warszawa).",
    countedOk: "ZALICZONO ✅",
    back: "Wróć do Panelu",
    noPending: "Brak pending check-in (OTP wygasł albo już potwierdzony).",
    btnConfirm: "Potwierdź",
    fox: "Fox",
    statusBlock: "Statusy lokalu",
    reserve: "📍Rezerwa",
    reserveSet: "Ustaw rezerwę",
    reserveClear: "Usuń rezerwę",
    reserveStart: "Start (YYYY-MM-DD HH:MM)",
    reserveHours: "Ile godzin (1–24)",
    reserveHint: "LOCKED: max 2/mies, max 24h, ustaw min. 24h wcześniej",
    limited: "Dziś ograniczone",
    limitedSet: "Ustaw 'Dziś ograniczone'",
    limitedClear: "Wyłącz 'Dziś ograniczone'",
    limitedHours: "Ile godzin (1–3)",
    limitedReason: "Powód",
    limitedHint: "LOCKED: max 2/tydz, max 3h, FULL / PRIVATE EVENT / KITCHEN LIMIT",
    stampsBlock: "Emoji-stamps",
    stampsFoxId: "Fox ID (Telegram)",
    stampsDelta: "Zmiana (+/-)",
    stampsNote: "Notatka (opcjonalnie)",
    stampsApply: "Zastosuj",
    stampsBalance: "Saldo",
    stampsQuick: "Szybko z pending",
  },
  en: {
    title: "Venue Panel",
    chooseVenue: "Choose venue",
    pin: "PIN",
    login: "Login",
    wrongPin: "Wrong PIN.",
    hintReset: "If test: OWNER in Telegram → /resetpin 1",
    otp: "OTP (6 digits)",
    confirm: "Confirm",
    pending: "Pending check-ins (10 min)",
    logout: "Logout",
    todayAlready: "TODAY ALREADY ✅",
    tryTomorrow: "Try tomorrow after 00:00 (Warsaw).",
    countedOk: "COUNTED ✅",
    back: "Back to Panel",
    noPending: "No pending check-in (OTP expired or already confirmed).",
    btnConfirm: "Confirm",
    fox: "Fox",
    statusBlock: "Venue status",
    reserve: "📍Reserve",
    reserveSet: "Set reserve",
    reserveClear: "Clear reserve",
    reserveStart: "Start (YYYY-MM-DD HH:MM)",
    reserveHours: "Duration hours (1–24)",
    reserveHint: "LOCKED: max 2/month, max 24h, must set 24h ahead",
    limited: "Today limited",
    limitedSet: "Set today limited",
    limitedClear: "Disable today limited",
    limitedHours: "Duration hours (1–3)",
    limitedReason: "Reason",
    limitedHint: "LOCKED: max 2/week, max 3h, FULL / PRIVATE EVENT / KITCHEN LIMIT",
    stampsBlock: "Emoji-stamps",
    stampsFoxId: "Fox ID (Telegram)",
    stampsDelta: "Delta (+/-)",
    stampsNote: "Note (optional)",
    stampsApply: "Apply",
    stampsBalance: "Balance",
    stampsQuick: "Quick from pending",
  },
  ua: {
    title: "Панель закладу",
    chooseVenue: "Обери заклад",
    pin: "ПІН",
    login: "Увійти",
    wrongPin: "Невірний ПІН.",
    hintReset: "Якщо тест: OWNER в Telegram → /resetpin 1",
    otp: "OTP (6 цифр)",
    confirm: "Підтвердити",
    pending: "Очікують підтвердження (10 хв)",
    logout: "Вийти",
    todayAlready: "СЬОГОДНІ ВЖЕ БУЛО ✅",
    tryTomorrow: "Спробуй завтра після 00:00 (Варшава).",
    countedOk: "ЗАРАХОВАНО ✅",
    back: "Назад в Panel",
    noPending: "Немає pending check-in (OTP прострочився або вже підтверджений).",
    btnConfirm: "Підтвердити",
    fox: "Фокс",
    statusBlock: "Статуси закладу",
    reserve: "📍Резерв",
    reserveSet: "Поставити резерв",
    reserveClear: "Зняти резерв",
    reserveStart: "Старт (YYYY-MM-DD HH:MM)",
    reserveHours: "Тривалість год (1–24)",
    reserveHint: "LOCKED: max 2/місяць, max 24h, ставити мін. за 24h",
    limited: "Сьогодні обмежено",
    limitedSet: "Увімкнути 'Сьогодні обмежено'",
    limitedClear: "Вимкнути 'Сьогодні обмежено'",
    limitedHours: "Тривалість год (1–3)",
    limitedReason: "Причина",
    limitedHint: "LOCKED: max 2/тиждень, max 3h, FULL / PRIVATE EVENT / KITCHEN LIMIT",
    stampsBlock: "Emoji-stamps",
    stampsFoxId: "Fox ID (Telegram)",
    stampsDelta: "Зміна (+/-)",
    stampsNote: "Нотатка (необов.)",
    stampsApply: "Застосувати",
    stampsBalance: "Баланс",
    stampsQuick: "Швидко з pending",
  },
};

function pickLang(q) {
  const v = String(q || "").toLowerCase();
  if (v === "en") return "en";
  if (v === "ua" || v === "uk") return "ua";
  return "pl";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseCookies(cookieHeader) {
  const out = {};
  const parts = String(cookieHeader || "").split(";");
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (opts.maxAge === 0) parts.push("Max-Age=0");
  res.setHeader("Set-Cookie", [
    ...(res.getHeader("Set-Cookie") ? [].concat(res.getHeader("Set-Cookie")) : []),
    parts.join("; "),
  ]);
}

async function getAuthedVenue(req) {
  const c = parseCookies(req.headers.cookie || "");
  const vid = Number(c.panel_vid);
  const sig = c.panel_sig;
  if (!Number.isInteger(vid) || vid <= 0 || !sig) return null;

  const venue = await getVenueWithPin(vid);
  if (!venue || !venue.pin_hash) return null;

  const expected = hmac(`vid=${vid}|pin_hash=${venue.pin_hash}`);
  if (expected !== sig) return null;

  return venue;
}

function pageShell(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:Arial, sans-serif; padding:16px; max-width:860px; margin:0 auto;}
    .card{border:1px solid #ddd; border-radius:12px; padding:14px; margin:12px 0;}
    input,select,button{font-size:16px; padding:10px; width:100%; margin:6px 0; box-sizing:border-box;}
    button{cursor:pointer;}
    .big{font-size:20px; font-weight:700;}
    .ok{background:#e9ffe9;}
    .bad{background:#ffe9e9;}
    .muted{color:#666;}
    .row{display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;}
    .row > *{flex:1; min-width:220px;}
    .pendingItem{display:flex; gap:10px; align-items:center; justify-content:space-between;}
    .pendingLeft{flex:1;}
    .btnSmall{width:auto; padding:10px 14px;}
    a{color:#0b63ce; text-decoration:none;}
    a:hover{text-decoration:underline;}
    .pill{display:inline-block; padding:4px 10px; border-radius:999px; border:1px solid #ccc; margin-right:6px; font-size:13px;}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function parseLocalDateTimeToISO(s) {
  // expects "YYYY-MM-DD HH:MM"
  const str = String(s || "").trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  // We interpret it as Warsaw local time, but easiest: let DB store as timestamptz using "YYYY-MM-DDTHH:MM:00+01:00" is tricky.
  // We will approximate by treating as UTC-like ISO and let Postgres parse; for MVP it is acceptable.
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
}

app.get("/panel", async (req, res) => {
  const lang = pickLang(req.query.lang);
  const t = T[lang];

  const venue = await getAuthedVenue(req);
  const venues = await listVenues();

  if (!venue) {
    const options = venues
      .map((v) => `<option value="${v.id}">${escapeHtml(v.name)} (ID ${v.id})</option>`)
      .join("");

    const body = `
      <h2>${escapeHtml(t.title)}</h2>

      <div class="card">
        <form method="POST" action="/panel/login">
          <label>${escapeHtml(t.chooseVenue)}</label>
          <select name="venue_id" required>${options}</select>

          <label>${escapeHtml(t.pin)}</label>
          <input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required />

          <div class="row">
            <select name="lang">
              <option value="pl"${lang === "pl" ? " selected" : ""}>PL</option>
              <option value="en"${lang === "en" ? " selected" : ""}>EN</option>
              <option value="ua"${lang === "ua" ? " selected" : ""}>UA</option>
            </select>
            <button type="submit">${escapeHtml(t.login)}</button>
          </div>
        </form>
        ${req.query.err ? `<div class="card bad"><div class="big">${escapeHtml(t.wrongPin)}</div><div class="muted">${escapeHtml(t.hintReset)}</div></div>` : ""}
      </div>
    `;
    return res.status(200).send(pageShell(t.title, body));
  }

  const pending = await pool.query(
    `
    SELECT id, otp, user_id, fox_username, fox_name, expires_at
    FROM checkins
    WHERE venue_id = $1 AND status = 'pending' AND expires_at > NOW()
    ORDER BY id DESC
    LIMIT 30
  `,
    [venue.id]
  );

  let pendingRows = `<div class="muted">—</div>`;
  let pendingFoxButtons = `<div class="muted">—</div>`;

  if (pending.rows.length > 0) {
    pendingRows = pending.rows
      .map((r) => {
        const nick = displayNick(r);
        const id4 = last4(r.user_id);
        return `
          <div class="card">
            <div class="pendingItem">
              <div class="pendingLeft">
                <div><b>OTP:</b> ${escapeHtml(r.otp)}</div>
                <div class="muted">${escapeHtml(t.fox)}: ${escapeHtml(nick)} (ID****${escapeHtml(id4)})</div>
              </div>
              <form method="POST" action="/panel/confirm_pending">
                <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
                <input type="hidden" name="checkin_id" value="${escapeHtml(r.id)}" />
                <button class="btnSmall" type="submit">${escapeHtml(t.btnConfirm)}</button>
              </form>
            </div>
          </div>
        `;
      })
      .join("");

    // Quick select fox for stamps
    pendingFoxButtons = pending.rows
      .map((r) => {
        const nick = displayNick(r);
        return `
          <form method="GET" action="/panel" style="display:inline-block; margin:4px 6px 0 0;">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
            <input type="hidden" name="prefill_fox" value="${escapeHtml(r.user_id)}" />
            <button class="btnSmall" type="submit">${escapeHtml(t.stampsQuick)}: ${escapeHtml(nick)}</button>
          </form>
        `;
      })
      .join("");
  }

  const reserveActive = isActiveUntil(venue.reserve_until);
  const limitedActive = isActiveUntil(venue.limited_until);

  const statusPills = [
    reserveActive ? `<span class="pill">📍RESERVE</span>` : "",
    limitedActive ? `<span class="pill">⚠️LIMIT: ${escapeHtml(venue.limited_reason || "?")}</span>` : "",
    !reserveActive && !limitedActive ? `<span class="pill">OK</span>` : "",
  ].join(" ");

  const prefillFox = req.query.prefill_fox ? String(req.query.prefill_fox) : "";

  const body = `
    <h2>${escapeHtml(t.title)}</h2>

    <div class="card">
      <div class="big">🏪 ${escapeHtml(venue.name)} (ID ${venue.id})</div>
      <div class="muted">City: ${escapeHtml(venue.city)}</div>
      <div style="margin-top:8px">${statusPills}</div>

      <div style="margin-top:10px" class="row">
        <form method="POST" action="/panel/confirm_manual" style="flex:2">
          <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
          <label>${escapeHtml(t.otp)}</label>
          <input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required />
          <button type="submit">${escapeHtml(t.confirm)}</button>
        </form>

        <form method="GET" action="/panel/logout" style="flex:1">
          <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
          <button type="submit">${escapeHtml(t.logout)}</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="big">${escapeHtml(t.statusBlock)}</div>

      <div class="row">
        <div class="card" style="margin:0;">
          <div class="big">${escapeHtml(t.reserve)}</div>
          <div class="muted">${escapeHtml(t.reserveHint)}</div>
          <div class="muted">Aktualnie: ${reserveActive ? `do ${escapeHtml(String(venue.reserve_until))}` : "—"}</div>

          <form method="POST" action="/panel/set_reserve">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
            <label>${escapeHtml(t.reserveStart)}</label>
            <input name="start" placeholder="2026-02-20 12:00" required />
            <label>${escapeHtml(t.reserveHours)}</label>
            <input name="hours" inputmode="numeric" placeholder="24" required />
            <button type="submit">${escapeHtml(t.reserveSet)}</button>
          </form>

          <form method="POST" action="/panel/clear_reserve">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
            <button type="submit">${escapeHtml(t.reserveClear)}</button>
          </form>
        </div>

        <div class="card" style="margin:0;">
          <div class="big">${escapeHtml(t.limited)}</div>
          <div class="muted">${escapeHtml(t.limitedHint)}</div>
          <div class="muted">Aktualnie: ${limitedActive ? `do ${escapeHtml(String(venue.limited_until))} (${escapeHtml(venue.limited_reason || "?")})` : "—"}</div>

          <form method="POST" action="/panel/set_limited">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
            <label>${escapeHtml(t.limitedHours)}</label>
            <input name="hours" inputmode="numeric" placeholder="3" required />
            <label>${escapeHtml(t.limitedReason)}</label>
            <select name="reason" required>
              <option value="FULL">FULL</option>
              <option value="PRIVATE_EVENT">PRIVATE EVENT</option>
              <option value="KITCHEN_LIMIT">KITCHEN LIMIT</option>
            </select>
            <button type="submit">${escapeHtml(t.limitedSet)}</button>
          </form>

          <form method="POST" action="/panel/clear_limited">
            <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
            <button type="submit">${escapeHtml(t.limitedClear)}</button>
          </form>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="big">${escapeHtml(t.stampsBlock)}</div>
      <div class="muted">LOCKED: lokal sam dodaje/odejmuje stamps. System trzyma saldo i historię.</div>

      <div class="row">
        <form method="POST" action="/panel/stamps_apply" style="flex:2">
          <input type="hidden" name="lang" value="${escapeHtml(lang)}" />
          <label>${escapeHtml(t.stampsFoxId)}</label>
          <input name="fox_id" inputmode="numeric" placeholder="np. 123456789" value="${escapeHtml(prefillFox)}" required />
          <label>${escapeHtml(t.stampsDelta)}</label>
          <input name="delta" placeholder="+1 albo -1" required />
          <label>${escapeHtml(t.stampsNote)}</label>
          <input name="note" placeholder="np. lunch / nagroda" />
          <button type="submit">${escapeHtml(t.stampsApply)}</button>
        </form>

        <div class="card" style="margin:0; flex:1">
          <div class="big">${escapeHtml(t.stampsQuick)}</div>
          ${pendingFoxButtons}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="big">${escapeHtml(t.pending)}</div>
      ${pendingRows}
    </div>
  `;

  return res.status(200).send(pageShell(t.title, body));
});

app.post("/panel/login", async (req, res) => {
  const venueId = Number(req.body.venue_id);
  const pin = String(req.body.pin || "").trim();
  const lang = pickLang(req.body.lang);

  if (!Number.isInteger(venueId) || venueId <= 0 || pin.length !== 6) {
    return res.redirect(`/panel?lang=${lang}&err=1`);
  }

  const venue = await getVenueWithPin(venueId);
  if (!venue || !venue.pin_hash) return res.redirect(`/panel?lang=${lang}&err=1`);
  if (!verifyPin(pin, venue.pin_hash)) return res.redirect(`/panel?lang=${lang}&err=1`);

  const sig = hmac(`vid=${venueId}|pin_hash=${venue.pin_hash}`);
  setCookie(res, "panel_vid", String(venueId));
  setCookie(res, "panel_sig", sig);

  return res.redirect(`/panel?lang=${lang}`);
});

// Manual OTP
app.post("/panel/confirm_manual", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const t = T[lang];

  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);

  const otp = String(req.body.otp || "").trim();
  if (!/^\d{6}$/.test(otp)) return res.redirect(`/panel?lang=${lang}`);

  const r = await confirmByOtp({ venueId: venue.id, otp });

  if (!r.ok) {
    const body = `
      <h2>${escapeHtml(t.title)}</h2>
      <div class="card bad">
        <div class="big">❌ ${escapeHtml(t.noPending)}</div>
      </div>
      <a href="/panel?lang=${lang}">${escapeHtml(t.back)}</a>
    `;
    return res.status(200).send(pageShell(t.title, body));
  }

  const headline = r.countedAdded ? t.countedOk : t.todayAlready;
  const extra = r.countedAdded ? "" : `<div class="muted">${escapeHtml(t.tryTomorrow)}</div>`;

  const body = `
    <h2>${escapeHtml(t.title)}</h2>
    <div class="card ${r.countedAdded ? "ok" : "bad"}">
      <div class="big">${escapeHtml(headline)}</div>
      <div><b>Lokal:</b> ${escapeHtml(r.venueName)}</div>
      <div><b>Dzień (Warszawa):</b> ${escapeHtml(r.dayISO)}</div>
      ${extra}
      <div style="margin-top:10px"><b>X/Y:</b> ${r.X}/${r.Y}</div>
    </div>
    <a href="/panel?lang=${lang}">${escapeHtml(t.back)}</a>
  `;
  return res.status(200).send(pageShell(t.title, body));
});

// Pending button confirm
app.post("/panel/confirm_pending", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const t = T[lang];

  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);

  const checkinId = Number(req.body.checkin_id);
  if (!Number.isInteger(checkinId) || checkinId <= 0) return res.redirect(`/panel?lang=${lang}`);

  const r = await confirmByCheckinId({ venueId: venue.id, checkinId });

  if (!r.ok) {
    const body = `
      <h2>${escapeHtml(t.title)}</h2>
      <div class="card bad">
        <div class="big">❌ ${escapeHtml(t.noPending)}</div>
      </div>
      <a href="/panel?lang=${lang}">${escapeHtml(t.back)}</a>
    `;
    return res.status(200).send(pageShell(t.title, body));
  }

  const headline = r.countedAdded ? t.countedOk : t.todayAlready;
  const extra = r.countedAdded ? "" : `<div class="muted">${escapeHtml(t.tryTomorrow)}</div>`;

  const body = `
    <h2>${escapeHtml(t.title)}</h2>
    <div class="card ${r.countedAdded ? "ok" : "bad"}">
      <div class="big">${escapeHtml(headline)}</div>
      <div><b>Lokal:</b> ${escapeHtml(r.venueName)}</div>
      <div><b>Dzień (Warszawa):</b> ${escapeHtml(r.dayISO)}</div>
      ${extra}
      <div style="margin-top:10px"><b>X/Y:</b> ${r.X}/${r.Y}</div>
    </div>
    <a href="/panel?lang=${lang}">${escapeHtml(t.back)}</a>
  `;
  return res.status(200).send(pageShell(t.title, body));
});

// ===== STATUS ENDPOINTS =====
app.post("/panel/set_reserve", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);

  const startStr = String(req.body.start || "");
  const hours = String(req.body.hours || "").trim();

  const iso = parseLocalDateTimeToISO(startStr);
  if (!iso) return res.redirect(`/panel?lang=${lang}`);

  const r = await setReserve(venue.id, iso, hours);
  if (!r.ok) {
    return res.redirect(`/panel?lang=${lang}`); // MVP: silent; can add errors later
  }
  return res.redirect(`/panel?lang=${lang}`);
});

app.post("/panel/clear_reserve", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);
  await clearReserve(venue.id);
  return res.redirect(`/panel?lang=${lang}`);
});

app.post("/panel/set_limited", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);

  const hours = String(req.body.hours || "").trim();
  const reason = String(req.body.reason || "").trim();
  const r = await setLimited(venue.id, hours, reason);
  if (!r.ok) {
    return res.redirect(`/panel?lang=${lang}`);
  }
  return res.redirect(`/panel?lang=${lang}`);
});

app.post("/panel/clear_limited", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);
  await clearLimited(venue.id);
  return res.redirect(`/panel?lang=${lang}`);
});

// ===== STAMPS ENDPOINT =====
app.post("/panel/stamps_apply", async (req, res) => {
  const lang = pickLang(req.body.lang);
  const venue = await getAuthedVenue(req);
  if (!venue) return res.redirect(`/panel?lang=${lang}`);

  const foxId = Number(String(req.body.fox_id || "").trim());
  const deltaRaw = String(req.body.delta || "").trim();
  const note = String(req.body.note || "").trim();

  if (!Number.isInteger(foxId) || foxId <= 0) return res.redirect(`/panel?lang=${lang}`);

  // parse delta like "+1" or "-2" or "3"
  const delta = Number(deltaRaw);
  if (!Number.isInteger(delta) || delta === 0) return res.redirect(`/panel?lang=${lang}`);

  await createFoxIfMissing(foxId); // optional, but keeps system consistent
  await applyStampDelta(venue.id, foxId, delta, note);

  return res.redirect(`/panel?lang=${lang}&prefill_fox=${foxId}`);
});

app.get("/panel/logout", async (req, res) => {
  const lang = pickLang(req.query.lang);
  setCookie(res, "panel_vid", "", { maxAge: 0 });
  setCookie(res, "panel_sig", "", { maxAge: 0 });
  return res.redirect(`/panel?lang=${lang}`);
});

// ===== ROUTES =====
app.get("/", (req, res) => res.status(200).send("The FoxPot Club backend OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.get("/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0] });
  } catch (e) {
    console.error("❌ /db error:", e);
    res.status(500).json({ ok: false });
  }
});

// ===== WEBHOOK =====
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));

// ===== START =====
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on ${PORT}`);
      console.log(`✅ Webhook path: ${webhookPath}`);
      if (PUBLIC_URL) console.log(`✅ Panel: ${PUBLIC_URL}/panel`);
    });
  } catch (e) {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  }
})();
