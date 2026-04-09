const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

const oldStart = html.indexOf('function generatePdf() {');
const oldEnd   = html.indexOf('\n// ── Init ──');

const newFn = `function generatePdf() {
  const logoSrc = document.querySelector('.topbar-logo img')?.src || '';
  const name    = escHtml(localDisplayName || NICKNAME);
  const bio     = escHtml(profileData?.bio || '');
  const specs   = localSpecializations || [];
  const city    = escHtml(profileData?.city || '');
  const district= escHtml(localDistrict || '');
  const address = escHtml(localAddress || '');
  const email   = escHtml(localEmail || '');
  const profileUrl = location.origin + '/fox/' + NICKNAME;
  const hourly  = escHtml(profileData?.hourly_rate || '');
  const langs   = Array.isArray(profileData?.languages) ? profileData.languages.map(escHtml) : [];
  const vis = localSectionsVis;
  const show = s => vis[s] !== false;

  // ── Header lines ──
  const locParts = [district, address, city].filter(Boolean);
  const locLine  = locParts.join(' · ');
  const contactParts = [];
  if (email) contactParts.push('📧 ' + email);
  contactParts.push('🌐 ' + profileUrl);
  const contactLine = contactParts.join(' &nbsp;·&nbsp; ');

  // ── Sections ──
  let sectionsHtml = '';

  if (show('experience') && localExperience.length) {
    sectionsHtml += '<div class="cv-sec"><div class="cv-sec-title">Doświadczenie zawodowe</div>'
      + localExperience.map(e =>
          '<div class="cv-item">'
          + '<div class="cv-row"><span class="cv-item-title">' + escHtml(e.title||'') + '</span>'
          + (e.period ? '<span class="cv-meta">' + escHtml(e.period) + '</span>' : '') + '</div>'
          + (e.company ? '<div class="cv-company">' + escHtml(e.company) + '</div>' : '')
          + (e.desc    ? '<div class="cv-desc">'    + escHtml(e.desc)    + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('education') && localEducation.length) {
    sectionsHtml += '<div class="cv-sec"><div class="cv-sec-title">Wykształcenie</div>'
      + localEducation.map(e =>
          '<div class="cv-item">'
          + '<div class="cv-row"><span class="cv-item-title cv-orange">' + escHtml(e.school||'') + '</span>'
          + (e.years ? '<span class="cv-meta">' + escHtml(e.years) + '</span>' : '') + '</div>'
          + (e.field  ? '<div class="cv-company">' + escHtml(e.field)  + '</div>' : '')
          + (e.degree ? '<div class="cv-desc">'   + escHtml(e.degree) + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('skills') && localSkills.length) {
    sectionsHtml += '<div class="cv-sec"><div class="cv-sec-title">Umiejętności</div>'
      + '<div class="cv-desc">' + localSkills.map(escHtml).join(' · ') + '</div>'
      + '</div>';
  }

  if (show('services') && localServices.length) {
    sectionsHtml += '<div class="cv-sec"><div class="cv-sec-title">Usługi / Oferta</div>'
      + localServices.map(s =>
          '<div class="cv-item">'
          + '<div class="cv-row"><span class="cv-item-title cv-orange">' + escHtml(s.name||'') + '</span>'
          + (s.price ? '<span class="cv-meta">' + escHtml(s.price) + '</span>' : '') + '</div>'
          + (s.desc  ? '<div class="cv-desc">' + escHtml(s.desc) + '</div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  if (show('portfolio') && localPortfolio.length) {
    sectionsHtml += '<div class="cv-sec"><div class="cv-sec-title">Portfolio</div>'
      + localPortfolio.map(p =>
          '<div class="cv-item">'
          + '<div class="cv-item-title">' + escHtml(p.title||'') + '</div>'
          + (p.result ? '<div class="cv-desc">' + escHtml(p.result) + '</div>' : '')
          + ((p.tags||[]).length ? '<div class="cv-desc" style="color:#888">' + p.tags.map(escHtml).join(' · ') + '</div>' : '')
          + (p.url    ? '<div class="cv-desc"><a href="' + escHtml(p.url) + '" style="color:#F97E00">' + escHtml(p.url) + '</a></div>' : '')
          + '</div>').join('')
      + '</div>';
  }

  // ── Build full HTML ──
  const doc = '<!DOCTYPE html><html><head><meta charset="utf-8"/><style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;font-size:12px;padding:15mm}'
    + '.cv-logo{height:32px;width:auto;display:block;margin-bottom:12px}'
    + '.cv-name{font-size:24px;font-weight:700;color:#111;margin-bottom:5px}'
    + '.cv-loc{font-size:11px;color:#555;margin-bottom:2px}'
    + '.cv-contact{font-size:11px;color:#555;margin-bottom:4px}'
    + '.cv-extra{font-size:11px;color:#555;margin-bottom:2px}'
    + '.cv-bio{font-size:12px;color:#333;line-height:1.5;margin-top:8px;margin-bottom:8px}'
    + '.cv-specs{font-size:11px;color:#F97E00;margin-bottom:10px}'
    + '.cv-hr{border:none;border-top:1px solid #ddd;margin:12px 0}'
    + '.cv-sec{margin-top:14px}'
    + '.cv-sec-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;'
    +   'color:#111;border-bottom:1px solid #F97E00;padding-bottom:3px;margin-bottom:8px}'
    + '.cv-item{margin-bottom:9px}'
    + '.cv-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}'
    + '.cv-item-title{font-size:13px;font-weight:600;color:#111}'
    + '.cv-orange{color:#F97E00}'
    + '.cv-company{font-size:11px;color:#F97E00;margin-top:1px}'
    + '.cv-meta{font-size:10px;color:#888;white-space:nowrap}'
    + '.cv-desc{font-size:11px;color:#555;margin-top:3px;line-height:1.5}'
    + '.cv-footer{position:fixed;bottom:8mm;left:0;right:0;text-align:center;'
    +   'font-size:9px;color:#bbb;border-top:1px solid #eee;padding-top:3px}'
    + '</style></head><body>'
    + (logoSrc ? '<img class="cv-logo" src="' + logoSrc + '" alt=""/>' : '')
    + '<div class="cv-name">' + name + '</div>'
    + (locLine    ? '<div class="cv-loc">'     + locLine     + '</div>' : '')
    + '<div class="cv-contact">' + contactLine + '</div>'
    + (hourly     ? '<div class="cv-extra">💰 ' + hourly + '</div>' : '')
    + (langs.length ? '<div class="cv-extra">🗣 ' + langs.join(' · ') + '</div>' : '')
    + (bio        ? '<div class="cv-bio">'     + bio         + '</div>' : '')
    + (specs.length ? '<div class="cv-specs">' + specs.map(escHtml).join(' · ') + '</div>' : '')
    + '<hr class="cv-hr"/>'
    + sectionsHtml
    + '<div class="cv-footer">Wygenerowano przez The FoxPot Club &middot; thefoxpot.club</div>'
    + '</body></html>';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;left:-9999px;top:0;width:794px';
  wrapper.innerHTML = doc;
  document.body.appendChild(wrapper);

  html2pdf().set({
    margin: 0,
    filename: 'cv-' + NICKNAME + '.pdf',
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, allowTaint: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(wrapper).save().then(() => document.body.removeChild(wrapper));
}

`;

html = html.slice(0, oldStart) + newFn + html.slice(oldEnd);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
