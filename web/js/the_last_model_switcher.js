import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

/* ═══════════════════════════════════════════════════════════
   THE LAST MODEL SWITCHER by Maxomarai
   ═══════════════════════════════════════════════════════════ */

/* ─── Helpers ─── */
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function aspectStr(w, h) { const g = gcd(w, h); return `${w / g}:${h / g}`; }

/* ─── Output slot index -> value key mapping (no CLIP) ─── */
const OUTPUT_MAP = {
    4: "width",
    5: "height",
    6: "steps",
    7: "cfg",
    8: "seed",
};

/* ─── Find a widget by name (handles DynamicCombo prefix variants) ─── */
function findWidget(node, name) {
    if (!node.widgets) return null;
    const candidates = [name, `model.${name}`, name.replace("model.", "")];
    for (const w of node.widgets) {
        if (candidates.includes(w.name)) return w;
    }
    for (const w of node.widgets) {
        if (w.name && w.name.endsWith(`.${name}`)) return w;
        if (w.name && w.name.endsWith(name)) return w;
    }
    return null;
}

/* ─── Get model name from node ─── */
function getName(node) {
    if (node.widgets) {
        for (const w of node.widgets) {
            if (w.name === "model" || w.name === "model.model") {
                const v = w.value;
                if (typeof v === "string" && v) return v.replace(/\s*\[MISSING\]/, "").trim();
                if (typeof v === "object" && v) {
                    const n = v.model || v.value || "";
                    if (n) return String(n).replace(/\s*\[MISSING\]/, "").trim();
                }
            }
        }
    }
    if (node.widgets_values && typeof node.widgets_values[0] === "string" && node.widgets_values[0].length > 3) {
        return node.widgets_values[0].replace(/\s*\[MISSING\]/, "").trim();
    }
    return "";
}

/* ─── Get selected resolution from node ─── */
function getResolution(node) {
    const w = findWidget(node, "resolution");
    return w ? w.value : "";
}

/* ─── Get selected megapixels from node ─── */
function getMegapixels(node) {
    const w = findWidget(node, "megapixels");
    return w ? w.value : "";
}

/* ─── Parse megapixel string like "1.0 MP" -> 1.0 ─── */
function parseMp(s) {
    if (!s) return 0;
    const m = String(s).match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : 0;
}

/* ─── Scale resolution by megapixels ─── */
function scaleResolution(baseW, baseH, mp) {
    if (!mp || mp <= 0) return [baseW, baseH];
    const aspect = baseW / baseH;
    const total = mp * 1024 * 1024;
    const h = Math.sqrt(total / aspect);
    const width = Math.round((h * aspect) / 8) * 8;
    const height = Math.round(h / 8) * 8;
    return [width, height];
}

