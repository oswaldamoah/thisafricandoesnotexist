// Free LLMs that (1) polish the template prompt into natural photographer language and
// (2) look at each finished image and reject bad ones (extra fingers, two faces, text, cartoonish).
// Everything here is optional and fails open: if no key is set or a call fails, the
// template prompt is used and the image is accepted.

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

// OpenAI-compatible chat endpoints with free models.
const CHAT = {
  // Google Gemini text models are free on the API (images are not). OpenAI-compatible endpoint.
  gemini: () => env('GEMINI_API_KEY') && {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    key: env('GEMINI_API_KEY'),
    body: { model: env('GEMINI_LLM', 'gemini-2.5-flash'), reasoning_effort: 'none' },
  },
  // DeepSeek (free variant) via OpenRouter, falling back to OpenRouter's free router.
  openrouter: () => env('OPENROUTER_API_KEY') && {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: env('OPENROUTER_API_KEY'),
    body: { models: env('OPENROUTER_MODELS', 'deepseek/deepseek-v4-flash:free,openrouter/free').split(',') },
  },
  // Alibaba ModelScope — same token as the image provider. Pick any LLM that shows the
  // "API-Inference" panel on its ModelScope page.
  modelscope: () => env('MODELSCOPE_TOKEN') && {
    url: `${env('MODELSCOPE_BASE', 'https://api-inference.modelscope.cn/v1')}/chat/completions`,
    key: env('MODELSCOPE_TOKEN'),
    body: { model: env('MODELSCOPE_LLM', 'deepseek-ai/DeepSeek-V3.2') },
  },
  // Zhipu GLM Flash — free on bigmodel.cn.
  zhipu: () => env('ZHIPU_API_KEY') && {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    key: env('ZHIPU_API_KEY'),
    body: { model: env('ZHIPU_LLM', 'glm-4.7-flash'), thinking: { type: 'disabled' } },
  },
};

async function chat(providerId, messages, { maxTokens = 700, temperature = 0.6 } = {}) {
  const p = CHAT[providerId]?.();
  if (!p) return null;
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...p.body, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`${providerId} chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: j.choices?.[0]?.message?.content?.trim() || '', model: j.model || p.body.model || providerId };
}

const POLISH_SYSTEM = `You write prompts for photorealistic text-to-image models.
Rewrite the structured description you are given into ONE flowing prompt (90-170 words) that reads like a photographer's shot note.
Rules:
- Keep EVERY physical detail: age, gender, city, face shape, forehead, eyes, nose, lips, cheekbones, jaw, skin shade and undertone, hair, grooming, clothing, accessory, age details, skin imperfections, background, lighting, lens.
- Put the most identity-defining details (face structure, skin, hair) early.
- Do not add ethnic, tribal or racial labels, and never write "mixed race" or "biracial". Do not add props, costumes or scenery that were not given.
- Never contradict a detail. No markdown, no quotes, no preamble. Output only the prompt.`;

export function llmEnabled() {
  return env('LLM_POLISH', '1') !== '0' && Object.values(CHAT).some((f) => f());
}

export async function polishPrompt(profile, log = () => {}) {
  if (!llmEnabled()) return null;
  const order = env('LLM_ORDER', 'gemini,openrouter,modelscope,zhipu').split(',').map((s) => s.trim());
  for (const id of order) {
    try {
      const r = await chat(id, [
        { role: 'system', content: POLISH_SYSTEM },
        { role: 'user', content: profile.prompt },
      ]);
      if (!r) continue;
      const t = r.text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
      // sanity checks: right length, kept age + city, no banned labels
      if (t.length < 250 || t.length > 1800) throw new Error(`bad length ${t.length}`);
      if (!t.includes(String(profile.age)) || !t.includes(profile.city)) throw new Error('dropped age or city');
      if (/mixed[- ]race|biracial|tribal|villager/i.test(t)) throw new Error('used banned wording');
      return { prompt: t, by: `${id}:${r.model}` };
    } catch (e) {
      log(`polish via ${id} failed: ${e.message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vision QA with a free vision model (Zhipu GLM-4.6V-Flash, or a Qwen-VL model on ModelScope).
const QA_PROMPT = (p) => `You are a strict photo editor checking an AI-generated street portrait.
Intended subject: a ${p.age}-year-old ${p.gender} in ${p.city}.
Score 1-10 for how convincingly it looks like a REAL unedited photograph of exactly one real person.
Deduct heavily for: more or fewer than one main face, deformed eyes/teeth/hands, plastic or airbrushed skin, cartoon/3D/painting look, any visible text, logo or watermark, a child or teenager, or an obviously wrong age/gender.
Reply with JSON only: {"score": <1-10>, "issues": ["..."]}`;

export function qaEnabled() {
  const p = env('QA_PROVIDER', '');
  return (p === 'zhipu' && !!env('ZHIPU_API_KEY')) || (p === 'modelscope' && !!env('MODELSCOPE_TOKEN'));
}

export async function qaCheck(thumbJpeg, profile, log = () => {}) {
  if (!qaEnabled()) return { pass: true, score: null };
  const which = env('QA_PROVIDER');
  const b64 = thumbJpeg.toString('base64');
  const conf = which === 'zhipu'
    ? { id: 'zhipu', model: env('QA_MODEL', 'glm-4.6v-flash'), url: b64 } // Zhipu accepts raw base64
    : { id: 'modelscope', model: env('QA_MODEL', 'Qwen/Qwen3-VL-8B-Instruct'), url: `data:image/jpeg;base64,${b64}` };
  try {
    const base = CHAT[conf.id]();
    const res = await fetch(base.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${base.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...base.body, model: conf.model, max_tokens: 300, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: conf.url } },
          { type: 'text', text: QA_PROMPT(profile) },
        ] }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    const score = Number(j.score);
    if (!Number.isFinite(score)) throw new Error(`unparseable QA reply: ${text.slice(0, 120)}`);
    return { pass: score >= Number(env('QA_MIN_SCORE', 6)), score, issues: j.issues || [] };
  } catch (e) {
    log(`QA failed open: ${e.message}`);
    return { pass: true, score: null };
  }
}
