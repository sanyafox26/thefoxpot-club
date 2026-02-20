<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
<meta name="theme-color" content="#0a0b14"/>
<title>FoxPot Club</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter+Tight:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
<style>
/* ═══════════════ RESET & ROOT ═══════════════ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #0a0b14;
  --bg2:       #10121f;
  --bg3:       #161929;
  --border:    rgba(255,255,255,0.07);
  --border2:   rgba(255,255,255,0.12);
  --fox:       #f5a623;
  --fox2:      #e8842a;
  --accent:    #7c5cfc;
  --accent2:   #a07bff;
  --green:     #2ecc71;
  --red:       #e74c3c;
  --gold:      #ffd700;
  --text:      #f0f0f5;
  --muted:     rgba(240,240,245,0.45);
  --muted2:    rgba(240,240,245,0.25);
  --card-bg:   rgba(255,255,255,0.04);
  --card-border: rgba(255,255,255,0.08);
  --radius:    18px;
  --radius-sm: 12px;
  --font:      'Outfit', sans-serif;
  --mono:      'Inter Tight', sans-serif;
  --safe-top:  env(safe-area-inset-top, 0px);
  --safe-bot:  env(safe-area-inset-bottom, 0px);
}

html { height: 100%; -webkit-tap-highlight-color: transparent; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  min-height: 100%;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ═══════════════ NOISE TEXTURE ═══════════════ */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
  background-repeat: repeat;
  pointer-events: none;
  z-index: 0;
  opacity: 0.6;
}

/* ═══════════════ APP SHELL ═══════════════ */
#app {
  position: relative;
  z-index: 1;
  max-width: 430px;
  margin: 0 auto;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding-bottom: calc(72px + var(--safe-bot));
}

/* ═══════════════ HEADER ═══════════════ */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  position: sticky;
  top: 0;
  z-index: 100;
  background: linear-gradient(to bottom, var(--bg) 80%, transparent);
  backdrop-filter: blur(8px);
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.3px;
}

.logo .fox-icon {
  width: 32px; height: 32px;
  background: linear-gradient(135deg, var(--fox), var(--fox2));
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  box-shadow: 0 4px 16px rgba(245,166,35,0.35);
}

.header-version {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  padding: 3px 8px;
  border-radius: 20px;
}

/* ═══════════════ SCREENS ═══════════════ */
.screen {
  display: none;
  flex-direction: column;
  flex: 1;
  padding: 0 16px;
  animation: fadeIn 0.25s ease;
}
.screen.active { display: flex; }

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ═══════════════ BOTTOM NAV ═══════════════ */
.bottom-nav {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  z-index: 200;
  display: flex;
  background: rgba(16,18,31,0.92);
  backdrop-filter: blur(20px);
  border-top: 1px solid var(--border);
  padding-bottom: var(--safe-bot);
}

.nav-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 4px 8px;
  font-size: 10px;
  color: var(--muted);
  cursor: pointer;
  border: none;
  background: none;
  font-family: var(--font);
  font-weight: 600;
  letter-spacing: 0.3px;
  transition: color 0.2s, transform 0.15s;
  -webkit-user-select: none;
  user-select: none;
}
.nav-btn .nav-icon { font-size: 22px; line-height: 1; transition: transform 0.2s; }
.nav-btn.active { color: var(--fox); }
.nav-btn.active .nav-icon { transform: scale(1.15); }
.nav-btn:active { transform: scale(0.92); }

/* ═══════════════ CARDS ═══════════════ */
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 12px;
  position: relative;
  overflow: hidden;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 60%);
  pointer-events: none;
}

.card-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}

/* ═══════════════ PROFILE SCREEN ═══════════════ */
.profile-hero {
  background: linear-gradient(135deg, #1a1030 0%, #0d1220 50%, #0a1018 100%);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 24px 20px 20px;
  margin-bottom: 12px;
  position: relative;
  overflow: hidden;
}

.profile-hero::before {
  content: '🦊';
  position: absolute;
  right: -10px; top: -10px;
  font-size: 90px;
  opacity: 0.06;
  transform: rotate(15deg);
}

.profile-avatar {
  width: 64px; height: 64px;
  background: linear-gradient(135deg, var(--fox), var(--fox2));
  border-radius: 20px;
  display: flex; align-items: center; justify-content: center;
  font-size: 32px;
  margin-bottom: 12px;
  box-shadow: 0 8px 24px rgba(245,166,35,0.3);
}

.profile-name {
  font-size: 20px;
  font-weight: 800;
  line-height: 1.2;
  margin-bottom: 4px;
}

.profile-tag {
  font-size: 13px;
  color: var(--muted);
  font-family: var(--mono);
  margin-bottom: 12px;
}

.founder-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: linear-gradient(90deg, rgba(255,215,0,0.15), rgba(255,215,0,0.08));
  border: 1px solid rgba(255,215,0,0.3);
  border-radius: 20px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--gold);
  margin-bottom: 12px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 4px;
}

.stat-box {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: var(--radius-sm);
  padding: 10px 8px;
  text-align: center;
}
.stat-box .stat-val {
  font-size: 20px;
  font-weight: 800;
  line-height: 1;
  margin-bottom: 3px;
  font-family: var(--mono);
}
.stat-box .stat-lbl {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.5px;
  font-weight: 600;
}
.stat-box.fox-color .stat-val { color: var(--fox); }
.stat-box.purple-color .stat-val { color: var(--accent2); }
.stat-box.green-color .stat-val { color: var(--green); }

