/**
 * FoxPot Club — Phase 1 (Warsaw)
 * Railway + Postgres + Express + Telegraf (WEBHOOK)
 *
 * Uses EXISTING Railway variables from your screenshot:
 * - BOT_TOKEN
 * - DATABASE_URL
 * - PUBLIC_URL            (base public https url)
 * - WEBHOOK_SECRET        (admin secret + webhook path secret)
 *
 * Fixes:
 * - Bot silent => webhook not set.
 * - Adds /admin/webhook?secret=... to FORCE reset webhook.
 * - /tg shows current webhook info.
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
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

if (!BOT_TOKEN) console.error("❌ Missing BOT_TOKEN");
if (!DATABASE_URL) console.error("❌ Missing DATABASE_URL");
if (!PUBLIC_URL) console.error("❌ Missing PUBLIC_URL");
if (!WEBHOOK_SECRET) console.error("❌ Missing WEBHOOK_SECRET");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const bot = new Telegraf(BOT_TOKEN);

// -------- Time Warsaw ----------
function warsawDayISO(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(date);
}

// -------- DB migrate (minimal test tables, safe) ----------
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

async function getOrCreateFox(tg_id, tg_username) {
  let fox = await dbOne(`SELECT * FROM fp1_foxes WHERE tg_id=$1`, [String(tg_id)]);
  if (fox) return fox;

  fox = await dbOne(
    `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites)
     VALUES($1,$2,'Warsaw',1,3) RETURNING *`,
    [String(tg_id), tg_username || null]
  );
  return fox;
}

// -------- Health ----------
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

// -------- Webhook info ----------
app.get("/tg", async (req, res) => {
  try {
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, webhook: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------- FORCE reset webhook (admin) ----------
app.get("/admin/webhook", async (req, res) => {
  const secret = String(req.query.secret || "").trim();

  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: "missing BOT_TOKEN" });
  if (!PUBLIC_URL) return res.status(500).json({ ok: false, error: "missing PUBLIC_URL" });

  const webhookUrl = `${PUBLIC_URL}/tg-webhook/${WEBHOOK_SECRET}`;

  try {
    // Drop pending updates so we start clean
    await bot.telegram.deleteWebhook(true);
    await bot.telegram.setWebhook(webhookUrl);
    const info = await bot.telegram.getWebhookInfo();
    return res.json({ ok: true, set_to: webhookUrl, webhook: info });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------- WEBHOOK receiver (secret in path) ----------
app.post("/tg-webhook/:secret", (req, res) => {
  if (String(req.params.secret || "") !== WEBHOOK_SECRET) {
    return res.status(403).send("forbidden");
  }
  return bot.handleUpdate(req.body, res);
});

// -------- Telegram commands (simple alive test) ----------
bot.start(async (ctx) => {
  const tg_id = String(ctx.from.id);
  const tg_username = ctx.from.username ? String(ctx.from.username) : null;

  const fox = await getOrCreateFox(tg_id, tg_username);

  return ctx.reply(
    `🦊 FoxPot bot działa ✅\n` +
      `City: ${fox.city}\n` +
      `Rating: ${fox.rating}\n` +
      `Invites: ${fox.invites}\n\n` +
      `Jeśli to widzisz — webhook działa.`
  );
});

bot.command("ping", (ctx) => ctx.reply("pong ✅"));

// -------- Start ----------
(async () => {
  await migrate();

  app.get("/", (req, res) => res.send("FoxPot Club API OK"));

  app.listen(PORT, () => {
    console.log(`✅ Server listening on ${PORT}`);
    console.log("ℹ️ PUBLIC_URL:", PUBLIC_URL || "(empty)");
    console.log("ℹ️ WEBHOOK_SECRET:", WEBHOOK_SECRET ? "(set)" : "(empty)");
  });
})();
