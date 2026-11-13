// This African Does Not Exist — server.
// - Keeps a pool of pre-generated portraits (like thispersondoesnotexist), so every refresh is instant.
// - A background worker rotates through the free image providers, respecting each one's rate limit.
// - Serves the page, the images and a small JSON API.
//
//   npm install && npm start          -> http://localhost:3000
//   MOCK=1 npm start                  -> offline test with placeholder images

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ---- tiny .env loader (no dependency) ----
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (!/^["']/.test(v)) v = v.replace(/(^|\s+)#.*$/, ''); // strip inline comments on unquoted values
    process.env[m[1]] = v.replace(/^["']|["']$/g, '');
  }
}

const { sampleProfile } = await import('./public/promptEngine.js');
const { enabledProviders } = await import('./lib/providers.js');
const { finishImage } = await import('./lib/image.js');
const { polishPrompt, qaCheck, llmEnabled, qaEnabled } = await import('./lib/llm.js');
const { Store } = await import('./lib/store.js');

const PORT = Number(process.env.PORT || 3000);
const TARGET_POOL = Number(process.env.TARGET_POOL || 1000);   // stop generating once the pool is this big...
const ROTATE = process.env.ROTATE !== '0';                     // ...unless ROTATE=1: then keep replacing old faces
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const QA_MAX_RETRIES = 0; // a rejected image just frees the slot; the loop makes another (respects rate limits)

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/phenotypes.json'), 'utf8'));
const store = new Store(path.join(ROOT, 'data'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- optional FairFace calibration (tools/fairface_calibrate.py writes this file) ----
let overrides = {};
const calFile = path.join(ROOT, 'data/fairface_calibration.json');
if (fs.existsSync(calFile)) {
  const cal = JSON.parse(fs.readFileSync(calFile, 'utf8'));
  const blend = Number(process.env.FAIRFACE_BLEND || 0.5); // 0 = ignore FairFace, 1 = use it fully
  const mix = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, (1 - blend) * a[k] + blend * (b[k] ?? a[k])]));
  const ws = config.generation_pipeline_rules.weighted_sampling_strategy;
  if (cal.age_cohort_weights) overrides.age_cohort_weights = mix(ws.age_cohort_weights, cal.age_cohort_weights);
  if (cal.gender_weights) overrides.gender_weights = mix({ woman: 0.5, man: 0.5 }, cal.gender_weights);
  log('FairFace calibration loaded, blend', blend, overrides);
}

// ---- worker ----
const providers = enabledProviders();
const state = Object.fromEntries(providers.map((p) => [p.id, {
  busy: false, nextAt: 0, day: '', usedToday: 0, cooldownUntil: 0, failStreak: 0, ok: 0, failed: 0, rejected: 0, lastError: '',
}]));
let running = 0;

function today() { return new Date().toISOString().slice(0, 10); }

function readyProvider() {
  const now = Date.now();
  for (const p of providers) {
    const s = state[p.id];
    if (s.day !== today()) { s.day = today(); s.usedToday = 0; }
    if (!s.busy && now >= s.nextAt && now >= s.cooldownUntil && s.usedToday < p.dailyLimit) return p;
  }
  return null;
}

async function makeOne(p) {
  const s = state[p.id];
  s.busy = true;
  s.usedToday += 1;
  s.nextAt = Date.now() + p.minIntervalMs;
  try {
    for (let attempt = 0; attempt <= QA_MAX_RETRIES; attempt++) {
      const profile = sampleProfile(config, { overrides });
      const polished = await polishPrompt(profile, log);
      const prompt = polished?.prompt || profile.prompt;
      const t0 = Date.now();
      const { bytes, model } = await p.generate({ prompt, negativePrompt: profile.negativePrompt, seed: profile.seed, profile });
      const { webp, thumb } = await finishImage(bytes, { cropBottom: p.cropBottom });
      const qa = await qaCheck(thumb, profile, log);
      if (!qa.pass) {
        s.rejected += 1;
        log(`✗ ${p.id} rejected by QA (score ${qa.score}): ${qa.issues?.join('; ')}`);
        continue;
      }
      const id = crypto.randomBytes(6).toString('hex');
      store.add({
        id, file: `${id}.webp`, createdAt: Date.now(), views: 0,
        provider: p.id, model, seed: profile.seed,
        region_id: profile.region_id, region_label: profile.region_label, is_mixed_heritage: profile.is_mixed_heritage,
        cohort: profile.cohort, age: profile.age, gender: profile.gender, city: profile.city,
        hairstyle: profile.hairstyle, skin: profile.skin,
        prompt, template_prompt: profile.prompt, polished_by: polished?.by || null,
        qa_score: qa.score, ms: Date.now() - t0,
      }, webp);
      if (ROTATE && store.count() > TARGET_POOL) store.removeOldest();
      s.ok += 1; s.failStreak = 0;
      log(`✓ ${p.id}/${model} ${profile.age}${profile.gender[0]} ${profile.city} (${((Date.now() - t0) / 1000).toFixed(1)}s) pool=${store.count()}`);
      break;
    }
  } catch (e) {
    s.failed += 1; s.failStreak += 1; s.lastError = e.message.slice(0, 300);
    // back off: 429 -> respect Retry-After or 10 min; other errors -> 30s, 60s, 120s … max 30 min
    const backoff = e.status === 429 ? (e.retryAfterMs || 10 * 60e3)
      : e.status === 401 || e.status === 403 ? 60 * 60e3
      : Math.min(30e3 * 2 ** (s.failStreak - 1), 30 * 60e3);
    s.cooldownUntil = Date.now() + backoff;
    log(`! ${p.id} failed (${e.message.slice(0, 160)}) — pausing ${Math.round(backoff / 1000)}s`);
  } finally {
    s.busy = false;
  }
}

async function workerLoop() {
  if (!providers.length) { log('No image providers enabled. Check your .env'); return; }
  log('Providers:', providers.map((p) => p.id).join(', '),
    '| LLM polish:', llmEnabled() ? 'on' : 'off', '| vision QA:', qaEnabled() ? 'on' : 'off');
  for (;;) {
    const full = store.count() >= TARGET_POOL && !ROTATE;
    if (!full && running < CONCURRENCY) {
      const p = readyProvider();
      if (p) {
        running += 1;
        makeOne(p).finally(() => { running -= 1; });
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css' };

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(type === 'application/json' && typeof body !== 'string' ? JSON.stringify(body) : body);
}

function publicRecord(r) {
  return {
    id: r.id, image: `/images/${r.file}`, age: r.age, gender: r.gender, city: r.city,
    region_label: r.region_label, is_mixed_heritage: r.is_mixed_heritage,
    provider: r.provider, model: r.model, prompt: r.prompt, created_at: r.createdAt,
  };
}

function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/face') {
    const exclude = new Set((url.searchParams.get('exclude') || '').split(',').filter(Boolean));
    const r = store.random(exclude);
    if (!r) return send(res, 503, { error: 'warming up', pool: 0, providers: providers.map((x) => x.id) }, 'application/json', { 'Retry-After': '10' });
    return send(res, 200, publicRecord(r), 'application/json', { 'Cache-Control': 'no-store' });
  }
  if (p === '/face.webp' || p === '/image') { // a random face, straight as an image (TPDNE-style)
    const r = store.random();
    if (!r) return send(res, 503, { error: 'warming up' });
    return serveFile(res, path.join(store.imgDir, r.file), 'no-store');
  }
  if (p.startsWith('/api/face/')) {
    const r = store.get(p.split('/').pop());
    return r ? send(res, 200, publicRecord(r)) : send(res, 404, { error: 'not found' });
  }
  if (p === '/api/stats') {
    return send(res, 200, {
      pool: store.stats(), target: TARGET_POOL, rotate: ROTATE, running,
      providers: providers.map((x) => ({ id: x.id, label: x.label, dailyLimit: x.dailyLimit, ...state[x.id],
        cooldownSeconds: Math.max(0, Math.round((state[x.id].cooldownUntil - Date.now()) / 1000)) })),
      llm_polish: llmEnabled(), vision_qa: qaEnabled(),
    });
  }
  if (p === '/api/sample') { // preview what the prompt engine produces
    return send(res, 200, sampleProfile(config, { overrides, seed: Number(url.searchParams.get('seed')) || undefined }));
  }
  if (p.startsWith('/images/')) {
    const name = path.basename(p);
    if (!/^[a-f0-9]+\.webp$/.test(name)) return send(res, 400, { error: 'bad name' });
    return serveFile(res, path.join(store.imgDir, name), 'public, max-age=31536000, immutable');
  }
  // static files from /public
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const file = path.join(ROOT, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 400, { error: 'bad path' });
  return serveFile(res, file);
});

server.listen(PORT, () => {
  log(`This African Does Not Exist → http://localhost:${PORT}  (pool ${store.count()}/${TARGET_POOL})`);
  workerLoop();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });
