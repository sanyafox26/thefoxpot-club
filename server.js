/**
 * THE FOXPOT CLUB — Phase 1 MVP (Bot + Panel) — server.js
 * Stateless Panel (no cookies/sessions) + Real DB confirm + 1/day counted (Europe/Warsaw)
 *
 * ENV required:
 * - BOT_TOKEN
 * - DATABASE_URL
 * - PUBLIC_URL   (e.g. https://thefoxpot-club-production.up.railway.app)
 * Optional:
 * - ADMIN_USER_ID
 * - WEBHOOK_SECRET (if you want webhook path; bot will still work for sending messages even without webhook)
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
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : "";

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL");
}
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
});

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// ---------- Helpers ----------
function nowUtcISO() {
  return new Date().toISOString();
}

function warsawDayKeyDateString(d = new Date()) {
  // Returns "YYYY-MM-DD" in Europe/Warsaw
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

function genOTP6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function makePinSalt() {
  return crypto.randomBytes(8).toString("hex");
}

function makePinHash(pin, salt) {
  // Simple + stable for Phase 1
  return sha256Hex(`${salt}:${pin}`);
}

function safeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function panelUrl() {
  // /panel is always safe entry
  return `${PUBLIC_URL.replace(/\/$/, "")}/panel`;
}

async function dbQuery(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ---------- Schema (stable, minimal) ----------
async function ensureSchema() {
  // Tables
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      pin_salt TEXT NOT NULL DEFAULT '',
      pin_hash TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS foxes (
      id SERIAL PRIMARY KEY,
      user_id BIGINT UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      user_id BIGINT NOT NULL,
      otp TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ NULL
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS counted_visits (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL,
      user_id BIGINT NOT NULL,
      day_key DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Indexes (safe)
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_checkins_venue_otp ON checkins(venue_id, otp);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_checkins_expires ON checkins(expires_at);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_counted_unique ON counted_visits(venue_id, user_id, day_key);`);

  // Seed test venues if empty
  const v = await dbQuery(`SELECT COUNT(*)::int AS c FROM venues;`);
  const c = v.rows[0]?.c || 0;

  if (c === 0) {
    // Test venue #1
    const salt1 = makePinSalt();
    const hash1 = makePinHash("123456", salt1);
    await dbQuery(
      `INSERT INTO venues(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`,
      ["Test Kebab #1", "Warsaw", salt1, hash1]
    );

    // Test venue #2
    const salt2 = makePinSalt();
    const hash2 = makePinHash("123456", salt2);
    await dbQuery(
      `INSERT INTO venues(name, city, pin_salt, pin_hash) VALUES ($1,$2,$3,$4);`,
      ["Test Pizza #2", "Warsaw", salt2, hash2]
    );

    console.log("✅ Seeded test venues (PIN 123456).");
  }
}

async function getVenueById(id) {
  const r = await dbQuery(`SELECT id, name, city, pin_salt, pin_hash FROM venues WHERE id=$1;`, [id]);
  return r.rows[0] || null;
}

async function verifyVenuePin(venueId, pin) {
  const v = await getVenueById(venueId);
  if (!v) return { ok: false, reason: "VENUE_NOT_FOUND" };
  const salt = v.pin_salt || "";
  const hash = v.pin_hash || "";
  if (!salt || !hash) return { ok: false, reason: "PIN_NOT_SET" };

  const computed = makePinHash(String(pin), String(salt));
  if (computed !== hash) return { ok: false, reason: "PIN_INVALID" };

  return { ok: true, venue: v };
}

async function upsertFox(userId, username) {
  // ensure fox exists
  await dbQuery(
    `INSERT INTO foxes(user_id, username)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET username = EXCLUDED.username;`,
    [userId, username || ""]
  );
}

async function countedExistsToday(userId, venueId) {
  const dayKey = warsawDayKeyDateString(new Date());
  const r = await dbQuery(
    `SELECT 1 FROM counted_visits WHERE user_id=$1 AND venue_id=$2 AND day_key=$3::date LIMIT 1;`,
    [userId, venueId, dayKey]
  );
  return r.rowCount > 0;
}

async function addCountedVisit(userId, venueId) {
  const dayKey = warsawDayKeyDateString(new Date());
  // Avoid duplicates via check first (simple, Phase 1)
  const exists = await countedExistsToday(userId, venueId);
  if (exists) return { added: false, dayKey };

  await dbQuery(
    `INSERT INTO counted_visits(user_id, venue_id, day_key) VALUES ($1,$2,$3::date);`,
    [userId, venueId, dayKey]
  );
  return { added: true, dayKey };
}

async function getXY(userId, venueId) {
  const x = await dbQuery(`SELECT COUNT(*)::int AS c FROM counted_visits WHERE user_id=$1 AND venue_id=$2;`, [
    userId,
    venueId,
  ]);
  const y = await dbQuery(`SELECT COUNT(*)::int AS c FROM counted_visits WHERE venue_id=$1;`, [venueId]);
  return { X: x.rows[0]?.c || 0, Y: y.rows[0]?.c || 0 };
}

// ---------- Health ----------
app.get("/health", async (req, res) => {
  try {
    const t = await dbQuery(`SELECT NOW() AS now;`);
    res.json({ ok: true, db: true, now: t.rows[0]?.now, ts: nowUtcISO() });
  } catch (e) {
    res.json({ ok: true, db: false, error: String(e?.message || e), ts: nowUtcISO() });
  }
});

// ---------- PANEL (Stateless) ----------
app.get("/panel", (req, res) => {
  res.send(`
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Panel lokalu</title>
    </head>
    <body style="background:#0f1220;color:white;font-family:system-ui,Segoe UI,Arial;padding:40px;">
      <div style="max-width:720px;margin:0 auto;background:#14182b;padding:24px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);">
        <h2 style="margin:0 0 10px;">Panel lokalu</h2>
        <p style="opacity:.85;margin:0 0 18px;">Zaloguj się PIN-em lokalu</p>

        <form method="POST" action="/panel/login">
          <div style="display:flex;gap:12px;align-items:flex-end;">
            <div style="flex:1;">
              <label>Venue ID</label><br/>
              <input name="venue" placeholder="np. 1" style="width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0f1220;color:white;" />
            </div>
            <div style="flex:1;">
              <label>PIN (6 cyfr)</label><br/>
              <input name="pin" placeholder="123456" style="width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0f1220;color:white;" />
            </div>
          </div>

          <button type="submit" style="margin-top:14px;padding:10px 14px;border-radius:10px;border:0;background:#6e56ff;color:white;font-weight:700;cursor:pointer;">
            Zaloguj
          </button>
        </form>

        <div style="margin-top:16px;opacity:.7;font-size:13px;">
          Test: Venue 1 / PIN 123456
        </div>
      </div>
    </body>
  </html>
  `);
});

app.post("/panel/login", async (req, res) => {
  const venue = String(req.body.venue || "").trim();
  const pin = String(req.body.pin || "").trim();

  if (!venue || !pin) return res.redirect("/panel");

  const venueId = Number(venue);
  if (!Number.isFinite(venueId) || venueId <= 0) return res.redirect("/panel");

  const v = await verifyVenuePin(venueId, pin);
  if (!v.ok) return res.redirect("/panel");

  // Stateless redirect
  res.redirect(`/panel/${venueId}/${encodeURIComponent(pin)}`);
});

app.get("/panel/:venue/:pin", async (req, res) => {
  const venueId = Number(req.params.venue);
  const pin = decodeURIComponent(String(req.params.pin || ""));

  if (!Number.isFinite(venueId) || venueId <= 0) return res.redirect("/panel");

  const v = await verifyVenuePin(venueId, pin);
  if (!v.ok) return res.redirect("/panel");

  const venue = v.venue;

  // Pending list
  const pending = await dbQuery(
    `SELECT id, otp, user_id, expires_at
     FROM checkins
     WHERE venue_id=$1 AND confirmed_at IS NULL AND expires_at > NOW()
     ORDER BY expires_at ASC
     LIMIT 50;`,
    [venueId]
  );

  const pendingHtml =
    pending.rows.length === 0
      ? `<div style="opacity:.75;">Brak aktywnych check-inów</div>`
      : `<div style="display:flex;flex-direction:column;gap:10px;">
          ${pending.rows
            .map((r) => {
              return `<div style="padding:10px;border:1px solid #2a2f49;border-radius:12px;background:#0f1220;">
                <div><b>OTP:</b> ${safeHtml(r.otp)}</div>
                <div style="opacity:.8;font-size:13px;">Fox ID: ****${String(r.user_id).slice(-4)} | Expires: ${safeHtml(
                new Date(r.expires_at).toLocaleString("pl-PL")
              )}</div>
              </div>`;
            })
            .join("")}
        </div>`;

  res.send(`
  <html>
    <head><meta charset="utf-8"/><title>Panel lokalu</title></head>
    <body style="background:#0f1220;color:white;font-family:system-ui,Segoe UI,Arial;padding:40px;">
      <div style="max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:14px;">
        <div style="background:#14182b;padding:20px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);">
          <h2 style="margin:0 0 6px;">Panel lokalu</h2>
          <div style="opacity:.85;">Zalogowano: <b>${safeHtml(venue.name)}</b> (ID ${venueId})</div>
        </div>

        <div style="background:#14182b;padding:20px;border-radius:14px;">
          <h3 style="margin:0 0 10px;">Wprowadź OTP</h3>
          <form method="POST" action="/panel/${venueId}/${encodeURIComponent(pin)}/confirm" style="display:flex;gap:10px;align-items:center;">
            <input name="otp" placeholder="OTP (6 cyfr)" style="flex:1;padding:10px;border-radius:10px;border:1px solid #2a2f49;background:#0f1220;color:white;" />
            <button type="submit" style="padding:10px 14px;border-radius:10px;border:0;background:#6e56ff;color:white;font-weight:700;cursor:pointer;">Confirm</button>
          </form>
          <div style="margin-top:10px;opacity:.7;font-size:13px;">Tip: OTP ważny 10 minut.</div>
          <div style="margin-top:8px;"><a href="/panel" style="color:#9aa4ff;">Wyloguj</a></div>
        </div>

        <div style="background:#14182b;padding:20px;border-radius:14px;">
          <h3 style="margin:0 0 10px;">Pending check-ins (10 min)</h3>
          ${pendingHtml}
        </div>
      </div>
    </body>
  </html>
  `);
});

app.post("/panel/:venue/:pin/confirm", async (req, res) => {
  const venueId = Number(req.params.venue);
  const pin = decodeURIComponent(String(req.params.pin || ""));
  const otp = String(req.body.otp || "").trim();

  if (!Number.isFinite(venueId) || venueId <= 0) return res.redirect("/panel");
  if (!otp) return res.redirect(`/panel/${venueId}/${encodeURIComponent(pin)}`);

  const v = await verifyVenuePin(venueId, pin);
  if (!v.ok) return res.redirect("/panel");

  // Find valid pending checkin
  const r = await dbQuery(
    `SELECT id, user_id, expires_at, confirmed_at
     FROM checkins
     WHERE venue_id=$1 AND otp=$2
     ORDER BY id DESC
     LIMIT 1;`,
    [venueId, otp]
  );

  if (r.rowCount === 0) {
    return res.send(renderPanelResult("OTP nie znaleziono", `OTP: ${safeHtml(otp)}`, venueId, pin));
  }

  const checkin = r.rows[0];

  // Expired?
  if (new Date(checkin.expires_at).getTime() <= Date.now()) {
    return res.send(renderPanelResult("OTP wygasł", `OTP: ${safeHtml(otp)}`, venueId, pin));
  }

  // Already confirmed?
  if (checkin.confirmed_at) {
    return res.send(renderPanelResult("Już potwierdzono", `OTP: ${safeHtml(otp)}`, venueId, pin));
  }

  // Confirm it
  await dbQuery(`UPDATE checkins SET confirmed_at=NOW() WHERE id=$1;`, [checkin.id]);

  const userId = Number(checkin.user_id);

  // Counted (1/day)
  const counted = await addCountedVisit(userId, venueId);
  const xy = await getXY(userId, venueId);

  const dayKey = counted.dayKey;
  const venue = v.venue;

  // Notify fox in Telegram
  if (bot) {
    try {
      if (!counted.added) {
        await bot.telegram.sendMessage(
          userId,
          `DZIŚ JUŻ BYŁO ✅\nLokal: ${venue.name}\nDzień (Warszawa): ${dayKey}\nX/Y: ${xy.X}/${xy.Y}`
        );
      } else {
        await bot.telegram.sendMessage(
          userId,
          `✅ Confirm OK\n🏪 ${venue.name}\n📅 Day (Warszawa): ${dayKey}\n📊 X/Y: ${xy.X}/${xy.Y}`
        );
      }
    } catch (e) {
      console.error("Telegram sendMessage error:", e?.message || e);
    }
  }

  if (!counted.added) {
    return res.send(
      renderPanelResult(
        "DZIŚ JUŻ BYŁO ✅",
        `Lokal: ${safeHtml(venue.name)}<br/>Dzień (Warszawa): ${safeHtml(dayKey)}<br/>X/Y: ${xy.X}/${xy.Y}`,
        venueId,
        pin
      )
    );
  }

  return res.send(
    renderPanelResult(
      "Confirm OK ✅",
      `Lokal: ${safeHtml(venue.name)}<br/>OTP: ${safeHtml(otp)}<br/>Dzień (Warszawa): ${safeHtml(dayKey)}<br/>X/Y: ${xy.X}/${xy.Y}`,
      venueId,
      pin
    )
  );
});

function renderPanelResult(title, bodyHtml, venueId, pin) {
  return `
  <html>
    <head><meta charset="utf-8"/><title>${safeHtml(title)}</title></head>
    <body style="background:#0f1220;color:white;font-family:system-ui,Segoe UI,Arial;padding:40px;">
      <div style="max-width:720px;margin:0 auto;background:#14182b;padding:24px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);">
        <h2 style="margin:0 0 10px;">${safeHtml(title)}</h2>
        <div style="opacity:.9;line-height:1.5;">${bodyHtml}</div>
        <div style="margin-top:16px;display:flex;gap:10px;">
          <a href="/panel/${venueId}/${encodeURIComponent(pin)}" style="color:#9aa4ff;">Powrót</a>
          <a href="/panel" style="color:#9aa4ff;">Wyloguj</a>
        </div>
      </div>
    </body>
  </html>`;
}

// ---------- TELEGRAM BOT ----------
async function listVenuesText() {
  const r = await dbQuery(`SELECT id, name, city FROM venues ORDER BY id ASC LIMIT 50;`);
  if (r.rowCount === 0) return "Brak lokali.";
  return r.rows.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`).join("\n");
}

if (bot) {
  bot.start(async (ctx) => {
    const text =
      `THE FOXPOT CLUB — MVP\n\n` +
      `Komendy:\n` +
      `/venues — lista lokali\n` +
      `/panel — link do Panelu lokalu\n` +
      `/checkin <venue_id> — check-in (OTP 10 min)\n\n` +
      `Przykład: /checkin 1`;
    await ctx.reply(text);
  });

  bot.command("venues", async (ctx) => {
    try {
      const t = await listVenuesText();
      await ctx.reply(`🏪 Lokale (testowe)\n\n${t}\n\nCheck-in: /checkin 1`);
    } catch (e) {
      await ctx.reply("Błąd /venues.");
    }
  });

  bot.command("panel", async (ctx) => {
    await ctx.reply(`Panel lokalu: ${panelUrl()}`);
  });

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

      await upsertFox(userId, username);

      // Block counted today (Phase 1)
      const exists = await countedExistsToday(userId, venueId);
      const dayKey = warsawDayKeyDateString(new Date());

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
      const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await dbQuery(
        `INSERT INTO checkins(venue_id, user_id, otp, expires_at) VALUES ($1,$2,$3,$4);`,
        [venueId, userId, otp, expires.toISOString()]
      );

      await ctx.reply(
        `✅ Check-in utworzony (10 min)\n\n` +
          `🏪 ${v.name}\n` +
          `🔐 OTP: ${otp}\n\n` +
          `Personel potwierdza w Panelu.\n` +
          `Panel: ${panelUrl()}`
      );
    } catch (e) {
      console.error("checkin error:", e?.message || e);
      await ctx.reply("Błąd check-in.");
    }
  });

  // Webhook: if you already have it set earlier, keep it.
  // For Phase 1 simplest: Telegram long-polling is blocked on Railway sometimes, so we just rely on your existing webhook setup.
  // We still start bot in "webhook mode" using express if WEBHOOK_SECRET is provided.
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
  if (WEBHOOK_SECRET && PUBLIC_URL) {
    const path = `/${WEBHOOK_SECRET.replace(/^\//, "")}`;
    bot.telegram.setWebhook(`${PUBLIC_URL.replace(/\/$/, "")}${path}`).then(() => {
      console.log("✅ Webhook set:", path);
    }).catch((e) => {
      console.error("Webhook set error:", e?.message || e);
    });

    app.use(bot.webhookCallback(path));
    console.log("✅ Webhook path ready:", path);
  } else {
    console.log("ℹ️ WEBHOOK_SECRET or PUBLIC_URL missing — webhook not set here.");
    // NOTE: If you used webhook earlier, keep it in Railway variables and it will work.
  }
}

// ---------- Boot ----------
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
