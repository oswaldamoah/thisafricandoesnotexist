# Project documentation

This document is for people who want to fork, clone, deploy, or extend **This
African Does Not Exist**.

## Project layout

```text
server.js                 Local HTTP server and background generation loop
public/
  index.html              Browser interface
  promptEngine.js         Profile sampling and prompt assembly
  phenotypes.json         Generation vocabulary and weighted distributions
lib/
  providers.js            Image-provider adapters and rate limits
  llm.js                  Optional prompt polishing and vision QA
  image.js                Crop, resize, WebP, and EXIF processing
  store.js                JSON metadata and image-pool storage
  kaggle.js               Optional Kaggle GPU batch integration
tools/
  build-site.mjs          Build static hosting output
  cycle.mjs               One serverless Kaggle/pool cycle
  samplePrompts.js        Prompt preview utility
  fairface_calibrate.py   Optional age/gender calibration
data/
  db.json                 Local metadata pool
  images/                 Generated WebP files
local-data/               Read-only fallback faces for the local server
.github/workflows/faces.yml
                          Hourly Kaggle and GitHub Pages workflow
```

## Local runtime

The local server loads `.env`, reads the phenotype configuration, creates a
`Store` for `data/`, and starts a generation worker. Each worker job:

1. samples a profile with a deterministic seed;
2. optionally sends the template prompt to an LLM;
3. selects the next available provider;
4. downloads the generated image;
5. runs image post-processing and optional vision QA;
6. writes a metadata record and WebP to the pool;
7. removes the oldest record when `TARGET_POOL` is exceeded.

The server is intentionally dependency-light. It uses Node's HTTP and
filesystem APIs and `sharp` for image processing. There is no database server
or frontend build step.

### Local commands

```bash
npm install
npm start                 # production-style local server
npm run mock              # offline placeholder provider
npm run test-prompt       # print five sampled prompts
```

Set `PORT` to change the listening port. Set `MOCK=1` when testing without
network access. `ROTATE=0` stops filling the pool after `TARGET_POOL` faces;
the default keeps replacing the oldest faces.

## Configuration and providers

Copy `.env.example` to `.env`. Every setting is optional.

The simplest setup has no keys and uses Pollinations. More providers improve
throughput and give the worker alternatives when a free quota is exhausted.
Provider credentials are read only from environment variables; never commit
`.env` or API keys.

Important groups of settings:

- `TARGET_POOL`, `ROTATE`, `CONCURRENCY`, and `FRESH_MIN` control pool behavior.
- `PROVIDER_ORDER` controls provider preference.
- `MODELSCOPE_TOKEN`, `CF_ACCOUNT_ID`/`CF_API_TOKEN`, `ZHIPU_API_KEY`, and
  `SILICONFLOW_API_KEY` enable free or quota-based providers.
- `GEMINI_API_KEY` and `MUAPI_KEY` enable paid providers; check billing before
  turning them on.
- `LOCAL_SD_URL` connects to an AUTOMATIC1111, Forge, or SD.Next server
  started with its API enabled.
- `LLM_POLISH=1` enables optional prompt rewriting when a supported LLM key is
  available.
- `QA_PROVIDER` enables optional vision-based rejection of poor generations.
- `FAIRFACE_BLEND` applies an optional calibration file produced by
  `tools/fairface_calibrate.py`.

Provider quotas, model names, and free tiers change over time. `/api/stats`
exposes provider health, failures, and the last error so a fork owner can see
why generation has paused.

## Data model and pool behavior

`data/db.json` is an array of metadata records. Each record points to one
WebP file in `data/images/`. The store writes metadata using a temporary file
and atomic rename, and removes records whose image file is missing at startup.

The public server favors the newest Kaggle batch. If that batch contains fewer
than `FRESH_MIN` faces, it tops up from the newest available records. If the
main pool is empty, `local-data/` can be used as a read-only fallback.

Generated files include EXIF metadata identifying them as AI-generated. Keep
that labeling if you change the image pipeline.

## Prompt engine

The prompt engine follows the `step_by_step_assembly` rules in
`public/phenotypes.json`. It samples region and age weights, chooses anatomy
traits, and combines them with skin, hair, grooming, clothing, pose,
expression, imperfections, background, lighting, and lens details.

When changing phenotype data:

- preserve internally consistent combinations;
- keep region and city data specific rather than treating Africa as one look;
- avoid real-person likenesses and identity claims;
- update the consistency rules when adding a new dependent attribute;
- use `npm run test-prompt` to inspect the result.

The seed is stored with each face, so a profile can be regenerated
deterministically even though provider output may vary.

## Static GitHub Pages deployment

Static mode uses pre-generated images rather than a running Node server. The
build command is:

```bash
node tools/build-site.mjs pool _site
```

It copies `public/` into `_site/`, publishes the pool under `faces/`, publishes
the read-only `local-data/` fallback, writes manifests, and creates
`.nojekyll`. The browser reads the manifests and can fall back to live
Pollinations generation when no server is available.

### Automated workflow setup

1. Fork the repository.
2. In **Settings → Secrets and variables → Actions**, add the
   `KAGGLE_API_TOKEN` secret.
3. Add the `KAGGLE_USERNAME` repository variable.
4. In **Settings → Pages**, choose **GitHub Actions** as the source.
5. Open **Actions → faces** and run the workflow.

The workflow runs hourly, checks or starts a private Kaggle notebook, imports
completed faces, keeps the newest 500 faces on the `pool` branch, and deploys
the static site when the published content changes. The Kaggle account must
support GPU notebooks and internet access.

If you also run the local server, set `KAGGLE_BATCH=0` locally to avoid
starting competing Kaggle jobs. The workflow's production defaults live in
`.github/workflows/faces.yml`; local defaults live in `.env.example`.

## Extending the project

### Add an image provider

Add an adapter to the provider map in `lib/providers.js` with:

- an `enabled()` check based on environment variables;
- a `generate()` function returning image bytes and a model name;
- a sensible interval and daily limit;
- watermark cropping information when needed.

Use the shared response checking and timeout patterns. Provider failures should
remain visible through `/api/stats` and should not silently look like
successful images.

### Change the site

The browser UI is in `public/index.html`. Keep the API contract stable when
possible, especially `/api/face`, `/api/face/:id`, and the manifest shape used
by static mode. If an endpoint changes, update the README and this document.

### Change the Kaggle batch

`lib/kaggle.js` samples jobs and injects them into `kaggle/generate.py`.
`tools/cycle.mjs` is the single-cycle entry point used by GitHub Actions.
Keep temporary Kaggle push/output folders out of the committed pool branch.

## Validation checklist

Before opening a pull request:

```bash
npm run test-prompt
MOCK=1 npm start
node tools/build-site.mjs pool _site
```

Check that:

- the local page loads;
- `/api/sample?seed=123` is repeatable;
- mock mode creates valid placeholder faces;
- generated images remain square WebP files;
- static manifests point to files that exist;
- no secrets, `.env`, generated pool, or personal data were added.

## Ethics and responsible use

These are synthetic faces, not a dataset of real people. Do not use them to
create fake identities, testimonials, dating profiles, IDs, surveillance
records, or claims about real communities. Keep the disclosure that the people
do not exist, preserve the AI-generated metadata, and review provider and
dataset licenses before publishing a fork.
