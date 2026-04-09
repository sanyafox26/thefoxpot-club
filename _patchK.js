const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// ── 1. Replace all @media print / #cv-print CSS ──
const cssStart = html.indexOf('#cv-print{display:none}');
const cssEnd   = html.indexOf('\n}', html.indexOf('@page{margin:15mm')) + 2; // closing brace of @media print

const newCss = `#cv-print{display:none}
body.print-mode #cv-print{display:block}
@media print{
  body *{display:none!important}
  body #cv-print,body #cv-print *{display:revert!important}
  @page{margin:15mm;size:A4}
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  #cv-print{font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#222;width:100%}
  .pcv-name{font-size:28px;font-weight:700;color:#111;margin-bottom:4px}
  .pcv-contact{font-size:10px;color:#555;margin-bottom:2px}
  .pcv-extra{font-size:10px;color:#555;margin-bottom:2px}
  .pcv-bio{font-size:11px;color:#333;font-style:italic;margin:8px 0;line-height:1.5}
  .pcv-specs{font-size:10px;color:#F97E00;margin-bottom:0}
  .pcv-hr{border:none;border-top:2px solid #F97E00;margin:10px 0}
  .pcv-sec{page-break-inside:avoid}
  .pcv-sec-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#333;border-bottom:1px solid #ddd;padding-bottom:3px;margin:14px 0 8px 0}
  .pcv-item{margin-bottom:10px;page-break-inside:avoid}
  .pcv-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .pcv-item-title{font-size:11px;font-weight:700;color:#222}
  .pcv-orange{color:#F97E00!important}
  .pcv-period{font-size:10px;color:#777;white-space:nowrap}
  .pcv-company{font-size:11px;color:#F97E00;margin-top:1px}
  .pcv-desc{font-size:10px;color:#555;margin-top:2px;margin-left:10px;line-height:1.5}
  .pcv-desc2{font-size:10px;color:#555;margin-top:2px;line-height:1.5}
  .pcv-tags{font-size:9px;color:#999;margin-top:2px}
  .pcv-skills{font-size:10px;color:#333;line-height:1.8}
  .pcv-rodo{font-size:7px;font-style:italic;color:#bbb;margin-top:4px;line-height:1.4}
  .pcv-footer{border-top:1px solid #eee;padding-top:6px;font-size:8px;color:#aaa;text-align:center;margin-top:6px}
}`;

html = html.slice(0, cssStart) + newCss + html.slice(cssEnd);

// ── 2. Replace generatePdf() body ──
const fnStart = html.indexOf('function generatePdf() {');
const fnEnd   = html.indexOf('\n\n\n// ── Init ──');

const newFn = `function generatePdf() {
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

  // Contact line: district · address · city | email | url
  const locParts = [district, address, city].filter(Boolean);
  const contactParts = [];
  if (locParts.length) contactParts.push(locParts.join(' · '));
  if (email) contactParts.push(email);
  contactParts.push(profileUrl);
  const contactLine = contactParts.join(' &nbsp;|&nbsp; ');

  let sectionsHtml = '';

  if (show('experience') && localExperience.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Doświadczenie zawodowe</div>'
      + localExperience.map(e =>
          '<div class="pcv-item">'
          + '<div class="pcv-row">'
          +   '<span class="pcv-item-title">' + escHtml(e.title||'') + '</span>'
          +   (e.period ? '<span class="pcv-period">' + escHtml(e.period) + '</span>' : '')
          + '</div>'
          + (e.company ? '<div class="pcv-company">' + escHtml(e.company) + '</div>' : '')
          + (e.desc    ? '<div class="pcv-desc">'    + escHtml(e.desc)    + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('education') && localEducation.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Wykształcenie</div>'
      + localEducation.map(e => {
          const sub = [e.field, e.degree].filter(Boolean).map(escHtml).join(' · ');
          return '<div class="pcv-item">'
            + '<div class="pcv-row">'
            +   '<span class="pcv-item-title pcv-orange">' + escHtml(e.school||'') + '</span>'
            +   (e.years ? '<span class="pcv-period">' + escHtml(e.years) + '</span>' : '')
            + '</div>'
            + (sub ? '<div class="pcv-desc2">' + sub + '</div>' : '')
            + '</div>';
        }).join('')
      + '</div>';
  }

  if (show('skills') && localSkills.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Umiejętności</div>'
      + '<div class="pcv-skills">' + localSkills.map(escHtml).join(' · ') + '</div>'
      + '</div>';
  }

  if (show('services') && localServices.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Usługi / Oferta</div>'
      + localServices.map(s =>
          '<div class="pcv-item">'
          + '<div class="pcv-row">'
          +   '<span class="pcv-item-title">' + escHtml(s.name||'') + '</span>'
          +   (s.price ? '<span class="pcv-orange" style="font-size:10px">' + escHtml(s.price) + '</span>' : '')
          + '</div>'
          + (s.desc ? '<div class="pcv-desc2">' + escHtml(s.desc) + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('portfolio') && localPortfolio.length) {
    sectionsHtml += '<div class="pcv-sec"><div class="pcv-sec-title">Portfolio</div>'
      + localPortfolio.map(p => {
          const sub = [p.role, p.result].filter(Boolean).map(escHtml).join(' · ');
          return '<div class="pcv-item">'
            + '<div class="pcv-row">'
            +   '<span class="pcv-item-title">' + escHtml(p.title||'') + '</span>'
            +   (p.url ? '<a href="'+escHtml(p.url)+'" class="pcv-orange" style="font-size:10px">'+escHtml(p.url)+'</a>' : '')
            + '</div>'
            + (sub ? '<div class="pcv-desc2">' + sub + '</div>' : '')
            + ((p.tags||[]).length ? '<div class="pcv-tags">' + p.tags.map(escHtml).join(' · ') + '</div>' : '')
            + '</div>';
        }).join('')
      + '</div>';
  }

  const cvEl = document.getElementById('cv-print');
  cvEl.innerHTML =
      '<div class="pcv-name">' + name + '</div>'
    + '<div class="pcv-contact">' + contactLine + '</div>'
    + (hourly       ? '<div class="pcv-extra">Stawka: ' + hourly + '</div>' : '')
    + (langs.length ? '<div class="pcv-extra">Języki: ' + langs.join(' · ') + '</div>' : '')
    + (bio          ? '<div class="pcv-bio">' + bio + '</div>' : '')
    + (specs.length ? '<div class="pcv-specs">' + specs.map(escHtml).join(' · ') + '</div>' : '')
    + '<hr class="pcv-hr"/>'
    + sectionsHtml
    + '<div class="pcv-rodo">Wyrażam zgodę na przetwarzanie moich danych osobowych zawartych w tym dokumencie dla celów rekrutacji, zgodnie z RODO (Rozporządzenie UE 2016/679).</div>'
    + '<div class="pcv-footer">Profil: thefoxpot.club/fox/' + NICKNAME + '</div>';

  document.body.classList.add('print-mode');
  window.print();
  document.body.classList.remove('print-mode');
}`;

html = html.slice(0, fnStart) + newFn + html.slice(fnEnd);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