.streak-bar-wrap {
  margin-top: 4px;
}
.streak-info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.streak-label { font-size: 12px; color: var(--muted); font-weight: 600; }
.streak-val { font-size: 14px; font-weight: 800; color: var(--fox); }
.streak-bar-bg {
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: 10px;
  overflow: hidden;
}
.streak-bar-fg {
  height: 100%;
  background: linear-gradient(90deg, var(--fox), var(--fox2));
  border-radius: 10px;
  transition: width 0.8s cubic-bezier(.4,0,.2,1);
  min-width: 4px;
}

/* ═══════════════ SPIN SCREEN ═══════════════ */
.spin-hero {
  background: linear-gradient(160deg, #1a0a2e 0%, #0d1220 100%);
  border: 1px solid rgba(124,92,252,0.2);
  border-radius: var(--radius);
  padding: 28px 20px;
  text-align: center;
  margin-bottom: 12px;
  position: relative;
  overflow: hidden;
}
.spin-hero::before {
  content: '';
  position: absolute;
  top: -40%; left: 50%;
  transform: translateX(-50%);
  width: 200px; height: 200px;
  background: radial-gradient(circle, rgba(124,92,252,0.2) 0%, transparent 70%);
  pointer-events: none;
}

.spin-machine {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(124,92,252,0.25);
  border-radius: var(--radius);
  padding: 20px 16px;
  font-size: 32px;
  letter-spacing: 8px;
  font-family: var(--mono);
  margin: 16px 0;
  min-height: 70px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.3s;
  position: relative;
  z-index: 1;
}
.spin-machine.spinning {
  border-color: var(--fox);
  animation: pulseGlow 0.6s ease-in-out infinite alternate;
}
@keyframes pulseGlow {
  from { box-shadow: 0 0 0px rgba(245,166,35,0); }
  to   { box-shadow: 0 0 20px rgba(245,166,35,0.3); }
}

.spin-title { font-size: 24px; font-weight: 800; margin-bottom: 4px; position: relative; z-index: 1; }
.spin-sub { font-size: 13px; color: var(--muted); position: relative; z-index: 1; }

.spin-btn {
  width: 100%;
  padding: 16px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: none;
  border-radius: var(--radius-sm);
  color: white;
  font-size: 16px;
  font-weight: 800;
  font-family: var(--font);
  cursor: pointer;
  position: relative; z-index: 1;
  transition: opacity 0.2s, transform 0.15s;
  letter-spacing: 0.3px;
  box-shadow: 0 4px 20px rgba(124,92,252,0.35);
}
.spin-btn:active { transform: scale(0.97); }
.spin-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.spin-result {
  display: none;
  background: rgba(46,204,113,0.08);
  border: 1px solid rgba(46,204,113,0.2);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  text-align: center;
  margin-top: 12px;
}
.spin-result.visible { display: block; animation: bounceIn 0.4s cubic-bezier(.34,1.56,.64,1); }
@keyframes bounceIn {
  from { transform: scale(0.8); opacity: 0; }
  to   { transform: scale(1); opacity: 1; }
}
.spin-result-emoji { font-size: 36px; margin-bottom: 6px; }
.spin-result-label { font-size: 17px; font-weight: 800; color: var(--green); }
.spin-result-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }

.prizes-list { margin-top: 4px; }
.prize-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
}
.prize-row:last-child { border-bottom: none; }
.prize-left { display: flex; align-items: center; gap: 10px; }
.prize-emoji { font-size: 20px; width: 28px; text-align: center; }
.prize-name { font-weight: 600; }
.prize-chance {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  background: var(--card-bg);
  border: 1px solid var(--border);
  padding: 3px 8px;
  border-radius: 20px;
}

/* ═══════════════ CHECK-IN SCREEN ═══════════════ */
.checkin-hero {
  background: linear-gradient(135deg, #0a1a12 0%, #0d1220 100%);
  border: 1px solid rgba(46,204,113,0.15);
  border-radius: var(--radius);
  padding: 24px 20px;
  text-align: center;
  margin-bottom: 12px;
}
.checkin-title { font-size: 22px; font-weight: 800; margin-bottom: 6px; }
.checkin-sub { font-size: 13px; color: var(--muted); }

.venue-select-wrap {
  margin-bottom: 12px;
}
.venue-select-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
  display: block;
}
.venue-select {
  width: 100%;
  padding: 13px 16px;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 14px;
  font-family: var(--font);
  font-weight: 600;
  appearance: none;
  cursor: pointer;
  outline: none;
}
.venue-select:focus { border-color: var(--green); }