/* ─── Fetch preset info ─── */
async function fetchInfo(name) {
    const r = await fetch(`/the_last_model_switcher/preset_info?name=${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error("Not found: " + name);
    return r.json();
}

/* ─── Set a widget value on a node by name ─── */
function setWidget(node, name, value) {
    if (!node.widgets) return;
    for (const w of node.widgets) {
        if (w.name === name) {
            w.value = value;
            w.callback?.(value);
            return;
        }
    }
}

/* ─── Resolve width/height from preset info + resolution + megapixels ─── */
function resolveWidthHeight(info, resName, mpStr) {
    let baseW = 1024, baseH = 1024;
    if (resName && info.resolutions && info.resolutions[resName]) {
        [baseW, baseH] = info.resolutions[resName];
    } else if (info.default_resolution && info.resolutions[info.default_resolution]) {
        [baseW, baseH] = info.resolutions[info.default_resolution];
    }
    const mp = parseMp(mpStr);
    if (mp > 0) {
        [baseW, baseH] = scaleResolution(baseW, baseH, mp);
    }
    return [baseW, baseH];
}

/* ─── Update only width/height (for resolution/megapixels changes) ─── */
function updateResolution(node, info, resName, mpStr) {
    const [w, h] = resolveWidthHeight(info, resName, mpStr);
    setWidget(node, "width", w);
    setWidget(node, "height", h);
    node.setDirtyCanvas(true, true);
}

/* ─── Full populate: width/height + steps/cfg/guidance (for model changes) ─── */
function populateAll(node, info, resName, mpStr) {
    const [w, h] = resolveWidthHeight(info, resName, mpStr);
    setWidget(node, "width", w);
    setWidget(node, "height", h);
    setWidget(node, "steps", info.steps);
    setWidget(node, "cfg", info.cfg);
    setWidget(node, "guidance", info.guidance || 0);
    node.setDirtyCanvas(true, true);
}

/* ─── Push values to all connected downstream nodes ─── */
function pushValuesToConnectedNodes(node, vals) {
    if (!node.outputs || !vals) return;
    const graph = node.graph || app.graph;
    if (!graph) return;

    for (const [slotIdx, valKey] of Object.entries(OUTPUT_MAP)) {
        const output = node.outputs[parseInt(slotIdx)];
        if (!output || !output.links || !output.links.length) continue;
        const value = vals[valKey];
        if (value === undefined) continue;

        for (const linkId of output.links) {
            const link = graph.links?.get ? graph.links.get(linkId) : graph.links?.[linkId];
            if (!link) continue;

            const targetNode = graph.getNodeById(link.target_id);
            if (!targetNode || !targetNode.widgets) continue;

            const targetInput = targetNode.inputs?.[link.target_slot];
            if (!targetInput) continue;

            for (const widget of targetNode.widgets) {
                if (widget.name === targetInput.name) {
                    const numVal = Number(value);
                    const newVal = isNaN(numVal) ? value : numVal;
                    if (widget.value !== newVal) {
                        widget.value = newVal;
                        widget.callback?.(newVal);
                    }
                    break;
                }
            }
        }
    }
    app.graph.setDirtyCanvas(true, true);
}

/*
 * ─── Check connections and build warnings ───
 *
 * Output indices (no CLIP):
 *   0=MODEL, 1=VAE, 2=positive, 3=negative,
 *   4=width, 5=height, 6=steps, 7=cfg, 8=guidance, 9=seed
 */
function checkConnections(node, info) {
    const warnings = [];
    if (!node.outputs) return warnings;

    const hasLinks = (idx) => {
        const o = node.outputs[idx];
        return o && o.links && o.links.length > 0;
    };

    const isFlux = info && info.is_flux;
    const negSupported = info && info.negative_prompt_supported;

    if (!hasLinks(0)) warnings.push("MODEL output is not connected");
    if (!hasLinks(2)) warnings.push("positive output is not connected - KSampler needs it");
    if (!hasLinks(3) && !isFlux) warnings.push("negative output is not connected - recommended for this model");

    const posPrompt = node.widgets?.find(w => w.name === "positive_prompt");
    const negPrompt = node.widgets?.find(w => w.name === "negative_prompt");

    if (posPrompt && (!posPrompt.value || posPrompt.value.trim() === "")) {
        warnings.push("Positive prompt is empty");
    }
    if (negPrompt && negPrompt.value && negPrompt.value.trim() !== "" && !negSupported) {
        warnings.push("Negative prompt will be ignored (not supported by this model)");
    }

    if (!hasLinks(4) && !hasLinks(5)) {
        warnings.push("width/height not connected - connect to EmptyLatentImage");
    }

    return warnings;
}

/* ─── Format info as readable text ─── */
function formatInfo(i, warnings) {
    const lines = [];
    const sep = "=".repeat(48);
    const sep2 = "~".repeat(48);

    lines.push(sep);
    lines.push("  THE LAST MODEL SWITCHER");
    lines.push(`  ${i.name}`);
    lines.push(sep);
    lines.push("");
    if (i.description) lines.push(i.description);
    lines.push("");
    lines.push(`  Model:      ${i.diffusion_model}`);
    lines.push(`  CLIP:       ${i.clip_type}`);
    lines.push(`  VAE:        ${i.vae}`);
    lines.push("");
    lines.push(sep2);
    lines.push("  RECOMMENDED SETTINGS");
    lines.push(sep2);
    lines.push(`  Sampler:    ${i.sampler}`);
    lines.push(`  Scheduler:  ${i.scheduler}`);
    if (i.is_flux) lines.push("  ModelSamplingFlux: auto-applied");
    lines.push(`  Neg prompt: ${i.negative_prompt_supported ? "supported" : "not used"}`);

    if (i.info_text) {
        lines.push("");
        lines.push(`  ${i.info_text}`);
    }

    const clips = Object.keys(i.compatible_clips || {});
    if (clips.length) {
        lines.push("");
        lines.push("  Compatible CLIPs:");
        clips.forEach(c => lines.push(`    - ${c}`));
    }

    if (i.missing_files?.length) {
        lines.push("");
        lines.push(`  WARNING: Missing: ${i.missing_files.join(", ")}`);
    }

    if (warnings && warnings.length) {
        lines.push("");
        lines.push("  !! WARNINGS !!");
        warnings.forEach(w => lines.push(`  >> ${w}`));
    }

    lines.push("");
    lines.push(sep);
    lines.push("  BY MAXOMARAI");
    lines.push(sep);
    return lines.join("\n");
}

/* ─── Ensure text widget exists on node ─── */
function getOrCreateTextWidget(node) {
    let w = node.widgets?.find(w => w.name === "_tlms_info");
    if (w) return w;

    const widgetData = ComfyWidgets["STRING"](node, "_tlms_info", ["STRING", { multiline: true }], app);
    w = widgetData.widget;
    w.inputEl.readOnly = true;
    w.inputEl.style.opacity = "0.85";
    w.inputEl.style.fontSize = "10px";
    w.inputEl.style.fontFamily = "'Consolas', 'JetBrains Mono', monospace";
    w.inputEl.style.background = "rgba(12,15,25,0.92)";
    w.inputEl.style.color = "#c0c8d8";
    w.inputEl.style.border = "1px solid rgba(60,70,90,0.4)";
    w.inputEl.style.borderRadius = "6px";
    w.inputEl.style.padding = "8px 10px";
    w.inputEl.style.lineHeight = "1.55";
    w.inputEl.style.resize = "none";
    w.serialize = false;
    w.value = "";
    return w;
}

/* ─── Show info text in node ─── */
function showText(node, text) {
    const w = getOrCreateTextWidget(node);
    w.value = text;
    w.inputEl.value = text;
    w.inputEl.style.height = "auto";
    w.inputEl.style.height = w.inputEl.scrollHeight + "px";
    requestAnimationFrame(() => {
        const sz = node.computeSize();
        node.size[0] = Math.max(node.size[0], sz[0]);
        node.size[1] = Math.max(node.size[1], sz[1]);
        node.setDirtyCanvas(true, true);
    });
}

/* ═══ Extension ═══ */
app.registerExtension({
    name: "Maxomarai.TheLastModelSwitcher",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "TheLastModelSwitcher") return;

        /* Output indices: 0=model, 1=vae, 2=positive, 3=negative, 4=width, 5=height, 6=steps, 7=cfg, 8=seed */
        const OUTPUT_LABELS = ["model", "vae", "positive", "negative", "width", "height", "steps", "cfg", "seed"];

        const ox = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (msg) {
            ox?.apply(this, arguments);
            if (msg?.text?.[0]) {
                showText(this, msg.text[0]);
            }
            const vals = msg?.output_values?.[0];
            if (vals && this.outputs) {
                if (vals.seed) this._lastSeed = parseInt(vals.seed, 10);

                /* Update value labels on outputs */
                for (let i = 0; i < this.outputs.length; i++) {
                    const out = this.outputs[i];
                    const baseName = OUTPUT_LABELS[i];
                    if (baseName && vals[baseName] !== undefined) {
                        out.label = `${baseName}: ${vals[baseName]}`;
                    }
                }

                /* Update positive/negative labels based on model type */
                /* (uses the shared function defined in nodeCreated scope) */
                const infoForLabels = {
                    is_flux: vals.is_flux,
                    guidance: parseFloat(vals.guidance_value) || 0,
                };
                if (this._updateOutputLabels) this._updateOutputLabels(infoForLabels);
                this.setDirtyCanvas(true, true);
                pushValuesToConnectedNodes(this, vals);
            }
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "TheLastModelSwitcher" && node.type !== "TheLastModelSwitcher") return;

        node.size[0] = Math.max(node.size[0], 380);

        /* ─── Welcome text ─── */
        requestAnimationFrame(() => {
            const welcome = [
                "THE LAST MODEL SWITCHER",
                "by Maxomarai",
                "================================================",
                "",
                "  GETTING STARTED:",
                "",
                "  1. Select a model from the dropdown above",
                "     (only models you have downloaded appear)",
                "",
                "  2. Write your prompt in the text fields",
                "",
                "  3. Connect outputs to your workflow:",
                "     MODEL    -> KSampler (model)",
                "     VAE      -> VAE Decode",
                "     positive -> KSampler (positive)  [includes FluxGuidance]",
                "     negative -> KSampler (negative)  [empty for Flux, safe to keep]",
                "     width    -> EmptyLatentImage (width)",
                "     height   -> EmptyLatentImage (height)",
                "     steps    -> KSampler (steps)",
                "     cfg      -> KSampler (cfg)",
                "     seed     -> KSampler (seed)",
                "",
                "  Everything else is automatic!",
                "",
                "  BUTTONS:",
                "  AI Identify Model    - use AI for optimal settings",
                "  AI Enhance Prompt    - improve your prompt with AI",
                "  Show Model Info      - view current model details",
                "  Scan for New Models  - find models in your folders",
                "  AI Settings          - configure AI provider & key",
                "  Edit Presets File    - customize presets manually",
                "",
                "================================================",
            ].join("\n");
            if (!getName(node)) {
                showText(node, welcome);
            }
        });

        /* ─── Polling: detect widget value changes ─── */
        let lastState = {
            model: "", resolution: "", megapixels: "", clip: "",
            width: "", height: "", steps: "", cfg: "", guidance: "",
        };
        let updateTimer = null;

        function getWidgetVal(name) {
            const w = node.widgets?.find(w => w.name === name);
            return w ? String(w.value) : "";
        }

        function getCurrentState() {
            return {
                model: getName(node),
                resolution: getResolution(node),
                megapixels: getMegapixels(node),
                clip: (findWidget(node, "clip_variant") || {}).value || "",
                width: getWidgetVal("width"),
                height: getWidgetVal("height"),
                steps: getWidgetVal("steps"),
                cfg: getWidgetVal("cfg"),
                guidance: getWidgetVal("guidance"),
                seed: getWidgetVal("seed"),
            };
        }

        function presetChanged(a, b) {
            return a.model !== b.model || a.resolution !== b.resolution
                || a.megapixels !== b.megapixels || a.clip !== b.clip;
        }

        function valuesChanged(a, b) {
            return a.width !== b.width || a.height !== b.height
                || a.steps !== b.steps || a.cfg !== b.cfg || a.guidance !== b.guidance
                || a.seed !== b.seed;
        }

        function stateChanged(a, b) {
            return presetChanged(a, b) || valuesChanged(a, b);
        }

        function pushCurrentValues() {
            const getVal = (name) => {
                const w = node.widgets?.find(w => w.name === name);
                return w ? w.value : undefined;
            };
            const vals = {
                width: String(getVal("width") || ""),
                height: String(getVal("height") || ""),
                steps: String(getVal("steps") || ""),
                cfg: String(getVal("cfg") || ""),
                seed: String(getVal("seed") || ""),
            };
            pushValuesToConnectedNodes(node, vals);
        }

        /* Update output labels based on model type (Flux vs SD/SDXL).
         * Also stored on node so onExecuted can call it. */
        node._updateOutputLabels = updateOutputLabels;
        function updateOutputLabels(info) {
            if (!node.outputs || !info) return;
            const isFlux = info.is_flux;
            const guidanceVal = info.guidance || 0;

            for (let i = 0; i < node.outputs.length; i++) {
                const out = node.outputs[i];
                const baseName = OUTPUT_LABELS[i];
                if (baseName === "positive") {
                    out.label = isFlux && guidanceVal > 0
                        ? `positive (+guidance ${guidanceVal})`
                        : "positive";
                } else if (baseName === "negative") {
                    out.label = isFlux ? "negative (unused)" : "negative";
                }
            }
            node.setDirtyCanvas(true, true);
        }

        async function handleChange(cur, prev) {
            if (!cur.model) return;

            const presetDidChange = presetChanged(cur, prev);
            const valuesDidChange = valuesChanged(cur, prev);

            if (presetDidChange) {
                clearTimeout(updateTimer);
                updateTimer = setTimeout(async () => {
                    try {
                        const i = await fetchInfo(cur.model);
                        const modelChanged = cur.model !== prev.model;

                        if (modelChanged) {
                            populateAll(node, i, cur.resolution, cur.megapixels);
                        } else {
                            updateResolution(node, i, cur.resolution, cur.megapixels);
                        }

                        updateOutputLabels(i);
                        showText(node, formatInfo(i, checkConnections(node, i)));
                        pushCurrentValues();
                    } catch (e) { showText(node, "Error: " + e.message); }
                }, 100);
            } else if (valuesDidChange) {
                pushCurrentValues();
            }
        }

        /* Poll for widget value changes */
        const pollInterval = setInterval(() => {
            if (!node.graph) { clearInterval(pollInterval); return; }
            const cur = getCurrentState();
            if (stateChanged(cur, lastState)) {
                const prev = { ...lastState };
                lastState = cur;
                handleChange(cur, prev);
            }
        }, 500);

        /* Poll for connection changes -> update warnings */
        let lastConnectionHash = "";
        const connectionPoll = setInterval(() => {
            if (!node.graph) { clearInterval(connectionPoll); return; }
            let hash = "";
            if (node.outputs) {
                for (const o of node.outputs) {
                    hash += (o.links ? o.links.length : 0) + ",";
                }
            }
            const posW = node.widgets?.find(w => w.name === "positive_prompt");
            const negW = node.widgets?.find(w => w.name === "negative_prompt");
            hash += "|" + (posW?.value || "").length + "|" + (negW?.value || "").length;

            if (hash !== lastConnectionHash) {
                lastConnectionHash = hash;
                const n = getName(node);
                if (n) {
                    fetchInfo(n).then(i => {
                        showText(node, formatInfo(i, checkConnections(node, i)));
                    }).catch(() => {});
                }
            }
        }, 2000);

        /* Fallback: onWidgetChanged */
        const ow = node.onWidgetChanged;
        node.onWidgetChanged = function (name, value) {
            ow?.apply(this, arguments);
            const cur = getCurrentState();
            if (stateChanged(cur, lastState)) {
                const prev = { ...lastState };
                lastState = cur;
                handleChange(cur, prev);
            }
        };

        /* ═══════════════════════════════════════════════════
         * BUTTONS / WIDGETS  (in logical order)
         * ═══════════════════════════════════════════════════ */

        /* (a) AI Identify Model */
        node.addWidget("button", "AI Identify Model", "", async () => {
            const n = getName(node);
            if (!n) { showText(node, "No model selected"); return; }

            showText(node, "AI is analyzing this model...");
            try {
                const r = await fetch("/the_last_model_switcher/ai_identify", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ preset_name: n }),
                });
                const d = await r.json();
                if (d.error) { showText(node, "AI Error: " + d.error); return; }

                const ai = d.ai_result;
                const lines = [];
                lines.push("AI IDENTIFICATION COMPLETE");
                lines.push("=".repeat(48));
                lines.push("");
                if (ai.model_name) lines.push(`  Model:      ${ai.model_name}`);
                if (ai.description) lines.push(`  ${ai.description}`);
                lines.push("");
                lines.push("  UPDATED SETTINGS:");
                if (ai.sampler_name) lines.push(`  Sampler:    ${ai.sampler_name}`);
                if (ai.scheduler) lines.push(`  Scheduler:  ${ai.scheduler}`);
                if (ai.steps) lines.push(`  Steps:      ${ai.steps}`);
                if (ai.cfg !== undefined) lines.push(`  CFG:        ${ai.cfg}`);
                if (ai.guidance) lines.push(`  Guidance:   ${ai.guidance}`);
                lines.push(`  Neg prompt: ${ai.negative_prompt_supported ? "yes" : "no"}`);
                if (ai.confidence) lines.push(`  Confidence: ${ai.confidence}`);
                if (ai.info_text) {
                    lines.push("");
                    lines.push(`  ${ai.info_text}`);
                }
                lines.push("");
                lines.push("Settings saved to presets.json.");
                lines.push("Restart ComfyUI for dropdown changes.");
                showText(node, lines.join("\n"));

                if (ai.steps) setWidget(node, "steps", ai.steps);
                if (ai.cfg !== undefined) setWidget(node, "cfg", ai.cfg);
                if (ai.guidance !== undefined) setWidget(node, "guidance", ai.guidance);
                pushCurrentValues();
            } catch (e) { showText(node, "AI Error: " + e.message); }
        }, { serialize: false });

        /* (b) enhance_style combo */
        const enhanceStyles = ["enhance", "detailed", "concise", "creative", "fix"];
        node.addWidget("combo", "enhance_style", enhanceStyles[0], () => {}, {
            values: enhanceStyles, serialize: false,
        });

        /* Custom instruction field (optional, overrides style if filled) */
        const customWidget = ComfyWidgets["STRING"](node, "enhance_instruction", ["STRING", { multiline: false }], app);
        customWidget.widget.inputEl.placeholder = "Custom instruction (optional, overrides style)";
        customWidget.widget.inputEl.style.fontSize = "10px";
        customWidget.widget.inputEl.style.opacity = "0.8";
        customWidget.widget.serialize = false;
        customWidget.widget.value = "";

        /* (c) AI Enhance Prompt */
        node.addWidget("button", "AI Enhance Prompt", "", async () => {
            const n = getName(node);
            if (!n) { showText(node, "No model selected"); return; }

            const posW = node.widgets?.find(w => w.name === "positive_prompt");
            if (!posW || !posW.value?.trim()) {
                showText(node, "Write a prompt first, then click Enhance.");
                return;
            }

            const styleW = node.widgets?.find(w => w.name === "enhance_style");
            const instrW = node.widgets?.find(w => w.name === "enhance_instruction");
            let style = styleW?.value || "enhance";
            let customInstruction = instrW?.value?.trim() || "";

            if (customInstruction) {
                style = "custom";
            }

            let clipType = "";
            try {
                const info = await fetchInfo(n);
                clipType = info?.clip_type || "";
            } catch (e) {}

            showText(node, "AI is enhancing your prompt...");
            try {
                const r = await fetch("/the_last_model_switcher/enhance_prompt", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        prompt: posW.value,
                        model_name: n,
                        clip_type: clipType,
                        style: style,
                        custom_instruction: customInstruction,
                    }),
                });
                const d = await r.json();
                if (d.error) { showText(node, "Error: " + d.error); return; }

                const lines = [];
                lines.push("AI ENHANCED PROMPT");
                lines.push("=".repeat(48));
                lines.push("");
                lines.push("ORIGINAL:");
                lines.push(posW.value);
                lines.push("");
                lines.push("ENHANCED:");
                lines.push(d.enhanced);
                lines.push("");
                lines.push("Click 'Apply Enhanced Prompt' to use it,");
                lines.push("or edit it manually in the prompt field.");
                showText(node, lines.join("\n"));

                node._pendingEnhanced = d.enhanced;
            } catch (e) { showText(node, "Error: " + e.message); }
        }, { serialize: false });

        /* (d) Apply Enhanced Prompt */
        node.addWidget("button", "Apply Enhanced Prompt", "", () => {
            if (!node._pendingEnhanced) {
                showText(node, "No enhanced prompt pending. Click 'AI Enhance Prompt' first.");
                return;
            }
            const posW = node.widgets?.find(w => w.name === "positive_prompt");
            if (posW) {
                posW.value = node._pendingEnhanced;
                if (posW.inputEl) posW.inputEl.value = node._pendingEnhanced;
                posW.callback?.(node._pendingEnhanced);
            }
            node._pendingEnhanced = null;
            showText(node, "Enhanced prompt applied! You can edit it further if needed.");
        }, { serialize: false });

        /* (e) Seed tools */
        node._lastSeed = null;

        node.addWidget("button", "New Random Seed", "", () => {
            const newSeed = Math.floor(Math.random() * 0xFFFFFFFFFFFF);
            setWidget(node, "seed", newSeed);
            pushCurrentValues();
        }, { serialize: false });

        node.addWidget("button", "Reuse Last Seed", "", () => {
            if (node._lastSeed === null) {
                showText(node, "No previous seed to reuse. Run the workflow first.");
                return;
            }
            setWidget(node, "seed", node._lastSeed);
            pushCurrentValues();
        }, { serialize: false });

        node.addWidget("button", "Copy Seed", "", async () => {
            const seedW = node.widgets?.find(w => w.name === "seed");
            if (seedW) {
                try {
                    await navigator.clipboard.writeText(String(seedW.value));
                    showText(node, `Seed copied: ${seedW.value}`);
                } catch (e) {
                    showText(node, `Seed: ${seedW.value} (copy manually)`);
                }
            }
        }, { serialize: false });

        node.addWidget("button", "Paste Seed", "", async () => {
            try {
                const text = await navigator.clipboard.readText();
                const parsed = parseInt(text.trim(), 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    setWidget(node, "seed", parsed);
                    pushCurrentValues();
                    showText(node, `Seed pasted: ${parsed}`);
                } else {
                    showText(node, "Clipboard doesn't contain a valid seed number.");
                }
            } catch (e) {
                showText(node, "Can't read clipboard. Check browser permissions.");
            }
        }, { serialize: false });

        /* (f) Show Model Info */
        node.addWidget("button", "Show Model Info", "", async () => {
            const n = getName(node);
            if (!n) { showText(node, "No model selected"); return; }
            showText(node, "Loading...");
            try {
                const i = await fetchInfo(n);
                showText(node, formatInfo(i, checkConnections(node, i)));
            } catch (e) { showText(node, "Error: " + e.message); }
        }, { serialize: false });

        /* (g) Scan for New Models */
        node.addWidget("button", "Scan for New Models", "", async () => {
            showText(node, "Scanning model directories...");
            try {
                const r = await fetch("/the_last_model_switcher/scan");
                const d = await r.json();
                const lines = [];
                lines.push(`Scan complete! ${d.total_presets} models total.`);
                if (d.added.length) {
                    lines.push("");
                    lines.push(`NEW MODELS FOUND (${d.added.length}):`);
                    d.added.forEach(m => lines.push(`  + ${m.name} [${m.type}]`));
                    lines.push("");
                    lines.push("Restart ComfyUI to see them in the dropdown.");
                } else {
                    lines.push("No new models found.");
                }
                if (d.skipped.length) {
                    lines.push("");
                    lines.push(`Could not identify (${d.skipped.length}):`);
                    d.skipped.forEach(f => lines.push(`  ? ${f}`));
                }
                showText(node, lines.join("\n"));
            } catch (e) { showText(node, "Error scanning: " + e.message); }
        }, { serialize: false });

        /* (h) AI Settings */
        node.addWidget("button", "AI Settings", "", async () => {
            let current = {};
            try {
                const r = await fetch("/the_last_model_switcher/ai_settings");
                if (r.ok) current = await r.json();
            } catch (e) {}

            const curProvider = current.provider || "(not set)";
            const curModel = current.model || "(not set)";
            const curHasKey = current.has_key ? "configured" : "not set";
            const curBaseUrl = current.base_url || "";

            const providerInput = prompt(
                `AI Settings\n` +
                `Current: provider=${curProvider}, key=${curHasKey}, model=${curModel}\n\n` +
                `Choose provider (anthropic / openai / custom):\n` +
                `(Leave blank to keep current)`,
                curProvider !== "(not set)" ? curProvider : ""
            );
            if (providerInput === null) return;

            const provider = providerInput.trim() || curProvider;
            if (provider && provider !== "(not set)") {
                try {
                    await fetch("/settings/tlms.ai_provider", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(provider),
                    });
                } catch (e) {}
            }

            const apiKeyInput = prompt(
                `Enter API key for ${provider}:\n` +
                `(Leave blank to keep current key)`
            );
            if (apiKeyInput === null) return;

            if (apiKeyInput.trim()) {
                try {
                    await fetch("/settings/tlms.ai_api_key", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(apiKeyInput.trim()),
                    });
                } catch (e) {}
            }

            const modelInput = prompt(
                `Enter model name (e.g. claude-sonnet-4-20250514, gpt-4o):\n` +
                `(Leave blank to keep current)`,
                curModel !== "(not set)" ? curModel : ""
            );
            if (modelInput === null) return;

            if (modelInput.trim()) {
                try {
                    await fetch("/settings/tlms.ai_model", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(modelInput.trim()),
                    });
                } catch (e) {}
            }

            if (provider === "custom") {
                const baseUrlInput = prompt(
                    `Enter base URL for custom provider:\n` +
                    `(Leave blank to keep current)`,
                    curBaseUrl || ""
                );
                if (baseUrlInput !== null && baseUrlInput.trim()) {
                    try {
                        await fetch("/settings/tlms.ai_base_url", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(baseUrlInput.trim()),
                        });
                    } catch (e) {}
                }
            }

            const lines = [];
            lines.push("AI SETTINGS UPDATED");
            lines.push("=".repeat(48));
            lines.push("");
            lines.push(`  Provider:  ${provider}`);
            lines.push(`  API Key:   ${apiKeyInput?.trim() ? "updated" : "unchanged"}`);
            lines.push(`  Model:     ${modelInput?.trim() || curModel}`);
            if (provider === "custom") {
                lines.push(`  Base URL:  configured`);
            }
            lines.push("");
            lines.push("Settings saved. AI features will use these.");
            showText(node, lines.join("\n"));
        }, { serialize: false });

        /* (i) Edit Presets File */
        node.addWidget("button", "Edit Presets File", "", async () => {
            try {
                const r = await fetch("/the_last_model_switcher/presets_path");
                const d = await r.json();
                const path = d.path;
                const lines = [];
                lines.push("PRESETS FILE LOCATION:");
                lines.push("=".repeat(48));
                lines.push("");
                lines.push(path);
                lines.push("");
                lines.push("Open this file in a text editor to add/edit");
                lines.push("model presets manually. After editing, click");
                lines.push("'Reload Presets' to pick up changes.");
                lines.push("");
                lines.push("(Path copied to clipboard)");
                showText(node, lines.join("\n"));
                try { await navigator.clipboard.writeText(path); } catch (e) {}
            } catch (e) { showText(node, "Error: " + e.message); }
        }, { serialize: false });

        /* (j) Reload Presets */
        node.addWidget("button", "Reload Presets", "", async () => {
            try {
                const r = await fetch("/the_last_model_switcher/reload");
                const d = await r.json();
                showText(node, `Presets reloaded: ${d.count} models\n\n${d.names.join("\n")}\n\n(Restart ComfyUI to update dropdown)`);
            } catch (e) { showText(node, "Error reloading: " + e.message); }
        }, { serialize: false });

        /* ═══════════════════════════════════════════════════
         * REORDER WIDGETS
         *
         * Schema widgets (from Python) appear first in order.
         * JS-added buttons need to be moved to logical positions.
         *
         * Desired layout:
         *   model (+ sub-inputs)
         *   [AI Identify Model]       \
         *   [Show Model Info]          > model tools
         *   [Scan for New Models]     /
         *   [enhance_style]           \
         *   [AI Enhance Prompt]        > prompt tools
         *   [Apply Enhanced Prompt]   /
         *   positive_prompt
         *   negative_prompt
         *   seed
         *   [New Random Seed]         \
         *   [Reuse Last Seed]          > seed tools
         *   [Copy Seed]               |
         *   [Paste Seed]             /
         *   width, height, steps, cfg, guidance
         *   weight_dtype (advanced)
         *   [AI Settings]             \
         *   [Edit Presets File]        > admin tools
         *   [Reload Presets]          /
         *   _tlms_info (info panel)
         * ═══════════════════════════════════════════════════ */
        requestAnimationFrame(() => {
            if (!node.widgets || node.widgets.length < 5) return;

            const byName = (name) => node.widgets.find(w => w.name === name);
            const findBtn = (text) => node.widgets.find(w => w.type === "button" && w.name === text);

            /* Group widgets by where they should go */
            const modelTools = [
                findBtn("AI Identify Model"),
                findBtn("Show Model Info"),
                findBtn("Scan for New Models"),
            ].filter(Boolean);

            const promptTools = [
                byName("enhance_style"),
                byName("enhance_instruction"),
                findBtn("AI Enhance Prompt"),
                findBtn("Apply Enhanced Prompt"),
            ].filter(Boolean);

            const seedTools = [
                findBtn("New Random Seed"),
                findBtn("Reuse Last Seed"),
                findBtn("Copy Seed"),
                findBtn("Paste Seed"),
            ].filter(Boolean);

            const adminTools = [
                findBtn("AI Settings"),
                findBtn("Edit Presets File"),
                findBtn("Reload Presets"),
            ].filter(Boolean);

            /* Remove all movable widgets */
            const allMovable = new Set([...modelTools, ...promptTools, ...seedTools, ...adminTools]);
            const ordered = node.widgets.filter(w => !allMovable.has(w));

            /* Helper: insert group before a named widget */
            const insertBefore = (arr, targetName, group) => {
                const idx = arr.findIndex(w => w.name === targetName);
                if (idx >= 0) arr.splice(idx, 0, ...group);
            };

            /* Helper: insert group after a named widget */
            const insertAfter = (arr, targetName, group) => {
                const idx = arr.findIndex(w => w.name === targetName);
                if (idx >= 0) arr.splice(idx + 1, 0, ...group);
            };

            /* Insert in reverse order of position (bottom-up) so indices stay valid */
            insertBefore(ordered, "_tlms_info", adminTools);
            insertAfter(ordered, "seed", seedTools);
            insertBefore(ordered, "positive_prompt", promptTools);
            insertBefore(ordered, "positive_prompt", modelTools);

            node.widgets = ordered;
            node.setDirtyCanvas(true, true);
        });
    },
});
