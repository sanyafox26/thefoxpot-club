/**
 * THE FOXPOT CLUB — Phase 1 MVP (Bot + Panel) — server.js
 * FIX: use NEW prefixed tables fp1_* to avoid old DB schema conflicts.
 *
 * ENV required:
 * - BOT_TOKEN
 * - DATABASE_URL
 * - PUBLIC_URL
 * Optional:
 * - WEBHOOK_SECRET
 */

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

if (!DATABASE_URL) console.error("❌ Missing DATABASE_URL");
if (!BOT_TOKEN) console.error("❌ Missing BOT_TOKEN");
if (!PUBLIC_URL) console.error("❌ Missing PUBLIC_URL");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
});

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// -------- helpers --------
function warsawDayKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`; // YYYY-MM-DD
}

function genOTP6() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function pinHash(pin, salt) {
  return sha256Hex(`${salt}:${pin}`);
}
function salt8() {
  return crypto.randomBytes(8).toString("hex");
}
function safeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function db(text, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(text, params);
  } finally {
    c.release();
  }
}

function panelUrl() {
  return `${PUBLIC_URL.replace(/\/$/, "")}/panel`;
}

// -------- NEW TABLES (prefixed) --------
const T = {
  venues: "fp1_venues",
  foxes: "fp1_foxes",
  checkins: "fp1_checkins",
  counted: "fp1_counted_visits",
};

async function ensureSchema() {
  await db(`
    CREATE TABLE IF NOT EXISTS ${T.venues} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      pin_salt TEXT NOT NULL DEFAULT '',
      pin_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS ${T.foxes} (
      id SERIAL PRIMARY KEY,
      user_id BIGINT UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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

  await db(`
    CREATE TABLE IF NOT EXISTS ${T.counted} (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      user_id BIGINT NOT NULL,
      day_key DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_checkins_venue_otp ON ${T.checkins}(venue_id, otp);`);
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_checkins_expires ON ${T.checkins}(expires_at);`);
  await db(`CREATE INDEX IF NOT EXISTS fp1_idx_counted_unique ON ${T.counted}(venue_id, user_id, day_key);`);

  const r = await db(`SELECT COUNT(*)::int AS c FROM ${T.venues};`);
  if ((r.rows[0]?.c || 0) === 0) {
    const s1 = salt8();
    const h1 = pinHash("123456", s1);
    await db(`INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`, [
      "Test Kebab #1",
      "Warsaw",
      s1,
      h1,
    ]);

    const s2 = salt8();
    const h2 = pinHash("123456", s2);
    await db(`INSERT INTO ${T.venues}(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`, [
      "Test Pizza #2",
      "Warsaw",
      s2,
      h2,
    ]);
    console.log("✅ Seeded fp1_venues (PIN 123456).");
  }
}

async function getVenue(venueId) {
  const r = await db(`SELECT id,name,city,pin_salt,pin_hash FROM ${T.venues} WHERE id=$1;`, [venueId]);
  return r.rows[0] || null;
}

async function verifyPin(venueId, pin) {
  const v = await getVenue(venueId);
  if (!v) return { ok: false };
  const h = pinHash(String(pin), String(v.pin_salt || ""));
  return h === v.pin_hash ? { ok: true, venue: v } : { ok: false };
}

async function upsertFox(userId, username) {
  await db(
    `INSERT INTO ${T.foxes}(user_id, username)
     VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username;`,
    [userId, username || ""]
  );
}

async function countedExists(userId, venueId) {
  const day = warsawDayKey(new Date());
  const r = await db(
    `SELECT 1 FROM ${T.counted} WHERE user_id=$1 AND venue_id=$2 AND day_key=$3::date LIMIT 1;`,
    [userId, venueId, day]
  );
  return { exists: r.rowCount > 0, day };
}

async function addCounted(userId, venueId) {
  const { exists, day } = await countedExists(userId, venueId);
  if (exists) return { added: false, day };
  await db(`INSERT INTO ${T.counted}(user_id, venue_id, day_key) VALUES ($1,$2,$3::date);`, [userId, venueId, day]);
  return { added: true, day };
}

async function getXY(userId, venueId) {
  const x = await db(`SELECT COUNT(*)::int AS c FROM ${T.counted} WHERE user_id=$1 AND venue_id=$2;`, [userId, venueId]);
  const y = await db(`SELECT COUNT(*)::int AS c FROM ${T.counted} WHERE venue_id=$1;`, [venueId]);
  return { X: x.rows[0]?.c || 0, Y: y.rows[0]?.c || 0 };
}

// -------- health --------
app.get("/health", async (req, res) => {
  try {
    const t = await db(`SELECT NOW() AS now;`);
    res.json({ ok: true, db: true, now: t.rows[0]?.now, tz: "Europe/Warsaw" });
  } catch (e) {
    res.json({ ok: true, db: false, error: String(e?.message || e) });
  }
});

// -------- panel (stateless) --------
app.get("/panel", (req, res) => {
  res.send(`
  <html><head><meta charset="utf-8"/><title>Panel lokalu</title></head>
  <body style="background:#0f1220;color:white;font-family:system-ui;padding:40px;">
    <div style="max-width:760px;margin:0 auto;background:#14182b;padding:24px;border-radius:14px;">
      <h2 style="margin:0 0 10px;">Panel lokalu</h2>
      <form method="POST" action="/panel/login">
        <div style="display:flex;gap:12px;">
          <div style="flex:1;">
            <label>Venue ID</label><br/>
            <input name="venue" value="1" style="width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0f1220;color:white;" />
          </div>
          <div style="flex:1;">
            <label>PIN (6 cyfr)</label><br/>
            <input name="pin" value="123456" style="width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0f1220;color:white;" />
          </div>
        </div>
        <button style="margin-top:14px;padding:10px 14px;border:0;border-radius:10px;background:#6e56ff;color:white;font-weight:700;">Zaloguj</button>
      </form>
    </div>
  </body></html>`);
});

app.post("/panel/login", async (req, res) => {
  const venueId = Number(String(req.body.venue || "").trim());
  const pin = String(req.body.pin || "").trim();
  if (!venueId || !pin) return res.redirect("/panel");
  const ok = await verifyPin(venueId, pin);
  if (!ok.ok) return res.redirect("/panel");
  res.redirect(`/panel/${venueId}/${encodeURIComponent(pin)}`);
});

app.get("/panel/:venue/:pin", async (req, res) => {
  const venueId = Number(req.params.venue);
  const pin = decodeURIComponent(String(req.params.pin || ""));
  const ok = await verifyPin(venueId, pin);
  if (!ok.ok) return res.redirect("/panel");

  const venue = ok.venue;

  const pending = await db(
    `SELECT otp, user_id, expires_at FROM ${T.checkins}
     WHERE venue_id=$1 AND confirmed_at IS NULL AND expires_at > NOW()
     ORDER BY expires_at ASC LIMIT 50;`,
    [venueId]
  );

  const pendingHtml =
    pending.rows.length === 0
      ? `<div style="opacity:.75;">Brak aktywnych check-inów</div>`
      : pending.rows
          .map(
            (r) => `
            <div style="padding:10px;border:1px solid #2a2f49;border-radius:12px;background:#0f1220;margin-bottom:10px;">
              <div><b>OTP:</b> ${safeHtml(r.otp)}</div>
              <div style="opacity:.8;font-size:13px;">Fox ID: ****${String(r.user_id).slice(-4)} | Expires: ${safeHtml(
              new Date(r.expires_at).toLocaleString("pl-PL")
            )}</div>
            </div>`
          )
          .join("");

  res.send(`
  <html><head><meta charset="utf-8"/><title>Panel</title></head>
  <body style="background:#0f1220;color:white;font-family:system-ui;padding:40px;">
    <div style="max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px;">
      <div style="background:#14182b;padding:20px;border-radius:14px;">
        <h2 style="margin:0 0 6px;">Panel lokalu</h2>
        <div style="opacity:.85;">Zalogowano: <b>${safeHtml(venue.name)}</b> (ID ${venueId})</div>
        <div style="margin-top:8px;"><a href="/panel" style="color:#9aa4ff;">Wyloguj</a></div>
      </div>

      <div style="background:#14182b;padding:20px;border-radius:14px;">
        <h3 style="margin:0 0 10px;">Wprowadź OTP</h3>
        <form method="POST" action="/panel/${venueId}/${encodeURIComponent(pin)}/confirm" style="display:flex;gap:10px;">
          <input name="otp" placeholder="OTP (6 cyfr)" style="flex:1;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0f1220;color:white;" />
          <button style="padding:10px 14px;border:0;border-radius:10px;background:#6e56ff;color:white;font-weight:700;">Confirm</button>
        </form>
      </div>

      <div style="background:#14182b;padding:20px;border-radius:14px;">
        <h3 style="margin:0 0 10px;">Pending check-ins (10 min)</h3>
        ${pendingHtml}
      </div>
    </div>
  </body></html>`);
});

app.post("/panel/:venue/:pin/confirm", async (req, res) => {
  const venueId = Number(req.params.venue);
  const pin = decodeURIComponent(String(req.params.pin || ""));
  const otp = String(req.body.otp || "").trim();

  const ok = await verifyPin(venueId, pin);
  if (!ok.ok) return res.redirect("/panel");
  const venue = ok.venue;

  const r = await db(
    `SELECT id, user_id, expires_at, confirmed_at FROM ${T.checkins}
     WHERE venue_id=$1 AND otp=$2 ORDER BY id DESC LIMIT 1;`,
    [venueId, otp]
  );

  if (r.rowCount === 0) return res.send(resultPage("OTP nie znaleziono", venueId, pin));
  const chk = r.rows[0];
  if (new Date(chk.expires_at).getTime() <= Date.now()) return res.send(resultPage("OTP wygasł", venueId, pin));
  if (chk.confirmed_at) return res.send(resultPage("Już potwierdzono", venueId, pin));

  await db(`UPDATE ${T.checkins} SET confirmed_at=NOW() WHERE id=$1;`, [chk.id]);

  const userId = Number(chk.user_id);
  const counted = await addCounted(userId, venueId);
  const xy = await getXY(userId, venueId);

  if (bot) {
    if (!counted.added) {
      await bot.telegram.sendMessage(
        userId,
        `DZIŚ JUŻ BYŁO ✅\nLokal: ${venue.name}\nDzień (Warszawa): ${counted.day}\nX/Y: ${xy.X}/${xy.Y}`
      );
    } else {
      await bot.telegram.sendMessage(
        userId,
        `✅ Confirm OK\n🏪 ${venue.name}\n📅 Day (Warszawa): ${counted.day}\n📊 X/Y: ${xy.X}/${xy.Y}`
      );
    }
  }

  return res.send(
    resultPage(
      counted.added ? `Confirm OK ✅ (X/Y ${xy.X}/${xy.Y})` : `DZIŚ JUŻ BYŁO ✅ (X/Y ${xy.X}/${xy.Y})`,
      venueId,
      pin
    )
  );
});

function resultPage(title, venueId, pin) {
  return `
  <html><head><meta charset="utf-8"/><title>${safeHtml(title)}</title></head>
  <body style="background:#0f1220;color:white;font-family:system-ui;padding:40px;">
    <div style="max-width:720px;margin:0 auto;background:#14182b;padding:24px;border-radius:14px;">
      <h2 style="margin:0 0 10px;">${safeHtml(title)}</h2>
      <a href="/panel/${venueId}/${encodeURIComponent(pin)}" style="color:#9aa4ff;">Powrót</a>
    </div>
  </body></html>`;
}

// -------- bot --------
if (bot) {
  bot.start(async (ctx) => {
    await ctx.reply(
      `THE FOXPOT CLUB — MVP\n\nKomendy:\n/venues\n/panel\n/checkin <venue_id>\n\nPrzykład: /checkin 1`
    );
  });

  bot.command("venues", async (ctx) => {
    const r = await db(`SELECT id,name,city FROM ${T.venues} ORDER BY id ASC LIMIT 50;`);
    const t = r.rows.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`).join("\n");
    await ctx.reply(`🏪 Lokale (testowe)\n\n${t}\n\nCheck-in: /checkin 1`);
  });

  bot.command("panel", async (ctx) => {
    await ctx.reply(`Panel: ${panelUrl()}`);
  });

  bot.command("checkin", async (ctx) => {
    try {
      const msg = String(ctx.message?.text || "");
      const venueId = Number(msg.split(" ")[1]);

      if (!venueId) return ctx.reply("Użycie: /checkin <venue_id>\nPrzykład: /checkin 1");

      const v = await getVenue(venueId);
      if (!v) return ctx.reply("Nie znaleziono lokalu.");

      const userId = Number(ctx.from?.id);
      const username = ctx.from?.username ? `@${ctx.from.username}` : "";
      await upsertFox(userId, username);

      const today = await countedExists(userId, venueId);
      if (today.exists) {
        const xy = await getXY(userId, venueId);
        return ctx.reply(
          `DZIŚ JUŻ BYŁO ✅\nLokal: ${v.name}\nDzień (Warszawa): ${today.day}\nX/Y: ${xy.X}/${xy.Y}\nPanel: ${panelUrl()}`
        );
      }

      const otp = genOTP6();
      const expires = new Date(Date.now() + 10 * 60 * 1000);

      await db(`INSERT INTO ${T.checkins}(venue_id, user_id, otp, expires_at) VALUES ($1,$2,$3,$4);`, [
        venueId,
        userId,
        otp,
        expires.toISOString(),
      ]);

      await ctx.reply(
        `✅ Check-in utworzony (10 min)\n\n🏪 ${v.name}\n🔐 OTP: ${otp}\n\nPersonel potwierdza w Panelu.\nPanel: ${panelUrl()}`
      );
    } catch (e) {
      console.error("checkin error:", e?.message || e);
      await ctx.reply("Błąd check-in");
    }
  });

  if (WEBHOOK_SECRET && PUBLIC_URL) {
    const path = `/${WEBHOOK_SECRET.replace(/^\//, "")}`;
    bot.telegram
      .setWebhook(`${PUBLIC_URL.replace(/\/$/, "")}${path}`)
      .then(() => console.log("✅ Webhook set:", path))
      .catch((e) => console.error("Webhook set error:", e?.message || e));
    app.use(bot.webhookCallback(path));
    console.log("✅ Webhook path ready:", path);
  } else {
    console.log("ℹ️ WEBHOOK_SECRET or PUBLIC_URL missing — webhook not set here.");
  }
}

// -------- boot --------
(async () => {
  try {
    await ensureSchema();
    console.log("✅ DB schema OK (fp1_*).");
  } catch (e) {
    console.error("❌ ensureSchema error:", e?.message || e);
  }

  app.listen(PORT, () => console.log("✅ Server listening on", PORT));
})();
