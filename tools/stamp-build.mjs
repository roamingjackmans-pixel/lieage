// Stamps a deploy with its version and makes every file URL unique to that build.
//   node tools/stamp-build.mjs <public dir> <commit>
// Run by the GitHub Pages workflow on the checkout (the result is never committed).
// Why: GitHub Pages lets browsers reuse files for ~10 minutes, and a phone could end up mixing old and
// new code. With ?v=<commit> on every script, stylesheet and import, a new build is all-new URLs.
import fs from 'node:fs';
import path from 'node:path';

const [dir = 'public', commitArg = 'dev'] = process.argv.slice(2);
const commit = String(commitArg).slice(0, 7);
const root = path.resolve(dir);
const pkg = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8'));
const built = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const info = { version: pkg.version, commit, built };

fs.writeFileSync(path.join(root, 'version.js'), `// Build stamp (written at deploy time).\nwindow.LG_VERSION = ${JSON.stringify(info)};\n`);

let n = 0;
for (const page of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {   // index.html
  const p = path.join(root, page);
  const html = fs.readFileSync(p, 'utf8').replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")((?!https?:|data:|\/\/)[^"?#]+\.(?:js|css))(")/g,
    (m, a, url, b) => { n++; return `${a}${url}?v=${commit}${b}`; });
  fs.writeFileSync(p, html);
}

let m = 0;
const d = path.join(root, 'js');
for (const f of fs.readdirSync(d)) {
  if (!f.endsWith('.js')) continue;
  const p = path.join(d, f);
  const src = fs.readFileSync(p, 'utf8');
  const out = src.replace(/((?:\bfrom|\bimport)\s*\(?\s*['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g, (all, a, url, b) => { m++; return `${a}${url}?v=${commit}${b}`; });
  if (out !== src) fs.writeFileSync(p, out);
}
console.log(`stamped v${info.version} (${commit}) · ${n} page assets · ${m} imports`);
