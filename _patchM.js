const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

// ── 1. Add html2pdf CDN before </body> ──
html = html.replace(
  `<div id="cv-print"></div>\n</body>`,
  `<div id="cv-print"></div>\n<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>\n</body>`
);

// ── 2. Wrap avatar in heroPhotoWrap + add toggle button ──
html = html.replace(
  `      <div class="avatar-wrap">
        <img class="avatar" id="foxAvatar" src="" alt=""/>
      </div>`,
  `      <div id="heroPhotoWrap">
        <div class="avatar-wrap">
          <img class="avatar" id="foxAvatar" src="" alt=""/>
        </div>
        <button class="hero-vis-btn" id="visHeroPhoto" onclick="toggleSectionVis('photo')"></button>
      </div>`
);

// ── 3. Add photo to heroItems array ──
html = html.replace(
  `  const heroItems = [
    { key: 'address',         wrapId: 'heroAddressWrap', btnId: 'visHeroAddress' },`,
  `  const heroItems = [
    { key: 'photo',           wrapId: 'heroPhotoWrap',   btnId: 'visHeroPhoto' },
    { key: 'address',         wrapId: 'heroAddressWrap', btnId: 'visHeroAddress' },`
);

// ── 4. Add photo label ──
html = html.replace(
  `    address: 'Adres', email: 'Email', rating: 'Rating', availability: 'Dostępność',`,
  `    photo: 'Zdjęcie', address: 'Adres', email: 'Email', rating: 'Rating', availability: 'Dostępność',`
);

