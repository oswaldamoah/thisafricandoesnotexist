// Builds the static site for GitHub Pages:
//   node tools/build-site.mjs <poolDir> <outDir>
//
// <outDir>/                 everything in public/ (index.html, promptEngine.js, phenotypes.json)
// <outDir>/faces/           the pool's images + manifest.json (newest batch shown first)
// <outDir>/local-data/      your kept faces + manifest.json (last resort)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poolDir = path.resolve(process.argv[2] || 'pool');
const out = path.resolve(process.argv[3] || '_site');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), out, { recursive: true });

function publish(srcDir, destName) {
  const db = path.join(srcDir, 'db.json');
  const dest = path.join(out, destName);
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(db)) {
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ updatedAt: Date.now(), faces: [] }));
    return 0;
  }
  const rows = JSON.parse(fs.readFileSync(db, 'utf8')).filter((r) => fs.existsSync(path.join(srcDir, 'images', r.file)));
  for (const r of rows) fs.copyFileSync(path.join(srcDir, 'images', r.file), path.join(dest, r.file));
  const faces = rows.sort((a, b) => b.createdAt - a.createdAt).map((r) => ({
    id: r.id, src: `${destName}/${r.file}`, batch: r.batch || null, provider: r.provider, model: r.model,
    createdAt: r.createdAt, age: r.age, gender: r.gender, city: r.city, region_label: r.region_label, prompt: r.prompt,
  }));
  fs.writeFileSync(path.join(dest, 'manifest.json'),
    JSON.stringify({ updatedAt: Date.now(), freshMin: Number(process.env.FRESH_MIN || 20), faces }));
  return faces.length;
}

const pool = publish(poolDir, 'faces');
const local = publish(path.join(ROOT, 'local-data'), 'local-data');
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`site built in ${out}: ${pool} pool faces, ${local} local-data faces`);
