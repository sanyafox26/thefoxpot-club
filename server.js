/**
 * The FoxPot Club — server.js (FULL FILE, HARDENED MIGRATIONS + FIXED CHECKIN INSERT)
 *
 * Fixes:
 * - Auto-add missing columns (fox_id, confirmed_at, etc.) in existing tables
 * - Create indexes only after columns exist (non-fatal)
 * - FIX: expires_at interval calculation (prevents "Error creating check-in")
 *
 * Required ENV:
 * - DATABASE_URL
 * - BOT_TOKEN
 * - PUBLIC_URL
 * - WEBHOOK_SECRET
 *
 * Optional:
 * - ADMIN_USER_ID
 * - NODE_ENV=production
 */

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Telegraf } = require("telegraf");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : "";

if (!DATABASE_URL) throw new Error("Missing env: DATABASE_URL");
if (!BOT_TOKEN) throw new Error("Missing env: BOT_TOKEN");
if (!PUBLIC_URL) throw new Error("Missing env: PUBLIC_URL");
if (!WEBHOOK_SECRET) throw new Error("Missing env: WEBHOOK_SECRET");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// ---------------- helpers ----------------
function nowISO() {
  return new Date().toISOString();
}

function warsawDayISO(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}

function randOTP6() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function pbkdf2Hex(pin, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.pbkdf2Sync(String(pin), salt, 120000, 32, "sha256").toString("hex");
}

// simple cookie signing
function signCookie(payload) {
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sha256Hex(raw + "|" + WEBHOOK_SECRET);
  return `${raw}.${sig}`;
}
function verifyCookie(cookieVal) {
  if (!cookieVal) return null;
  const parts = cookieVal.split(".");
  if (parts.length !== 2) return null;
  const [raw, sig] = parts;
  const exp = sha256Hex(raw + "|" + WEBHOOK_SECRET);
  if (sig !== exp) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function getCookie(req, name) {
  const h = req.headers.cookie || "";
  const items = h.split(";").map(s => s.trim()).filter(Boolean);
  for (const it of items) {
    const idx = it.indexOf("=");
    if (idx === -1) continue;
    const k = it.slice(0, idx).trim();
    const v = it.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}
function setCookie(res, name, value) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`);
}
function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

// ---------------- DB schema helpers ----------------
async function columnExists(tableName, columnName) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2
    LIMIT 1;
  `;
  const { rows } = await pool.query(q, [tableName, columnName]);
  return rows.length > 0;
}

async function addColumnIfMissing(tableName, columnName, columnTypeSQL) {
  const exists = await columnExists(tableName, columnName);
  if (exists) return;
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnTypeSQL};`);
}

async function safeQuery(sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    console.error("⚠️ DB non-fatal:", e.message);
  }
}

async function ensureTablesAndMigrations() {
  // baseline tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pin_salt TEXT,
      pin_hash TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS foxes (
      id BIGINT PRIMARY KEY,
      username TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      venue_id INT,
      fox_id BIGINT,
      otp TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      day_warsaw DATE,
      confirmed_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS counted_visits (
      id SERIAL PRIMARY KEY,
      venue_id INT,
      fox_id BIGINT,
      day_warsaw DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_status_events (
      id SERIAL PRIMARY KEY,
      venue_id INT,
      kind TEXT NOT NULL,
      reason TEXT,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_stamps (
      id SERIAL PRIMARY KEY,
      venue_id INT,
      fox_id BIGINT,
      balance INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS venue_stamp_events (
      id SERIAL PRIMARY KEY,
      venue_id INT,
      fox_id BIGINT,
      delta INT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // hard migrations for older schemas
  await addColumnIfMissing("venues", "pin_salt", "TEXT");
  await addColumnIfMissing("venues", "pin_hash", "TEXT");
  await addColumnIfMissing("venues", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await addColumnIfMissing("venues", "city", "TEXT");
  await addColumnIfMissing("venues", "name", "TEXT");

  await addColumnIfMissing("foxes", "username", "TEXT");
  await addColumnIfMissing("foxes", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await addColumnIfMissing("checkins", "venue_id", "INT");
  await addColumnIfMissing("checkins", "fox_id", "BIGINT");
  await addColumnIfMissing("checkins", "otp", "TEXT");
  await addColumnIfMissing("checkins", "expires_at", "TIMESTAMPTZ");
  await addColumnIfMissing("checkins", "day_warsaw", "DATE");
  await addColumnIfMissing("checkins", "confirmed_at", "TIMESTAMPTZ");
  await addColumnIfMissing("checkins", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await addColumnIfMissing("counted_visits", "venue_id", "INT");
  await addColumnIfMissing("counted_visits", "fox_id", "BIGINT");
  await addColumnIfMissing("counted_visits", "day_warsaw", "DATE");
  await addColumnIfMissing("counted_visits", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await addColumnIfMissing("venue_status_events", "venue_id", "INT");
  await addColumnIfMissing("venue_status_events", "kind", "TEXT");
  await addColumnIfMissing("venue_status_events", "reason", "TEXT");
  await addColumnIfMissing("venue_status_events", "starts_at", "TIMESTAMPTZ");
  await addColumnIfMissing("venue_status_events", "ends_at", "TIMESTAMPTZ");
  await addColumnIfMissing("venue_status_events", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await addColumnIfMissing("venue_stamps", "venue_id", "INT");
  await addColumnIfMissing("venue_stamps", "fox_id", "BIGINT");
  await addColumnIfMissing("venue_stamps", "balance", "INT NOT NULL DEFAULT 0");
  await addColumnIfMissing("venue_stamps", "updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  await addColumnIfMissing("venue_stamp_events", "venue_id", "INT");
  await addColumnIfMissing("venue_stamp_events", "fox_id", "BIGINT");
  await addColumnIfMissing("venue_stamp_events", "delta", "INT NOT NULL DEFAULT 0");
  await addColumnIfMissing("venue_stamp_events", "note", "TEXT");
  await addColumnIfMissing("venue_stamp_events", "created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");

  // constraints + indexes (non-fatal)
  await safeQuery(`
    ALTER TABLE checkins
    ADD CONSTRAINT IF NOT EXISTS checkins_venue_fk
    FOREIGN KEY (venue_id) REFERENCES venues(id);
  `);
  await safeQuery(`
    ALTER TABLE checkins
    ADD CONSTRAINT IF NOT EXISTS checkins_fox_fk
    FOREIGN KEY (fox_id) REFERENCES foxes(id);
  `);

  await safeQuery(`
    ALTER TABLE counted_visits
    ADD CONSTRAINT IF NOT EXISTS counted_visits_venue_fk
    FOREIGN KEY (venue_id) REFERENCES venues(id);
  `);
  await safeQuery(`
    ALTER TABLE counted_visits
    ADD CONSTRAINT IF NOT EXISTS counted_visits_fox_fk
    FOREIGN KEY (fox_id) REFERENCES foxes(id);
  `);

  await safeQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS checkins_unique_daily
    ON checkins (venue_id, fox_id, day_warsaw)
    WHERE confirmed_at IS NOT NULL;
  `);

  await safeQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS counted_visits_unique_daily
    ON counted_visits (venue_id, fox_id, day_warsaw);
  `);

  await safeQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS venue_stamps_unique
    ON venue_stamps (venue_id, fox_id);
  `);
}