// ── 5. Replace generatePdf() — use html2pdf, add avatar, absolute URL ──
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

  // Avatar — absolute URL, respects photo toggle
  const avatarSrc = (show('photo') && document.getElementById('foxAvatar')?.src) || '';

  // Contact line
  const locParts = [district, address, city].filter(Boolean);
  const cParts = [];
  if (locParts.length) cParts.push(locParts.join(' · '));
  if (email) cParts.push(email);
  cParts.push(profileUrl);
  const contactLine = cParts.join(' &nbsp;|&nbsp; ');

  // Sections
  let sections = '';

  if (show('experience') && localExperience.length) {
    sections += '<div class="section-title">Doświadczenie zawodowe</div>'
      + localExperience.map(e =>
          '<div class="cv-row"><span class="cv-title">' + escHtml(e.title||'') + '</span>'
          + (e.period ? '<span class="cv-date">' + escHtml(e.period) + '</span>' : '') + '</div>'
          + (e.company ? '<div class="cv-company">' + escHtml(e.company) + '</div>' : '')
          + (e.desc    ? '<div class="cv-desc">'   + escHtml(e.desc)    + '</div>' : '')
        ).join('');
  }

  if (show('education') && localEducation.length) {
    sections += '<div class="section-title">Wykształcenie</div>'
      + localEducation.map(e => {
          const sub = [e.field, e.degree].filter(Boolean).map(escHtml).join(' · ');
          return '<div class="cv-row"><span class="cv-title" style="color:#F97E00">' + escHtml(e.school||'') + '</span>'
            + (e.years ? '<span class="cv-date">' + escHtml(e.years) + '</span>' : '') + '</div>'
            + (sub ? '<div class="cv-desc" style="margin-left:0">' + sub + '</div>' : '');
        }).join('');
  }

  if (show('skills') && localSkills.length) {
    sections += '<div class="section-title">Umiejętności</div>'
      + '<div class="cv-tags">' + localSkills.map(escHtml).join(' · ') + '</div>';
  }

  if (show('services') && localServices.length) {
    sections += '<div class="section-title">Usługi / Oferta</div>'
      + localServices.map(s =>
          '<div class="cv-row"><span class="cv-title">' + escHtml(s.name||'') + '</span>'
          + (s.price ? '<span style="color:#F97E00;font-size:10px">' + escHtml(s.price) + '</span>' : '') + '</div>'
          + (s.desc  ? '<div class="cv-desc" style="margin-left:0">' + escHtml(s.desc) + '</div>' : '')
        ).join('');
  }

  if (show('portfolio') && localPortfolio.length) {
    sections += '<div class="section-title">Portfolio</div>'
      + localPortfolio.map(p => {
          const sub = [p.role, p.result].filter(Boolean).map(escHtml).join(' · ');
          return '<div class="cv-row"><span class="cv-title">' + escHtml(p.title||'') + '</span>'
            + (p.url ? '<a href="'+escHtml(p.url)+'" style="color:#F97E00;font-size:10px">'+escHtml(p.url)+'</a>' : '') + '</div>'
            + (sub ? '<div class="cv-desc" style="margin-left:0">' + sub + '</div>' : '')
            + ((p.tags||[]).length ? '<div style="font-size:9px;color:#999;margin-bottom:8px">' + p.tags.map(escHtml).join(' · ') + '</div>' : '');
        }).join('');
  }

  // Header: flex row with optional photo
  const headerHtml = avatarSrc
    ? '<div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:8px">'
      + '<img src="'+avatarSrc+'" style="width:70px;height:70px;border-radius:50%;object-fit:cover;flex-shrink:0"/>'
      + '<div style="flex:1"><h1>'+name+'</h1>'
      + '<div class="contacts">'+contactLine+'</div>'
      + (hourly  ? '<div class="contacts">Stawka: '+hourly+'</div>' : '')
      + (langs.length ? '<div class="contacts">Języki: '+langs.join(' · ')+'</div>' : '')
      + '</div></div>'
    : '<h1>'+name+'</h1>'
      + '<div class="contacts">'+contactLine+'</div>'
      + (hourly  ? '<div class="contacts">Stawka: '+hourly+'</div>' : '')
      + (langs.length ? '<div class="contacts">Języki: '+langs.join(' · ')+'</div>' : '');

  const htmlString = \`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:11px; color:#222; background:white; padding:15mm; }
  h1 { font-size:24px; font-weight:700; margin-bottom:4px; }
  .contacts { font-size:10px; color:#555; margin-bottom:4px; }
  .bio { font-size:11px; font-style:italic; margin:6px 0; color:#333; }
  .specs { font-size:10px; color:#F97E00; margin-bottom:8px; }
  .divider { border:none; border-top:2px solid #F97E00; margin:10px 0; }
  .section-title { font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; border-bottom:1px solid #ddd; padding-bottom:3px; margin:14px 0 8px 0; color:#333; }
  .cv-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:2px; }
  .cv-title { font-weight:700; font-size:11px; }
  .cv-date { font-size:10px; color:#777; white-space:nowrap; }
  .cv-company { color:#F97E00; font-size:11px; margin-bottom:2px; }
  .cv-desc { font-size:10px; color:#555; margin-left:10px; margin-bottom:8px; line-height:1.5; }
  .cv-tags { font-size:10px; color:#333; line-height:1.8; margin-bottom:8px; }
  .footer { border-top:1px solid #eee; margin-top:20px; padding-top:6px; font-size:8px; color:#aaa; text-align:center; }
  .rodo { font-size:7px; color:#bbb; font-style:italic; margin-top:4px; text-align:center; }
</style></head>
<body>
  \${headerHtml}
  \${bio    ? '<div class="bio">'+bio+'</div>' : ''}
  \${specs.length ? '<div class="specs">'+specs.map(escHtml).join(' · ')+'</div>' : ''}
  <hr class="divider"/>
  \${sections}
  <div class="rodo">Wyrażam zgodę na przetwarzanie moich danych osobowych zawartych w tym dokumencie dla celów rekrutacji, zgodnie z RODO (Rozporządzenie UE 2016/679).</div>
  <div class="footer">Profil: thefoxpot.club/fox/\${NICKNAME}</div>
</body></html>\`;

  const filename = 'CV_' + (localDisplayName || NICKNAME).replace(/\\s+/g, '_') + '.pdf';
  const opt = {
    margin: [15, 15, 15, 15],
    filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, background: '#ffffff', useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };
  html2pdf().set(opt).from(htmlString).save();
}`;

html = html.slice(0, fnStart) + newFn + html.slice(fnEnd);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
