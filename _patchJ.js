const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// ── 1. Add @media print CSS + #cv-print styles ──
html = html.replace(
  `@media print{`,
  `/* ── CV Print ── */
#cv-print{display:none}
body.print-mode #cv-print{display:block}
@media print{
  body *{display:none!important}
  body #cv-print,body #cv-print *{display:revert!important}
  #cv-print{
    font-family:Arial,Helvetica,sans-serif;
    background:#fff;color:#111;font-size:12px;
    padding:15mm;width:210mm;margin:0 auto;
  }
  .pcv-logo{height:30px;width:auto;display:block;margin-bottom:10px}
  .pcv-name{font-size:24px;font-weight:700;color:#111;margin-bottom:5px}
  .pcv-loc{font-size:11px;color:#555;margin-bottom:2px}
  .pcv-contact{font-size:11px;color:#555;margin-bottom:4px}
  .pcv-extra{font-size:11px;color:#555;margin-bottom:2px}
  .pcv-bio{font-size:12px;color:#333;line-height:1.5;margin-top:8px;margin-bottom:8px}
  .pcv-specs{font-size:11px;color:#F97E00;margin-bottom:10px}
  .pcv-hr{border:none;border-top:1px solid #ddd;margin:12px 0}
  .pcv-sec{margin-top:14px;page-break-inside:avoid}
  .pcv-sec-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#111;border-bottom:1px solid #F97E00;padding-bottom:3px;margin-bottom:8px}
  .pcv-item{margin-bottom:9px;page-break-inside:avoid}
  .pcv-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .pcv-item-title{font-size:13px;font-weight:600;color:#111}
  .pcv-orange{color:#F97E00!important}
  .pcv-company{font-size:11px;color:#F97E00;margin-top:1px}
  .pcv-meta{font-size:10px;color:#888;white-space:nowrap}
  .pcv-desc{font-size:11px;color:#555;margin-top:3px;line-height:1.5}
  .pcv-footer{margin-top:20px;padding-top:6px;border-top:1px solid #eee;font-size:9px;color:#bbb;text-align:center}
`
);

// ── 2. Add #cv-print div to body (before </body>) ──
html = html.replace(
  `<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
</body>`,
  `<div id="cv-print"></div>
</body>`
);

// ── 3. Replace generatePdf() with window.print() approach ──
const oldStart = html.indexOf('function generatePdf() {');
const oldEnd   = html.indexOf('\n\n// ── Init ──');

const newFn = `function generatePdf() {
  console.log('PDF generation started (print mode)');
  const logoSrc  = document.querySelector('.topbar-logo img')?.src || '';
  const name     = escHtml(localDisplayName || NICKNAME);
  const bio      = escHtml(profileData?.bio || '');
  const specs    = localSpecializations || [];
  const city     = escHtml(profileData?.city || '');
  const district = escHtml(localDistrict || '');
  const address  = escHtml(localAddress || '');
  const email    = escHtml(localEmail || '');
  const profileUrl = location.origin + '/fox/' + NICKNAME;
  const hourly   = escHtml(profileData?.hourly_rate || '');
  const langs    = Array.isArray(profileData?.languages) ? profileData.languages.map(escHtml) : [];
  const vis = localSectionsVis;
  const show = s => vis[s] !== false;

  const locParts = [district, address, city].filter(Boolean);
  const locLine  = locParts.join(' · ');
  const cParts   = [];
  if (email) cParts.push('📧 ' + email);
  cParts.push('🌐 ' + profileUrl);
  const contactLine = cParts.join('  ·  ');

  let sectionsHtml = '';

  if (show('experience') && localExperience.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Doświadczenie zawodowe</div>'
      + localExperience.map(e =>
          '<div class="pcv-item">'
          + '<div class="pcv-row"><span class="pcv-item-title">' + escHtml(e.title||'') + '</span>'
          + (e.period ? '<span class="pcv-meta">' + escHtml(e.period) + '</span>' : '') + '</div>'
          + (e.company ? '<div class="pcv-company">' + escHtml(e.company) + '</div>' : '')
          + (e.desc    ? '<div class="pcv-desc">'   + escHtml(e.desc)    + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('education') && localEducation.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Wykształcenie</div>'
      + localEducation.map(e =>
          '<div class="pcv-item">'
          + '<div class="pcv-row"><span class="pcv-item-title pcv-orange">' + escHtml(e.school||'') + '</span>'
          + (e.years ? '<span class="pcv-meta">' + escHtml(e.years) + '</span>' : '') + '</div>'
          + (e.field  ? '<div class="pcv-company">' + escHtml(e.field)  + '</div>' : '')
          + (e.degree ? '<div class="pcv-desc">'   + escHtml(e.degree) + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('skills') && localSkills.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Umiejętności</div>'
      + '<div class="pcv-desc">' + localSkills.map(escHtml).join(' · ') + '</div>'
      + '</div>';
  }

  if (show('services') && localServices.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Usługi / Oferta</div>'
      + localServices.map(s =>
          '<div class="pcv-item">'
          + '<div class="pcv-row"><span class="pcv-item-title pcv-orange">' + escHtml(s.name||'') + '</span>'
          + (s.price ? '<span class="pcv-meta">' + escHtml(s.price) + '</span>' : '') + '</div>'
          + (s.desc  ? '<div class="pcv-desc">' + escHtml(s.desc) + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('portfolio') && localPortfolio.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Portfolio</div>'
      + localPortfolio.map(p =>
          '<div class="pcv-item">'
          + '<div class="pcv-item-title">' + escHtml(p.title||'') + '</div>'
          + (p.result ? '<div class="pcv-desc">' + escHtml(p.result) + '</div>' : '')
          + ((p.tags||[]).length ? '<div class="pcv-desc" style="color:#888">' + p.tags.map(escHtml).join(' · ') + '</div>' : '')
          + (p.url    ? '<div class="pcv-desc"><a href="' + escHtml(p.url) + '">' + escHtml(p.url) + '</a></div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  const cvEl = document.getElementById('cv-print');
  cvEl.innerHTML =
      (logoSrc ? '<img class="pcv-logo" src="' + logoSrc + '" alt=""/>' : '')
    + '<div class="pcv-name">'    + name        + '</div>'
    + (locLine     ? '<div class="pcv-loc">'    + locLine     + '</div>' : '')
    + '<div class="pcv-contact">' + contactLine + '</div>'
    + (hourly      ? '<div class="pcv-extra">💰 ' + hourly + '</div>' : '')
    + (langs.length? '<div class="pcv-extra">🗣 ' + langs.join(' · ') + '</div>' : '')
    + (bio         ? '<div class="pcv-bio">'   + bio         + '</div>' : '')
    + (specs.length? '<div class="pcv-specs">' + specs.map(escHtml).join(' · ') + '</div>' : '')
    + '<hr class="pcv-hr"/>'
    + sectionsHtml
    + '<div class="pcv-footer">Wygenerowano przez The FoxPot Club &middot; thefoxpot.club</div>';

  document.body.classList.add('print-mode');
  window.print();
  document.body.classList.remove('print-mode');
}

`;

html = html.slice(0, oldStart) + newFn + html.slice(oldEnd);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