.checkin-btn {
  width: 100%;
  padding: 16px;
  background: linear-gradient(135deg, #1a7a42, var(--green));
  border: none;
  border-radius: var(--radius-sm);
  color: white;
  font-size: 16px;
  font-weight: 800;
  font-family: var(--font);
  cursor: pointer;
  transition: opacity 0.2s, transform 0.15s;
  letter-spacing: 0.3px;
  box-shadow: 0 4px 20px rgba(46,204,113,0.25);
  margin-bottom: 12px;
}
.checkin-btn:active { transform: scale(0.97); }
.checkin-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.otp-display {
  display: none;
  background: var(--bg3);
  border: 2px solid var(--green);
  border-radius: var(--radius);
  padding: 24px;
  text-align: center;
  margin-bottom: 12px;
  animation: fadeIn 0.3s ease;
}
.otp-display.visible { display: block; }
.otp-display-label { font-size: 11px; color: var(--muted); letter-spacing: 1px; text-transform: uppercase; font-weight: 700; margin-bottom: 8px; }
.otp-code {
  font-size: 48px;
  font-weight: 800;
  font-family: var(--mono);
  letter-spacing: 8px;
  color: var(--green);
  text-shadow: 0 0 20px rgba(46,204,113,0.4);
  margin: 8px 0;
}
.otp-venue { font-size: 14px; color: var(--muted); margin-bottom: 4px; }
.otp-timer { font-size: 12px; color: var(--muted); font-family: var(--mono); }
.otp-timer span { color: var(--fox); }

.venues-list { margin-top: 4px; }
.venue-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: opacity 0.15s;
}
.venue-card:last-child { border-bottom: none; }
.venue-card:active { opacity: 0.7; }
.venue-icon {
  width: 40px; height: 40px;
  background: rgba(46,204,113,0.1);
  border: 1px solid rgba(46,204,113,0.2);
  border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.venue-info { flex: 1; min-width: 0; }
.venue-name { font-size: 14px; font-weight: 700; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.venue-meta { font-size: 11px; color: var(--muted); }
.venue-id-badge {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  background: var(--card-bg);
  border: 1px solid var(--border);
  padding: 3px 7px;
  border-radius: 8px;
  flex-shrink: 0;
}

/* ═══════════════ ACHIEVEMENTS ═══════════════ */
.ach-category { margin-bottom: 16px; }
.ach-category-title {
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ach-count-badge {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--muted);
  background: var(--card-bg);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: 10px;
  margin-left: auto;
}

.ach-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ach-item {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  padding: 12px;
  position: relative;
  overflow: hidden;
}
.ach-item.unlocked {
  background: rgba(245,166,35,0.07);
  border-color: rgba(245,166,35,0.25);
}
.ach-item.unlocked::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(245,166,35,0.05) 0%, transparent 60%);
}
.ach-emoji { font-size: 24px; margin-bottom: 6px; display: block; }
.ach-label { font-size: 12px; font-weight: 700; margin-bottom: 3px; }
.ach-bonus { font-size: 11px; color: var(--fox); font-family: var(--mono); font-weight: 500; }
.ach-lock { font-size: 10px; color: var(--muted2); font-family: var(--mono); }
.ach-check {
  position: absolute;
  top: 8px; right: 8px;
  width: 18px; height: 18px;
  background: var(--fox);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px;
}

/* ═══════════════ LEADERBOARD ═══════════════ */
.top-header-card {
  background: linear-gradient(135deg, #1a1030 0%, #0d1220 100%);
  border: 1px solid rgba(124,92,252,0.2);
  border-radius: var(--radius);
  padding: 20px;
  text-align: center;
  margin-bottom: 12px;
}
.top-title { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
.top-sub { font-size: 13px; color: var(--muted); }

.leaderboard { }
.leader-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
  position: relative;
  overflow: hidden;
  transition: transform 0.15s;
}
.leader-row:active { transform: scale(0.98); }
.leader-row.me {
  background: rgba(124,92,252,0.1);
  border-color: rgba(124,92,252,0.3);
}
.leader-row.pos-1 { background: rgba(255,215,0,0.07); border-color: rgba(255,215,0,0.25); }
.leader-row.pos-2 { background: rgba(192,192,192,0.06); border-color: rgba(192,192,192,0.2); }
.leader-row.pos-3 { background: rgba(205,127,50,0.06); border-color: rgba(205,127,50,0.2); }

.leader-pos {
  font-size: 16px;
  font-weight: 800;
  font-family: var(--mono);
  width: 32px;
  text-align: center;
  flex-shrink: 0;
}
.leader-avatar {
  width: 36px; height: 36px;
  background: linear-gradient(135deg, var(--fox), var(--fox2));
  border-radius: 11px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.leader-info { flex: 1; min-width: 0; }
.leader-name { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leader-sub { font-size: 11px; color: var(--muted); margin-top: 1px; }
.leader-rating {
  font-size: 16px;
  font-weight: 800;
  font-family: var(--mono);
  color: var(--fox);
  flex-shrink: 0;
}
.leader-founder {
  font-size: 10px;
  color: var(--gold);
  font-weight: 700;
  font-family: var(--mono);
}
.my-pos-card {
  background: rgba(124,92,252,0.08);
  border: 1px solid rgba(124,92,252,0.25);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
}
.my-pos-right { font-family: var(--mono); color: var(--accent2); }

/* ═══════════════ LOADING & STATES ═══════════════ */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 20px;
  gap: 12px;
  color: var(--muted);
  font-size: 14px;
}
.spinner {
  width: 32px; height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--fox);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.empty-state {
  text-align: center;
  padding: 32px 20px;
  color: var(--muted);
}
.empty-state .empty-icon { font-size: 40px; margin-bottom: 12px; }
.empty-state .empty-text { font-size: 14px; font-weight: 600; }
.empty-state .empty-sub { font-size: 12px; margin-top: 6px; }

.error-banner {
  background: rgba(231,76,60,0.1);
  border: 1px solid rgba(231,76,60,0.25);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #ff8a80;
  margin-bottom: 12px;
  display: none;
}
.error-banner.visible { display: block; }

.success-banner {
  background: rgba(46,204,113,0.1);
  border: 1px solid rgba(46,204,113,0.25);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #69f0ae;
  margin-bottom: 12px;
  display: none;
}
.success-banner.visible { display: block; animation: fadeIn 0.3s ease; }

/* ═══════════════ UTILITIES ═══════════════ */
.mt4 { margin-top: 4px; }
.mt8 { margin-top: 8px; }
.mt12 { margin-top: 12px; }
.mb12 { margin-bottom: 12px; }
.screen-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 4px;
}
.screen-sub {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 16px;
}

/* ═══════════════ WELCOME / UNAUTH ═══════════════ */
.welcome-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 24px;
}
.welcome-fox {
  font-size: 72px;
  margin-bottom: 16px;
  animation: floatFox 3s ease-in-out infinite;
}
@keyframes floatFox {
  0%, 100% { transform: translateY(0); }
  50%       { transform: translateY(-10px); }
}
.welcome-title { font-size: 26px; font-weight: 800; margin-bottom: 8px; }
.welcome-sub { font-size: 14px; color: var(--muted); line-height: 1.6; max-width: 280px; }

