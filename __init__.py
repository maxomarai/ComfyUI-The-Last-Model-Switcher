from __future__ import annotations

import inspect
import json
import logging
import math
import os

import torch
from aiohttp import web
from typing_extensions import override

import comfy.sd
import comfy.utils
import comfy.model_sampling
import comfy.model_management
import folder_paths
import server
from comfy_api.latest import ComfyExtension, io

PRESETS_FILE = os.path.join(os.path.dirname(__file__), "presets.json")
WEB_DIRECTORY = "./web"

# --- GGUF support (optional) ---
_gguf_available = False
_gguf_loader = None
_gguf_ops = None
_gguf_nodes = None

try:
    import importlib
    _gguf_nodes = importlib.import_module("custom_nodes.ComfyUI-GGUF.nodes")
    _gguf_loader = importlib.import_module("custom_nodes.ComfyUI-GGUF.loader")
    _gguf_ops = importlib.import_module("custom_nodes.ComfyUI-GGUF.ops")
    _gguf_available = True
    logging.info("[TheLastModelSwitcher] GGUF support enabled")
except Exception:
    try:
        import sys
        gguf_path = os.path.join(os.path.dirname(__file__), "..", "ComfyUI-GGUF")
        if os.path.isdir(gguf_path) and gguf_path not in sys.path:
            sys.path.insert(0, gguf_path)
        from loader import gguf_sd_loader as _sd_fn, gguf_clip_loader as _clip_fn
        from ops import GGMLOps as _ops_cls
        import types
        _gguf_loader = types.SimpleNamespace(gguf_sd_loader=_sd_fn, gguf_clip_loader=_clip_fn)
        _gguf_ops = types.SimpleNamespace(GGMLOps=_ops_cls)
        _gguf_available = True
    except Exception:
        pass


def _is_gguf(filename: str) -> bool:
    return filename.lower().endswith(".gguf")


def _load_diffusion_model_gguf(unet_path: str):
    ops = _gguf_ops.GGMLOps()
    sd, extra = _gguf_loader.gguf_sd_loader(unet_path)
    kwargs = {}
    valid_params = inspect.signature(comfy.sd.load_diffusion_model_state_dict).parameters
    if "metadata" in valid_params:
        kwargs["metadata"] = extra.get("metadata", {})
    model = comfy.sd.load_diffusion_model_state_dict(
        sd, model_options={"custom_operations": ops}, **kwargs,
    )
    if model is None:
        raise RuntimeError(f"Could not detect model type: {unet_path}")
    model = _gguf_nodes.GGUFModelPatcher.clone(model)
    model.patch_on_device = False
    return model


