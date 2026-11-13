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
    // oldest among the most-viewed half
    const sorted = [...this.rows].sort((a, b) => (b.views - a.views) || (a.createdAt - b.createdAt));
    const victim = sorted[0];
    this.rows = this.rows.filter((r) => r !== victim);
    fs.rmSync(path.join(this.imgDir, victim.file), { force: true });
    this.save();
  }

  // Random face, favouring ones that have been shown least and skipping ones the client just saw.
  random(exclude = new Set()) {
    let pool = this.rows.filter((r) => !exclude.has(r.id));
    if (!pool.length) pool = this.rows;
    if (!pool.length) return null;
    const minViews = Math.min(...pool.map((r) => r.views));
    const fresh = pool.filter((r) => r.views <= minViews + 1);
    const r = fresh[Math.floor(Math.random() * fresh.length)];
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
