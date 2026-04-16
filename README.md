# The Last Model Switcher

A ComfyUI custom node by **Maxomarai** that makes switching between AI image generation models effortless. Select your model from a dropdown and everything else is configured automatically - compatible CLIP/text encoders, VAE, resolution, and recommended sampler settings.

No more guessing which text encoder goes with which model.

## Features

- **One-click model switching** - Switch between Flux 1, Flux 2, SDXL and more from a single dropdown
- **Auto CLIP/text encoder selection** - Only compatible text encoders are shown for the selected model
- **Auto VAE** - The correct VAE is selected automatically
- **Aspect ratio & resolution presets** - Choose from pre-configured resolutions per model
- **Megapixel scaling** (Flux 2) - Scale resolution by megapixel target while keeping aspect ratio
- **Editable outputs** - Steps, CFG, guidance, width, height are editable widgets that auto-populate from presets but can be manually overridden
- **Live info panel** - Shows recommended sampler, scheduler, and model details directly on the node
- **Smart model caching** - Models are cached between executions for faster subsequent generations
- **VAE tiling** - Automatically enabled for memory-efficient high-resolution decode
- **GGUF support** - Works with GGUF quantized models (requires [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF))
- **Connected node sync** - Pushes values to connected downstream nodes after execution

## Outputs

| Output | Type | Description |
|--------|------|-------------|
| MODEL | MODEL | Loaded model with ModelSamplingFlux applied (for Flux models) |
| CLIP | CLIP | Compatible text encoder |
| VAE | VAE | Compatible VAE |
| width | INT | Resolution width (from preset, megapixel-scaled, or manual) |
| height | INT | Resolution height |
| steps | INT | Sampling steps (preset default or your override) |
| cfg | FLOAT | CFG scale |
| guidance | FLOAT | Flux guidance value (0 for non-Flux models) |

## Supported Models

### Flux 2 (with megapixel scaling)
- Flux 2 Dev (Mistral / Qwen3 4B / full precision)
- Flux 2 Klein 4B (fp8 / full / base)
- Flux 2 Klein 9B (full / GGUF Q8)

### Flux 1
- Flux 1 Dev (full / GGUF Q5)
- Flux 1 Kontext Dev (GGUF)

### SDXL
- Playground v2.5

## Installation

### Option 1: ComfyUI Manager (Recommended)

Search for "The Last Model Switcher" in ComfyUI Manager and click Install.

### Option 2: Git Clone

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/maxomarai/ComfyUI-The-Last-Model-Switcher.git the_last_model_switcher
```

Restart ComfyUI after installation.

### Option 3: Manual Download

1. Download this repository as a ZIP
2. Extract to `ComfyUI/custom_nodes/the_last_model_switcher/`
3. Restart ComfyUI

## Usage

1. Add the node: **Right-click > Add Node > loaders > Maxomarai > The Last Model Switcher**
2. Select a model from the dropdown
3. Compatible CLIP variants and resolutions appear automatically as sub-options
4. Connect the outputs to your workflow (KSampler, CLIPTextEncode, EmptyLatentImage, etc.)
5. The info panel at the bottom shows recommended settings

### Customizing Values

- **width / height** - Auto-set from preset + megapixels. Type your own values anytime.
- **steps / cfg / guidance** - Auto-set when switching models. Changing resolution/megapixels does NOT reset these.
- **Megapixels** (Flux 2 only) - Select from 0.25 to 4.0 MP. Scales resolution while keeping aspect ratio.

### Adding Your Own Models

Edit `presets.json` in the node directory. Each preset defines:

```json
{
    "My Custom Model": {
        "description": "Description shown in info panel",
        "diffusion_model": "my_model.safetensors",
        "vae": "my_vae.safetensors",
        "clip_type": "flux2",
        "default_clip": ["my_clip.safetensors"],
        "compatible_clips": {
            "Clip Name": ["my_clip.safetensors"]
        },
        "resolutions": {
            "1:1 Square (1024x1024)": [1024, 1024]
        },
        "default_resolution": "1:1 Square (1024x1024)",
        "megapixels": 1.0,
        "sampler": {
            "sampler_name": "euler",
            "scheduler": "simple",
            "steps": 20,
            "cfg": 1.0
        },
        "guidance": 3.5,
        "apply_model_sampling_flux": true,
        "negative_prompt_supported": false,
        "info_text": "Your recommended settings info."
    }
}
```

Click "Reload Presets" on the node to pick up changes (restart ComfyUI to update the dropdown).

## Requirements

- ComfyUI V2 (with `comfy_api.latest` support)
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) (optional, for GGUF model support)

## License

MIT License - see [LICENSE](LICENSE) for details.