/* ═══════════════ RESPONSIVE FINAL POLISH ═══════════════ */
.section-gap { height: 4px; }
</style>
</head>
<body>
<div id="app">

  <!-- HEADER -->
  <header class="header">
    <div class="logo">
      <div class="fox-icon">🦊</div>
      FoxPot
    </div>
    <span class="header-version">V19 WEBAPP</span>
  </header>

  <!-- SCREEN: PROFIL -->
  <section class="screen active" id="screen-profile">
    <div id="profile-loading" class="loading-state">
      <div class="spinner"></div>
      Ładowanie profilu…
    </div>
    <div id="profile-content" style="display:none">
      <div class="profile-hero">
        <div class="profile-avatar">🦊</div>
        <div class="profile-name" id="p-name">Fox</div>
        <div class="profile-tag" id="p-tag">@username</div>
        <div class="founder-badge" id="p-founder" style="display:none">
          👑 <span id="p-founder-txt">FOUNDER FOX #1</span>
        </div>
        <div class="stats-grid">
          <div class="stat-box fox-color">
            <div class="stat-val" id="p-rating">0</div>
            <div class="stat-lbl">PUNKTY</div>
          </div>
          <div class="stat-box purple-color">
            <div class="stat-val" id="p-invites">0</div>
            <div class="stat-lbl">ZAPR.</div>
          </div>
          <div class="stat-box green-color">
            <div class="stat-val" id="p-visits">0</div>
            <div class="stat-lbl">WIZYTY</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🔥 Streak</div>
        <div class="streak-bar-wrap">
          <div class="streak-info-row">
            <span class="streak-label" id="p-streak-label">Aktualny streak</span>
            <span class="streak-val" id="p-streak-val">0 dni</span>
          </div>
          <div class="streak-bar-bg">
            <div class="streak-bar-fg" id="p-streak-bar" style="width:0%"></div>
          </div>
          <div class="streak-info-row" style="margin-top:8px;margin-bottom:0">
            <span class="streak-label">Rekord</span>
            <span class="streak-val" id="p-streak-best" style="color:var(--muted)">0 dni</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">📍 Informacje</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <div>
            <div style="color:var(--muted);font-size:11px;margin-bottom:3px;font-weight:600">MIASTO</div>
            <div id="p-city" style="font-weight:700">Warsaw</div>
          </div>
          <div>
            <div style="color:var(--muted);font-size:11px;margin-bottom:3px;font-weight:600">DZIELNICA</div>
            <div id="p-district" style="font-weight:700">—</div>
          </div>
          <div>
            <div style="color:var(--muted);font-size:11px;margin-bottom:3px;font-weight:600">❄️ FREEZE</div>
            <div id="p-freeze" style="font-weight:700">0</div>
          </div>
          <div>
            <div style="color:var(--muted);font-size:11px;margin-bottom:3px;font-weight:600">SPIN DZIŚ</div>
            <div id="p-spin-today" style="font-weight:700">—</div>
          </div>
        </div>
      </div>
    </div>
    <div id="profile-error" class="error-banner">Błąd ładowania profilu.</div>
    <div id="profile-unauth" style="display:none">
      <div class="welcome-screen">
        <div class="welcome-fox">🦊</div>
        <div class="welcome-title">THE FOXPOT CLUB</div>
        <div class="welcome-sub">Otwórz tę aplikację przez bota Telegram, aby zobaczyć swój profil.</div>
      </div>
    </div>
  </section>

  <!-- SCREEN: SPIN -->
  <section class="screen" id="screen-spin">
    <div class="spin-hero">
      <div class="spin-title">🎰 Daily Spin</div>
      <div class="spin-sub">Jedno losowanie dziennie — kręć po każdej wizycie!</div>
      <div class="spin-machine" id="spin-machine">🦊 💎 ⭐ 🎁 👑</div>
      <button class="spin-btn" id="spin-btn" onclick="doSpin()">Kręć! 🎰</button>
      <div class="spin-result" id="spin-result">
        <div class="spin-result-emoji" id="spin-result-emoji">🎁</div>
        <div class="spin-result-label" id="spin-result-label">+2 punkty!</div>
        <div class="spin-result-sub" id="spin-result-sub">Następny spin jutro</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">NAGRODY I SZANSE</div>
      <div class="prizes-list">
        <div class="prize-row"><div class="prize-left"><span class="prize-emoji">🎁</span><span class="prize-name">+2 punkty</span></div><span class="prize-chance">60%</span></div>
        <div class="prize-row"><div class="prize-left"><span class="prize-emoji">⭐</span><span class="prize-name">+5 punktów</span></div><span class="prize-chance">20%</span></div>
        <div class="prize-row"><div class="prize-left"><span class="prize-emoji">🎟️</span><span class="prize-name">+1 zaproszenie</span></div><span class="prize-chance">10%</span></div>
        <div class="prize-row"><div class="prize-left"><span class="prize-emoji">💎</span><span class="prize-name">+15 punktów</span></div><span class="prize-chance">7%</span></div>
        <div class="prize-row"><div class="prize-left"><span class="prize-emoji">❄️</span><span class="prize-name">+1 Freeze streak</span></div><span class="prize-chance">3%</span></div>
      </div>
    </div>
  </section>

  <!-- SCREEN: CHECK-IN -->
  <section class="screen" id="screen-checkin">
    <div class="checkin-hero">
      <div class="checkin-title">📍 Check-in</div>
      <div class="checkin-sub">Wybierz lokal i pokaż OTP personelowi</div>
    </div>

    <div id="checkin-error" class="error-banner"></div>
    <div id="checkin-success" class="success-banner"></div>

    <div class="otp-display" id="otp-display">
      <div class="otp-display-label">Twój kod OTP — pokaż personelowi</div>
      <div class="otp-code" id="otp-code">000000</div>
      <div class="otp-venue" id="otp-venue">Lokal</div>
      <div class="otp-timer">Ważny przez: <span id="otp-timer-val">10:00</span></div>
    </div>

    <div class="venue-select-wrap">
      <label class="venue-select-label">Wybierz lokal</label>
      <select class="venue-select" id="venue-select">
        <option value="">— wybierz lokal —</option>
      </select>
    </div>
    <button class="checkin-btn" id="checkin-btn" onclick="doCheckin()">Generuj OTP ✓</button>

    <div class="card">
      <div class="card-title">AKTYWNE LOKALE</div>
      <div class="venues-list" id="venues-list">
        <div class="loading-state"><div class="spinner"></div></div>
      </div>
    </div>
  </section>

  <!-- SCREEN: ACHIEVEMENTS -->
  <section class="screen" id="screen-achievements">
    <div class="screen-title">🏆 Osiągnięcia</div>
    <div class="screen-sub" id="ach-summary">Ładowanie…</div>
    <div id="ach-loading" class="loading-state"><div class="spinner"></div></div>
    <div id="ach-content"></div>
  </section>

  <!-- SCREEN: TOP -->
  <section class="screen" id="screen-top">
    <div class="top-header-card">
      <div class="top-title">🦊 Top Fox</div>
      <div class="top-sub">Ranking 10 najlepszych graczy</div>
    </div>
    <div id="top-loading" class="loading-state"><div class="spinner"></div></div>
    <div id="top-content"></div>
  </section>

  <!-- BOTTOM NAV -->
  <nav class="bottom-nav">
    <button class="nav-btn active" id="nav-profile"     onclick="switchScreen('profile')">
      <span class="nav-icon">🦊</span>Profil
    </button>
    <button class="nav-btn"        id="nav-checkin"     onclick="switchScreen('checkin')">
      <span class="nav-icon">📍</span>Check-in
    </button>
    <button class="nav-btn"        id="nav-spin"        onclick="switchScreen('spin')">
      <span class="nav-icon">🎰</span>Spin
    </button>
    <button class="nav-btn"        id="nav-achievements" onclick="switchScreen('achievements')">
      <span class="nav-icon">🏆</span>Nagrody
    </button>
    <button class="nav-btn"        id="nav-top"         onclick="switchScreen('top')">
      <span class="nav-icon">👑</span>Top
    </button>
  </nav>

