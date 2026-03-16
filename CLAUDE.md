# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The FoxPot Club is a Telegram Mini App loyalty/rewards platform for restaurants and venues in Warsaw, Poland. Users check in at venues via OTP codes, earn ratings, maintain streaks, and unlock achievements. It includes a venue partner panel and admin panel.

## Tech Stack

- **Backend:** Node.js + Express.js + Telegraf (Telegram bot framework)
- **Database:** PostgreSQL (via `pg`)
- **Frontend:** Vanilla HTML/CSS/JavaScript (no build step, no framework)
- **PWA:** Service worker (`sw.js`) with network-first HTML, cache-first assets

## Commands

```bash
npm install        # Install dependencies
npm start          # Start server (node server.js), default port 8080
```

No test suite, no linter, no build step. Database migrations run automatically on boot (idempotent `IF NOT EXISTS`).

## Required Environment Variables

`BOT_TOKEN`, `DATABASE_URL`, `PUBLIC_URL` are required. Optional: `WEBHOOK_SECRET`, `COOKIE_SECRET`, `ADMIN_SECRET`, `ADMIN_TG_ID`, `PORT`.

## Architecture

**Single-server monolith** — everything lives in two JS files:

- **`server.js`** (~4400 lines): Express server, all REST API endpoints (`/api/*`), Telegram bot handlers, venue partner panel (`/panel/*`), admin panel (`/admin/*`), database migrations, CRON jobs (obligation penalties every 15min, leaderboard resets weekly/monthly).
- **`fox_support.js`** (~1100 lines): Support ticket system module — FAQ tree, two-step escalation, problem fingerprinting, admin notifications.

Frontend pages are standalone HTML files served statically:
- `webapp.html` — main Telegram Mini App (the core user experience)
- `index.html` — landing page
- `faq.html`, `partners.html`, `privacy.html`, `rules.html` — info pages

## Key Patterns

- **All dates use Warsaw timezone** — helper functions `warsawDayKey()`, `warsawWeekBounds()`, `warsawHour()` handle timezone conversion. Always use these, never raw `new Date()` for date logic.
- **Telegram Web App auth** — `requireWebAppAuth` middleware validates `initData` cryptographic signatures. Venue panel uses cookie-based sessions with rate-limited PIN login.
- **OTP check-in flow** — user generates 6-digit code (valid 10 min), venue staff confirms via partner panel.
- **Obligation system** — after check-in, users must return within 24h or face escalating penalties (bans, rating loss).
- **Soft deletes** — users have `is_deleted`/`deleted_at` fields; re-registration cleans the account.
- **All DB tables prefixed `fp1_`** — e.g., `fp1_foxes` (users), `fp1_venues`, `fp1_checkins`, `fp1_achievements`.
- **Support system state is in-memory** (resets on server restart).

## API Structure

- `/api/*` — user-facing REST endpoints (profile, venues, check-in, spin, achievements, receipts, invites)
- `/panel/*` — venue partner dashboard (login, confirm OTP, manage photos/dishes, stamps)
- `/admin/*` — admin dashboard (approve/reject venues)
- `/health`, `/version` — server status endpoints