async function ensureTestVenues() {
  const { rows } = await pool.query(`SELECT id FROM venues ORDER BY id LIMIT 1;`);
  if (rows.length > 0) return;

  const pin = "123456";
  function mk(pinPlain) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = pbkdf2Hex(pinPlain, salt);
    return { salt, hash };
  }

  const v1 = mk(pin);
  const v2 = mk(pin);

  await pool.query(
    `INSERT INTO venues (name, city, pin_salt, pin_hash) VALUES
     ($1,$2,$3,$4), ($5,$6,$7,$8);`,
    ["Test Kebab #1", "Warsaw", v1.salt, v1.hash, "Test Pizza #2", "Warsaw", v2.salt, v2.hash]
  );
}

// ---------------- HEALTH ----------------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1 as ok;");
    res.json({ ok: true, db: true, ts: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e), ts: nowISO() });
  }
});

// ---------------- PANEL ----------------
async function getVenueById(venueId) {
  const { rows } = await pool.query(
    `SELECT id, name, city, pin_salt, pin_hash FROM venues WHERE id=$1`,
    [venueId]
  );
  return rows[0] || null;
}

async function getCurrentStatus(venueId) {
  const { rows } = await pool.query(
    `SELECT kind, reason, starts_at, ends_at
     FROM venue_status_events
     WHERE venue_id=$1 AND starts_at <= NOW() AND ends_at >= NOW()
     ORDER BY created_at DESC
     LIMIT 10;`,
    [venueId]
  );
  const reserve = rows.find(r => r.kind === "reserve") || null;
  const limited = rows.find(r => r.kind === "limited") || null;
  return { reserve, limited };
}

