// promptEngine.js — turns phenotypes.json into one concrete portrait prompt.
// Works in the browser (static mode) and in Node (server mode). No dependencies.
//
// Follows generation_pipeline_rules.step_by_step_assembly in phenotypes.json,
// plus a few consistency rules so the sampler never asks for contradictions
// (e.g. a beard on a woman, flyaway hair under a hijab, gray hair on a 22-year-old).

// ---------- seeded RNG (mulberry32) so every face is reproducible ----------
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function weightedPick(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[entries.length - 1][0];
}

function sampleDistinct(rng, arr, min, max) {
  const n = Math.min(arr.length, min + Math.floor(rng() * (max - min + 1)));
  const pool = [...arr];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const stripParens = (s) => s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
const joinTraits = (arr) => arr.map(lc).join(' and ');

// "young_adult_18_29" -> [18, 29]
function ageRange(key) {
  const m = key.match(/(\d+)_(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [18, 75];
}

// ---------- consistency rules ----------
const COVERED_HAIR = /hijab|headwrap|doek|turban/i;
const NO_HAIR = /bald|clean-shaven head|buzz/i;
const DYED = /bleach|blonde|copper|burgundy|balayage|highlights/i;
const STRAIGHTENED = /silk press|wig|weave|slicked|sleek/i;

function groomingAllowed(item, { gender, hairstyle, cohort }) {
  const s = item.toLowerCase();
  if (/beard/.test(s) && gender !== 'man') return false;
  if (/makeup|lip gloss/.test(s) && gender !== 'woman') return false;
  if (/silver|gray/.test(s) && cohort === 'young_adult_18_29') return false;
  if (/frizz|flyaway|curly hair/.test(s) && (COVERED_HAIR.test(hairstyle) || NO_HAIR.test(hairstyle) || STRAIGHTENED.test(hairstyle))) return false;
  if (/haircut|hairline/.test(s) && COVERED_HAIR.test(hairstyle)) return false;
  return true;
}

function ageModifierAllowed(item, { hairstyle, gender }) {
  const s = item.toLowerCase();
  if (/razor lineup|styled edges/.test(s) && COVERED_HAIR.test(hairstyle)) return false;
  if (/salt-and-pepper|graying hairline/.test(s) && (COVERED_HAIR.test(hairstyle) || NO_HAIR.test(hairstyle) || DYED.test(hairstyle))) return false;
  return true;
}

function imperfectionAllowed(item, { hairstyle }) {
  if (/baby hairs/i.test(item) && (COVERED_HAIR.test(hairstyle) || NO_HAIR.test(hairstyle))) return false;
  return true;
}

// Mature people rarely get bleached pixies / fresh starter locs in the sampler's head;
// we don't forbid it, we just make age-appropriate grey more likely to show up.
function filtered(arr, fn, ctx) {
  const ok = arr.filter((x) => fn(x, ctx));
  return ok.length ? ok : arr;
}

// Pick the city so it never contradicts the background ("street in Addis Ababa" -> Addis Ababa).
function chooseCity(rng, profile, background) {
  const cities = profile.demographics_sample.map(stripParens);
  const known = new Set(cities);
  // also recognise cities named in any background of any profile
  for (const c of ['Lagos', 'Accra', 'Abidjan', 'Dakar', 'Addis Ababa', 'Mogadishu', 'Nairobi', 'Asmara', 'Juba', 'Kampala',
    'Johannesburg', 'Cape Town', 'Gaborone', 'Windhoek', 'Durban', 'Cairo', 'Casablanca', 'Tunis', 'Algiers',
    'London', 'Paris', 'Lisbon', 'Dar es Salaam', 'Khartoum', 'Dubai', 'Beirut']) known.add(c);
  const named = [...known].filter((c) => background.includes(c));
  if (named.length) return pick(rng, named);
  return pick(rng, cities);
}

// City -> nationality word for the identity lead. Image models anchor on these far more
// than on anatomy lists. Mixed-heritage profiles never get one (mixed_heritage_guidelines #1).
const DEMONYM = {
  Lagos: 'Nigerian', Accra: 'Ghanaian', Abidjan: 'Ivorian', Dakar: 'Senegalese',
  'Addis Ababa': 'Ethiopian', Mogadishu: 'Somali', Asmara: 'Eritrean',
  Juba: 'South Sudanese', Kampala: 'Ugandan', Nairobi: 'Kenyan',
  Johannesburg: 'South African', 'Cape Town': 'South African', Durban: 'South African',
  Gaborone: 'Motswana', Windhoek: 'Namibian',
  Cairo: 'Egyptian', Casablanca: 'Moroccan', Tunis: 'Tunisian', Algiers: 'Algerian',
};

// Extra sartorial blend for mixed-heritage profiles (mixed_heritage_guidelines #2).
const MIXED_ACCENTS = [
  'a slim-cut trench coat layered over contemporary African streetwear',
  'subtle heritage beaded bracelet',
  'small brass heritage pendant',
  'tailored blazer paired with a modern wax-print scarf',
];

/**
 * sampleProfile(config, opts) -> { seed, profile fields..., prompt, negativePrompt }
 * opts.seed        integer seed (random if omitted)
 * opts.overrides   { region_weights, age_cohort_weights, gender_weights } to replace config weights
 *                  (used by FairFace calibration)
 * opts.region      force a region id (e.g. "horn_of_africa")
 * opts.gender      force "man" | "woman"
 */
export function sampleProfile(config, opts = {}) {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = makeRng(seed);
  const rules = config.generation_pipeline_rules;
  const ws = rules.weighted_sampling_strategy;
  const ov = opts.overrides || {};

  // 1. region
  let regionKey = opts.region || weightedPick(rng, ov.region_weights || ws.region_weights);
  let profile;
  if (regionKey === 'mixed_heritage_pool') {
    profile = pick(rng, config.mixed_heritage_phenotypes);
  } else {
    profile = config.regional_phenotypes.find((p) => p.id === regionKey)
      || config.mixed_heritage_phenotypes.find((p) => p.id === regionKey);
  }
  if (!profile) throw new Error(`Unknown region ${regionKey}`);
  const isMixed = config.mixed_heritage_phenotypes.includes(profile);

  // gender (not in the JSON; 50/50 unless calibrated)
  const gender = opts.gender || weightedPick(rng, ov.gender_weights || { woman: 0.5, man: 0.5 });

  // 2. age
  const cohort = weightedPick(rng, ov.age_cohort_weights || ws.age_cohort_weights);
  const [lo, hi] = ageRange(cohort);
  const age = lo + Math.floor(rng() * (hi - lo + 1));

  // 7 (done early because other choices depend on hair). styling
  const styling = profile.modern_styling;
  const hairstyle = pick(rng, gender === 'woman' ? styling.female_hair : styling.male_hair);
  const wardrobe = pick(rng, styling.wardrobe);
  const background = pick(rng, styling.urban_backgrounds);
  const city = chooseCity(rng, profile, background);
  const ctx = { gender, hairstyle, cohort };

  const ageModifier = pick(rng, filtered(config.age_cohort_modifiers[cohort], ageModifierAllowed, ctx));

  // 3. anatomy (1–2 distinct traits per category) + 1 skin tone
  const a = profile.anatomy;
  const anatomy = {};
  for (const k of ['face_shape', 'forehead', 'eyes', 'nose', 'lips', 'cheekbones', 'jawline']) {
    anatomy[k] = sampleDistinct(rng, a[k], 1, 2);
  }
  const skin = pick(rng, profile.skin_tones);

  // 4. pose + expression
  const cme = config.candid_micro_expressions;
  const gaze = pick(rng, cme.gaze_and_pose);
  const expression = pick(rng, cme.expression);

  // 5. grooming, accessory, 1–2 imperfections
  const eag = config.everyday_accessories_and_grooming;
  const grooming = pick(rng, filtered(eag.grooming_realism, groomingAllowed, ctx));
  let accessory = pick(rng, eag.accessories);
  if (isMixed && rng() < 0.5) accessory = `${accessory}, with ${pick(rng, MIXED_ACCENTS)}`;
  const imperfections = sampleDistinct(rng, filtered(config.realism_imperfections_pool, imperfectionAllowed, ctx), 1, 2);

  // 6. photographic physics
  const pp = config.photographic_physics;
  const lighting = pick(rng, pp.lighting);
  const camera = pick(rng, pp.camera_artifacts);

  // assemble with the template from the JSON
  const fields = {
    age, gender, city,
    gaze_and_pose: gaze,
    expression,
    face_shape: anatomy.face_shape.length > 1
      ? `${lc(anatomy.face_shape[0])} face with hints of a ${lc(anatomy.face_shape[1])} shape`
      : `${lc(anatomy.face_shape[0])} face`,
    forehead: joinTraits(anatomy.forehead),
    eyes: joinTraits(anatomy.eyes),
    nose: joinTraits(anatomy.nose),
    lips: joinTraits(anatomy.lips),
    cheekbones: joinTraits(anatomy.cheekbones),
    jawline: joinTraits(anatomy.jawline),
    skin_shade: lc(skin.shade),
    skin_undertone: lc(skin.undertone),
    hairstyle,
    grooming_realism: lc(grooming),
    wardrobe: lc(wardrobe),
    accessory: lc(accessory),
    age_cohort_modifier: ageModifier.charAt(0).toUpperCase() + ageModifier.slice(1),
    realism_imperfections: imperfections.map(lc).join(', '),
    urban_background: background,
    lighting: lc(lighting),
    camera_artifacts: lc(camera),
    global_style: lc(config.global_prompt_modifiers.style),
  };

  let prompt = rules.prompt_assembly_template.replace(/\{(\w+)\}/g, (_, k) => (fields[k] ?? ''));

  // Identity lead. Many image models only read the first ~60-77 words, and the JSON template
  // reaches skin tone and hair around word 70. So we state who this is, skin and hair first.
  const demonym = isMixed ? '' : (DEMONYM[city] || '');
  const lead = `Real photo of a ${age}-year-old ${demonym ? `${demonym} ` : ''}${gender} with ${fields.skin_shade} skin `
    + `(${fields.skin_undertone} undertones) and ${lc(hairstyle)}, in ${city}.`;
  prompt = `${lead} ${prompt}`;
  // mixed_heritage_guidelines #1: never emit monolithic labels
  prompt = prompt.replace(/\b(mixed[- ]race|biracial)\b/gi, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1');
  prompt = prompt.replace(/\ba (18|8\d)-year-old/g, 'an $1-year-old');
  prompt = prompt.replace(/\. ([a-z])/g, (_, c) => `. ${c.toUpperCase()}`);

  return {
    seed,
    region_id: profile.id,
    region_label: profile.region_label,
    is_mixed_heritage: isMixed,
    cohort,
    age,
    gender,
    city,
    hairstyle,
    wardrobe,
    background,
    skin,
    anatomy,
    prompt,
    negativePrompt: config.global_prompt_modifiers.negative_prompts.join(', '),
  };
}

// Many fast models (FLUX schnell, Z-Image Turbo) ignore negative prompts.
// For those, we fold the most important negatives into positive wording.
export function positiveGuards() {
  return 'Single real adult person, photographed on a modern city street, contemporary everyday clothing, unretouched natural skin, no text, no watermark';
}