def _load_clip_gguf(clip_paths: list[str], clip_type):
    clip_data = []
    for p in clip_paths:
        if _is_gguf(p):
            clip_data.append(_gguf_loader.gguf_clip_loader(p))
        else:
            clip_data.append(comfy.utils.load_torch_file(p, safe_load=True))
    clip = comfy.sd.load_text_encoder_state_dicts(
        clip_type=clip_type, state_dicts=clip_data,
        model_options={"custom_operations": _gguf_ops.GGMLOps,
                       "initial_device": comfy.model_management.text_encoder_offload_device()},
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    clip.patcher = _gguf_nodes.GGUFModelPatcher.clone(clip.patcher)
    return clip


def load_presets() -> dict:
    with open(PRESETS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


# ──────────────────────────────────────────────────────────
#  Model cache - avoids reloading from disk on every execution
# ──────────────────────────────────────────────────────────
_cache = {
    "model_key": None,
    "clip_key": None,
    "vae_key": None,
    "model": None,
    "clip": None,
    "vae": None,
    "clip_files": None,
}


def _cache_get_model(key):
    if _cache["model_key"] == key and _cache["model"] is not None:
        return _cache["model"]
    return None


def _cache_set_model(key, model):
    _cache["model_key"] = key
    _cache["model"] = model


def _cache_get_clip(key):
    if _cache["clip_key"] == key and _cache["clip"] is not None:
        return _cache["clip"]
    return None


def _cache_set_clip(key, clip, clip_files):
    _cache["clip_key"] = key
    _cache["clip"] = clip
    _cache["clip_files"] = clip_files


def _cache_get_vae(key):
    if _cache["vae_key"] == key and _cache["vae"] is not None:
        return _cache["vae"]
    return None


def _cache_set_vae(key, vae):
    _cache["vae_key"] = key
    _cache["vae"] = vae


def _cache_clear():
    """Clear all cached models to free memory."""
    _cache["model_key"] = None
    _cache["clip_key"] = None
    _cache["vae_key"] = None
    _cache["model"] = None
    _cache["clip"] = None
    _cache["vae"] = None
    _cache["clip_files"] = None
    comfy.model_management.cleanup_models()
    comfy.model_management.soft_empty_cache()


# ──────────────────────────────────────────────────────────
#  API endpoints
# ──────────────────────────────────────────────────────────

@server.PromptServer.instance.routes.get("/the_last_model_switcher/presets")
async def get_presets_api(request):
    return web.json_response(load_presets())

@server.PromptServer.instance.routes.get("/the_last_model_switcher/preset_info")
async def get_preset_info_api(request):
    preset_name = request.query.get("name", "")
    presets = load_presets()
    if preset_name not in presets or presets[preset_name] is None:
        return web.json_response({"error": f"Not found: {preset_name}"}, status=404)
    cfg = presets[preset_name]
    sampler = cfg.get("sampler", {})
    is_flux = cfg.get("apply_model_sampling_flux", False)
    return web.json_response({
        "name": preset_name,
        "description": cfg.get("description", ""),
        "diffusion_model": cfg.get("diffusion_model") or cfg.get("checkpoint", "N/A"),
        "clip_type": cfg.get("clip_type", "N/A"),
        "vae": cfg.get("vae") or "from checkpoint",
        "resolutions": cfg.get("resolutions", {}),
        "default_resolution": cfg.get("default_resolution", ""),
        "compatible_clips": cfg.get("compatible_clips", {}),
        "sampler": sampler.get("sampler_name", "euler"),
        "scheduler": sampler.get("scheduler", "normal"),
        "steps": sampler.get("steps", 20),
        "cfg": sampler.get("cfg", 1.0),
        "missing_files": _validate_preset(preset_name, cfg),
        "is_gguf": _is_gguf(cfg.get("diffusion_model", "")),
        "is_checkpoint": bool(cfg.get("checkpoint")),
        "guidance": cfg.get("guidance", 0.0),
        "is_flux": is_flux,
        "megapixels": cfg.get("megapixels", 1.0),
        "negative_prompt_supported": cfg.get("negative_prompt_supported", not is_flux),
        "info_text": cfg.get("info_text", ""),
        "supported_megapixels": cfg.get("supported_megapixels", []),
        "default_megapixels": cfg.get("default_megapixels", ""),
    })

@server.PromptServer.instance.routes.get("/the_last_model_switcher/reload")
async def reload_presets_api(request):
    presets = load_presets()
    return web.json_response({"count": len(presets), "names": list(presets.keys())})


# ──────────────────────────────────────────────────────────
#  Model auto-detection (reads safetensors header only)
# ──────────────────────────────────────────────────────────

def _read_safetensors_keys(filepath: str) -> list[str]:
    """Read tensor key names from safetensors header without loading weights."""
    try:
        import safetensors
        with safetensors.safe_open(filepath, framework="pt", device="cpu") as f:
            return list(f.keys())
    except Exception:
        return []


def _detect_model_type(filepath: str) -> dict | None:
    """Detect model architecture from safetensors header keys.
    Returns a preset template dict or None if unknown."""

    if _is_gguf(filepath):
        return None  # Can't inspect GGUF headers easily

    keys = _read_safetensors_keys(filepath)
    if not keys:
        return None

    filename = os.path.basename(filepath)
    name_lower = filename.lower()

    # ── Check if it's a full checkpoint (has embedded UNet + CLIP) ──
    is_checkpoint = any(k.startswith("model.diffusion_model.") for k in keys)
    has_conditioner = any(k.startswith("conditioner.") for k in keys)
    has_cond_stage = any(k.startswith("cond_stage_model.") for k in keys)

    # ── Check diffusion model architecture ──
    has_joint_blocks = any(k.startswith("joint_blocks.") for k in keys)
    has_double_blocks = any(k.startswith("double_blocks.") for k in keys)
    has_single_blocks = any(k.startswith("single_blocks.") for k in keys)
    has_input_blocks = any(k.startswith("input_blocks.") or k.startswith("model.diffusion_model.input_blocks.") for k in keys)

    # Flux detection
    has_guidance_embed = any("guidance" in k and ("in_layer" in k or "embed" in k) for k in keys)

    # ── SDXL checkpoint ──
    if is_checkpoint and has_conditioner:
        return {
            "description": f"SDXL checkpoint (auto-detected from {filename})",
            "checkpoint": filename,
            "clip_type": "sdxl",
            "default_clip": None,
            "compatible_clips": {},
            "resolutions": {
                "1:1 Square (1024x1024)": [1024, 1024],
                "3:2 Photo (1216x832)": [1216, 832],
                "2:3 Portrait (832x1216)": [832, 1216],
                "16:9 Wide (1344x768)": [1344, 768],
                "9:16 Tall (768x1344)": [768, 1344],
                "4:3 Standard (1152x896)": [1152, 896],
                "3:4 Portrait Standard (896x1152)": [896, 1152],
            },
            "default_resolution": "1:1 Square (1024x1024)",
            "megapixels": 1.0,
            "sampler": {"sampler_name": "euler", "scheduler": "normal", "steps": 25, "cfg": 6.0},
            "guidance": 0.0,
            "apply_model_sampling_flux": False,
            "negative_prompt_supported": True,
            "info_text": "Auto-detected SDXL checkpoint. euler/normal, 25 steps, CFG 6.0.",
        }

    # ── SD 1.5 checkpoint ──
    if is_checkpoint and (has_cond_stage or has_input_blocks):
        return {
            "description": f"SD 1.5 checkpoint (auto-detected from {filename})",
            "checkpoint": filename,
            "clip_type": "stable_diffusion",
            "default_clip": None,
            "compatible_clips": {},
            "resolutions": {
                "1:1 Square (512x512)": [512, 512],
                "3:2 Photo (768x512)": [768, 512],
                "2:3 Portrait (512x768)": [512, 768],
                "16:9 Wide (912x512)": [912, 512],
                "9:16 Tall (512x912)": [512, 912],
            },
            "default_resolution": "1:1 Square (512x512)",
            "megapixels": 0.26,
            "sampler": {"sampler_name": "euler_ancestral", "scheduler": "normal", "steps": 25, "cfg": 7.0},
            "guidance": 0.0,
            "apply_model_sampling_flux": False,
            "negative_prompt_supported": True,
            "info_text": "Auto-detected SD 1.5 checkpoint. euler_ancestral/normal, 25 steps, CFG 7.0.",
        }

    # ── SD3 / SD3.5 diffusion model ──
    if has_joint_blocks:
        return {
            "description": f"SD3/SD3.5 model (auto-detected from {filename})",
            "diffusion_model": filename,
            "vae": "sd3_vae.safetensors",
            "clip_type": "sd3",
            "default_clip": ["clip_l.safetensors", "clip_g.safetensors", "t5xxl_fp8_e4m3fn_scaled.safetensors"],
            "compatible_clips": {
                "clip-l + clip-g + T5 XXL (fp8)": ["clip_l.safetensors", "clip_g.safetensors", "t5xxl_fp8_e4m3fn_scaled.safetensors"],
                "clip-l + clip-g + T5 XXL (fp16)": ["clip_l.safetensors", "clip_g.safetensors", "t5xxl_fp16.safetensors"],
                "clip-l + clip-g (no T5)": ["clip_l.safetensors", "clip_g.safetensors"],
            },
            "resolutions": {
                "1:1 Square (1024x1024)": [1024, 1024],
                "3:2 Photo (1216x832)": [1216, 832],
                "2:3 Portrait (832x1216)": [832, 1216],
                "16:9 Wide (1344x768)": [1344, 768],
                "9:16 Tall (768x1344)": [768, 1344],
            },
            "default_resolution": "1:1 Square (1024x1024)",
            "megapixels": 1.0,
            "sampler": {"sampler_name": "euler", "scheduler": "simple", "steps": 28, "cfg": 4.5},
            "guidance": 0.0,
            "apply_model_sampling_flux": False,
            "negative_prompt_supported": True,
            "info_text": "Auto-detected SD3/SD3.5. euler/simple, 28 steps, CFG 4.5.",
        }

    # ── Flux architecture (has double_blocks + single_blocks) ──
    if has_double_blocks and has_single_blocks:
        # Detect Flux 2 vs Flux 1 by checking for Flux2-specific patterns
        # Flux 2 has different hidden sizes and key patterns
        is_flux2 = any("txt_attn.norm.key_norm.scale" in k for k in keys)

        if is_flux2:
            return {
                "description": f"Flux 2 model (auto-detected from {filename})",
                "diffusion_model": filename,
                "vae": "flux2-vae.safetensors",
                "clip_type": "flux2",
                "default_clip": ["qwen_3_4b_fp8_mixed.safetensors"],
                "compatible_clips": {
                    "Qwen 3 4B (fp8)": ["qwen_3_4b_fp8_mixed.safetensors"],
                    "Qwen 3 4B (bf16)": ["qwen_3_4b.safetensors"],
                    "Mistral 3 Small (bf16)": ["mistral_3_small_flux2_bf16.safetensors"],
                },
                "resolutions": {
                    "1:1 Square (1024x1024)": [1024, 1024],
                    "3:2 Photo (1216x832)": [1216, 832],
                    "2:3 Portrait (832x1216)": [832, 1216],
                    "16:9 Wide (1344x768)": [1344, 768],
                    "9:16 Tall (768x1344)": [768, 1344],
                    "4:3 Standard (1152x896)": [1152, 896],
                    "3:4 Portrait Standard (896x1152)": [896, 1152],
                },
                "default_resolution": "1:1 Square (1024x1024)",
                "megapixels": 1.0,
                "supported_megapixels": ["0.25 MP", "0.5 MP", "1.0 MP", "1.5 MP", "2.0 MP", "4.0 MP"],
                "default_megapixels": "1.0 MP",
                "sampler": {"sampler_name": "euler", "scheduler": "simple", "steps": 20, "cfg": 1.0},
                "guidance": 3.5,
                "apply_model_sampling_flux": True,
                "negative_prompt_supported": False,
                "info_text": "Auto-detected Flux 2. euler/simple, 20 steps, CFG 1.0, guidance 3.5.",
            }
        else:
            # Flux 1
            is_schnell = not has_guidance_embed
            return {
                "description": f"Flux 1 {'Schnell' if is_schnell else 'Dev'} (auto-detected from {filename})",
                "diffusion_model": filename,
                "vae": "ae.safetensors",
                "clip_type": "flux",
                "default_clip": ["clip_l.safetensors", "t5xxl_fp16.safetensors"],
                "compatible_clips": {
                    "clip-l + T5 XXL (fp16)": ["clip_l.safetensors", "t5xxl_fp16.safetensors"],
                    "clip-l + T5 XXL (fp8)": ["clip_l.safetensors", "t5xxl_fp8_e4m3fn_scaled.safetensors"],
                },
                "resolutions": {
                    "1:1 Square (1024x1024)": [1024, 1024],
                    "3:2 Photo (1216x832)": [1216, 832],
                    "2:3 Portrait (832x1216)": [832, 1216],
                    "16:9 Wide (1344x768)": [1344, 768],
                    "9:16 Tall (768x1344)": [768, 1344],
                },
                "default_resolution": "1:1 Square (1024x1024)",
                "megapixels": 1.0,
                "sampler": {"sampler_name": "euler", "scheduler": "simple",
                            "steps": 4 if is_schnell else 20, "cfg": 1.0},
                "guidance": 0.0 if is_schnell else 3.5,
                "apply_model_sampling_flux": not is_schnell,
                "negative_prompt_supported": False,
                "info_text": f"Auto-detected Flux 1 {'Schnell (4 steps)' if is_schnell else 'Dev (20 steps)'}.",
            }

    return None


def _get_all_model_files() -> list[tuple[str, str, str]]:
    """Return list of (filename, full_path, folder_type) for all model files."""
    files = []
    for folder_key in ("checkpoints", "diffusion_models", "unet"):
        try:
            for name in folder_paths.get_filename_list(folder_key):
                if name.lower().endswith((".safetensors", ".gguf", ".ckpt")):
                    try:
                        path = folder_paths.get_full_path(folder_key, name)
                        if path and os.path.exists(path):
                            files.append((name, path, folder_key))
                    except Exception:
                        pass
        except Exception:
            pass
    return files


def _make_preset_name(filename: str, model_type: str) -> str:
    """Generate a clean preset name from filename."""
    name = os.path.splitext(filename)[0]
    # Clean up common suffixes
    for suffix in ("_fp8", "_fp16", "_bf16", "-fp8", "-fp16", "-bf16",
                   "_fp8mixed", "_fp8_e4m3fn", "_fp8_scaled",
                   "_fp8_e4m3fn_scaled", ".fp8", ".fp16"):
        if name.lower().endswith(suffix):
            name = name[:len(name) - len(suffix)]
    # Replace underscores/hyphens with spaces, title case
    name = name.replace("_", " ").replace("-", " ")
    # Add type suffix
    name = f"{name} ({model_type})"
    return name


@server.PromptServer.instance.routes.get("/the_last_model_switcher/scan")
async def scan_models_api(request):
    """Scan model directories, detect new models, add to presets."""
    presets = load_presets()
    all_files = _get_all_model_files()

    # Find files already in presets
    known_files = set()
    for name, cfg in presets.items():
        if cfg is None:
            continue
        if cfg.get("checkpoint"):
            known_files.add(cfg["checkpoint"])
        if cfg.get("diffusion_model"):
            known_files.add(cfg["diffusion_model"])

    added = []
    skipped = []

    for filename, filepath, folder_key in all_files:
        if filename in known_files:
            continue

        detected = _detect_model_type(filepath)
        if detected is None:
            skipped.append(filename)
            continue

        # Generate preset name
        if detected.get("checkpoint"):
            model_type = "SDXL" if detected.get("clip_type") == "sdxl" else "SD 1.5"
        elif "flux2" in detected.get("clip_type", ""):
            model_type = "Flux 2"
        elif "flux" in detected.get("clip_type", ""):
            model_type = "Flux 1"
        elif "sd3" in detected.get("clip_type", ""):
            model_type = "SD3"
        else:
            model_type = "auto"

        preset_name = _make_preset_name(filename, model_type)

        # Avoid duplicate names
        if preset_name in presets:
            preset_name = f"{preset_name} [{filename[:8]}]"

        presets[preset_name] = detected
        known_files.add(filename)
        added.append({"name": preset_name, "file": filename, "type": model_type})

    # Save updated presets
    if added:
        with open(PRESETS_FILE, "w", encoding="utf-8") as f:
            json.dump(presets, f, indent=4, ensure_ascii=False)

    return web.json_response({
        "added": added,
        "skipped": skipped,
        "total_presets": len([k for k, v in presets.items() if v is not None]),
    })


# ──────────────────────────────────────────────────────────
#  Helpers
# ──────────────────────────────────────────────────────────

def _file_exists(folder_key: str, filename: str) -> bool:
    try:
        path = folder_paths.get_full_path(folder_key, filename)
        return path is not None and os.path.exists(path)
    except Exception:
        return False

def _resolve_clip_path(filename: str) -> str:
    for key in ("text_encoders", "clip"):
        path = folder_paths.get_full_path(key, filename)
        if path and os.path.exists(path):
            return path
    return folder_paths.get_full_path_or_raise("text_encoders", filename)

def _validate_preset(name: str, cfg: dict) -> list[str]:
    missing = []
    if cfg.get("checkpoint") and not _file_exists("checkpoints", cfg["checkpoint"]):
        missing.append(cfg["checkpoint"])
    if cfg.get("diffusion_model"):
        dm = cfg["diffusion_model"]
        found = _file_exists("diffusion_models", dm)
        if not found:
            try:
                p = folder_paths.get_full_path("unet", dm)
                found = p is not None and os.path.exists(p)
            except Exception:
                pass
        if not found:
            missing.append(dm)
    if cfg.get("vae") and not _file_exists("vae", cfg["vae"]):
        missing.append(cfg["vae"])
    return missing


def _build_dynamic_options() -> list[io.DynamicCombo.Option]:
    presets = load_presets()
    options = []
    for name, cfg in presets.items():
        if cfg is None:
            continue
        missing = _validate_preset(name, cfg)
        if missing:
            continue
        sub_inputs = []

        clips = cfg.get("compatible_clips", {})
        if clips:
            clip_names = list(clips.keys())
            default_key = clip_names[0]
            dc = cfg.get("default_clip")
            if dc:
                for cn, cf in clips.items():
                    if cf == dc:
                        default_key = cn
                        break
            sub_inputs.append(io.Combo.Input("clip_variant", options=clip_names,
                default=default_key, tooltip="Text encoder / CLIP variant for this model."))

        resolutions = cfg.get("resolutions", {})
        if resolutions:
            res_names = list(resolutions.keys())
            sub_inputs.append(io.Combo.Input("resolution", options=res_names,
                default=cfg.get("default_resolution", res_names[0]),
                tooltip="Output resolution / aspect ratio."))

        mp_options = cfg.get("supported_megapixels")
        if mp_options:
            sub_inputs.append(io.Combo.Input("megapixels", options=mp_options,
                default=cfg.get("default_megapixels", mp_options[0]),
                tooltip="Target megapixels. Scales resolution while keeping aspect ratio."))

        options.append(io.DynamicCombo.Option(key=name, inputs=sub_inputs))
    return options


# ──────────────────────────────────────────────────────────
#  The node
# ──────────────────────────────────────────────────────────

class TheLastModelSwitcher(io.ComfyNode):
    """
    The Last Model Switcher by Maxomarai

    Switch models easily - auto-selects compatible CLIP, VAE, resolution,
    and outputs recommended sampler settings. No more guessing which
    text encoder goes with which model.

    OUTPUTS:
      MODEL / CLIP / VAE         Core model components ready for KSampler
      positive / negative        CONDITIONING from your prompt (negative is empty for Flux)
      width / height             Resolution (preset, custom, or megapixel-scaled)
      steps / cfg / guidance     Sampler settings (preset defaults or your overrides)
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="TheLastModelSwitcher",
            display_name="The Last Model Switcher",
            category="loaders/Maxomarai",
            is_output_node=True,
            description=(
                "The Last Model Switcher by Maxomarai\n\n"
                "Switch models with one click. Auto-selects compatible CLIP, VAE, "
                "and resolution. Outputs recommended sampler settings.\n"
                "Supports Flux 1, Flux 2, SDXL, and more."
            ),
            inputs=[
                io.DynamicCombo.Input("model", options=_build_dynamic_options(),
                    tooltip="Select your model. Compatible CLIP and resolution options appear automatically."),

                # ── Prompt inputs ──
                io.String.Input("positive_prompt", default="", multiline=True,
                    tooltip="Positive prompt. Encoded with the selected CLIP model."),
                io.String.Input("negative_prompt", default="", multiline=True,
                    tooltip="Negative prompt. Only used for models that support it (SD, SDXL). Ignored for Flux."),

                # ── Value inputs (auto-populated from preset, editable) ──
                io.Int.Input("width", default=1024, min=64, max=8192, step=8,
                    tooltip="Output width. Auto-set from preset, or type your own value."),
                io.Int.Input("height", default=1024, min=64, max=8192, step=8,
                    tooltip="Output height. Auto-set from preset, or type your own value."),
                io.Int.Input("steps", default=20, min=1, max=10000,
                    tooltip="Sampling steps. Auto-set from preset, or type your own value."),
                io.Float.Input("cfg", default=1.0, min=0.0, max=100.0, step=0.1, round=0.01,
                    tooltip="CFG scale. Auto-set from preset, or type your own value."),
                io.Float.Input("guidance", default=3.5, min=0.0, max=100.0, step=0.5,
                    tooltip="Flux guidance. Auto-set from preset, or type your own value."),

                # ── Advanced ──
                io.Combo.Input("weight_dtype", options=["default", "fp8_e4m3fn", "fp8_e5m2"],
                    default="default", tooltip="Weight dtype override for diffusion model.",
                    optional=True, advanced=True),
            ],
            outputs=[
                io.Model.Output(display_name="MODEL"),
                io.Clip.Output(display_name="CLIP"),
                io.Vae.Output(display_name="VAE"),
                io.Conditioning.Output(display_name="positive",
                    tooltip="Positive conditioning from your prompt. Connect to KSampler positive."),
                io.Conditioning.Output(display_name="negative",
                    tooltip="Negative conditioning. Empty for Flux models. Connect to KSampler negative."),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Int.Output(display_name="steps"),
                io.Float.Output(display_name="cfg"),
                io.Float.Output(display_name="guidance",
                    tooltip="Flux guidance value (0 = N/A). Connect to FluxGuidance node."),
            ],
        )

    @classmethod
    def execute(
        cls, model: dict,
        positive_prompt: str = "",
        negative_prompt: str = "",
        width: int = 1024,
        height: int = 1024,
        steps: int = 20,
        cfg: float = 1.0,
        guidance: float = 3.5,
        weight_dtype: str = "default",
    ) -> io.NodeOutput:
        presets = load_presets()
        preset_name = model["model"]
        clip_variant = model.get("clip_variant")
        resolution_name = model.get("resolution")
        megapixels_str = model.get("megapixels", "")

        if preset_name not in presets:
            raise ValueError(f"Model '{preset_name}' not found in presets")

        pcfg = presets[preset_name]
        embedding_dirs = folder_paths.get_folder_paths("embeddings")
        is_flux = pcfg.get("apply_model_sampling_flux", False)
        loaded_model = None
        clip_obj = None
        vae = None
        clip_files = None
        cache_status = []

        # ── Build cache keys ──
        dm_file = pcfg.get("diffusion_model", "")
        ckpt_file = pcfg.get("checkpoint", "")
        model_cache_key = (ckpt_file or dm_file, weight_dtype)

        clips_map = pcfg.get("compatible_clips", {})
        dc = pcfg.get("default_clip")
        if clip_variant and clip_variant in clips_map:
            clip_files = clips_map[clip_variant]
        elif dc:
            clip_files = dc
        elif clips_map:
            clip_files = list(clips_map.values())[0]
        clip_cache_key = (tuple(clip_files) if clip_files else None, pcfg.get("clip_type", ""))

        vae_file = pcfg.get("vae", "")
        vae_cache_key = vae_file

        # ── Clear cache if model changed (free VRAM) ──
        if _cache["model_key"] is not None and _cache["model_key"] != model_cache_key:
            logging.info(f"[TheLastModelSwitcher] Model changed, clearing cache and freeing VRAM")
            _cache_clear()

        # ── Load model (with cache) ──
        if pcfg.get("checkpoint"):
            cached = _cache_get_model(model_cache_key)
            if cached is not None:
                loaded_model = cached
                clip_obj = _cache_get_clip(model_cache_key)
                vae = _cache_get_vae(model_cache_key)
                clip_files = _cache.get("clip_files")
                cache_status.append("MODEL/CLIP/VAE from cache")
            else:
                try:
                    ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", pcfg["checkpoint"])
                    out = comfy.sd.load_checkpoint_guess_config(
                        ckpt_path, output_vae=True, output_clip=True, embedding_directory=embedding_dirs)
                    loaded_model, clip_obj, vae = out[:3]
                    _cache_set_model(model_cache_key, loaded_model)
                    _cache_set_clip(model_cache_key, clip_obj, None)
                    _cache_set_vae(model_cache_key, vae)
                    cache_status.append("MODEL/CLIP/VAE loaded from disk")
                except Exception as e:
                    _cache_clear()
                    raise RuntimeError(
                        f"Failed to load checkpoint '{pcfg['checkpoint']}': {e}\n"
                        f"The file may be corrupted or incomplete. Try re-downloading it."
                    ) from e
        elif dm_file:
            cached = _cache_get_model(model_cache_key)
            if cached is not None:
                loaded_model = cached
                cache_status.append("MODEL from cache")
            else:
                try:
                    if _is_gguf(dm_file):
                        if not _gguf_available:
                            raise RuntimeError("GGUF required but ComfyUI-GGUF not installed.")
                        unet_path = folder_paths.get_full_path("unet", dm_file)
                        if not unet_path:
                            unet_path = folder_paths.get_full_path_or_raise("diffusion_models", dm_file)
                        loaded_model = _load_diffusion_model_gguf(unet_path)
                    else:
                        mo = {}
                        if weight_dtype == "fp8_e4m3fn": mo["dtype"] = torch.float8_e4m3fn
                        elif weight_dtype == "fp8_e5m2": mo["dtype"] = torch.float8_e5m2
                        unet_path = folder_paths.get_full_path_or_raise("diffusion_models", dm_file)
                        loaded_model = comfy.sd.load_diffusion_model(unet_path, model_options=mo)
                    _cache_set_model(model_cache_key, loaded_model)
                    cache_status.append("MODEL loaded from disk")
                except Exception as e:
                    _cache_clear()
                    raise RuntimeError(
                        f"Failed to load model '{dm_file}': {e}\n"
                        f"The file may be corrupted or incomplete. Try re-downloading it."
                    ) from e

        # ── Load CLIP (with cache) ──
        if clip_obj is None and clip_files:
            cached = _cache_get_clip(clip_cache_key)
            if cached is not None:
                clip_obj = cached
                clip_files = _cache.get("clip_files") or clip_files
                cache_status.append("CLIP from cache")
            else:
                try:
                    ct_str = pcfg.get("clip_type", "stable_diffusion")
                    ct = getattr(comfy.sd.CLIPType, ct_str.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
                    clip_paths = [_resolve_clip_path(f) for f in clip_files]
                    if any(_is_gguf(f) for f in clip_files):
                        if not _gguf_available:
                            raise RuntimeError("GGUF CLIP required but ComfyUI-GGUF not installed.")
                        clip_obj = _load_clip_gguf(clip_paths, ct)
                    else:
                        clip_obj = comfy.sd.load_clip(ckpt_paths=clip_paths,
                            embedding_directory=embedding_dirs, clip_type=ct)
                    _cache_set_clip(clip_cache_key, clip_obj, clip_files)
                    cache_status.append("CLIP loaded from disk")
                except Exception as e:
                    raise RuntimeError(
                        f"Failed to load CLIP '{', '.join(clip_files)}': {e}\n"
                        f"Make sure the text encoder files exist in your text_encoders folder."
                    ) from e

        # ── Load VAE (with cache) ──
        if vae is None and vae_file:
            cached = _cache_get_vae(vae_cache_key)
            if cached is not None:
                vae = cached
                cache_status.append("VAE from cache")
            else:
                try:
                    vae_path = folder_paths.get_full_path_or_raise("vae", vae_file)
                    sd, metadata = comfy.utils.load_torch_file(vae_path, return_metadata=True)
                    vae = comfy.sd.VAE(sd=sd, metadata=metadata)
                    vae.throw_exception_if_invalid()
                    _cache_set_vae(vae_cache_key, vae)
                    cache_status.append("VAE loaded from disk")
                except Exception as e:
                    raise RuntimeError(
                        f"Failed to load VAE '{vae_file}': {e}\n"
                        f"Make sure the VAE file exists in your vae folder."
                    ) from e

        if loaded_model is None:
            raise ValueError(f"Model '{preset_name}' has no model file configured.")

        # ── Encode prompts to CONDITIONING ──
        positive_cond = None
        negative_cond = None
        if clip_obj is not None:
            # Positive prompt
            pos_text = positive_prompt if positive_prompt else ""
            pos_tokens = clip_obj.tokenize(pos_text)
            positive_cond = clip_obj.encode_from_tokens_scheduled(pos_tokens)

            # Negative prompt (empty for Flux, user text for SD/SDXL)
            neg_support = pcfg.get("negative_prompt_supported", not is_flux)
            neg_text = negative_prompt if (negative_prompt and neg_support) else ""
            neg_tokens = clip_obj.tokenize(neg_text)
            negative_cond = clip_obj.encode_from_tokens_scheduled(neg_tokens)

        # ── VAE tiling for high resolutions ──
        if vae is not None:
            try:
                if hasattr(vae, "enable_tiling"):
                    vae.enable_tiling()
            except Exception:
                pass

        # ── Apply megapixel scaling ──
        # Parse megapixels from DynamicCombo (e.g. "2.0 MP" -> 2.0)
        selected_mp = 0.0
        if megapixels_str:
            import re
            mp_match = re.match(r"([\d.]+)", megapixels_str)
            if mp_match:
                selected_mp = float(mp_match.group(1))

        if selected_mp > 0:
            # Scale width/height by megapixel target, keeping aspect ratio
            aspect = width / height if height > 0 else 1.0
            total = selected_mp * 1024 * 1024
            h = math.sqrt(total / aspect)
            width = round((h * aspect) / 8) * 8
            height = round(h / 8) * 8
        else:
            width = round(width / 8) * 8
            height = round(height / 8) * 8

        target_mp = (width * height) / (1024 * 1024)

        # ── Sampler settings (from input widgets) ──
        sc = pcfg.get("sampler", {})
        rec_sampler = sc.get("sampler_name", "euler")
        rec_scheduler = sc.get("scheduler", "normal")
        out_steps = steps
        out_cfg = cfg
        guidance_value = guidance

        # ── Apply ModelSamplingFlux ──
        if is_flux and loaded_model is not None:
            m = loaded_model.clone()
            max_shift, base_shift = 1.15, 0.5
            x1, x2 = 256, 4096
            mm = (max_shift - base_shift) / (x2 - x1)
            b = base_shift - mm * x1
            shift = (width * height / (8 * 8 * 2 * 2)) * mm + b

            class ModelSamplingAdvanced(comfy.model_sampling.ModelSamplingFlux, comfy.model_sampling.CONST):
                pass

            model_sampling = ModelSamplingAdvanced(loaded_model.model.model_config)
            model_sampling.set_parameters(shift=shift)
            m.add_object_patch("model_sampling", model_sampling)
            loaded_model = m

        # ── Build info text ──
        neg_support = pcfg.get("negative_prompt_supported", not is_flux)
        custom_info = pcfg.get("info_text", "")

        info = [
            f"{'=' * 50}",
            f"  THE LAST MODEL SWITCHER",
            f"  {preset_name}",
            f"{'=' * 50}",
            "",
            pcfg.get("description", ""),
            "",
            f"  Model:      {pcfg.get('diffusion_model') or pcfg.get('checkpoint', 'N/A')}",
            f"  CLIP:       {', '.join(clip_files) if clip_files else 'from checkpoint'} ({pcfg.get('clip_type', 'N/A')})",
            f"  VAE:        {pcfg.get('vae') or 'from checkpoint'}",
            "",
            f"  Resolution: {width} x {height}  ({target_mp:.2f} MP)",
            "",
            f"{'~' * 50}",
            f"  RECOMMENDED SETTINGS",
            f"{'~' * 50}",
            f"  Sampler:    {rec_sampler}",
            f"  Scheduler:  {rec_scheduler}",
            f"  Steps:      {out_steps}",
            f"  CFG:        {out_cfg}",
        ]
        if guidance_value > 0:
            info.append(f"  Guidance:   {guidance_value}")
        if is_flux:
            info.append(f"  ModelSamplingFlux: applied (shift auto-calculated)")
        if neg_support:
            info.append(f"  Neg prompt: supported (output encoded)")
        else:
            info.append(f"  Neg prompt: not used (empty conditioning output)")
        if custom_info:
            info.append("")
            info.append(f"  {custom_info}")

        missing = _validate_preset(preset_name, pcfg)
        if missing:
            info.append("")
            info.append(f"  WARNING: Missing files: {', '.join(missing)}")

        if cache_status:
            info.append("")
            info.append(f"  Cache: {' | '.join(cache_status)}")

        info.append("")
        info.append(f"{'=' * 50}")
        info.append("  BY MAXOMARAI")
        info.append(f"{'=' * 50}")

        # ── Output labels with values ──
        output_values = {
            "width": str(width),
            "height": str(height),
            "steps": str(out_steps),
            "cfg": str(out_cfg),
            "guidance": str(guidance_value),
        }

        return io.NodeOutput(
            loaded_model, clip_obj, vae,
            positive_cond, negative_cond,
            width, height,
            out_steps, out_cfg,
            guidance_value,
            ui={
                "text": ("\n".join(info),),
                "output_values": (output_values,),
            },
        )


class TheLastModelSwitcherExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [TheLastModelSwitcher]


async def comfy_entrypoint() -> TheLastModelSwitcherExtension:
    return TheLastModelSwitcherExtension()
