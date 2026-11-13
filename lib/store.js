// Tiny file-backed database: data/db.json + data/images/*.webp. No native modules needed.
import fs from 'fs';
import path from 'path';

export class Store {
  constructor(dir, { readOnly = false } = {}) {
    this.dir = dir;
    this.readOnly = readOnly;
    this.imgDir = path.join(dir, 'images');
    this.file = path.join(dir, 'db.json');
    if (!readOnly) fs.mkdirSync(this.imgDir, { recursive: true });
    this.rows = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    // drop rows whose image file went missing
    this.rows = this.rows.filter((r) => fs.existsSync(path.join(this.imgDir, r.file)));
    this.timer = null;
  }

  save() {
    if (this.readOnly) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rows));
      fs.renameSync(tmp, this.file); // atomic replace
    }, 300);
  }

  flush() {
    if (this.readOnly) return;
    clearTimeout(this.timer);
    fs.writeFileSync(this.file, JSON.stringify(this.rows));
  }

  count() { return this.rows.length; }

  add(record, webp) {
    fs.writeFileSync(path.join(this.imgDir, record.file), webp);
    this.rows.push(record);
    this.save();
  }

  removeOldest() {
    if (!this.rows.length) return;
    // strictly the oldest face, so the pool always holds the newest TARGET_POOL faces
    let victim = this.rows[0];
    for (const r of this.rows) if (r.createdAt < victim.createdAt) victim = r;
    this.rows = this.rows.filter((r) => r !== victim);
    fs.rmSync(path.join(this.imgDir, victim.file), { force: true });
    this.save();
  }

  // The faces visitors should see right now:
  //   the newest Kaggle batch (+ any API faces made since it landed).
  //   If that's fewer than minFresh faces, top up with the newest faces overall.
  //   No Kaggle batches yet -> everything in the pool.
  freshSet(minFresh = 20) {
    const kaggleRows = this.rows.filter((r) => r.batch && r.provider === 'kaggle');
    if (!kaggleRows.length) return { rows: this.rows, batch: null };
    let newest = kaggleRows[0];
    for (const r of kaggleRows) if (r.createdAt > newest.createdAt) newest = r;
    let since = Infinity;
    for (const r of kaggleRows) if (r.batch === newest.batch && r.createdAt < since) since = r.createdAt;
    let rows = this.rows.filter((r) => r.createdAt >= since);
    if (rows.length < minFresh) rows = [...this.rows].sort((a, b) => b.createdAt - a.createdAt).slice(0, minFresh);
    return { rows, batch: newest.batch, since };
  }

  // Random face from the fresh set, favouring ones shown least, skipping ones this visitor just saw.
  random(exclude = new Set(), minFresh = 20) {
    const fresh = this.freshSet(minFresh).rows;
    let pool = fresh.filter((r) => !exclude.has(r.id));
    if (!pool.length) pool = fresh;
    if (!pool.length) return null;
    let minViews = Infinity;
    for (const r of pool) if (r.views < minViews) minViews = r.views;
    const least = pool.filter((r) => r.views <= minViews + 1);
    const r = least[Math.floor(Math.random() * least.length)];
    r.views += 1;
    this.save();
    return r;
  }

  get(id) { return this.rows.find((r) => r.id === id) || null; }

  stats() {
    const by = (k) => this.rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
    return { total: this.rows.length, byProvider: by('provider'), byRegion: by('region_id'), byCohort: by('cohort'), byGender: by('gender') };
  }
}
