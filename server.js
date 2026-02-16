/**
 * FoxPot Club — Phase 1 (Warsaw)
 * Express + Telegraf (WEBHOOK) + Postgres (Railway)
 *
 * Fix for "bot silent":
 * - Adds /admin/webhook endpoint to FORCE reset webhook
 * - /tg shows current webhook info
 *
 * ENV REQUIRED:
 * - BOT_TOKEN
 * - DATABASE_URL
 * - BASE_URL  (example: https://thefoxpot-club-production.up.railway.app)
 * - ADMIN_SECRET (for /admin/webhook)
 */

const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const BASE_URL = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

if (!DATABASE_URL) console.error("❌ Missing DATABASE_URL");
if (!BOT_TOKEN) console.error("❌ Missing BOT_TOKEN");
if (!BASE_URL) console.error("❌ Missing BASE_URL");
if (!ADMIN_SECRET) console.error("⚠️ Missing ADMIN_SECRET (admin webhook reset will not work)");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const bot = new Telegraf(BOT_TOKEN);

// ---------- Time (Warsaw) ----------
function warsawDayISO(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(date);
}

// ---------- DB migrate (minimal) ----------
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
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

    await client.query("COMMIT");
    console.log("✅ DB migrations OK");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ DB migrate error:", e);
  } finally {
    client.release();
  }
}

// ---------- DB helpers ----------
async function dbOne(q, params = []) {
  const r = await pool.query(q, params);
  return r.rows[0] || null;
}
async function getFoxByTg(tg_id) {
  return dbOne(`SELECT * FROM fp1_foxes WHERE tg_id=$1`, [String(tg_id)]);
}
function genInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ---------- Health ----------
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: !!r.rows?.length, tz: "Europe/Warsaw", day_warsaw: warsawDayISO(new Date()) });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});

// ---------- Webhook debug ----------
app.get("/tg", async (req, res) => {
  try {
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, webhook: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- FORCE reset webhook (admin) ----------
app.get("/admin/webhook", async (req, res) => {
  const secret = String(req.query.secret || "");
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: "missing BOT_TOKEN" });
  if (!BASE_URL) return res.status(500).json({ ok: false, error: "missing BASE_URL" });

  const WEBHOOK_PATH = "/tg-webhook";
  const full = `${BASE_URL}${WEBHOOK_PATH}`;

  try {
    // drop pending updates so we start clean
    await bot.telegram.deleteWebhook(true);
    await bot.telegram.setWebhook(full);
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, set_to: full, webhook: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- WEBHOOK receiver ----------
const WEBHOOK_PATH = "/tg-webhook";
app.post(WEBHOOK_PATH, (req, res) => bot.handleUpdate(req.body, res));

// ---------- Telegram basic commands ----------
bot.start(async (ctx) => {
  const tg_id = String(ctx.from.id);
  const tg_username = ctx.from.username ? String(ctx.from.username) : null;

  let fox = await getFoxByTg(tg_id);
  if (!fox) {
    // For now: allow auto-create so we can test bot is alive
    fox = await dbOne(
      `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites)
       VALUES($1,$2,'Warsaw',1,3) RETURNING *`,
      [tg_id, tg_username]
    );
  }

  return ctx.reply(
    `🦊 Bot działa.\n` +
    `User: ${tg_username ? "@" + tg_username : tg_id}\n` +
    `City: ${fox.city}\nRating: ${fox.rating}\nInvites: ${fox.invites}\n\n` +
    `Test komendy:\n/invite`
  );
});

bot.command("invite", async (ctx) => {
  const tg_id = String(ctx.from.id);
  const tg_username = ctx.from.username ? String(ctx.from.username) : null;

  let fox = await getFoxByTg(tg_id);
  if (!fox) {
    fox = await dbOne(
      `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites)
       VALUES($1,$2,'Warsaw',1,3) RETURNING *`,
      [tg_id, tg_username]
    );
  }

  if (Number(fox.invites) <= 0) return ctx.reply("❌ 0 invites.");

  // consume 1 invite + create code
  const code = genInviteCode();
  await pool.query("BEGIN");
  try {
    await pool.query(`UPDATE fp1_foxes SET invites = invites - 1 WHERE tg_id=$1`, [tg_id]);
    await pool.query(
      `INSERT INTO fp1_invites(code, created_by_fox_id, created_by_tg, max_uses, uses)
       VALUES($1,$2,$3,1,0)`,
      [code, fox.id, tg_id]
    );
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error(e);
    return ctx.reply("❌ Error creating invite.");
  }

  const fox2 = await getFoxByTg(tg_id);
  return ctx.reply(`🎟️ Invite: ${code}\nInvites now: ${fox2.invites}`);
});

// ---------- Start server ----------
(async () => {
  await migrate();

  app.get("/", (req, res) => res.send("FoxPot Club API OK"));

  app.listen(PORT, () => {
    console.log(`✅ Server listening on ${PORT}`);
    console.log("ℹ️ BASE_URL:", BASE_URL || "(empty)");
  });
})();
