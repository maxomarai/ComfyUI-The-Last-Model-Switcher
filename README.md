# The Last Model Switcher

A ComfyUI custom node by **Maxomarai** that makes switching between AI image generation models effortless.

Select your model from a dropdown and **everything configures itself** - CLIP, VAE, resolution, prompts, sampler settings, and guidance. Switch from SDXL to Flux without rewiring a single connection.

## Quick Start

### 1. Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/maxomarai/ComfyUI-The-Last-Model-Switcher.git the_last_model_switcher
```

Restart ComfyUI. The node appears under **loaders > Maxomarai > The Last Model Switcher**.

### 2. Connect

The node replaces multiple nodes in your workflow. Here's all you need:

```
The Last Model Switcher              KSampler
  ┌─────────────────────┐            ┌──────────────┐
  │ [model dropdown]    │            │              │
  │ [resolution]        │   MODEL ──>│ model        │
  │ [megapixels]        │            │              │
  │ [positive prompt]   │ positive ─>│ positive     │
  │ [negative prompt]   │ negative ─>│ negative     │
  │                     │            │              │
  │ width  [1024]       │     VAE ──>│         LATENT──> VAE Decode
  │ height [1024]       │            │              │
  │ steps  [20]         │   width ──>│              │
  │ cfg    [1.0]        │  height ──>│ EmptyLatent  │
  │ guidance [3.5]      │   steps ──>│ Image        │
  │                     │     cfg ──>│              │
  │ [info panel]        │            └──────────────┘
  └─────────────────────┘
```

**That's it.** No separate CLIPTextEncode, no FluxGuidance node, no guessing which VAE or text encoder to use.

### 3. Generate

Write your prompt, hit Queue. Switch models anytime - all settings update automatically.

## What It Does

| When you switch models... | The node automatically... |
|---------------------------|--------------------------|
| SDXL to Flux 2 | Changes CLIP, VAE, resolution, disables negative prompt, applies guidance |
| Flux 2 to SD 1.5 | Switches to 512x512, enables negative prompt, adjusts CFG to 7.0 |
| Any model change | Updates steps, sampler, scheduler to optimal values for that model |
| Resolution preset change | Updates width/height (keeps your steps/cfg untouched) |
| Megapixel change (Flux 2) | Scales width/height while keeping aspect ratio |

## Outputs

| Output | Description |
|--------|-------------|
| **MODEL** | Loaded model (with ModelSamplingFlux for Flux) |
| **CLIP** | Compatible text encoder (for custom encoding workflows) |
| **VAE** | Compatible VAE |
| **positive** | Your prompt encoded as conditioning (with FluxGuidance applied for Flux) |
| **negative** | Negative prompt conditioning (empty for Flux - safe to keep connected) |
| **width / height** | Resolution from preset, megapixel-scaled, or manually typed |
| **steps / cfg** | Sampler settings (auto or manual) |
| **guidance** | Flux guidance value (also applied internally to positive conditioning) |

## Features

### Built-in Prompt Encoding
Write your positive and negative prompts directly on the node. They're encoded with the correct CLIP for the selected model. For Flux models, FluxGuidance is applied automatically to the positive conditioning.

### Smart Warnings
The info panel warns you about connection issues in real-time:
- Missing connections (MODEL, positive, negative not connected)
- Empty prompt
- Negative prompt on Flux (will be ignored)
- Width/height not connected

### Auto Model Scanner
Click **"Scan for New Models"** to detect models in your folders. The scanner reads safetensors headers (instant, no model loading) and identifies:
- SD 1.5 / SDXL checkpoints
- SD3 / SD3.5 models
- Flux 1 Dev / Schnell
- Flux 2 models
- Turbo / Lightning / distilled variants (from filename)

Detected models get correct presets automatically.

### AI Model Identification
Click **"AI Identify Model"** to use AI for precise model identification. It analyzes the filename, file size, and architecture to suggest optimal settings.

### AI-Powered Features (multi-provider)
The node supports multiple AI providers for model identification and prompt enhancement:

| Provider | Cost | API Key | Notes |
|----------|------|---------|-------|
| **Anthropic** (Claude) | Paid | Required | Best quality for model identification |
| **OpenAI** (GPT) | Paid | Required | Fast, widely available |
| **Ollama** | Free | Not needed | Runs locally on your machine |
| **Custom** | Varies | Optional | Any OpenAI-compatible endpoint (LM Studio, vLLM, etc.) |

Click **"AI Settings"** to configure. Click **"Test AI Connection"** to verify.

#### Using Ollama (Local AI)
1. Install from [ollama.com](https://ollama.com) and start it: `ollama serve`
2. Pull a model: `ollama pull llama3.2`
3. In the node, click **"AI Settings"** and choose `ollama` as provider
4. Enter model name (e.g. `llama3.2`, `qwen2.5`, `mistral`)
5. Click **"Test AI Connection"** to verify

Good local models for prompt work: `llama3.2`, `qwen2.5:7b`, `mistral:7b`.

### Model Caching
Models are cached between executions. Re-running with the same model skips disk loading entirely. Cache clears automatically when you switch to a different model, freeing VRAM.

### Live Value Sync
Connected downstream nodes (KSampler, EmptyLatentImage, etc.) update their widgets immediately when you change settings - before execution.

## Supported Models (25 presets)

Only models you have downloaded appear in the dropdown.

| Family | Models |
|--------|--------|
| **SD 1.5** | Base, DreamShaper 8, Realistic Vision 6 |
| **SDXL** | Base, RealVisXL V5.0, Juggernaut XL, DreamShaper XL, Pony V6, Animagine XL, Playground v2.5, Lightning 4-Step, Turbo |
| **SD3 / SD3.5** | Large, Large fp8, Large Turbo, Medium |
| **Flux 1** | Dev, Dev GGUF Q5, Schnell, Kontext Dev GGUF |
| **Flux 2** | Dev (Mistral/Qwen3/full), Klein 4B fp8, Klein 9B |

### Adding Custom Models

**Option A:** Click **"Scan for New Models"** - auto-detects and adds presets.

**Option B:** Click **"AI Identify Model"** - uses AI for precise settings.

**Option C:** Click **"Edit Presets File"** - manually edit `presets.json`.

## Node Buttons

| Button | What it does |
|--------|-------------|
| **Show Model Info** | Display current model details and recommended settings |
| **Scan for New Models** | Auto-detect new models in your folders |
| **AI Identify Model** | Use Claude AI for precise model identification |
| **Reload Presets** | Reload presets.json after manual edits |
| **Edit Presets File** | Show presets.json path (copied to clipboard) |

## Installation

### Git Clone

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/maxomarai/ComfyUI-The-Last-Model-Switcher.git the_last_model_switcher
```

### Manual Download

1. Download this repository as a ZIP
2. Extract to `ComfyUI/custom_nodes/the_last_model_switcher/`
3. Restart ComfyUI

## Requirements

- ComfyUI V2 (with `comfy_api.latest` support)
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) (optional, for GGUF model support)
- Anthropic API key (optional, for AI model identification)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Made by [Maxomarai](https://github.com/maxomarai)
