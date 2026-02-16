/**
 * FoxPot Club — Webhook Fix V3
 * Goal: prove deployed code + force webhook with existing vars:
 * BOT_TOKEN, DATABASE_URL, PUBLIC_URL, WEBHOOK_SECRET
 */

const express = require("express");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const bot = new Telegraf(BOT_TOKEN);

// ---------- MUST HAVE: version marker ----------
app.get("/version", (req, res) => {
  res.type("text/plain").send("FP_WEBHOOK_FIX_V3_OK");
});

// ---------- health ----------
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: !!r.rows?.length });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e?.message || e) });
  }
});

// ---------- webhook info ----------
app.get("/tg", async (req, res) => {
  try {
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, webhook: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- admin: check secret matches (no guessing) ----------
app.get("/admin/check", (req, res) => {
  const secret = String(req.query.secret || "").trim();
  const match = !!WEBHOOK_SECRET && secret === WEBHOOK_SECRET;

  // show minimal debug without leaking secret
  res.json({
    ok: true,
    match,
    env: {
      has_bot_token: !!BOT_TOKEN,
      has_db_url: !!DATABASE_URL,
      public_url: PUBLIC_URL || "",
      secret_len: WEBHOOK_SECRET.length,
    },
  });
});

// ---------- admin: force set webhook ----------
app.get("/admin/webhook", async (req, res) => {
  const secret = String(req.query.secret || "").trim();

  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: "missing BOT_TOKEN" });
  if (!PUBLIC_URL) return res.status(500).json({ ok: false, error: "missing PUBLIC_URL" });

  const webhookUrl = `${PUBLIC_URL}/tg-webhook/${WEBHOOK_SECRET}`;

  try {
    await bot.telegram.deleteWebhook(true); // drop pending
    await bot.telegram.setWebhook(webhookUrl);
    const info = await bot.telegram.getWebhookInfo();
    res.json({ ok: true, set_to: webhookUrl, webhook: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- webhook receiver ----------
app.post("/tg-webhook/:secret", (req, res) => {
  if (String(req.params.secret || "") !== WEBHOOK_SECRET) {
    return res.status(403).send("forbidden");
  }
  return bot.handleUpdate(req.body, res);
});

// ---------- telegram: simple alive test ----------
bot.start((ctx) => ctx.reply("🦊 Bot alive ✅"));
bot.command("ping", (ctx) => ctx.reply("pong ✅"));

app.get("/", (req, res) => res.type("text/plain").send("FoxPot Club API OK"));

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log("PUBLIC_URL:", PUBLIC_URL || "(empty)");
  console.log("WEBHOOK_SECRET length:", WEBHOOK_SECRET.length);
});
