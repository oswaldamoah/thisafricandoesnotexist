// Automatic Kaggle GPU batches — the "free GPU" engine, fully hands-off.
//
// Every KAGGLE_EVERY_HOURS the server:
//   1. samples KAGGLE_BATCH_SIZE profiles from the prompt engine,
//   2. bakes them into kaggle/generate.py and pushes it as a private GPU notebook (kaggle CLI),
//   3. checks the run's status every few minutes,
//   4. when it's done, downloads batch.json and adds every face to the pool.
// Kaggle gives ~30 free GPU hours a week; the defaults use roughly 1.5–2.5 h a day.
//
// Needs: `pip install kaggle` on this machine, plus in .env
//   KAGGLE_USERNAME=yourname and KAGGLE_KEY=... (from kaggle.json)  or  KAGGLE_API_TOKEN=...
// and a phone-verified Kaggle account (required by Kaggle for GPU + internet in notebooks).

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

export class KaggleBatcher {
  constructor({ root, store, config, sampleProfile, getOverrides, finishImage, log, wantMore, afterAdd }) {
    Object.assign(this, { root, store, config, sampleProfile, getOverrides, finishImage, log, wantMore, afterAdd });
    this.dir = path.join(store.dir, 'kaggle');
    this.stateFile = path.join(this.dir, 'state.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.state = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : { status: 'idle' };
    this.busy = false;
  }

  get user() { return env('KAGGLE_USERNAME'); }
  get slug() { return env('KAGGLE_KERNEL_SLUG', 'thisafrican-faces'); }
  get ref() { return `${this.user}/${this.slug}`; }

  enabled() {
    return env('KAGGLE_BATCH', '1') !== '0' && !!this.user && !!(env('KAGGLE_KEY') || env('KAGGLE_API_TOKEN'));
  }

  saveState() { fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2)); }

  publicState() {
    const { jobs, ...rest } = this.state;
    return { enabled: this.enabled(), kernel: this.enabled() ? this.ref : null, jobsInFlight: jobs?.length || 0, ...rest };
  }

  // Run the kaggle CLI. KAGGLE_CMD can be e.g. "python -m kaggle" if `kaggle` isn't on PATH.
  cli(args, timeoutMs = 10 * 60e3) {
    const [cmd, ...pre] = env('KAGGLE_CMD', 'kaggle').split(' ');
    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
      // New-style tokens (KGAT_…) are read from KAGGLE_API_TOKEN; a stray KAGGLE_USERNAME without
      // KAGGLE_KEY can make the CLI look for legacy credentials instead.
      if (childEnv.KAGGLE_API_TOKEN && !childEnv.KAGGLE_KEY) delete childEnv.KAGGLE_USERNAME;
      // On Windows the command runs through the shell, so quote anything with spaces or specials.
      const win = process.platform === 'win32';
      const q = (a) => (win && /[\s&()^|<>"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      const child = spawn(cmd, [...pre, ...args].map(q), {
        env: childEnv,
        cwd: this.dir, // paths below are relative to data/kaggle, so "My Shapes" never reaches the CLI
        shell: win,
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`kaggle ${args[0]} ${args[1]} timed out`)); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not run "${cmd}" (${e.message}). Install it with: pip install kaggle`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`kaggle ${args.slice(0, 2).join(' ')} exited ${code}: ${out.trim().slice(-400)}`));
      });
    });
  }

  // Called every minute by the server.
  async tick() {
    if (!this.enabled() || this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      if (this.state.status === 'running') {
        if (now - (this.state.lastPoll || 0) >= Number(env('KAGGLE_POLL_MINUTES', 4)) * 60e3) await this.poll();
      } else if (now >= (this.state.cooldownUntil || 0)
        && now - (this.state.lastStarted || 0) >= Number(env('KAGGLE_EVERY_HOURS', 24)) * 3600e3
        && this.wantMore()) {
        await this.push();
      }
    } catch (e) {
      this.log(`! kaggle: ${e.message}`);
      this.state.lastError = e.message.slice(0, 500);
      this.state.cooldownUntil = Date.now() + 30 * 60e3;
      if (this.state.status === 'pushing') this.state.status = 'idle';
      this.saveState();
    } finally {
      this.busy = false;
    }
  }

  async push() {
    const n = Number(env('KAGGLE_BATCH_SIZE', 120));
    const overrides = this.getOverrides();
    const jobs = Array.from({ length: n }, () => {
      const p = this.sampleProfile(this.config, { overrides });
      return {
        seed: p.seed, prompt: p.prompt, negative: p.negativePrompt,
        profile: {
          region_id: p.region_id, region_label: p.region_label, is_mixed_heritage: p.is_mixed_heritage,
          cohort: p.cohort, age: p.age, gender: p.gender, city: p.city, hairstyle: p.hairstyle, skin: p.skin,
        },
      };
    });
    const settings = {
      model: env('KAGGLE_MODEL', 'zimage'),               // zimage (falls back to sdxl) | sdxl
      sdxl_model: env('KAGGLE_SDXL_MODEL', 'SG161222/RealVisXL_V5.0'),
      max_minutes: Number(env('KAGGLE_MAX_MINUTES', 150)), // stop early so the run never hits Kaggle's 12 h cap
    };
    const template = fs.readFileSync(path.join(this.root, 'kaggle/generate.py'), 'utf8');
    const code = template
      .replace('__JOBS__', JSON.stringify(jobs.map(({ seed, prompt, negative }) => ({ seed, prompt, negative }))))
      .replace('__SETTINGS__', JSON.stringify(settings));

    const jobDir = path.join(this.dir, 'push');
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'generate.py'), code);
    fs.writeFileSync(path.join(jobDir, 'kernel-metadata.json'), JSON.stringify({
      id: this.ref,
      title: this.slug,
      code_file: 'generate.py',
      language: 'python',
      kernel_type: 'script',
      is_private: true,
      enable_gpu: true,
      enable_internet: true,
      machine_shape: env('KAGGLE_MACHINE', 'NvidiaTeslaT4'),
      dataset_sources: [], competition_sources: [], kernel_sources: [], model_sources: [],
    }, null, 2));

    this.state = { ...this.state, status: 'pushing' };
    this.saveState();
    const out = await this.cli(['kernels', 'push', '-p', 'push']);
    this.state = {
      ...this.state, status: 'running', kaggleStatus: 'queued', lastStarted: Date.now(), lastPoll: Date.now(),
      batchId: crypto.randomBytes(4).toString('hex'), jobs, lastError: null, pushOutput: out.slice(-300),
    };
    this.saveState();
    this.log(`⇪ kaggle: started a GPU batch of ${n} faces on ${this.ref}`);
  }

  async poll() {
    this.state.lastPoll = Date.now();
    const out = await this.cli(['kernels', 'status', this.ref], 2 * 60e3);
    const m = out.toLowerCase().match(/(complete|error|cancel\w*|running|queued|new)/g);
    const status = m ? m[m.length - 1] : 'unknown';
    this.state.kaggleStatus = status;
    if (status === 'complete') {
      await this.importResults();
    } else if (status === 'error' || status.startsWith('cancel')) {
      // a failed run may still have saved partial results
      const got = await this.importResults().catch(() => 0);
      if (!got) {
        this.state.status = 'idle';
        this.state.cooldownUntil = Date.now() + 6 * 3600e3;
        this.state.lastError = `Kaggle run ${status}. Open https://www.kaggle.com/code/${this.ref} to see the log.`;
        this.log(`! kaggle: run ${status} with no images — retrying in 6 h. Log: https://www.kaggle.com/code/${this.ref}`);
      }
    } else if (Date.now() - this.state.lastStarted > 13 * 3600e3) {
      this.state.status = 'idle'; // Kaggle kills sessions at 12 h; don't wait forever
      this.state.lastError = 'run took longer than 13 h, gave up waiting';
    }
    this.saveState();
  }

  async importResults() {
    const outDir = path.join(this.dir, 'output');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    await this.cli(['kernels', 'output', this.ref, '-p', 'output', '-o'], 20 * 60e3);
    const file = path.join(outDir, 'batch.json');
    if (!fs.existsSync(file)) throw new Error('run finished but batch.json is missing');
    const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bySeed = new Map((this.state.jobs || []).map((j) => [j.seed, j]));
    let added = 0;
    for (const item of batch.items || []) {
      const job = bySeed.get(item.seed);
      if (!job) continue;
      try {
        const { webp } = await this.finishImage(Buffer.from(item.image, 'base64'), { cropBottom: 0 });
        const id = crypto.randomBytes(6).toString('hex');
        this.store.add({
          id, file: `${id}.webp`, createdAt: Date.now(), views: 0,
          provider: 'kaggle', batch: this.state.batchId, model: item.model || batch.model, seed: job.seed,
          ...job.profile, prompt: job.prompt, template_prompt: job.prompt, polished_by: null, qa_score: null, ms: null,
        }, webp);
        this.afterAdd?.();
        added += 1;
      } catch (e) {
        this.log(`kaggle: skipped one image (${e.message})`);
      }
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    this.state = { ...this.state, status: 'idle', jobs: [], lastFinished: Date.now(), lastImported: added, lastModel: batch.model };
    this.saveState();
    this.log(`✓ kaggle: imported ${added} faces made with ${batch.model} — now showing this batch first (pool=${this.store.count()})`);
    return added;
  }
}