</div>

<script>
/* ═══════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════ */
const API_BASE = window.location.origin; // Ten sam serwer co server.js
const TG = window.Telegram?.WebApp;

// Inicjalizacja Telegram Web App
if (TG) {
  TG.ready();
  TG.expand();
  TG.setHeaderColor('#0a0b14');
  TG.setBackgroundColor('#0a0b14');
}

// Dane użytkownika z Telegram
const TG_USER = TG?.initDataUnsafe?.user || null;
const INIT_DATA = TG?.initData || '';

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
const state = {
  currentScreen: 'profile',
  profileLoaded: false,
  venuesLoaded: false,
  achLoaded: false,
  topLoaded: false,
  profile: null,
  venues: [],
  otpTimer: null,
  otpExpiry: null,
  spinDone: false,
};

/* ═══════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════ */
function switchScreen(name) {
  if (state.currentScreen === name) return;
  state.currentScreen = name;

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('screen-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');

  if (TG) TG.HapticFeedback?.selectionChanged();

  // Lazy load
  if (name === 'profile' && !state.profileLoaded) loadProfile();
  if (name === 'checkin' && !state.venuesLoaded) loadVenues();
  if (name === 'achievements' && !state.achLoaded) loadAchievements();
  if (name === 'top' && !state.topLoaded) loadTop();
}

