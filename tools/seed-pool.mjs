// Copy faces you generated locally (e.g. a Kaggle batch run by `npm start`) into the
// GitHub Pages pool, so the live site shows them without waiting for the hourly Action.
//   node tools/seed-pool.mjs <srcDir> <poolDir>      (defaults: data pool)
// <poolDir> should be a clone of the repo's `pool` branch. Existing pool faces and
// kaggle/state.json are kept; duplicates (same id) are skipped.

import fs from 'fs';
import path from 'path';

const src = path.resolve(process.argv[2] || 'data');
const pool = path.resolve(process.argv[3] || 'pool');
const TARGET_POOL = Number(process.env.TARGET_POOL || 500);

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);
const srcRows = read(path.join(src, 'db.json')).filter((r) => fs.existsSync(path.join(src, 'images', r.file)));
const poolRows = read(path.join(pool, 'db.json')).filter((r) => fs.existsSync(path.join(pool, 'images', r.file)));

fs.mkdirSync(path.join(pool, 'images'), { recursive: true });
const have = new Set(poolRows.map((r) => r.id));
let added = 0;
for (const r of srcRows) {
  if (have.has(r.id)) continue;
  fs.copyFileSync(path.join(src, 'images', r.file), path.join(pool, 'images', r.file));
  poolRows.push({ ...r, views: 0 });
  added++;
}

// keep only the newest TARGET_POOL faces, same rule as the Action
poolRows.sort((a, b) => b.createdAt - a.createdAt);
for (const r of poolRows.splice(TARGET_POOL)) fs.rmSync(path.join(pool, 'images', r.file), { force: true });

fs.writeFileSync(path.join(pool, 'db.json'), JSON.stringify(poolRows));
fs.writeFileSync(path.join(pool, 'manifest.json'), JSON.stringify({
  updatedAt: Date.now(), freshMin: Number(process.env.FRESH_MIN || 20),
  faces: poolRows.map((r) => ({
    id: r.id, src: `faces/${r.file}`, batch: r.batch || null, provider: r.provider, model: r.model,
    createdAt: r.createdAt, age: r.age, gender: r.gender, city: r.city, region_label: r.region_label, prompt: r.prompt,
  })),
}));
console.log(`added ${added} faces from ${src} -> ${pool} (pool now ${poolRows.length})`);
