// One step of the serverless Kaggle cycle. GitHub Actions runs this every hour:
//   node tools/cycle.mjs <poolDir>
//
// - If a Kaggle batch is running: check it; when it's done, import its faces into the pool.
// - If nothing is running and a batch is due (KAGGLE_EVERY_HOURS): start the next one.
// - Keeps only the newest TARGET_POOL faces (oldest deleted first).
// - Writes <poolDir>/manifest.json for the static site.
//
// The pool folder (db.json, images/, kaggle/state.json) lives on the repo's `pool` branch.
// Prints  deploy=true|false  and  save=true|false  to $GITHUB_OUTPUT.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Store } from '../lib/store.js';
import { KaggleBatcher } from '../lib/kaggle.js';
import { finishImage } from '../lib/image.js';
import { sampleProfile } from '../public/promptEngine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poolDir = path.resolve(process.argv[2] || 'pool');
const TARGET_POOL = Number(process.env.TARGET_POOL || 500);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/phenotypes.json'), 'utf8'));
let overrides = {};
const cal = path.join(ROOT, 'fairface_calibration.json');
if (fs.existsSync(cal)) {
  const c = JSON.parse(fs.readFileSync(cal, 'utf8'));
  const ws = config.generation_pipeline_rules.weighted_sampling_strategy;
  const mix = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, 0.5 * a[k] + 0.5 * (b?.[k] ?? a[k])]));
  overrides = { age_cohort_weights: mix(ws.age_cohort_weights, c.age_cohort_weights), gender_weights: mix({ woman: 0.5, man: 0.5 }, c.gender_weights) };
}

const store = new Store(poolDir);
const idsBefore = new Set(store.rows.map((r) => r.id));
process.env.KAGGLE_POLL_MINUTES = '0'; // this script runs hourly: always check when called

const kaggle = new KaggleBatcher({
  root: ROOT, store, config, sampleProfile, finishImage, log,
  getOverrides: () => overrides,
  wantMore: () => true,
  afterAdd: () => { while (store.count() > TARGET_POOL) store.removeOldest(); },
});
if (!kaggle.enabled()) {
  // Still let the site deploy (it falls back to local-data), but flag it in the Actions run.
  console.log('::warning::Kaggle is not configured: add the KAGGLE_USERNAME variable and KAGGLE_API_TOKEN secret in Settings → Secrets and variables → Actions.');
  writeManifest(store, path.join(poolDir, 'manifest.json'), 'faces/');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'deploy=false\nsave=false\n');
  process.exit(0);
}

const before = JSON.stringify({ s: kaggle.state.status, b: kaggle.state.batchId, e: kaggle.state.lastError });
await kaggle.tick();
const after = JSON.stringify({ s: kaggle.state.status, b: kaggle.state.batchId, e: kaggle.state.lastError });
store.flush();

// working folders never go into the pool branch
fs.rmSync(path.join(kaggle.dir, 'push'), { recursive: true, force: true });
fs.rmSync(path.join(kaggle.dir, 'output'), { recursive: true, force: true });

const changedFaces = store.rows.some((r) => !idsBefore.has(r.id)) || store.count() !== idsBefore.size;
writeManifest(store, path.join(poolDir, 'manifest.json'), 'faces/');

const st = kaggle.publicState();
log(`status=${st.status}${st.kaggleStatus ? ` (kaggle: ${st.kaggleStatus})` : ''} pool=${store.count()} ${changedFaces ? 'NEW FACES' : ''}${st.lastError ? ` lastError=${st.lastError}` : ''}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${changedFaces}\nsave=${changedFaces || before !== after}\n`);
}
// Show Kaggle problems as an error note on the Actions run (the job itself keeps going so the
// pool is still saved and the site still deploys).
if (st.lastError && before !== after) console.log(`::error::${st.lastError.replace(/\r?\n/g, ' ')}`);

function writeManifest(s, file, prefix) {
  const faces = [...s.rows]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      id: r.id, src: `${prefix}${r.file}`, batch: r.batch || null, provider: r.provider, model: r.model,
      createdAt: r.createdAt, age: r.age, gender: r.gender, city: r.city, region_label: r.region_label, prompt: r.prompt,
    }));
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), freshMin: Number(process.env.FRESH_MIN || 20), faces }));
}
