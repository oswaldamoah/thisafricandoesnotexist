// Image providers. Each one turns a prompt into raw image bytes.
// Free ones are on by default if their key is present; Pollinations needs no key at all.
//
//  id           | cost                         | key env                        | notes
//  -------------|------------------------------|--------------------------------|------------------------------------------
//  modelscope   | free daily quota (Alibaba)   | MODELSCOPE_TOKEN               | Z-Image-Turbo / Qwen-Image, async tasks
//  cloudflare   | free 10k neurons/day         | CF_ACCOUNT_ID + CF_API_TOKEN   | FLUX.2 klein (or schnell/dev)
//  gemini       | PAID (~$0.03-0.04/image)     | GEMINI_API_KEY                 | Nano Banana, needs AI Studio billing
//  zhipu        | free (CogView-3-Flash)       | ZHIPU_API_KEY                  | bigmodel.cn, adds an AI label -> cropped
//  siliconflow  | Kolors (check current price) | SILICONFLOW_API_KEY            | supports negative prompts
//  pollinations | free, no key (rate limited)  | POLLINATIONS_KEY optional      | watermark -> bottom strip cropped
//  muapi        | PAID per image               | MUAPI_KEY                      | the backend behind Open-Generative-AI
//  local        | free on your own GPU         | LOCAL_SD_URL                   | A1111 / Forge / SD.Next  /sdapi/v1/txt2img
//  mock         | offline test images          | MOCK=1                         | for testing the pipeline

import { positiveGuards } from '../public/promptEngine.js';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const list = (k, d) => env(k, d).split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProviderError extends Error {
  constructor(msg, { status, retryAfterMs } = {}) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; }
}

async function check(res, who) {
  if (res.ok) return res;
  const body = (await res.text().catch(() => '')).slice(0, 300);
  const ra = Number(res.headers.get('retry-after'));
  throw new ProviderError(`${who} HTTP ${res.status}: ${body}`, {
    status: res.status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
  });
}

async function download(url, who, timeoutMs = 120000) {
  const res = await check(await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }), who);
  const type = res.headers.get('content-type') || '';
  if (type && !type.startsWith('image/') && !type.includes('octet-stream')) {
    throw new ProviderError(`${who} returned ${type}, not an image`);
  }
  return Buffer.from(await res.arrayBuffer());
}

const clip = (s, n) => (s.length > n ? s.slice(0, s.lastIndexOf(',', n) > n * 0.7 ? s.lastIndexOf(',', n) : n) : s);
const withGuards = (prompt) => `${prompt} ${positiveGuards()}.`;

let rr = 0; // round-robin across a provider's model list
const nextModel = (models) => models[rr++ % models.length];

