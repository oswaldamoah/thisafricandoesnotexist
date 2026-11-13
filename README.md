# This African Does Not Exist

Realistic AI portraits of modern Africans, one per refresh, in the style of thispersondoesnotexist.com.
Every face is built from `public/phenotypes.json`: region weights, age cohorts, facial anatomy, skin tone,
modern hair and clothing, city backgrounds, candid expressions, skin imperfections and camera physics.
The images come from free models (Alibaba, Cloudflare, Zhipu, Pollinations), with optional paid and local extras.

## Run it

```bash
npm install
cp .env.example .env      # add any keys you have (none are required)
npm start                 # http://localhost:3000
```

With no keys, it uses Pollinations only (about 1 face every 16 seconds). Each key you add brings in another
model and speeds up generation. The server builds up a pool of faces in `data/`, so after the first few
minutes every refresh is instant.

Test without any network: `MOCK=1 npm start` (generates placeholder images).
See some prompts: `npm run test-prompt`.

## How it works

```
phenotypes.json ──► promptEngine.js ──► (optional) free LLM polishes the prompt
                     weighted sampling          DeepSeek via OpenRouter / ModelScope / GLM
                                                 │
                     ┌───────────────────────────┘
                     ▼
     image providers, rotated with rate limits and daily caps
     ModelScope Z-Image-Turbo · Cloudflare FLUX · Zhipu CogView · SiliconFlow Kolors · Pollinations
     (+ Muapi.ai paid, + your own GPU)
                     │
                     ▼
     lib/image.js: crop the watermark strip → square → 1024px WebP, tagged "AI-generated" in EXIF
                     │
                     ▼
     (optional) free vision model scores realism, rejects bad ones
                     │
                     ▼
     data/db.json + data/images/*.webp ──► index.html (/api/face, /face.webp)
```

### Prompt engine (`public/promptEngine.js`)
It follows `step_by_step_assembly` in your JSON exactly: region by `region_weights` (the mixed-heritage pool is split
evenly), age by `age_cohort_weights` (with an exact age in the range), 1–2 traits per anatomy category, one skin
tone, pose, expression, grooming, accessory, 1–2 imperfections, lighting, and lens. It also adds consistency rules:
- beards only on men and makeup only on women; no grey hair on people in their 20s
- no flyaways or hairline details under a hijab or headwrap, or on a shaved head
- the city always matches the background (a background "in Addis Ababa" means the city is Addis Ababa)
- mixed-heritage profiles never output "mixed race" or "biracial", and sometimes add tailoring and heritage-jewelry accents

Every face has a seed, so any face can be regenerated exactly.

### Endpoints
| path | what |
|---|---|
| `/` | the page |
| `/face.webp` | a random face as a plain image (embed it anywhere) |
| `/api/face` | random face + metadata JSON |
| `/api/face/:id` | a specific face (the page uses `#id` links) |
| `/api/stats` | pool counts by region/age/gender/provider, and each provider's health |
| `/api/sample?seed=123` | preview what the prompt engine produces |

### Static mode
If you upload only the `public/` folder to a static host (e.g. GitHub Pages), the page notices there is no
server and generates faces live in the browser via Pollinations. A taller image is requested and the frame
cuts off the bottom strip, so the watermark is hidden.

## FairFace

`tools/fairface_calibrate.py` loads only FairFace's **labels** (age, gender, race) through `kagglehub`, using the
`aibloy/fairface` dataset you found, or with `--hf` the Hugging Face copy. It calibrates the age and gender mix
against real photos labelled "Black" and writes `data/fairface_calibration.json`. The server blends it with your
JSON weights (`FAIRFACE_BLEND`).

```bash
pip install kagglehub pandas
python tools/fairface_calibrate.py
```

What FairFace can't do: it has no country or region labels, and it can't make a hosted model's pixels more
realistic. That would take fine-tuning a LoRA on a GPU. The project also deliberately doesn't feed real
FairFace faces into the models as references, because the output would resemble real, identifiable people.

## Provider notes
- **ModelScope** (Alibaba): Z-Image-Turbo is the strongest free option for real-looking skin. The free API needs a ModelScope account linked to a verified Alibaba Cloud account, and quotas are daily.
- **Cloudflare**: FLUX.1 schnell, very reliable. The 10k free neurons per day cover a few dozen images or more, depending on steps.
- **Zhipu** (bigmodel.cn): CogView-3-Flash is free but weaker at photorealism. GLM-4.7-Flash (text) and GLM-4.6V-Flash (vision QA) are free too.
- **Pollinations**: no key needed. The bottom strip is cropped to remove the watermark.
- **Muapi.ai**: the backend of [Open-Generative-AI](https://github.com/Anil-matcha/open-generative-ai). That repo is a front end, so its cloud models go through Muapi and cost money per image. Add `MUAPI_KEY` if you want Z-Image Turbo, FLUX Krea or HunyuanImage 3 from there.
- **Local GPU**: point `LOCAL_SD_URL` at AUTOMATIC1111, Forge or SD.Next (started with `--api`) and load any realistic SDXL or FLUX checkpoint.

Free tiers change often. Check `/api/stats`: a provider that keeps failing backs off automatically, and its last error is shown there.

## Ethics
Every image carries an "AI-generated" EXIF tag, and the page says plainly that none of these people exist.
Keep it that way if you deploy it. Don't present these faces as real people (fake profiles, testimonials, IDs).
