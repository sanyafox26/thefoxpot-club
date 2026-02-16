/**
 * The FoxPot Club — Phase 1 MVP (Warsaw)
 * Railway + Postgres + Express + Telegraf (WEBHOOK MODE)
 *
 * IMPORTANT:
 * - Use WEBHOOK (stable on Railway)
 * - Requires env:
 *   BOT_TOKEN
 *   DATABASE_URL
 *   BASE_URL = https://thefoxpot-club-production.up.railway.app
 */

const express = require("express");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const BASE_URL = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");

if (!DATABASE_URL) console.error("❌ Missing DATABASE_URL");
if (!BOT_TOKEN) console.error("❌ Missing BOT_TOKEN");
if (!BASE_URL) console.error("❌ Missing BASE_URL (required for webhook)");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const bot = new Telegraf(BOT_TOKEN);

// -------------------------
// Time helpers (Europe/Warsaw)
// -------------------------
function warsawDayISO(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(date);
}
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}
function safeInt(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function maskTgId(id) {
  const s = String(id || "");
  if (s.length <= 4) return "****";
  return "ID****" + s.slice(-4);
}

// -------------------------
// DB: self-migrations
// -------------------------
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_foxes (
        id BIGSERIAL PRIMARY KEY,
        tg_id TEXT UNIQUE NOT NULL,
        tg_username TEXT,
        city TEXT NOT NULL DEFAULT 'Warsaw',
        rating INT NOT NULL DEFAULT 1,
        invites INT NOT NULL DEFAULT 3,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        referred_by_code TEXT,
        referred_by_fox_id BIGINT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_venues (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT 'Warsaw',
        address TEXT,
        pin TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        reserve_start TIMESTAMPTZ,
        reserve_end TIMESTAMPTZ,
        limited_reason TEXT,
        limited_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_checkins (
        id BIGSERIAL PRIMARY KEY,
        venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
        fox_id BIGINT NOT NULL REFERENCES fp1_foxes(id) ON DELETE CASCADE,
        otp TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        confirmed_at TIMESTAMPTZ,
        confirmed_by TEXT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_venue_otp ON fp1_checkins(venue_id, otp);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fp1_checkins_expires ON fp1_checkins(expires_at);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_counted_visits (
        id BIGSERIAL PRIMARY KEY,
        venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
        fox_id BIGINT NOT NULL REFERENCES fp1_foxes(id) ON DELETE CASCADE,
        day_warsaw DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_checkin_id BIGINT REFERENCES fp1_checkins(id) ON DELETE SET NULL
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_fp1_counted_daily
      ON fp1_counted_visits(venue_id, fox_id, day_warsaw);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_invites (
        code TEXT PRIMARY KEY,
        created_by_fox_id BIGINT NOT NULL REFERENCES fp1_foxes(id) ON DELETE CASCADE,
        created_by_tg TEXT NOT NULL,
        max_uses INT NOT NULL DEFAULT 1,
        uses INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_invite_uses (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL REFERENCES fp1_invites(code) ON DELETE CASCADE,
        used_by_fox_id BIGINT REFERENCES fp1_foxes(id) ON DELETE SET NULL,
        used_by_tg TEXT NOT NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Seed test venues
    const v = await client.query(`SELECT COUNT(*)::int AS c FROM fp1_venues;`);
    if ((v.rows[0]?.c || 0) === 0) {
      await client.query(
        `INSERT INTO fp1_venues(name, city, address, pin, status) VALUES
         ('Test Kebab #1', 'Warsaw', 'Warsaw (test)', '123456', 'active'),
         ('Test Pizza #2', 'Warsaw', 'Warsaw (test)', '123456', 'active')
        ;`
      );
    }

    await client.query("COMMIT");
    console.log("✅ DB migrations OK");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ DB migrate error:", e);
  } finally {
    client.release();
  }
}

async function dbOne(q, params = []) {
  const r = await pool.query(q, params);
  return r.rows[0] || null;
}
async function dbMany(q, params = []) {
  const r = await pool.query(q, params);
  return r.rows || [];
}

async function getFoxByTg(tg_id) {
  return dbOne(`SELECT * FROM fp1_foxes WHERE tg_id=$1`, [String(tg_id)]);
}
async function createFox({ tg_id, tg_username, referred_by_code, referred_by_fox_id }) {
  return dbOne(
    `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites, referred_by_code, referred_by_fox_id)
     VALUES($1,$2,'Warsaw',1,3,$3,$4)
     RETURNING *`,
    [String(tg_id), tg_username || null, referred_by_code || null, referred_by_fox_id || null]
  );
}
async function getVenue(venue_id) {
  return dbOne(`SELECT * FROM fp1_venues WHERE id=$1`, [String(venue_id)]);
}
async function foxCountedToday(venue_id, fox_id, dayISO) {
  const r = await dbOne(
    `SELECT 1 FROM fp1_counted_visits WHERE venue_id=$1 AND fox_id=$2 AND day_warsaw=$3::date`,
    [String(venue_id), String(fox_id), dayISO]
  );
  return !!r;
}
function genOtp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function genInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
async function tgSendSafe(chatId, text) {
  try {
    await bot.telegram.sendMessage(chatId, text, { disable_web_page_preview: true });
  } catch (e) {
    console.warn("⚠️ Telegram send fail:", e?.message || e);
  }
}

// -------------------------
// Health endpoints
// -------------------------
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({
      ok: true,
      db: !!r.rows?.length,
      tz: "Europe/Warsaw",
      day_warsaw: warsawDayISO(new Date()),
    });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});

// Telegram webhook status
app.get("/tg", async (req, res) => {
  try {
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, webhook: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------------
// Telegram bot commands
// -------------------------

bot.command("venues", async (ctx) => {
  const venues = await dbMany(`SELECT id, name, city FROM fp1_venues ORDER BY id ASC LIMIT 50`);
  const lines = venues.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`);
  const txt = lines.length ? `🗺 Zakłady\n\n${lines.join("\n")}\n\nCheck-in: /checkin <venue_id>` : "Brak zakładów.";
  return ctx.reply(txt);
});

bot.command("panel", async (ctx) => {
  return ctx.reply(`Panel: ${BASE_URL}/panel`);
});

bot.start(async (ctx) => {
  const tg_id = String(ctx.from.id);
  const tg_username = ctx.from.username ? String(ctx.from.username) : null;
  const args = (ctx.message.text || "").split(" ").slice(1);
  const code = args[0] ? String(args[0]).trim().toUpperCase() : "";

  let fox = await getFoxByTg(tg_id);

  if (fox) {
    const totalCounted = await dbOne(
      `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE fox_id=$1`,
      [String(fox.id)]
    );
    const c = totalCounted?.c || 0;

    return ctx.reply(
      `🦊 Fox profile\n` +
        `User: ${tg_username ? "@" + tg_username : maskTgId(tg_id)}\n` +
        `City: ${fox.city}\n` +
        `Rating: ${safeInt(fox.rating)}\n` +
        `Invites: ${safeInt(fox.invites)}\n` +
        `Total counted visits: ${c}\n\n` +
        `Commands:\n` +
        `/checkin <venue_id>\n` +
        `/invite\n` +
        `/venues\n` +
        `/panel`
    );
  }

  if (!code) {
    return ctx.reply(
      `🔐 Rejestracja tylko przez invite.\n\n` +
        `Wyślij:\n` +
        `/start KODINVITE\n\n` +
        `Jeśli nie masz kodu — poproś Foxa o /invite.`
    );
  }

  const inv = await dbOne(`SELECT * FROM fp1_invites WHERE code=$1`, [code]);
  if (!inv) return ctx.reply(`❌ Nieprawidłowy kod.\nPoproś o nowy /invite.`);
  if (safeInt(inv.uses) >= safeInt(inv.max_uses)) return ctx.reply(`❌ Kod już wykorzystany.\nPoproś o nowy /invite.`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invLock = await client.query(`SELECT * FROM fp1_invites WHERE code=$1 FOR UPDATE`, [code]);
    const invRow = invLock.rows[0];
    if (!invRow) {
      await client.query("ROLLBACK");
      return ctx.reply(`❌ Nieprawidłowy kod.`);
    }
    if (safeInt(invRow.uses) >= safeInt(invRow.max_uses)) {
      await client.query("ROLLBACK");
      return ctx.reply(`❌ Kod już wykorzystany.`);
    }

    const newFoxRes = await client.query(
      `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites, referred_by_code, referred_by_fox_id)
       VALUES($1,$2,'Warsaw',1,3,$3,$4)
       RETURNING *`,
      [tg_id, tg_username, code, String(invRow.created_by_fox_id)]
    );
    const newFox = newFoxRes.rows[0];

    await client.query(`UPDATE fp1_invites SET uses=uses+1, last_used_at=NOW() WHERE code=$1`, [code]);
    await client.query(
      `INSERT INTO fp1_invite_uses(code, used_by_fox_id, used_by_tg) VALUES($1,$2,$3)`,
      [code, String(newFox.id), tg_id]
    );

    await client.query("COMMIT");

    try {
      const creator = await dbOne(`SELECT * FROM fp1_foxes WHERE id=$1`, [String(invRow.created_by_fox_id)]);
      if (creator) {
        const who = tg_username ? `@${tg_username}` : maskTgId(tg_id);
        await tgSendSafe(creator.tg_id, `✅ Twój invite użyty: ${code}\nNowy Fox: ${who}`);
      }
    } catch {}

    return ctx.reply(
      `✅ Zarejestrowano Foxa!\n` +
        `City: Warsaw\nRating: 1\nInvites: 3\n\n` +
        `Teraz możesz:\n` +
        `/venues\n` +
        `/checkin <venue_id>\n` +
        `/invite`
    );
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("start(invite) error:", e);
    return ctx.reply("❌ Błąd rejestracji. Spróbuj ponownie.");
  } finally {
    client.release();
  }
});

bot.command("invite", async (ctx) => {
  const tg_id = String(ctx.from.id);
  const fox = await getFoxByTg(tg_id);
  if (!fox) return ctx.reply(`🔐 Najpierw rejestracja przez invite: /start KODINVITE`);

  if (safeInt(fox.invites) <= 0) {
    return ctx.reply(`❌ Masz 0 invites.\nInvites rosną m.in. co 5 counted visits (+1).`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const foxLock = await client.query(`SELECT * FROM fp1_foxes WHERE tg_id=$1 FOR UPDATE`, [tg_id]);
    const f = foxLock.rows[0];
    if (!f) {
      await client.query("ROLLBACK");
      return ctx.reply(`❌ Nie znaleziono profilu Fox.`);
    }
    if (safeInt(f.invites) <= 0) {
      await client.query("ROLLBACK");
      return ctx.reply(`❌ Masz 0 invites.`);
    }

    await client.query(`UPDATE fp1_foxes SET invites = invites - 1 WHERE tg_id=$1`, [tg_id]);

    let code = "";
    for (let i = 0; i < 5; i++) {
      const c = genInviteCode();
      const exists = await client.query(`SELECT 1 FROM fp1_invites WHERE code=$1`, [c]);
      if (!exists.rows.length) { code = c; break; }
    }
    if (!code) {
      await client.query("ROLLBACK");
      return ctx.reply("❌ Nie udało się wygenerować kodu. Spróbuj ponownie.");
    }

    await client.query(
      `INSERT INTO fp1_invites(code, created_by_fox_id, created_by_tg, max_uses, uses)
       VALUES($1,$2,$3,1,0)`,
      [code, String(f.id), tg_id]
    );

    await client.query("COMMIT");

    const fox2 = await getFoxByTg(tg_id);

    return ctx.reply(
      `🎟️ Invite code: ${code}\n\n` +
        `Dla nowego Foxa:\n` +
        `/start ${code}\n\n` +
        `Twoje Invites teraz: ${safeInt(fox2?.invites)}`
    );
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("invite error:", e);
    return ctx.reply("❌ Błąd. Spróbuj ponownie.");
  } finally {
    client.release();
  }
});

bot.command("checkin", async (ctx) => {
  const tg_id = String(ctx.from.id);
  const fox = await getFoxByTg(tg_id);
  if (!fox) return ctx.reply(`🔐 Dostęp tylko przez invite.\nWyślij: /start KODINVITE`);

  const parts = (ctx.message.text || "").split(" ").map((s) => s.trim());
  const venue_id = parts[1];
  if (!venue_id || !/^\d+$/.test(venue_id)) return ctx.reply(`Użycie: /checkin <venue_id>\nNp: /checkin 1`);

  const venue = await getVenue(venue_id);
  if (!venue || venue.status !== "active") return ctx.reply(`❌ Nie znaleziono aktywnego lokalu o ID ${venue_id}.`);

  const day = warsawDayISO(new Date());
  if (await foxCountedToday(venue_id, fox.id, day)) {
    return ctx.reply(
      `DZIŚ JUŻ BYŁO ✅\n\n` +
        `Lokal: ${venue.name}\n` +
        `Dzień (Warszawa): ${day}\n` +
        `Spróbuj jutro po 00:00 (Warszawa).`
    );
  }

  const otp = genOtp6();
  const expiresAt = addMinutes(new Date(), 10);

  await dbOne(
    `INSERT INTO fp1_checkins(venue_id, fox_id, otp, expires_at)
     VALUES($1,$2,$3,$4)
     RETURNING id`,
    [String(venue_id), String(fox.id), otp, expiresAt.toISOString()]
  );

  return ctx.reply(
    `✅ Check-in utworzony (10 min)\n\n` +
      `🏪 ${venue.name}\n` +
      `🔐 OTP: ${otp}\n\n` +
      `Personel potwierdza w Panelu.\n` +
      `Panel: ${BASE_URL}/panel`
  );
});

// -------------------------
// Minimal panel placeholder (so /panel link works)
// -------------------------
app.get("/panel", (req, res) => {
  res.send("Panel placeholder OK (your panel code can be re-attached here).");
});

// -------------------------
// WEBHOOK wiring
// -------------------------
const WEBHOOK_PATH = "/tg-webhook";
app.post(WEBHOOK_PATH, (req, res) => bot.handleUpdate(req.body, res));

// -------------------------
// Start
// -------------------------
(async () => {
  await migrate();

  app.get("/", (req, res) => res.send("FoxPot Club API OK"));

  app.listen(PORT, async () => {
    console.log(`✅ Server listening on ${PORT}`);

    if (!BOT_TOKEN) {
      console.error("❌ BOT_TOKEN missing => bot will NOT work");
      return;
    }
    if (!BASE_URL) {
      console.error("❌ BASE_URL missing => webhook can’t be set");
      return;
    }

    const fullWebhookUrl = `${BASE_URL}${WEBHOOK_PATH}`;

    try {
      await bot.telegram.setWebhook(fullWebhookUrl);
      const info = await bot.telegram.getWebhookInfo();
      console.log("✅ Webhook set:", fullWebhookUrl);
      console.log("ℹ️ Webhook info:", info);
    } catch (e) {
      console.error("❌ setWebhook error:", e);
    }
  });
})();