function panelLayout(title, innerHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; background:#0b0b10; color:#fff; margin:0; padding:24px;}
    .card{max-width:920px;margin:0 auto;background:#141421;border:1px solid #2a2a40;border-radius:14px;padding:18px;}
    h1{font-size:20px;margin:0 0 12px}
    h2{font-size:16px;margin:18px 0 10px}
    input,select,button{padding:10px 12px;border-radius:10px;border:1px solid #33334d;background:#0f0f19;color:#fff;outline:none;}
    input{width:100%;box-sizing:border-box}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .row>div{flex:1;min-width:220px}
    button{cursor:pointer;background:#5b2cff;border-color:#5b2cff;font-weight:700}
    .muted{color:#b7b7d6;font-size:12px}
    .ok{color:#6dffb3;font-weight:700}
    .sep{height:1px;background:#2a2a40;margin:14px 0}
    code{background:#0f0f19;padding:2px 6px;border-radius:8px}
  </style>
</head>
<body>
  <div class="card">
    ${innerHtml}
  </div>
</body>
</html>`;
}

app.get("/panel", async (req, res) => {
  const sess = verifyCookie(getCookie(req, "fp_panel"));
  if (!sess || !sess.venue_id) {
    const html = panelLayout("Panel lokalu", `
      <h1>Panel lokalu</h1>
      <div class="muted">Zaloguj się PIN-em lokalu</div>
      <div class="sep"></div>
      <form method="POST" action="/panel/login">
        <div class="row">
          <div>
            <div class="muted">Venue ID</div>
            <input name="venue_id" placeholder="np. 1" required />
          </div>
          <div>
            <div class="muted">PIN (6 cyfr)</div>
            <input name="pin" placeholder="123456" required />
          </div>
        </div>
        <div style="margin-top:12px">
          <button type="submit">Zaloguj</button>
        </div>
      </form>
    `);
    return res.status(200).send(html);
  }

  const venue = await getVenueById(sess.venue_id);
  if (!venue) {
    clearCookie(res, "fp_panel");
    return res.redirect("/panel");
  }

  const status = await getCurrentStatus(venue.id);

  const { rows: pend } = await pool.query(
    `SELECT c.id, c.otp, c.fox_id, c.expires_at, f.username
     FROM checkins c
     JOIN foxes f ON f.id=c.fox_id
     WHERE c.venue_id=$1 AND (c.confirmed_at IS NULL) AND c.expires_at >= NOW()
     ORDER BY c.created_at DESC
     LIMIT 20;`,
    [venue.id]
  );

  const pendingHtml = pend.length
    ? pend.map(p => {
        const uname = p.username ? `@${p.username}` : "(no username)";
        const exp = new Date(p.expires_at).toISOString();
        return `<div style="padding:10px;border:1px solid #2a2a40;border-radius:12px;margin:8px 0">
          <div><b>OTP:</b> <code>${p.otp}</code></div>
          <div class="muted">Fox: ${uname} (ID ${String(p.fox_id).slice(0,4)}****)</div>
          <div class="muted">Expires: ${exp}</div>
        </div>`;
      }).join("")
    : `<div class="muted">—</div>`;

  const html = panelLayout("Panel lokalu", `
    <h1>Panel lokalu</h1>
    <div>🏪 <b>${venue.name}</b> (ID ${venue.id})</div>
    <div class="muted">City: ${venue.city}</div>
    <div class="ok" style="margin-top:6px">OK</div>

    <div class="sep"></div>

    <form method="POST" action="/panel/confirm">
      <h2>OTP (6 cyfr)</h2>
      <div class="row">
        <div>
          <input name="otp" placeholder="123456" required />
        </div>
        <div style="min-width:160px;flex:0">
          <button type="submit">Potwierdź</button>
        </div>
      </div>
      <div class="muted">Potwierdzenie check-in: przez Panel</div>
    </form>

    <div style="margin-top:10px">
      <form method="POST" action="/panel/logout">
        <button type="submit" style="background:#2a2a40;border-color:#2a2a40">Wyloguj</button>
      </form>
    </div>

    <div class="sep"></div>

    <h2>Statusy lokalu</h2>
    <div class="muted">Rezerwa: ${status.reserve ? "ON" : "—"} | Dziś ograniczone: ${status.limited ? "ON" : "—"}</div>

    <div class="sep"></div>

    <h2>Szybko z pending</h2>
    <div class="muted">Pending check-ins (10 min)</div>
    ${pendingHtml}
  `);

  res.status(200).send(html);
});

app.post("/panel/login", async (req, res) => {
  try {
    const venueId = Number(req.body.venue_id);
    const pin = String(req.body.pin || "").trim();
    if (!venueId || pin.length < 4) return res.redirect("/panel");

    const venue = await getVenueById(venueId);
    if (!venue || !venue.pin_salt || !venue.pin_hash) return res.redirect("/panel");

    const computed = pbkdf2Hex(pin, venue.pin_salt);
    if (computed !== venue.pin_hash) return res.redirect("/panel");

    setCookie(res, "fp_panel", signCookie({ venue_id: venue.id, ts: Date.now() }));
    return res.redirect("/panel");
  } catch {
    return res.redirect("/panel");
  }
});

app.post("/panel/logout", async (req, res) => {
  clearCookie(res, "fp_panel");
  res.redirect("/panel");
});

app.post("/panel/confirm", async (req, res) => {
  const sess = verifyCookie(getCookie(req, "fp_panel"));
  if (!sess || !sess.venue_id) return res.redirect("/panel");

  const venueId = Number(sess.venue_id);
  const otp = String(req.body.otp || "").trim();
  if (!/^\d{6}$/.test(otp)) return res.redirect("/panel");

  const { rows } = await pool.query(
    `SELECT id, fox_id, day_warsaw
     FROM checkins
     WHERE venue_id=$1 AND otp=$2 AND confirmed_at IS NULL AND expires_at >= NOW()
     ORDER BY created_at DESC
     LIMIT 1;`,
    [venueId, otp]
  );

  if (!rows.length) return res.redirect("/panel");

  const checkinId = rows[0].id;
  const foxId = rows[0].fox_id;
  const day = rows[0].day_warsaw;

  await pool.query(`UPDATE checkins SET confirmed_at=NOW() WHERE id=$1;`, [checkinId]);

  await pool.query(
    `INSERT INTO counted_visits (venue_id, fox_id, day_warsaw)
     VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING;`,
    [venueId, foxId, day]
  );

  try {
    await bot.telegram.sendMessage(
      foxId,
      `✅ Confirm OK\nLokal: Test (ID ${venueId})\nDzień (Warszawa): ${day}\n\nDZIŚ JUŻ BYŁO ✅\nSpróbuj jutro po 00:00 (Warszawa).`
    );
  } catch {}

  res.redirect("/panel");
});

// ---------------- Telegram bot ----------------
const bot = new Telegraf(BOT_TOKEN);

app.post(`/${WEBHOOK_SECRET}`, (req, res) => bot.handleUpdate(req.body, res));

bot.start(async (ctx) => {
  await ctx.reply(
    "The FoxPot Club ✅\n\nKomandy:\n/checkin <venue_id>\n\nPotwierdzenie teraz TYLKO przez Panel (PIN + OTP)."
  );
});

bot.command("checkin", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").trim().split(/\s+/);
    const venueId = Number(parts[1]);
    if (!venueId) return ctx.reply("❌ Napisz tak: /checkin 1");

    const foxId = String(ctx.from.id);
    const username = ctx.from.username ? String(ctx.from.username) : null;

    await pool.query(
      `INSERT INTO foxes (id, username) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username;`,
      [foxId, username]
    );

    const { rows } = await pool.query(`SELECT id, name FROM venues WHERE id=$1`, [venueId]);
    if (!rows.length) return ctx.reply("❌ Nie ma takiego lokalu.");
    const venue = rows[0];

    const otp = randOTP6();
    const day = warsawDayISO(new Date());
    const expiresMinutes = 10;

    // ✅ FIXED interval math
    await pool.query(
      `INSERT INTO checkins (venue_id, fox_id, otp, expires_at, day_warsaw)
       VALUES ($1,$2,$3, NOW() + ($4::int * interval '1 minute'), $5::date);`,
      [venueId, foxId, otp, expiresMinutes, day]
    );

    await ctx.reply(
      `✅ Check-in utworzony (10 min)\n\n🏪 ${venue.name}\n🔐 OTP: ${otp}\n\nPersonel potwierdza w Panelu.\nPanel: ${PUBLIC_URL}/panel`
    );
  } catch (e) {
    console.error("checkin error:", e); // важливо: у Railway logs буде точна причина
    return ctx.reply("❌ Error creating check-in");
  }
});

// ---------------- boot ----------------
(async () => {
  await ensureTablesAndMigrations();
  await ensureTestVenues();

  await bot.telegram.setWebhook(`${PUBLIC_URL}/${WEBHOOK_SECRET}`);

  app.listen(PORT, () => {
    console.log(`✅ Server listening on ${PORT}`);
    console.log(`✅ Webhook path ready: /${WEBHOOK_SECRET}`);
  });
})();