/* ═══════════════════════════════════════════════════
   API CALL (z autoryzacją Telegram initData)
═══════════════════════════════════════════════════ */
async function apiCall(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': INIT_DATA,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ═══════════════════════════════════════════════════
   PROFIL
═══════════════════════════════════════════════════ */
async function loadProfile() {
  state.profileLoaded = true;
  const loading = document.getElementById('profile-loading');
  const content = document.getElementById('profile-content');
  const err     = document.getElementById('profile-error');
  const unauth  = document.getElementById('profile-unauth');

  if (!TG_USER) {
    loading.style.display = 'none';
    unauth.style.display = 'block';
    return;
  }

  try {
    const data = await apiCall('/api/profile');
    state.profile = data;

    // Wypełnij profil
    document.getElementById('p-name').textContent =
      TG_USER.first_name + (TG_USER.last_name ? ' ' + TG_USER.last_name : '');

    document.getElementById('p-tag').textContent =
      TG_USER.username ? '@' + TG_USER.username : 'Fox #' + String(TG_USER.id).slice(-4);

    if (data.founder_number) {
      document.getElementById('p-founder').style.display = 'inline-flex';
      document.getElementById('p-founder-txt').textContent = 'FOUNDER FOX #' + data.founder_number;
    }

    document.getElementById('p-rating').textContent = data.rating ?? 0;
    document.getElementById('p-invites').textContent = data.invites ?? 0;
    document.getElementById('p-visits').textContent = data.total_visits ?? 0;

    // Streak
    const cur  = data.streak_current || 0;
    const best = data.streak_best || 0;
    document.getElementById('p-streak-val').textContent  = cur + ' dni';
    document.getElementById('p-streak-best').textContent = best + ' dni';

    // Progress do następnego bonusu
    let progress = 0, nextLabel = 'Streak';
    if (cur < 7)        { progress = (cur/7)*100;   nextLabel = `Do +5 pkt: ${7-cur} dni`; }
    else if (cur < 30)  { progress = (cur/30)*100;  nextLabel = `Do +15 pkt: ${30-cur} dni`; }
    else if (cur < 90)  { progress = (cur/90)*100;  nextLabel = `Do +50 pkt: ${90-cur} dni`; }
    else if (cur < 365) { progress = (cur/365)*100; nextLabel = `Do +200 pkt: ${365-cur} dni`; }
    else                { progress = 100;            nextLabel = '🏆 Maksymalny streak!'; }

    document.getElementById('p-streak-bar').style.width = Math.min(100, progress) + '%';
    document.getElementById('p-streak-label').textContent = nextLabel;

    // Info
    document.getElementById('p-city').textContent     = data.city     || 'Warsaw';
    document.getElementById('p-district').textContent = data.district || '—';
    document.getElementById('p-freeze').textContent   = data.streak_freeze_available ?? 0;
    document.getElementById('p-spin-today').textContent = data.spun_today
      ? '✅ ' + (data.spin_prize || 'kręcono')
      : '❌ nie kręcono';

    loading.style.display = 'none';
    content.style.display = 'block';

    // Stan spinu
    state.spinDone = !!data.spun_today;
    if (state.spinDone) updateSpinUIAlreadyDone(data.spin_prize);

  } catch (e) {
    loading.style.display = 'none';
    if (e.message.includes('401') || e.message.includes('not found') || e.message.includes('nie zarejestrowany')) {
      unauth.style.display = 'block';
    } else {
      err.textContent = '⚠️ Błąd: ' + e.message;
      err.classList.add('visible');
    }
  }
}

/* ═══════════════════════════════════════════════════
   LOKALE
═══════════════════════════════════════════════════ */
async function loadVenues() {
  state.venuesLoaded = true;
  try {
    const data = await apiCall('/api/venues');
    state.venues = data.venues || [];

    const select = document.getElementById('venue-select');
    const list   = document.getElementById('venues-list');

    // Wypełnij select
    select.innerHTML = '<option value="">— wybierz lokal —</option>';
    state.venues.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name + ' (' + v.city + ')';
      select.appendChild(opt);
    });

    // Wypełnij listę
    if (state.venues.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🏪</div><div class="empty-text">Brak aktywnych lokali</div></div>';
      return;
    }

    list.innerHTML = state.venues.map(v => `
      <div class="venue-card" onclick="selectVenue(${v.id})">
        <div class="venue-icon">🏪</div>
        <div class="venue-info">
          <div class="venue-name">${esc(v.name)}</div>
          <div class="venue-meta">${esc(v.city)}${v.address ? ' · ' + esc(v.address) : ''}</div>
        </div>
        <span class="venue-id-badge">ID ${v.id}</span>
      </div>
    `).join('');

  } catch (e) {
    document.getElementById('venues-list').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">Błąd ładowania lokali</div><div class="empty-sub">' + esc(e.message) + '</div></div>';
  }
}

function selectVenue(id) {
  document.getElementById('venue-select').value = String(id);
  if (TG) TG.HapticFeedback?.selectionChanged();
}

/* ═══════════════════════════════════════════════════
   CHECK-IN
═══════════════════════════════════════════════════ */
async function doCheckin() {
  if (!TG_USER) return showCheckinError('Musisz otworzyć aplikację przez Telegram.');

  const venueId = document.getElementById('venue-select').value;
  if (!venueId) return showCheckinError('Wybierz lokal z listy.');

  const btn = document.getElementById('checkin-btn');
  btn.disabled = true;
  btn.textContent = 'Generowanie…';
  hideCheckinMessages();

  try {
    const data = await apiCall('/api/checkin', 'POST', { venue_id: Number(venueId) });

    if (data.already_today) {
      showCheckinSuccess(`✅ Dziś już byłeś w tym lokalu! Wizyta: ${data.day}`);
      btn.disabled = false;
      btn.textContent = 'Generuj OTP ✓';
      return;
    }

    // Pokaż OTP
    const otp = data.otp;
    const venue = state.venues.find(v => v.id === Number(venueId));
    showOtp(otp, venue?.name || 'Lokal', data.expires_at);
    if (TG) TG.HapticFeedback?.notificationOccurred('success');

  } catch (e) {
    showCheckinError('Błąd: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = 'Generuj OTP ✓';
}

function showOtp(otp, venueName, expiresAt) {
  document.getElementById('otp-code').textContent   = otp;
  document.getElementById('otp-venue').textContent  = '🏪 ' + venueName;
  document.getElementById('otp-display').classList.add('visible');

  // Timer
  if (state.otpTimer) clearInterval(state.otpTimer);
  const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + 10 * 60 * 1000);
  state.otpExpiry = expiry;

  function updateTimer() {
    const ms = expiry - Date.now();
    if (ms <= 0) {
      document.getElementById('otp-timer-val').textContent = '0:00';
      clearInterval(state.otpTimer);
      return;
    }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    document.getElementById('otp-timer-val').textContent = m + ':' + String(s).padStart(2, '0');
  }
  updateTimer();
  state.otpTimer = setInterval(updateTimer, 1000);
}

function showCheckinError(msg) {
  const el = document.getElementById('checkin-error');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 5000);
}
function showCheckinSuccess(msg) {
  const el = document.getElementById('checkin-success');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 5000);
}
function hideCheckinMessages() {
  document.getElementById('checkin-error').classList.remove('visible');
  document.getElementById('checkin-success').classList.remove('visible');
}

