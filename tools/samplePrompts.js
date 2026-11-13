// Print a few prompts from the engine without generating anything.
//   node tools/samplePrompts.js 5            -> 5 random prompts
//   node tools/samplePrompts.js 3 horn_of_africa
import fs from 'fs';
import { sampleProfile } from '../public/promptEngine.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../public/phenotypes.json', import.meta.url), 'utf8'));
const n = Number(process.argv[2] || 3);
const region = process.argv[3];
for (let i = 0; i < n; i++) {
  const p = sampleProfile(cfg, region ? { region } : {});
  console.log(`\n#${i + 1}  seed=${p.seed}  ${p.age} ${p.gender} · ${p.city} · ${p.region_label}\n${p.prompt}`);
}