// ---------------------------------------------------------------------------
const providers = {
  // Alibaba ModelScope API-Inference — Z-Image-Turbo is excellent at photoreal skin.
  modelscope: {
    label: 'ModelScope (Alibaba)',
    enabled: () => !!env('MODELSCOPE_TOKEN'),
    minIntervalMs: Number(env('MODELSCOPE_INTERVAL_MS', 4000)),
    dailyLimit: Number(env('MODELSCOPE_DAILY_LIMIT', 300)),
    cropBottom: 0,
    async generate({ prompt, negativePrompt, seed }) {
      const base = env('MODELSCOPE_BASE', 'https://api-inference.modelscope.cn/v1');
      const model = nextModel(list('MODELSCOPE_MODELS', 'Tongyi-MAI/Z-Image-Turbo,Qwen/Qwen-Image'));
      const headers = { Authorization: `Bearer ${env('MODELSCOPE_TOKEN')}`, 'Content-Type': 'application/json' };
      const body = { model, prompt: clip(withGuards(prompt), 1900), size: '1024x1024', seed: seed % 2147483647 };
      if (!/turbo/i.test(model)) body.negative_prompt = negativePrompt; // turbo models ignore it
      const sub = await (await check(await fetch(`${base}/images/generations`, {
        method: 'POST', headers: { ...headers, 'X-ModelScope-Async-Mode': 'true' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      }), 'modelscope')).json();
      if (!sub.task_id) {
        const url = sub.images?.[0]?.url || sub.output_images?.[0];
        if (url) return { bytes: await download(url, 'modelscope'), model };
        throw new ProviderError(`modelscope: no task_id in ${JSON.stringify(sub).slice(0, 200)}`);
      }
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const t = await (await check(await fetch(`${base}/tasks/${sub.task_id}`, {
          headers: { ...headers, 'X-ModelScope-Task-Type': 'image_generation' }, signal: AbortSignal.timeout(30000),
        }), 'modelscope')).json();
        if (t.task_status === 'SUCCEED') return { bytes: await download(t.output_images[0], 'modelscope'), model };
        if (t.task_status === 'FAILED') throw new ProviderError(`modelscope task failed: ${JSON.stringify(t).slice(0, 200)}`);
      }
      throw new ProviderError('modelscope: timed out waiting for task');
    },
  },

  // Cloudflare Workers AI. Default: FLUX.2 [klein] 4B — far more realistic than FLUX.1 schnell
  // and still cheap enough for ~90 images/day inside the free 10k neurons.
  //   @cf/black-forest-labs/flux-2-klein-4b   ~90/day free   (default)
  //   @cf/black-forest-labs/flux-2-klein-9b   ~7/day free    (better)
  //   @cf/black-forest-labs/flux-2-dev        few/day free   (best, slow)
  //   @cf/black-forest-labs/flux-1-schnell    old, weak at faces
  cloudflare: {
    label: 'Cloudflare Workers AI',
    enabled: () => !!(env('CF_ACCOUNT_ID') && env('CF_API_TOKEN')),
    minIntervalMs: Number(env('CF_INTERVAL_MS', 2000)),
    dailyLimit: Number(env('CF_DAILY_LIMIT', 90)),
    cropBottom: 0,
    async generate({ prompt }) {
      const model = env('CF_MODEL', '@cf/black-forest-labs/flux-2-klein-4b');
      const url = `https://api.cloudflare.com/client/v4/accounts/${env('CF_ACCOUNT_ID')}/ai/run/${model}`;
      const auth = { Authorization: `Bearer ${env('CF_API_TOKEN')}` };
      const text = clip(withGuards(prompt), 2000);
      let res;
      if (/flux-2/.test(model)) {
        // FLUX.2 models take multipart form data, even for a prompt only.
        const send = (withSize) => {
          const form = new FormData();
          form.append('prompt', text);
          if (withSize) { form.append('width', '1024'); form.append('height', '1024'); }
          if (/flux-2-dev/.test(model)) form.append('steps', env('CF_STEPS', '25'));
          return fetch(url, { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(180000) });
        };
        res = await send(true);
        if (res.status === 400) res = await send(false); // schema didn't accept width/height: retry with prompt only
      } else {
        // flux-1-schnell rejects 'seed'; steps max 8
        res = await fetch(url, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text, steps: Math.min(8, Number(env('CF_STEPS', 8))) }),
          signal: AbortSignal.timeout(120000),
        });
      }
      const j = await (await check(res, 'cloudflare')).json();
      const b64 = j.result?.image;
      if (!b64) throw new ProviderError(`cloudflare: no image in response ${JSON.stringify(j).slice(0, 200)}`);
      return { bytes: Buffer.from(b64, 'base64'), model: model.split('/').pop() };
    },
  },

  // Google Gemini image models ("Nano Banana"). Same look as the Gemini app.
  // NOTE: Google's API free tier currently gives image models a quota of 0, so this needs billing
  // turned on in AI Studio. Roughly $0.03–0.04 per image with the Flash / Flash-Lite image models.
  gemini: {
    label: 'Google Gemini (Nano Banana)',
    enabled: () => !!env('GEMINI_API_KEY') && env('GEMINI_IMAGES', '1') !== '0',
    minIntervalMs: Number(env('GEMINI_INTERVAL_MS', 6000)),
    dailyLimit: Number(env('GEMINI_DAILY_LIMIT', 30)),
    cropBottom: 0,
    async generate({ prompt }) {
      const model = env('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const j = await (await check(await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Generate a photograph. ${withGuards(prompt)}` }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
        }),
        signal: AbortSignal.timeout(120000),
      }), 'gemini')).json();
      const part = j.candidates?.[0]?.content?.parts?.find((x) => x.inlineData || x.inline_data);
      const data = part?.inlineData?.data || part?.inline_data?.data;
      if (!data) throw new ProviderError(`gemini: no image (${j.candidates?.[0]?.finishReason || JSON.stringify(j).slice(0, 200)})`);
      return { bytes: Buffer.from(data, 'base64'), model };
    },
  },

  // Zhipu BigModel (China) — CogView-3-Flash is free. It stamps an "AI generated" mark
  // in the corner unless your account can disable it, so we crop the bottom.
  zhipu: {
    label: 'Zhipu BigModel',
    enabled: () => !!env('ZHIPU_API_KEY'),
    minIntervalMs: Number(env('ZHIPU_INTERVAL_MS', 5000)),
    dailyLimit: Number(env('ZHIPU_DAILY_LIMIT', 200)),
    cropBottom: Number(env('ZHIPU_CROP_BOTTOM', 0.07)),
    async generate({ prompt }) {
      const model = env('ZHIPU_IMAGE_MODEL', 'cogview-3-flash');
      const j = await (await check(await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('ZHIPU_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: clip(withGuards(prompt), 900), size: '1024x1024', watermark_enabled: false }),
        signal: AbortSignal.timeout(120000),
      }), 'zhipu')).json();
      const url = j.data?.[0]?.url;
      if (!url) throw new ProviderError(`zhipu: no url ${JSON.stringify(j).slice(0, 200)}`);
      return { bytes: await download(url, 'zhipu'), model };
    },
  },

  // SiliconFlow — Kwai Kolors (Kuaishou). Honors negative prompts.
  siliconflow: {
    label: 'SiliconFlow',
    enabled: () => !!env('SILICONFLOW_API_KEY'),
    minIntervalMs: Number(env('SILICONFLOW_INTERVAL_MS', 3000)),
    dailyLimit: Number(env('SILICONFLOW_DAILY_LIMIT', 100)),
    cropBottom: 0,
    async generate({ prompt, negativePrompt, seed }) {
      const base = env('SILICONFLOW_BASE', 'https://api.siliconflow.cn/v1');
      const model = env('SILICONFLOW_MODEL', 'Kwai-Kolors/Kolors');
      const j = await (await check(await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('SILICONFLOW_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, prompt: clip(prompt, 1800), negative_prompt: negativePrompt, image_size: '1024x1024',
          batch_size: 1, num_inference_steps: 25, guidance_scale: 5, seed: seed % 9999999999,
        }),
        signal: AbortSignal.timeout(120000),
      }), 'siliconflow')).json();
      const url = j.images?.[0]?.url || j.data?.[0]?.url;
      if (!url) throw new ProviderError(`siliconflow: no url ${JSON.stringify(j).slice(0, 200)}`);
      return { bytes: await download(url, 'siliconflow'), model };
    },
  },

  // Pollinations — works with no key at all (≈1 request / 15 s). With a free key from
  // enter.pollinations.ai it's faster. We ask for a taller image and crop the bottom strip
  // so the watermark never shows.
  pollinations: {
    label: 'Pollinations',
    enabled: () => env('POLLINATIONS_DISABLED', '0') !== '1',
    get minIntervalMs() { return env('POLLINATIONS_KEY') ? 3000 : 16000; },
    dailyLimit: Number(env('POLLINATIONS_DAILY_LIMIT', 2000)),
    cropBottom: Number(env('POLLINATIONS_CROP_PX', 96)) / 1120,
    async generate({ prompt, negativePrompt, seed }) {
      const model = env('POLLINATIONS_MODEL', 'flux');
      const key = env('POLLINATIONS_KEY');
      const q = new URLSearchParams({
        model, width: '1024', height: '1120', seed: String(seed), nologo: 'true', private: 'true',
        negative_prompt: negativePrompt,
      });
      if (key) q.set('key', key);
      const p = encodeURIComponent(clip(withGuards(prompt), 1500));
      const url = key ? `https://gen.pollinations.ai/image/${p}?${q}` : `https://image.pollinations.ai/prompt/${p}?${q}`;
      return { bytes: await download(url, 'pollinations', 180000), model };
    },
  },

  // Muapi.ai — the API that Anil-matcha/Open-Generative-AI calls under the hood.
  // PAID per generation (new accounts may get trial credits). Gives you Z-Image Turbo,
  // FLUX Krea, HunyuanImage 3, Seedream, Imagen 4 etc. through one key.
  muapi: {
    label: 'Muapi.ai (Open-Generative-AI backend)',
    enabled: () => !!env('MUAPI_KEY'),
    minIntervalMs: Number(env('MUAPI_INTERVAL_MS', 3000)),
    dailyLimit: Number(env('MUAPI_DAILY_LIMIT', 50)),
    cropBottom: 0,
    async generate({ prompt, seed }) {
      const base = env('MUAPI_BASE', 'https://api.muapi.ai');
      const endpoint = nextModel(list('MUAPI_MODELS', 'z-image-turbo,flux-krea-dev,hunyuan-image-3.0'));
      const headers = { 'Content-Type': 'application/json', 'x-api-key': env('MUAPI_KEY') };
      const sub = await (await check(await fetch(`${base}/api/v1/${endpoint}`, {
        method: 'POST', headers,
        body: JSON.stringify({ prompt: clip(withGuards(prompt), 2900), width: 1024, height: 1024, aspect_ratio: '1:1', num_images: 1, seed }),
        signal: AbortSignal.timeout(60000),
      }), 'muapi')).json();
      const id = sub.request_id || sub.id;
      let result = sub;
      if (id) {
        for (let i = 0; i < 90; i++) {
          await sleep(2000);
          result = await (await check(await fetch(`${base}/api/v1/predictions/${id}/result`, {
            headers, signal: AbortSignal.timeout(30000),
          }), 'muapi')).json();
          const st = String(result.status || '').toLowerCase();
          if (['completed', 'succeeded', 'success'].includes(st)) break;
          if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) throw new ProviderError(`muapi failed: ${JSON.stringify(result).slice(0, 200)}`);
        }
      }
      const url = result.outputs?.[0] || result.url || result.output?.url;
      if (!url) throw new ProviderError(`muapi: no output ${JSON.stringify(result).slice(0, 200)}`);
      return { bytes: await download(url, 'muapi'), model: endpoint };
    },
  },

  // Your own GPU: AUTOMATIC1111 / Forge / SD.Next started with --api.
  local: {
    label: 'Local Stable Diffusion',
    enabled: () => !!env('LOCAL_SD_URL'),
    minIntervalMs: 0,
    dailyLimit: Number(env('LOCAL_DAILY_LIMIT', 100000)),
    cropBottom: 0,
    async generate({ prompt, negativePrompt, seed }) {
      const j = await (await check(await fetch(`${env('LOCAL_SD_URL').replace(/\/$/, '')}/sdapi/v1/txt2img`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt, negative_prompt: negativePrompt, width: 1024, height: 1024, seed,
          steps: Number(env('LOCAL_STEPS', 28)), cfg_scale: Number(env('LOCAL_CFG', 5)),
        }),
        signal: AbortSignal.timeout(600000),
      }), 'local')).json();
      if (!j.images?.[0]) throw new ProviderError('local: no image');
      return { bytes: Buffer.from(j.images[0], 'base64'), model: 'local-sd' };
    },
  },

  // Offline placeholder images for testing the whole pipeline without any API.
  mock: {
    label: 'Mock (offline test)',
    enabled: () => env('MOCK', '0') === '1',
    minIntervalMs: 300,
    dailyLimit: 100000,
    cropBottom: 0.06,
    async generate({ seed, profile }) {
      const { default: sharp } = await import('sharp');
      const hue = seed % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1088">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="hsl(${hue},45%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,15%)"/></linearGradient></defs>
        <rect width="1024" height="1088" fill="url(#g)"/>
        <circle cx="512" cy="430" r="190" fill="hsl(${hue},30%,82%)"/>
        <circle cx="440" cy="400" r="22" fill="#111"/><circle cx="584" cy="400" r="22" fill="#111"/>
        <rect x="262" y="640" width="500" height="448" rx="200" fill="hsl(${hue},30%,88%)"/>
        <text x="512" y="80" font-size="40" fill="#fff" text-anchor="middle" font-family="sans-serif">${profile.age} · ${profile.city}</text>
        <rect y="1024" width="1024" height="64" fill="#ff00ff"/>
        <text x="512" y="1066" font-size="32" fill="#000" text-anchor="middle" font-family="sans-serif">FAKE WATERMARK (should be cropped)</text>
      </svg>`;
      return { bytes: await sharp(Buffer.from(svg)).png().toBuffer(), model: 'mock' };
    },
  },
};

export function enabledProviders() {
  // With MOCK=1 only the mock provider runs, so tests never hit the network.
  if (providers.mock.enabled()) return [{ id: 'mock', ...providers.mock }];
  const order = list('PROVIDER_ORDER', 'local,gemini,modelscope,cloudflare,zhipu,siliconflow,muapi,pollinations');
  const ids = order.filter((id) => providers[id] && providers[id].enabled());
  return ids.map((id) => ({ id, ...providers[id] }));
}

export { providers };