/* ═══════════════════════════════════════════════════
   SPIN
═══════════════════════════════════════════════════ */
const SPIN_FRAMES = [
  ['🦊','💎','⭐','🎁','👑'],['🔥','🎟️','❄️','🏆','🎰'],
  ['💎','🦊','🎁','⭐','🔥'],['👑','❄️','🦊','💎','🎟️'],
  ['🎰','⭐','🏆','🦊','🎁'],['❄️','🔥','💎','🎟️','👑'],
];
const PRIZE_DATA = [
  { type:'rating', value:2,  label:'+2 punkty',      emoji:'🎁', weight:60 },
  { type:'rating', value:5,  label:'+5 punktów',     emoji:'⭐', weight:20 },
  { type:'invite', value:1,  label:'+1 zaproszenie', emoji:'🎟️', weight:10 },
  { type:'rating', value:15, label:'+15 punktów',    emoji:'💎', weight:7  },
  { type:'freeze', value:1,  label:'+1 Freeze',      emoji:'❄️', weight:3  },
];

function pickLocalPrize() {
  const total = PRIZE_DATA.reduce((s,p)=>s+p.weight,0);
  let r = Math.random() * total;
  for (const p of PRIZE_DATA) { r -= p.weight; if (r < 0) return p; }
  return PRIZE_DATA[0];
}

async function doSpin() {
  if (!TG_USER) return;

  const btn     = document.getElementById('spin-btn');
  const machine = document.getElementById('spin-machine');
  const result  = document.getElementById('spin-result');

  if (btn.disabled) return;
  btn.disabled = true;
  result.classList.remove('visible');
  machine.classList.add('spinning');

  // Animacja lokalna (4 klatki)
  let frame = 0;
  const anim = setInterval(() => {
    const f = SPIN_FRAMES[frame % SPIN_FRAMES.length];
    machine.textContent = f.join(' ');
    frame++;
  }, 120);

  try {
    const data = await apiCall('/api/spin', 'POST');

    // Zatrzymaj animację po ~1.5s
    setTimeout(() => {
      clearInterval(anim);
      machine.classList.remove('spinning');

      if (data.already_spun) {
        const timeLeft = data.next_spin_in || '?';
        machine.textContent = '❌ Już kręciłeś dziś';
        btn.textContent = `Następny spin za: ${timeLeft}`;
        state.spinDone = true;
        return;
      }

      const prize = data.prize;
      const emojis = [prize.emoji, prize.emoji, prize.emoji];
      machine.textContent = emojis.join('  ');

      document.getElementById('spin-result-emoji').textContent = prize.emoji;
      document.getElementById('spin-result-label').textContent = prize.label + '!';
      document.getElementById('spin-result-sub').textContent   = 'Następny spin jutro!';
      result.classList.add('visible');

      if (TG) TG.HapticFeedback?.notificationOccurred('success');

      btn.textContent = '✅ Skręcono!';
      state.spinDone = true;

      // Odśwież profil
      if (state.profileLoaded) {
        state.profileLoaded = false;
        if (state.currentScreen === 'profile') loadProfile();
      }
    }, 1500);

  } catch (e) {
    clearInterval(anim);
    machine.classList.remove('spinning');
    machine.textContent = '⚠️ Błąd';
    btn.disabled = false;
    btn.textContent = 'Spróbuj ponownie';
    if (TG) TG.HapticFeedback?.notificationOccurred('error');
  }
}

function updateSpinUIAlreadyDone(prizeLabel) {
  const btn = document.getElementById('spin-btn');
  btn.disabled = true;
  btn.textContent = '✅ Kręcono dziś: ' + (prizeLabel || 'nagroda odebrana');
}

/* ═══════════════════════════════════════════════════
   OSIĄGNIĘCIA
═══════════════════════════════════════════════════ */
const ACH_CATEGORIES = [
  { label:'🗺️ Odkrywca',   keys:['explorer_1','explorer_10','explorer_30','explorer_100'] },
  { label:'🤝 Społeczność', keys:['social_1','social_10','social_50','social_100'] },
  { label:'🔥 Streak',      keys:['streak_7','streak_30','streak_90','streak_365'] },
  { label:'🏪 Wizyty',      keys:['visits_1','visits_10','visits_50','visits_100'] },
  { label:'🎰 Spin',        keys:['spin_10','spin_30'] },
  { label:'⭐ Specjalne',   keys:['pioneer','night_fox','morning_fox','vip_diamond'] },
];

