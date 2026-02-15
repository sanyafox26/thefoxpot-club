/**
 * The FoxPot Club — MVP (Security Pack #1)
 * - /confirm disabled in Telegram (confirm only via Panel)
 * - OTP: 10 min, one-time
 * - Confirm requires: Venue PIN + OTP
 * - 1 counted visit per Fox per Venue per day (Warsaw day)
 *
 * Works with Postgres if DATABASE_URL is set.
 * If Postgres is NOT set — falls back to in-memory mode (for safety).
 */

const express = require("express");
const crypto = require("crypto");

let { Telegraf } = require("telegraf");

// --- Optional Postgres (safe fallback if not configured)
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch (e) {
  Pool = null;
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OWNER_TG_ID = process.env.OWNER_TG_ID ? String(process.env.OWNER_TG_ID) : ""; // optional
const PANEL_URL = process.env.PANEL_URL || ""; // optional (if empty -> auto from request)

// Warsaw day helper
function warsawDateString(d = new Date()) {
  // returns YYYY-MM-DD in Europe/Warsaw
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function nowISO() {
  return new Date().toISOString();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function randOTP6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

// ====== DB or MEMORY ======
const hasDb = !!(Pool && process.env.DATABASE_URL);
const pool = hasDb
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;

const mem = {
  venues: new Map(), // id -> {id,name,city,pin}
  checkins: new Map(), // id -> {id,venue_id,fox_id,otp,expires_at,status,created_at,confirmed_at,day}
  visits: new Map(), // key `${venue_id}:${fox_id}:${day}` -> true
  visitStats: new Map(), // venue_id -> total visits count
  stamps: [],
};

async function dbInit() {
  if (!hasDb) return;

  // Minimal tables (safe create-if-not-exists)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS venues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      pin TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      fox_id BIGINT NOT NULL,
      fox_username TEXT,
      otp TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      day DATE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      fox_id BIGINT NOT NULL,
      day DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(venue_id, fox_id, day)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stamps (
      id SERIAL PRIMARY KEY,
      venue_id INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      fox_id BIGINT NOT NULL,
      delta INT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed test venues if empty
  const c = await pool.query(`SELECT COUNT(*)::int AS n FROM venues;`);
  if (c.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO venues (name, city, pin) VALUES
       ('Test Kebab #1', 'Warsaw', '123456'),
       ('Test Pizza #2', 'Warsaw', '123456');`
    );
  }
}

async function getVenueById(id) {
  const venueId = Number(id);
  if (!Number.isFinite(venueId)) return null;

  if (!hasDb) {
    return mem.venues.get(venueId) || null;
  }

  const r = await pool.query(`SELECT id, name, city, pin FROM venues WHERE id=$1`, [venueId]);
  return r.rows[0] || null;
}

async function ensureMemSeed() {
  if (hasDb) return;
  if (mem.venues.size > 0) return;
  mem.venues.set(1, { id: 1, name: "Test Kebab #1", city: "Warsaw", pin: "123456" });
  mem.venues.set(2, { id: 2, name: "Test Pizza #2", city: "Warsaw", pin: "123456" });
}

async function createCheckin({ venue_id, fox_id, fox_username }) {
  const otp = randOTP6();
  const dayStr = warsawDateString(new Date()); // YYYY-MM-DD
  const expires = addMinutes(new Date(), 10);

  if (!hasDb) {
    const id = mem.checkins.size + 1;
    mem.checkins.set(id, {
      id,
      venue_id,
      fox_id,
      fox_username,
      otp,
      expires_at: expires,
      status: "PENDING",
      created_at: new Date(),
      confirmed_at: null,
      day: dayStr,
    });
    return { id, otp, expires_at: expires, day: dayStr };
  }

  const r = await pool.query(
    `INSERT INTO checkins (venue_id, fox_id, fox_username, otp, expires_at, day)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, otp, expires_at, day`,
    [venue_id, fox_id, fox_username || null, otp, expires, dayStr]
  );
  return r.rows[0];
}

async function findPendingCheckinByOtp(venue_id, otp) {
  if (!hasDb) {
    for (const c of mem.checkins.values()) {
      if (c.venue_id === venue_id && c.otp === otp && c.status === "PENDING") return c;
    }
    return null;
  }

  const r = await pool.query(
    `SELECT * FROM checkins
     WHERE venue_id=$1 AND otp=$2 AND status='PENDING'
     ORDER BY created_at DESC
     LIMIT 1`,
    [venue_id, otp]
  );
  return r.rows[0] || null;
}

async function markCheckinConfirmed(checkin_id) {
  if (!hasDb) {
    const c = mem.checkins.get(checkin_id);
    if (!c) return;
    c.status = "CONFIRMED";
    c.confirmed_at = new Date();
    mem.checkins.set(checkin_id, c);
    return;
  }
  await pool.query(
    `UPDATE checkins SET status='CONFIRMED', confirmed_at=NOW()
     WHERE id=$1 AND status='PENDING'`,
    [checkin_id]
  );
}

async function hasVisitToday(venue_id, fox_id, dayStr) {
  if (!hasDb) {
    return mem.visits.has(`${venue_id}:${fox_id}:${dayStr}`);
  }
  const r = await pool.query(
    `SELECT 1 FROM visits WHERE venue_id=$1 AND fox_id=$2 AND day=$3 LIMIT 1`,
    [venue_id, fox_id, dayStr]
  );
  return r.rowCount > 0;
}

async function addVisitIfNotExists(venue_id, fox_id, dayStr) {
  if (!hasDb) {
    const key = `${venue_id}:${fox_id}:${dayStr}`;
    if (mem.visits.has(key)) return false;
    mem.visits.set(key, true);
    mem.visitStats.set(venue_id, (mem.visitStats.get(venue_id) || 0) + 1);
    return true;
  }

  try {
    await pool.query(
      `INSERT INTO visits (venue_id, fox_id, day) VALUES ($1,$2,$3)`,
      [venue_id, fox_id, dayStr]
    );
    return true;
  } catch (e) {
    // unique violation -> already exists
    return false;
  }
}

async function getXY(venue_id, fox_id) {
  if (!hasDb) {
    let x = 0;
    for (const key of mem.visits.keys()) {
      const [v, f] = key.split(":");
      if (Number(v) === Number(venue_id) && Number(f) === Number(fox_id)) x++;
    }
    const y = mem.visitStats.get(venue_id) || 0;
    return { x, y };
  }

  const xR = await pool.query(
    `SELECT COUNT(*)::int AS x FROM visits WHERE venue_id=$1 AND fox_id=$2`,
    [venue_id, fox_id]
  );
  const yR = await pool.query(`SELECT COUNT(*)::int AS y FROM visits WHERE venue_id=$1`, [venue_id]);
  return { x: xR.rows[0].x, y: yR.rows[0].y };
}

// ====== HTML (Panel) ======
function panelHTML({ venue, message = "", pending = [] }) {
  const safeMsg = String(message || "").replace(/</g, "&lt;");

  const pendingHtml =
    pending.length === 0
      ? `<div style="opacity:.7">—</div>`
      : pending
          .map(
            (p) => `
            <div style="border:1px solid #eee; padding:10px; border-radius:12px; margin:8px 0;">
              <div><b>OTP:</b> ${p.otp}</div>
              <div><b>Fox:</b> @${p.fox_username || "unknown"} (ID ${p.fox_id})</div>
              <div style="opacity:.7">Expires: ${p.expires_at}</div>
  <form method="POST" action="/panel/confirm" style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
    <input type="hidden" name="venue_id" value="${venue.id}">
    <input type="password" name="pin" placeholder="PIN lokalu" required style="padding:8px;border-radius:10px;border:1px solid #ddd;">
    <input type="text" name="otp" value="${p.otp}" inputmode="numeric" pattern="\\d{6}" maxlength="6"
      style="padding:8px;border-radius:10px;border:1px solid #ddd; width:120px;">
    <button type="submit" style="padding:8px 12px;border-radius:10px;border:0;background:#111;color:#fff;">
      Potwierdź OTP
    </button>
  </form>
            </div>
          `
          )
          .join("");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Panel lokalu — ${venue.name}</title>
</head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto; max-width: 720px; margin: 24px auto; padding: 0 12px;">
  <h2>Panel lokalu</h2>
  <div style="padding:12px;border:1px solid #eee;border-radius:14px;">
    <div><b>🏪 ${venue.name}</b> (ID ${venue.id})</div>
    <div>City: ${venue.city}</div>
    <div style="opacity:.7">Security Pack #1: confirm тільки через Panel (PIN + OTP)</div>
  </div>

  ${safeMsg ? `<div style="margin:14px 0; padding:10px; border-radius:12px; background:#f6f6f6;">${safeMsg}</div>` : ""}

  <h3 style="margin-top:18px;">Pending check-ins (10 min)</h3>
  ${pendingHtml}

  <hr style="margin:22px 0; border:0; border-top:1px solid #eee;" />
  <div style="opacity:.7">
    Якщо /confirm у Telegram не працює — це правильно ✅ Тепер підтвердження тільки тут.
  </div>
</body>
</html>
`;
}

async function getPendingForVenue(venue_id) {
  if (!hasDb) {
    const list = [];
    const now = new Date();
    for (const c of mem.checkins.values()) {
      if (c.venue_id === venue_id && c.status === "PENDING" && c.expires_at > now) {
        list.push({
          otp: c.otp,
          fox_id: c.fox_id,
          fox_username: c.fox_username || "",
          expires_at: c.expires_at.toISOString(),
        });
      }
    }
    // newest first by creation time (best-effort)
    return list.reverse();
  }

  const r = await pool.query(
    `SELECT otp, fox_id, fox_username, expires_at
     FROM checkins
     WHERE venue_id=$1 AND status='PENDING' AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 20`,
    [venue_id]
  );
  return r.rows.map((x) => ({
    otp: x.otp,
    fox_id: x.fox_id,
    fox_username: x.fox_username || "",
    expires_at: x.expires_at.toISOString(),
  }));
}

// ====== ROUTES ======
app.get("/", (req, res) => {
  res.json({ ok: true, service: "thefoxpot-club", ts: nowISO() });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, db: hasDb, ts: nowISO() });
});

// Panel view: /panel?venue=1
app.get("/panel", async (req, res) => {
  try {
    await ensureMemSeed();
    const venueId = Number(req.query.venue || 1);
    const venue = await getVenueById(venueId);
    if (!venue) return res.status(404).send("Venue not found");

    const pending = await getPendingForVenue(venue.id);
    res.status(200).send(panelHTML({ venue, pending }));
  } catch (e) {
    res.status(500).send("Panel error");
  }
});

// Confirm from Panel (PIN + OTP)
app.post("/panel/confirm", async (req, res) => {
  try {
    await ensureMemSeed();
    const venue_id = Number(req.body.venue_id);
    const pin = String(req.body.pin || "");
    const otp = String(req.body.otp || "").trim();

    const venue = await getVenueById(venue_id);
    if (!venue) return res.status(404).send("Venue not found");

    if (pin !== String(venue.pin)) {
      const pending = await getPendingForVenue(venue.id);
      return res.status(200).send(panelHTML({ venue, pending, message: "❌ Zły PIN" }));
    }

    if (!/^\d{6}$/.test(otp)) {
      const pending = await getPendingForVenue(venue.id);
      return res.status(200).send(panelHTML({ venue, pending, message: "❌ OTP має бути 6 цифр" }));
    }

    const checkin = await findPendingCheckinByOtp(venue.id, otp);
    if (!checkin) {
      const pending = await getPendingForVenue(venue.id);
      return res.status(200).send(panelHTML({ venue, pending, message: "❌ OTP не знайдено або вже використано" }));
    }

    // Expired?
    const exp = new Date(checkin.expires_at);
    if (exp <= new Date()) {
      const pending = await getPendingForVenue(venue.id);
      return res.status(200).send(panelHTML({ venue, pending, message: "❌ OTP прострочений" }));
    }

    const dayStr = checkin.day instanceof Date ? warsawDateString(checkin.day) : String(checkin.day);
    const fox_id = Number(checkin.fox_id);

    const already = await hasVisitToday(venue.id, fox_id, dayStr);
    if (already) {
      // consume OTP anyway for security
      await markCheckinConfirmed(checkin.id);

      const { x, y } = await getXY(venue.id, fox_id);
      const pending = await getPendingForVenue(venue.id);
      return res
        .status(200)
        .send(
          panelHTML({
            venue,
            pending,
            message:
              `Dzień (Warszawa): ${dayStr}<br><b>DZIŚ JUŻ BYŁO ✅</b><br>` +
              `Spróbuj jutro po 00:00 (Warszawa).<br>X/Y: ${x}/${y}`,
          })
        );
    }

    // Confirm + add visit
    await markCheckinConfirmed(checkin.id);
    await addVisitIfNotExists(venue.id, fox_id, dayStr);

    const { x, y } = await getXY(venue.id, fox_id);
    const pending = await getPendingForVenue(venue.id);

    return res.status(200).send(
      panelHTML({
        venue,
        pending,
        message:
          `✅ Confirm OK<br>Lokal: ${venue.name}<br><br>` +
          `Dzień (Warszawa): ${dayStr}<br><br>` +
          `✅ Counted Visit додано<br>` +
          `X/Y: ${x}/${y}`,
      })
    );
  } catch (e) {
    return res.status(500).send("Confirm error");
  }
});

// ====== TELEGRAM BOT ======
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    await ctx.reply(
      "The FoxPot Club ✅\n\nКоманди:\n/checkin <venue_id>\n\nПідтвердження тепер ТІЛЬКИ через Panel (PIN + OTP)."
    );
  });

  bot.command("checkin", async (ctx) => {
    try {
      await ensureMemSeed();

      const text = ctx.message.text || "";
      const parts = text.split(" ").filter(Boolean);
      const venue_id = Number(parts[1]);

      if (!Number.isFinite(venue_id)) {
        return ctx.reply("❌ Використай так: /checkin 1");
      }

      const venue = await getVenueById(venue_id);
      if (!venue) return ctx.reply("❌ Немає такого закладу");

      const fox_id = ctx.from.id;
      const fox_username = ctx.from.username || "";

      const c = await createCheckin({ venue_id, fox_id, fox_username });

      // Panel url (use env if provided)
      const panel = PANEL_URL ? PANEL_URL : "https://thefoxpot-club-production.up.railway.app/panel";

      await ctx.reply(
        `✅ Check-in utworzony (10 min)\n\n🏪 ${venue.name}\n🔐 OTP: ${c.otp}\n\n` +
          `Personel potwierdza w Panelu.\nPanel: ${panel}?venue=${venue.id}\n\n` +
          `⚠️ /confirm w Telegram jest wyłączone (security).`
      );
    } catch (e) {
      return ctx.reply("❌ Error creating check-in");
    }
  });

  // SECURITY: disable /confirm
  bot.command("confirm", async (ctx) => {
    return ctx.reply(
      "🔒 /confirm jest wyłączone.\n✅ Potwierdzenie чек-іну тільки через Panel lokalu (PIN + OTP)."
    );
  });

  // Optional: allow OWNER to see health (debug)
  bot.command("health", async (ctx) => {
    const me = String(ctx.from.id);
    if (OWNER_TG_ID && me !== OWNER_TG_ID) return;
    return ctx.reply(`ok=true db=${hasDb} ts=${nowISO()}`);
  });

  bot.launch().then(() => console.log("✅ Bot launched")).catch(() => console.log("❌ Bot launch failed"));
}

// ====== START ======
dbInit()
  .then(() => {
    if (!hasDb) ensureMemSeed();
    app.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("DB init failed", e);
    // still start in memory mode
    ensureMemSeed();
    app.listen(PORT, () => console.log(`✅ Server listening on ${PORT} (memory fallback)`));
  });
