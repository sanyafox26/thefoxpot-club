const fs = require('fs');
let html = fs.readFileSync('fox-profile.html', 'utf8');

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

  // Contact line
  const locParts = [district, address, city].filter(Boolean);
  const cParts = [];
  if (locParts.length) cParts.push(locParts.join(' · '));
  if (email) cParts.push(email);
  cParts.push(profileUrl);
  const contactLine = cParts.join(' &nbsp;|&nbsp; ');

  // Sections
  let body = '';

  if (show('experience') && localExperience.length) {
    body += '<div class="section-title">Doświadczenie zawodowe</div>'
      + localExperience.map(e =>
          '<div class="cv-row"><span class="cv-title">' + escHtml(e.title||'') + '</span>'
          + (e.period ? '<span class="cv-date">' + escHtml(e.period) + '</span>' : '') + '</div>'
          + (e.company ? '<div class="cv-company">' + escHtml(e.company) + '</div>' : '')
          + (e.desc    ? '<div class="cv-desc">'   + escHtml(e.desc)    + '</div>' : '')
        ).join('');
  }

  if (show('education') && localEducation.length) {
    body += '<div class="section-title">Wykształcenie</div>'
      + localEducation.map(e => {
          const sub = [e.field, e.degree].filter(Boolean).map(escHtml).join(' · ');
          return '<div class="cv-row"><span class="cv-title" style="color:#F97E00">' + escHtml(e.school||'') + '</span>'
            + (e.years ? '<span class="cv-date">' + escHtml(e.years) + '</span>' : '') + '</div>'
            + (sub ? '<div class="cv-desc" style="margin-left:0">' + sub + '</div>' : '');
        }).join('');
  }

  if (show('skills') && localSkills.length) {
    body += '<div class="section-title">Umiejętności</div>'
      + '<div class="cv-tags">' + localSkills.map(escHtml).join(' · ') + '</div>';
  }

  if (show('services') && localServices.length) {
    body += '<div class="section-title">Usługi / Oferta</div>'
      + localServices.map(s =>
          '<div class="cv-row"><span class="cv-title">' + escHtml(s.name||'') + '</span>'
          + (s.price ? '<span style="color:#F97E00;font-size:10px">' + escHtml(s.price) + '</span>' : '') + '</div>'
          + (s.desc  ? '<div class="cv-desc" style="margin-left:0">' + escHtml(s.desc) + '</div>' : '')
        ).join('');
  }

  if (show('portfolio') && localPortfolio.length) {
    body += '<div class="section-title">Portfolio</div>'
      + localPortfolio.map(p => {
          const sub = [p.role, p.result].filter(Boolean).map(escHtml).join(' · ');
          return '<div class="cv-row"><span class="cv-title">' + escHtml(p.title||'') + '</span>'
            + (p.url ? '<a href="'+escHtml(p.url)+'" style="color:#F97E00;font-size:10px">'+escHtml(p.url)+'</a>' : '') + '</div>'
            + (sub ? '<div class="cv-desc" style="margin-left:0">' + sub + '</div>' : '')
            + ((p.tags||[]).length ? '<div style="font-size:9px;color:#999;margin-bottom:8px">' + p.tags.map(escHtml).join(' · ') + '</div>' : '');
        }).join('');
  }

  const doc = \`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial,sans-serif; font-size:11px; color:#222; background:white; padding:15mm; }
  h1 { font-size:24px; font-weight:700; margin-bottom:4px; }
  .contacts { font-size:10px; color:#555; margin-bottom:8px; }
  .bio { font-size:11px; font-style:italic; margin:6px 0; color:#333; }
  .specs { font-size:10px; color:#F97E00; margin-bottom:8px; }
  .divider { border:none; border-top:2px solid #F97E00; margin:10px 0; }
  .section-title { font-size:10px; font-weight:700; letter-spacing:2px; text-transform:uppercase; border-bottom:1px solid #ddd; padding-bottom:3px; margin:14px 0 8px 0; color:#333; }
  .cv-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:2px; }
  .cv-title { font-weight:700; font-size:11px; }
  .cv-date { font-size:10px; color:#777; }
  .cv-company { color:#F97E00; font-size:11px; margin-bottom:2px; }
  .cv-desc { font-size:10px; color:#555; margin-left:10px; margin-bottom:8px; line-height:1.5; }
  .cv-tags { font-size:10px; color:#333; line-height:1.8; margin-bottom:8px; }
  .footer { border-top:1px solid #eee; margin-top:20px; padding-top:6px; font-size:8px; color:#aaa; text-align:center; }
  .rodo { font-size:7px; color:#bbb; font-style:italic; margin-top:4px; text-align:center; }
  @media print { @page { margin:15mm; size:A4 portrait; } body { padding:0; } }
</style>
</head>
<body>
  <h1>\${name}</h1>
  <div class="contacts">\${contactLine}</div>
  \${hourly  ? '<div class="contacts">Stawka: '+hourly+'</div>' : ''}
  \${langs.length ? '<div class="contacts">Języki: '+langs.join(' · ')+'</div>' : ''}
  \${bio    ? '<div class="bio">'+bio+'</div>' : ''}
  \${specs.length ? '<div class="specs">'+specs.map(s=>escHtml(s)).join(' · ')+'</div>' : ''}
  <hr class="divider"/>
  \${body}
  <div class="rodo">Wyrażam zgodę na przetwarzanie moich danych osobowych zawartych w tym dokumencie dla celów rekrutacji, zgodnie z RODO (Rozporządzenie UE 2016/679).</div>
  <div class="footer">Profil: thefoxpot.club/fox/\${NICKNAME}</div>
</body>
</html>\`;

  const w = window.open('', '_blank');
  if (!w) { alert('Zezwól na otwieranie nowych okien w przeglądarce.'); return; }
  w.document.write(doc);
  w.document.close();
  w.print();
}`;

html = html.slice(0, fnStart) + newFn + html.slice(fnEnd);

fs.writeFileSync('fox-profile.html', html);
console.log('Done, size:', html.length);
