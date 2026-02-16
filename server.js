/**
 * The FoxPot Club — Phase 1 MVP (Warsaw)
 * Node.js + Express + Telegraf + Postgres (Railway)
 *
 * LOCKED:
 * - Map public, discounts only for Fox via invite OR subscription (subscription not implemented here)
 * - /checkin <venue_id> => OTP 6 digits, TTL 10 min
 * - Staff confirms OTP in Web Panel (/panel)
 * - Without confirm: 0 counted / 0 stats / 0 rewards
 * - Counted Visit: max 1/day/venue/Fox (reset 00:00 Europe/Warsaw)
 * - Confirm debounce 15 min
 * - If already counted today => "DZIŚ JUŻ BYŁO ✅"
 * - X/Y: X = Fox lifetime counted visits in this venue; Y = venue lifetime counted visits
 *
 * NEW (STEP 2):
 * - Invite codes for Fox:
 *   /invite => consumes 1 invite, generates code (single-use)
 *   /start <code> => registration ONLY with invite code for new Fox
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
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL");
}
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const bot = new Telegraf(BOT_TOKEN);

// -------------------------
// Time helpers (Europe/Warsaw)
// -------------------------
function warsawNow() {
  return new Date();
}

function warsawDayISO(date = new Date()) {
  // "en-CA" => YYYY-MM-DD
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
// Minimal IP rate limit (panel login)
// -------------------------
const ipFails = new Map(); // ip => { count, until }
function ipNowMs() {
  return Date.now();
}
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf && typeof xf === "string") return xf.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
function isIpBlocked(ip) {
  const rec = ipFails.get(ip);
  if (!rec) return false;
  if (rec.until && rec.until > ipNowMs()) return true;
  if (rec.until && rec.until <= ipNowMs()) {
    ipFails.delete(ip);
    return false;
  }
  return false;
}
function addIpFail(ip) {
  const rec = ipFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 10) {
    rec.until = ipNowMs() + 15 * 60000;
  }
  ipFails.set(ip, rec);
}
function resetIpFail(ip) {
  ipFails.delete(ip);
}

// -------------------------
// DB: self-migrations
// -------------------------
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Foxes
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

    // Venues
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

    // Checkins (OTP)
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

    // Counted visits (1/day/venue/fox)
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fp1_counted_venue ON fp1_counted_visits(venue_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fp1_counted_fox ON fp1_counted_visits(fox_id);`);

    // Invite codes
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

    // Venue reserve logs (optional)
    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_venue_reserve_logs (
        id BIGSERIAL PRIMARY KEY,
        venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
        reserve_start TIMESTAMPTZ NOT NULL,
        reserve_end TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Venue limited logs (optional)
    await client.query(`
      CREATE TABLE IF NOT EXISTS fp1_venue_limited_logs (
        id BIGSERIAL PRIMARY KEY,
        venue_id BIGINT NOT NULL REFERENCES fp1_venues(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        limited_until TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Ensure we have at least 2 test venues
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

// -------------------------
// DB helpers
// -------------------------
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
  const r = await dbOne(
    `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites, referred_by_code, referred_by_fox_id)
     VALUES($1,$2,'Warsaw',1,3,$3,$4)
     RETURNING *`,
    [String(tg_id), tg_username || null, referred_by_code || null, referred_by_fox_id || null]
  );
  return r;
}

async function getVenue(venue_id) {
  return dbOne(`SELECT * FROM fp1_venues WHERE id=$1`, [String(venue_id)]);
}

async function getVenueStats(venue_id, fox_id) {
  const x = await dbOne(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1 AND fox_id=$2`,
    [String(venue_id), String(fox_id)]
  );
  const y = await dbOne(
    `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE venue_id=$1`,
    [String(venue_id)]
  );
  return { X: x?.c || 0, Y: y?.c || 0 };
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
  // 8 chars, upper, no confusing
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Telegram send safe
async function tgSendSafe(chatId, text) {
  try {
    await bot.telegram.sendMessage(chatId, text, { disable_web_page_preview: true });
  } catch (e) {
    console.warn("⚠️ Telegram send fail:", e?.message || e);
  }
}

// -------------------------
// Health
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

// -------------------------
// Web Panel (stateless, no cookies)
// -------------------------
function htmlPage(title, body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;background:#0b0d10;color:#e7e7e7}
    .card{max-width:860px;margin:0 auto;background:#131821;border:1px solid #222a36;border-radius:14px;padding:18px}
    input,select,button{font-size:16px;padding:10px 12px;border-radius:10px;border:1px solid #2b3442;background:#0f131a;color:#e7e7e7}
    button{cursor:pointer}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .muted{color:#9aa7b8;font-size:13px}
    .ok{color:#86efac}
    .bad{color:#fca5a5}
    a{color:#93c5fd}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{border-bottom:1px solid #263042;padding:10px;text-align:left;font-size:14px}
    .pill{display:inline-block;padding:4px 10px;border-radius:999px;background:#0f131a;border:1px solid #2b3442;font-size:12px}
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}

app.get("/panel", async (req, res) => {
  const body = `
    <h2>FoxPot Club — Panel lokalu</h2>
    <p class="muted">Logowanie: Venue ID + PIN (6 cyfr). Panel jest stateless (bez cookies).</p>

    <form method="POST" action="/panel/login">
      <div class="row">
        <input name="venue_id" placeholder="Venue ID" inputmode="numeric" />
        <input name="pin" placeholder="PIN (6 cyfr)" inputmode="numeric" />
        <button type="submit">Zaloguj</button>
      </div>
    </form>

    <p class="muted">Panel: confirm OTP → counted visit → X/Y aktualizacja → Telegram notify (jeśli możliwe).</p>
  `;
  res.send(htmlPage("Panel", body));
});

app.post("/panel/login", async (req, res) => {
  const ip = getClientIp(req);
  if (isIpBlocked(ip)) {
    return res.status(429).send(htmlPage("Panel", `<h3 class="bad">Zablokowano na 15 min</h3><p class="muted">Za dużo błędnych prób z tego IP.</p>`));
  }

  const venue_id = String(req.body.venue_id || "").trim();
  const pin = String(req.body.pin || "").trim();

  const venue = await getVenue(venue_id);
  if (!venue || String(venue.pin) !== pin) {
    addIpFail(ip);
    return res
      .status(401)
      .send(htmlPage("Panel", `<h3 class="bad">Błędne dane</h3><p class="muted">Sprawdź Venue ID i PIN.</p><p><a href="/panel">Wróć</a></p>`));
  }

  resetIpFail(ip);

  // Render dashboard with hidden venue_id+pin (stateless)
  return renderDashboard(res, venue_id, pin, null);
});

async function renderDashboard(res, venue_id, pin, msg) {
  const venue = await getVenue(venue_id);
  if (!venue || String(venue.pin) !== String(pin)) {
    return res.status(401).send(htmlPage("Panel", `<h3 class="bad">Sesja wygasła</h3><p><a href="/panel">Zaloguj ponownie</a></p>`));
  }

  const now = new Date();
  const day = warsawDayISO(now);

  // Pending checkins for this venue within TTL and not confirmed
  const pending = await dbMany(
    `SELECT c.id, c.otp, c.created_at, c.expires_at, f.tg_username, f.tg_id
     FROM fp1_checkins c
     JOIN fp1_foxes f ON f.id=c.fox_id
     WHERE c.venue_id=$1
       AND c.confirmed_at IS NULL
       AND c.expires_at > NOW()
     ORDER BY c.created_at DESC
     LIMIT 50`,
    [String(venue_id)]
  );

  // Status pills
  let statusHtml = "";
  const reserveActive = venue.reserve_start && venue.reserve_end && new Date(venue.reserve_start) <= now && now <= new Date(venue.reserve_end);
  const reserveFuture = venue.reserve_start && venue.reserve_end && now < new Date(venue.reserve_start);
  const limitedActive = venue.limited_until && now <= new Date(venue.limited_until);

  if (reserveActive) {
    statusHtml += `<span class="pill">📍 Rezerwa: AKTYWNA do ${new Date(venue.reserve_end).toLocaleString("pl-PL")}</span> `;
  } else if (reserveFuture) {
    statusHtml += `<span class="pill">📍 Rezerwa: ZAPLANOWANA od ${new Date(venue.reserve_start).toLocaleString("pl-PL")} do ${new Date(venue.reserve_end).toLocaleString("pl-PL")}</span> `;
  }
  if (limitedActive) {
    statusHtml += `<span class="pill">⚠️ Dziś ograniczone: ${venue.limited_reason || "LIMIT"} do ${new Date(venue.limited_until).toLocaleString("pl-PL")}</span> `;
  }
  if (!statusHtml) statusHtml = `<span class="pill">✅ Brak ograniczeń</span>`;

  const body = `
    <h2>Panel lokalu — ${venue.name}</h2>
    <p class="muted">Dzień (Warszawa): <b>${day}</b></p>
    <div>${statusHtml}</div>
    ${msg ? `<p class="${msg.ok ? "ok" : "bad"}"><b>${msg.text}</b></p>` : ""}

    <hr style="border:0;border-top:1px solid #263042;margin:14px 0"/>

    <h3>Confirm OTP</h3>
    <form method="POST" action="/panel/confirm">
      <input type="hidden" name="venue_id" value="${String(venue_id)}"/>
      <input type="hidden" name="pin" value="${String(pin)}"/>
      <div class="row">
        <input name="otp" placeholder="OTP (6 cyfr)" inputmode="numeric" />
        <button type="submit">Confirm</button>
        <button type="submit" formaction="/panel/refresh">Refresh</button>
      </div>
    </form>

    <h3>Pending check-ins (10 min)</h3>
    <table>
      <thead><tr><th>OTP</th><th>Fox</th><th>Utworzono</th><th>Ważne do</th></tr></thead>
      <tbody>
        ${
          pending.length
            ? pending
                .map((p) => {
                  const foxName = p.tg_username ? `@${p.tg_username}` : maskTgId(p.tg_id);
                  return `<tr>
                    <td><b>${p.otp}</b></td>
                    <td>${foxName}</td>
                    <td>${new Date(p.created_at).toLocaleString("pl-PL")}</td>
                    <td>${new Date(p.expires_at).toLocaleString("pl-PL")}</td>
                  </tr>`;
                })
                .join("")
            : `<tr><td colspan="4" class="muted">Brak pending.</td></tr>`
        }
      </tbody>
    </table>

    <p class="muted">Bez confirm w panelu: 0 counted / 0 stat / 0 rewards.</p>
    <p class="muted"><a href="/panel">Wyloguj</a></p>
  `;
  res.send(htmlPage("Panel dashboard", body));
}

app.post("/panel/refresh", async (req, res) => {
  const venue_id = String(req.body.venue_id || "").trim();
  const pin = String(req.body.pin || "").trim();
  return renderDashboard(res, venue_id, pin, null);
});

app.post("/panel/confirm", async (req, res) => {
  const venue_id = String(req.body.venue_id || "").trim();
  const pin = String(req.body.pin || "").trim();
  const otp = String(req.body.otp || "").trim();

  const venue = await getVenue(venue_id);
  if (!venue || String(venue.pin) !== pin) {
    return res.status(401).send(htmlPage("Panel", `<h3 class="bad">Błędne dane</h3><p><a href="/panel">Wróć</a></p>`));
  }

  if (!/^\d{6}$/.test(otp)) {
    return renderDashboard(res, venue_id, pin, { ok: false, text: "OTP musi mieć 6 cyfr." });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Find latest valid pending checkin by OTP
      const checkin = await client.query(
        `SELECT * FROM fp1_checkins
         WHERE venue_id=$1 AND otp=$2
         ORDER BY created_at DESC
         LIMIT 1`,
        [String(venue_id), otp]
      );

      const c = checkin.rows[0];
      if (!c) {
        await client.query("ROLLBACK");
        return renderDashboard(res, venue_id, pin, { ok: false, text: "Nie znaleziono OTP." });
      }

      const now = new Date();
      if (c.confirmed_at) {
        // Debounce: already confirmed
        await client.query("ROLLBACK");
        return renderDashboard(res, venue_id, pin, { ok: true, text: "✅ Już potwierdzone (debounce)." });
      }

      if (new Date(c.expires_at) <= now) {
        await client.query("ROLLBACK");
        return renderDashboard(res, venue_id, pin, { ok: false, text: "OTP wygasło." });
      }

      // Confirm it now
      await client.query(
        `UPDATE fp1_checkins SET confirmed_at=NOW(), confirmed_by=$1 WHERE id=$2`,
        [`panel:${venue_id}`, c.id]
      );

      const day = warsawDayISO(now);

      // Insert counted visit (unique per day)
      const ins = await client.query(
        `INSERT INTO fp1_counted_visits(venue_id, fox_id, day_warsaw, source_checkin_id)
         VALUES($1,$2,$3::date,$4)
         ON CONFLICT (venue_id, fox_id, day_warsaw) DO NOTHING
         RETURNING id`,
        [String(venue_id), String(c.fox_id), day, String(c.id)]
      );

      // If already counted today => message "DZIŚ JUŻ BYŁO ✅"
      if (ins.rows.length === 0) {
        await client.query("COMMIT");

        // Notify fox
        const fox = await dbOne(`SELECT * FROM fp1_foxes WHERE id=$1`, [String(c.fox_id)]);
        if (fox) {
          await tgSendSafe(
            fox.tg_id,
            `DZIŚ JUŻ BYŁO ✅\nLokal: ${venue.name}\nDzień (Warszawa): ${day}\nSpróbuj jutro po 00:00 (Warszawa).`
          );
        }

        return renderDashboard(res, venue_id, pin, { ok: true, text: "DZIŚ JUŻ BYŁO ✅ (counted już jest na dziś)" });
      }

      // Reward logic on confirmed counted visit:
      // - rating +1
      // - every 5 counted visits total => +1 invite (simple MVP)
      await client.query(`UPDATE fp1_foxes SET rating = rating + 1 WHERE id=$1`, [String(c.fox_id)]);

      // Total counted visits for fox
      const total = await client.query(
        `SELECT COUNT(*)::int AS c FROM fp1_counted_visits WHERE fox_id=$1`,
        [String(c.fox_id)]
      );
      const totalCounted = total.rows[0]?.c || 0;

      // If totalCounted is multiple of 5 => +1 invite
      if (totalCounted > 0 && totalCounted % 5 === 0) {
        await client.query(`UPDATE fp1_foxes SET invites = invites + 1 WHERE id=$1`, [String(c.fox_id)]);
      }

      await client.query("COMMIT");

      // Notify fox with X/Y
      const fox = await dbOne(`SELECT * FROM fp1_foxes WHERE id=$1`, [String(c.fox_id)]);
      const stats = await getVenueStats(venue_id, c.fox_id);
      if (fox) {
        const foxName = fox.tg_username ? `@${fox.tg_username}` : maskTgId(fox.tg_id);
        await tgSendSafe(
          fox.tg_id,
          `✅ Confirm OK\n🏪 ${venue.name}\n📅 Day (Warszawa): ${day}\n📊 X/Y: ${stats.X}/${stats.Y}\nFox: ${foxName}`
        );
      }

      return renderDashboard(res, venue_id, pin, { ok: true, text: "✅ Confirm OK — counted visit zapisany" });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error("Confirm error:", e);
      return renderDashboard(res, venue_id, pin, { ok: false, text: "Błąd confirm (sprawdź logi)." });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Panel confirm fatal:", e);
    return renderDashboard(res, venue_id, pin, { ok: false, text: "Błąd serwera." });
  }
});

// -------------------------
// Telegram bot commands
// -------------------------

// /venues
bot.command("venues", async (ctx) => {
  const venues = await dbMany(`SELECT id, name, city FROM fp1_venues ORDER BY id ASC LIMIT 50`);
  const lines = venues.map((v) => `• ID ${v.id}: ${v.name} (${v.city})`);
  const txt = lines.length ? `🗺 Zakłady\n\n${lines.join("\n")}\n\nCheck-in: /checkin <venue_id>` : "Brak zakładów.";
  return ctx.reply(txt);
});

// /panel
bot.command("panel", async (ctx) => {
  return ctx.reply(`Panel: https://thefoxpot-club-production.up.railway.app/panel`);
});

// /start [inviteCode]
bot.start(async (ctx) => {
  const tg_id = String(ctx.from.id);
  const tg_username = ctx.from.username ? String(ctx.from.username) : null;
  const args = (ctx.message.text || "").split(" ").slice(1);
  const code = args[0] ? String(args[0]).trim().toUpperCase() : "";

  let fox = await getFoxByTg(tg_id);

  // If fox already exists -> show profile
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

  // New fox => REQUIRE invite code
  if (!code) {
    return ctx.reply(
      `🔐 Rejestracja tylko przez invite.\n\n` +
        `Wyślij:\n` +
        `/start KODINVITE\n\n` +
        `Jeśli nie masz kodu — poproś Foxa o /invite.`
    );
  }

  // Validate invite code (must have remaining uses)
  const inv = await dbOne(`SELECT * FROM fp1_invites WHERE code=$1`, [code]);
  if (!inv) {
    return ctx.reply(`❌ Nieprawidłowy kod.\nSpróbuj ponownie albo poproś o nowy /invite.`);
  }
  if (safeInt(inv.uses) >= safeInt(inv.max_uses)) {
    return ctx.reply(`❌ Kod już wykorzystany.\nPoproś o nowy /invite.`);
  }

  // Create fox + mark invite use (transaction)
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock invite row
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

    // create fox
    const newFoxRes = await client.query(
      `INSERT INTO fp1_foxes(tg_id, tg_username, city, rating, invites, referred_by_code, referred_by_fox_id)
       VALUES($1,$2,'Warsaw',1,3,$3,$4)
       RETURNING *`,
      [tg_id, tg_username, code, String(invRow.created_by_fox_id)]
    );
    const newFox = newFoxRes.rows[0];

    // increment invite uses + log
    await client.query(
      `UPDATE fp1_invites SET uses=uses+1, last_used_at=NOW() WHERE code=$1`,
      [code]
    );
    await client.query(
      `INSERT INTO fp1_invite_uses(code, used_by_fox_id, used_by_tg) VALUES($1,$2,$3)`,
      [code, String(newFox.id), tg_id]
    );

    await client.query("COMMIT");

    // Notify creator (optional)
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
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("start(invite) error:", e);
    return ctx.reply("❌ Błąd rejestracji. Spróbuj ponownie.");
  } finally {
    client.release();
  }
});

// /invite (consume 1 invite, generate code)
bot.command("invite", async (ctx) => {
  const tg_id = String(ctx.from.id);
  const tg_username = ctx.from.username ? String(ctx.from.username) : null;

  const fox = await getFoxByTg(tg_id);
  if (!fox) {
    return ctx.reply(`🔐 Najpierw rejestracja przez invite: /start KODINVITE`);
  }

  const invites = safeInt(fox.invites);
  if (invites <= 0) {
    return ctx.reply(`❌ Masz 0 invites.\nInvites rosną m.in. co 5 counted visits (+1).`);
  }

  // Transaction: decrement invites and create invite code
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock fox
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

    // decrement invites
    await client.query(`UPDATE fp1_foxes SET invites = invites - 1 WHERE tg_id=$1`, [tg_id]);

    // create unique code (retry a few times)
    let code = "";
    for (let i = 0; i < 5; i++) {
      const c = genInviteCode();
      const exists = await client.query(`SELECT 1 FROM fp1_invites WHERE code=$1`, [c]);
      if (!exists.rows.length) {
        code = c;
        break;
      }
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

    // fetch updated fox
    const fox2 = await getFoxByTg(tg_id);

    return ctx.reply(
      `🎟️ Invite code: ${code}\n\n` +
        `Dla nowego Foxa:\n` +
        `/start ${code}\n\n` +
        `Twoje Invites teraz: ${safeInt(fox2?.invites)}`
    );
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("invite error:", e);
    return ctx.reply("❌ Błąd. Spróbuj ponownie.");
  } finally {
    client.release();
  }
});

// /checkin <venue_id>
bot.command("checkin", async (ctx) => {
  const tg_id = String(ctx.from.id);
  const fox = await getFoxByTg(tg_id);
  if (!fox) {
    return ctx.reply(`🔐 Dostęp tylko przez invite.\nWyślij: /start KODINVITE`);
  }

  const parts = (ctx.message.text || "").split(" ").map((s) => s.trim());
  const venue_id = parts[1];

  if (!venue_id || !/^\d+$/.test(venue_id)) {
    return ctx.reply(`Użycie: /checkin <venue_id>\nNp: /checkin 1`);
  }

  const venue = await getVenue(venue_id);
  if (!venue || venue.status !== "active") {
    return ctx.reply(`❌ Nie znaleziono aktywnego lokalu o ID ${venue_id}.`);
  }

  // NOTE: Geo radius is not enforced here (needs Telegram location + logic). Phase 1 MVP.
  const day = warsawDayISO(new Date());

  const already = await foxCountedToday(venue_id, fox.id, day);
  if (already) {
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
      `Panel: https://thefoxpot-club-production.up.railway.app/panel`
  );
});

// -------------------------
// Start server + bot
// -------------------------
(async () => {
  await migrate();

  app.get("/", (req, res) => {
    res.send("FoxPot Club API OK");
  });

  app.listen(PORT, () => {
    console.log(`✅ Server listening on ${PORT}`);
  });

  try {
    await bot.launch();
    console.log("✅ Telegram bot launched");
  } catch (e) {
    console.error("❌ Bot launch error:", e);
  }

  // Graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
})();