const ACH_META = {
  explorer_1:   {emoji:'🐾',label:'Pierwszy krok',   bonus:5},
  explorer_10:  {emoji:'🗺️',label:'Turysta',         bonus:10},
  explorer_30:  {emoji:'✈️',label:'Podróżnik',       bonus:30},
  explorer_100: {emoji:'🌍',label:'Legenda miejsc',   bonus:100},
  social_1:     {emoji:'🤝',label:'Przyjaciel',      bonus:5},
  social_10:    {emoji:'📣',label:'Rekruter',        bonus:50},
  social_50:    {emoji:'⭐',label:'Ambasador',       bonus:200},
  social_100:   {emoji:'👑',label:'Legenda',         bonus:500},
  streak_7:     {emoji:'🔥',label:'7 dni z rzędu',  bonus:10},
  streak_30:    {emoji:'💪',label:'30 dni z rzędu', bonus:50},
  streak_90:    {emoji:'🏅',label:'90 dni z rzędu', bonus:150},
  streak_365:   {emoji:'🏆',label:'365 dni!',       bonus:500},
  visits_1:     {emoji:'🎉',label:'Pierwsza wizyta', bonus:5},
  visits_10:    {emoji:'🥈',label:'10 wizyt',        bonus:10},
  visits_50:    {emoji:'🥇',label:'50 wizyt',        bonus:50},
  visits_100:   {emoji:'💫',label:'100 wizyt',       bonus:100},
  pioneer:      {emoji:'🚀',label:'Pionier',         bonus:20},
  night_fox:    {emoji:'🌙',label:'Nocny Fox',       bonus:10},
  morning_fox:  {emoji:'🌅',label:'Poranny Fox',     bonus:10},
  vip_diamond:  {emoji:'💎',label:'VIP Diamond',     bonus:200},
  spin_10:      {emoji:'🎰',label:'10 spinów',       bonus:15},
  spin_30:      {emoji:'🎰',label:'30 spinów',       bonus:50},
};

async function loadAchievements() {
  state.achLoaded = true;
  const loading = document.getElementById('ach-loading');
  const content = document.getElementById('ach-content');
  const summary = document.getElementById('ach-summary');

  if (!TG_USER) {
    loading.style.display = 'none';
    content.innerHTML = '<div class="empty-state"><div class="empty-icon">🦊</div><div class="empty-text">Otwórz przez Telegram</div></div>';
    return;
  }

  try {
    const data = await apiCall('/api/achievements');
    const have = new Set(data.achievements || []);
    const total = Object.keys(ACH_META).length;
    summary.textContent = `Odblokowano: ${have.size} / ${total}`;
    loading.style.display = 'none';

    content.innerHTML = ACH_CATEGORIES.map(cat => {
      const catUnlocked = cat.keys.filter(k => have.has(k)).length;
      const items = cat.keys.map(key => {
        const m = ACH_META[key];
        if (!m) return '';
        const unlocked = have.has(key);
        return `
          <div class="ach-item${unlocked ? ' unlocked' : ''}">
            ${unlocked ? '<div class="ach-check">✓</div>' : ''}
            <span class="ach-emoji">${m.emoji}</span>
            <div class="ach-label">${esc(m.label)}</div>
            ${unlocked
              ? `<div class="ach-bonus">+${m.bonus} pkt ✅</div>`
              : `<div class="ach-lock">+${m.bonus} pkt 🔒</div>`
            }
          </div>`;
      }).join('');

      return `
        <div class="ach-category">
          <div class="ach-category-title">
            ${esc(cat.label)}
            <span class="ach-count-badge">${catUnlocked}/${cat.keys.length}</span>
          </div>
          <div class="ach-grid">${items}</div>
        </div>`;
    }).join('');

  } catch (e) {
    loading.style.display = 'none';
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">Błąd ładowania</div><div class="empty-sub">${esc(e.message)}</div></div>`;
  }
}

/* ═══════════════════════════════════════════════════
   LEADERBOARD
═══════════════════════════════════════════════════ */
async function loadTop() {
  state.topLoaded = true;
  const loading = document.getElementById('top-loading');
  const content = document.getElementById('top-content');

  try {
    const data = await apiCall('/api/top');
    loading.style.display = 'none';

    const medals = ['🥇','🥈','🥉'];
    const myUserId = TG_USER ? String(TG_USER.id) : null;

    const rows = (data.top || []).map((f, i) => {
      const isMe = myUserId && String(f.user_id) === myUserId;
      const pos = i + 1;
      const posClass = pos <= 3 ? ` pos-${pos}` : '';
      const meClass  = isMe ? ' me' : '';
      const nick = f.username ? '@' + f.username : 'Fox #' + String(f.user_id).slice(-4);
      const founderHtml = f.founder_number
        ? `<span class="leader-founder">👑 #${f.founder_number}</span>`
        : '';
      return `
        <div class="leader-row${posClass}${meClass}">
          <div class="leader-pos">${medals[i] || pos}</div>
          <div class="leader-avatar">🦊</div>
          <div class="leader-info">
            <div class="leader-name">${esc(nick)}${isMe ? ' ← Ty' : ''}</div>
            <div class="leader-sub">${founderHtml}</div>
          </div>
          <div class="leader-rating">${f.rating} pkt</div>
        </div>`;
    }).join('');

    let myPosHtml = '';
    if (data.my_position && data.my_position > 10) {
      myPosHtml = `
        <div class="my-pos-card">
          <span>Twoja pozycja</span>
          <span class="my-pos-right">#${data.my_position} · ${data.my_rating || 0} pkt</span>
        </div>`;
    }

    content.innerHTML = `<div class="leaderboard">${rows}</div>${myPosHtml}`;

  } catch (e) {
    loading.style.display = 'none';
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">Błąd ładowania</div><div class="empty-sub">${esc(e.message)}</div></div>`;
  }
}

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ═══════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════ */
(function init() {
  // Pierwsze załadowanie ekranu profilu
  loadProfile();

  // Jeśli nie w Telegram — pokaż ostrzeżenie w konsoli
  if (!TG) {
    console.warn('[FoxPot] Nie w Telegram WebApp — część funkcji niedostępna.');
  }
})();
</script>
</body>
</html>
