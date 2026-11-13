# This file is a TEMPLATE. server.js fills in JOBS and SETTINGS, pushes it to Kaggle as a
# private GPU notebook, and later downloads /kaggle/working/batch.json automatically.
# Nothing here talks back to your server; it only reads the prompts baked into it.

import base64
import io
import json
import os
import subprocess
import sys
import time
import traceback

JOBS = __JOBS__
SETTINGS = __SETTINGS__

T0 = time.time()
OUT = "/kaggle/working/batch.json"


def log(*a):
    print(f"[{time.time() - T0:6.0f}s]", *a, flush=True)


log(f"{len(JOBS)} prompts, settings {SETTINGS}")
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U",
                "diffusers", "transformers", "accelerate", "sentencepiece", "safetensors"], check=False)

import numpy as np  # noqa: E402
import torch  # noqa: E402

log("torch", torch.__version__, "cuda", torch.cuda.is_available(),
    [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())])


def bf16_ok():
    try:
        return torch.cuda.is_bf16_supported(including_emulation=True)
    except TypeError:
        return torch.cuda.is_bf16_supported()


def looks_broken(img):
    a = np.asarray(img.convert("RGB").resize((64, 64)), dtype=np.float32)
    return bool(np.isnan(a).any() or a.std() < 8)


def load_zimage():
    from diffusers import ZImagePipeline
    dtype = torch.bfloat16 if bf16_ok() else torch.float16
    pipe = ZImagePipeline.from_pretrained(SETTINGS.get("zimage_model", "Tongyi-MAI/Z-Image-Turbo"), torch_dtype=dtype)
    pipe.enable_model_cpu_offload()  # 16 GB GPUs: keep only the active part on the GPU

    def gen(job):
        g = torch.Generator("cuda").manual_seed(job["seed"] % 2**31)
        return pipe(prompt=job["prompt"], height=1024, width=1024,
                    num_inference_steps=9, guidance_scale=0.0, generator=g).images[0]
    return "z-image-turbo", gen


def load_sdxl():
    from diffusers import AutoencoderKL, DPMSolverMultistepScheduler, StableDiffusionXLPipeline
    vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
    pipe = StableDiffusionXLPipeline.from_pretrained(
        SETTINGS.get("sdxl_model", "SG161222/RealVisXL_V5.0"), vae=vae, torch_dtype=torch.float16).to("cuda")
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)

    def gen(job):
        g = torch.Generator("cuda").manual_seed(job["seed"] % 2**31)
        # SDXL reads ~75 tokens: the identity lead at the start of every prompt is what matters most
        return pipe(prompt=job["prompt"], negative_prompt=job["negative"], height=1024, width=1024,
                    num_inference_steps=28, guidance_scale=5.0, generator=g).images[0]
    return SETTINGS.get("sdxl_model", "SG161222/RealVisXL_V5.0").split("/")[-1].lower(), gen


LOADERS = {"zimage": load_zimage, "sdxl": load_sdxl}
order = ["zimage", "sdxl"] if SETTINGS.get("model", "zimage") == "zimage" else ["sdxl"]

model_name, gen, first = None, None, None
for name in order:
    try:
        log("loading", name)
        model_name, gen = LOADERS[name]()
        t = time.time()
        first = gen(JOBS[0])  # probe: does this model produce a real picture on this GPU?
        if looks_broken(first):
            raise RuntimeError("probe image is blank/NaN")
        log(f"{name} works ({time.time() - t:.0f}s per image)")
        break
    except Exception as e:  # noqa: BLE001
        log(f"{name} failed: {e}")
        traceback.print_exc()
        gen = None
        torch.cuda.empty_cache()

if gen is None:
    sys.exit("No model could run on this GPU")

results = []


def save():
    with open(OUT + ".tmp", "w") as f:
        json.dump({"model": model_name, "items": results}, f)
    os.replace(OUT + ".tmp", OUT)


for i, job in enumerate(JOBS):
    if time.time() - T0 > SETTINGS["max_minutes"] * 60:
        log("time budget reached, stopping early")
        break
    try:
        img = first if i == 0 else gen(job)
        if looks_broken(img):
            log("blank image, skipped")
            continue
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=93)
        results.append({"seed": job["seed"], "model": model_name, "image": base64.b64encode(buf.getvalue()).decode()})
        log(f"{len(results)}/{len(JOBS)} done")
        if len(results) % 10 == 0:
            save()  # partial results survive a timeout
    except Exception as e:  # noqa: BLE001
        log("failed:", e)

save()
log("finished:", len(results), "images with", model_name)
