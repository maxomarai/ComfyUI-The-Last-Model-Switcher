import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

/* ═══════════════════════════════════════════════════════════
   THE LAST MODEL SWITCHER by Maxomarai
   ═══════════════════════════════════════════════════════════ */

/* ─── Helpers ─── */
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
function aspectStr(w, h) { const g = gcd(w, h); return `${w / g}:${h / g}`; }

/* ─── Output slot indices (no CLIP) ───
 * 0=model, 1=vae, 2=positive, 3=negative, 4=width, 5=height, 6=steps, 7=cfg, 8=seed */
const OUTPUT_LABELS = ["model", "vae", "positive", "negative", "width", "height", "steps", "cfg", "seed"];
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

/* ─── Show/hide a widget (preserves value, just hides UI) ─── */
function toggleWidget(widget, visible) {
    if (!widget) return;
    if (visible) {
        if (widget._hiddenType !== undefined) {
            widget.type = widget._hiddenType;
            delete widget._hiddenType;
        }
        if (widget._hiddenComputeSize) {
            widget.computeSize = widget._hiddenComputeSize;
            delete widget._hiddenComputeSize;
        } else {
            delete widget.computeSize;
        }
    } else {
        if (widget._hiddenType === undefined) {
            widget._hiddenType = widget.type;
            widget._hiddenComputeSize = widget.computeSize;
        }
        widget.type = "hidden";
        widget.computeSize = () => [0, -4];
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
    const hr = "─".repeat(46);

    lines.push(`▸ ${i.name}`);
    if (i.description) {
        lines.push(`  ${i.description}`);
    }
    lines.push("");
    lines.push(hr);

    /* Model files */
    lines.push(`  model    ${i.diffusion_model}`);
    lines.push(`  clip     ${i.clip_type}`);
    lines.push(`  vae      ${i.vae}`);

    /* Recommended settings */
    lines.push("");
    lines.push(hr);
    lines.push("  Recommended settings");
    lines.push(hr);
    lines.push(`  sampler    ${i.sampler} / ${i.scheduler}`);
    lines.push(`  steps      ${i.steps}`);
    lines.push(`  cfg        ${i.cfg}`);
    if (i.guidance > 0) {
        lines.push(`  guidance   ${i.guidance} (auto-applied for Flux)`);
    }
    lines.push(`  negative   ${i.negative_prompt_supported ? "supported" : "not used (Flux)"}`);

    if (i.info_text) {
        lines.push("");
        lines.push(`  ${i.info_text}`);
    }

    /* Warnings (only shown if any) */
    const allWarnings = [];
    if (i.missing_files?.length) {
        allWarnings.push(`Missing files: ${i.missing_files.join(", ")}`);
    }
    if (warnings && warnings.length) {
        allWarnings.push(...warnings);
    }
    if (allWarnings.length) {
        lines.push("");
        lines.push(hr);
        lines.push("  Warnings");
        lines.push(hr);
        allWarnings.forEach(w => lines.push(`  • ${w}`));
    }

    return lines.join("\n");
}

/* ─── Ensure text widget exists on node ─── */
function getOrCreateTextWidget(node) {
    let w = node.widgets?.find(w => w.name === "_tlms_info");
    if (w) return w;

    try {
        const widgetData = ComfyWidgets["STRING"](node, "_tlms_info", ["STRING", { multiline: true }], app);
        w = widgetData.widget;
        w.serialize = false;
        if (!w.value) w.value = "";

        /* Style the DOM element if available (ComfyUI V2 may not create inputEl). */
        if (w.inputEl) {
            try {
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
            } catch (e) { /* ignore styling errors */ }
        }
        return w;
    } catch (e) {
        console.warn("[TLMS] Could not create info widget:", e);
        return null;
    }
}

/* ─── Show info text in node ─── */
function showText(node, text) {
    const w = getOrCreateTextWidget(node);
    if (!w) return;
    w.value = text;
    if (w.inputEl) {
        try {
            w.inputEl.value = text;
            w.inputEl.style.height = "auto";
            w.inputEl.style.height = w.inputEl.scrollHeight + "px";
        } catch (e) { /* ignore DOM errors */ }
    }
    requestAnimationFrame(() => {
        if (node.computeSize) {
            const sz = node.computeSize();
            node.size[0] = Math.max(node.size[0], sz[0]);
            node.size[1] = Math.max(node.size[1], sz[1]);
        }
        node.setDirtyCanvas?.(true, true);
    });
}

/* ═══ Extension ═══ */
app.registerExtension({
    name: "Maxomarai.TheLastModelSwitcher",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "TheLastModelSwitcher") return;

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

                /* Update labels and widget visibility based on model type */
                const infoForLabels = {
                    is_flux: vals.is_flux,
                    guidance: parseFloat(vals.guidance_value) || 0,
                    negative_prompt_supported: vals.negative_prompt_supported !== false,
                };
                if (this._updateForModelType) this._updateForModelType(infoForLabels);

                /* Trigger Vue reactivity for output label mutations.
                 * Must use in-place splice (not array reassignment). */
                const snapshot = [...this.outputs];
                this.outputs.splice(0, this.outputs.length, ...snapshot);
                this.graph?.trigger?.("node:slot-label:changed", {
                    nodeId: this.id,
                    slotType: 1,
                });
                pushValuesToConnectedNodes(this, vals);
            }
        };
    },

    nodeCreated(node) {
        if (node.comfyClass !== "TheLastModelSwitcher" && node.type !== "TheLastModelSwitcher") return;

        /* Wider default - fits prompt fields and info panel comfortably */
        node.size[0] = Math.max(node.size[0], 440);

        /* ─── Welcome text ─── */
        requestAnimationFrame(() => {
            const welcome = [
                "▸ The Last Model Switcher",
                "  by Maxomarai",
                "",
                "──────────────────────────────────────────────",
                "  Quick start",
                "──────────────────────────────────────────────",
                "",
                "  1. Select a model from the dropdown above.",
                "  2. Write your prompt(s).",
                "  3. Connect the outputs:",
                "",
                "     model     →  KSampler",
                "     vae       →  VAE Decode",
                "     positive  →  KSampler (positive)",
                "     negative  →  KSampler (negative)",
                "     width     →  EmptyLatentImage",
                "     height    →  EmptyLatentImage",
                "     steps     →  KSampler",
                "     cfg       →  KSampler",
                "     seed      →  KSampler",
                "",
                "  Everything else is automatic.",
                "  FluxGuidance is baked into the positive",
                "  conditioning for Flux models.",
                "",
                "──────────────────────────────────────────────",
                "  Tools on this node",
                "──────────────────────────────────────────────",
                "",
                "  AI Identify Model   Auto-detect optimal settings",
                "  AI Enhance Prompt   Improve your prompt with AI",
                "  Scan for Models     Add newly-downloaded models",
                "  New Random Seed     Fresh random seed",
                "  Reuse Last Seed     Recall the previous seed",
                "  AI Settings         Configure provider",
                "  Test AI Connection  Verify your AI setup",
                "  Edit Presets File   Show presets.json path",
                "  Reload Presets      Reload after manual edits",
            ].join("\n");
            if (!getName(node)) {
                showText(node, welcome);
            }
        });

        /* ─── Polling: detect widget value changes ─── */
        let lastState = {
            model: "", resolution: "", megapixels: "", clip: "",
            width: "", height: "", steps: "", cfg: "", guidance: "", seed: "",
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

        /* Update node appearance based on selected model type:
         *  - Output labels: "positive (+guidance X)" for Flux
         *  - Hide guidance widget for non-Flux models
         *  - Hide negative prompt for Flux models (it's ignored)
         * Stored on node so onExecuted can also call it. */
        node._updateForModelType = updateForModelType;
        function updateForModelType(info) {
            if (!info) return;
            const isFlux = info.is_flux;
            const guidanceVal = info.guidance || 0;
            const negSupported = info.negative_prompt_supported !== false && !isFlux;

            /* Update output labels */
            if (node.outputs) {
                for (let i = 0; i < node.outputs.length; i++) {
                    const out = node.outputs[i];
                    const baseName = OUTPUT_LABELS[i];
                    if (baseName === "positive") {
                        out.label = isFlux && guidanceVal > 0
                            ? `positive (+guidance ${guidanceVal})`
                            : "positive";
                    } else if (baseName === "negative") {
                        out.label = negSupported ? "negative" : "negative (unused)";
                    }
                }
            }

            /* Hide/show widgets based on relevance */
            const guidanceW = node.widgets?.find(w => w.name === "guidance");
            const negPromptW = node.widgets?.find(w => w.name === "negative_prompt");
            toggleWidget(guidanceW, isFlux);
            toggleWidget(negPromptW, negSupported);

            /* Trigger Vue reactivity for output labels.
             * ComfyUI V2 wraps outputs in shallowReactive - property
             * mutations on items are not tracked. Splice in-place to
             * force a structural change that Vue detects. */
            if (node.outputs) {
                const snapshot = [...node.outputs];
                node.outputs.splice(0, node.outputs.length, ...snapshot);
            }
            node.graph?.trigger?.("node:slot-label:changed", {
                nodeId: node.id,
                slotType: 1,
            });

            /* Recompute node size to account for hidden widgets */
            if (node.computeSize) node.setSize(node.computeSize());
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

                        updateForModelType(i);
                        showText(node, formatInfo(i, checkConnections(node, i)));
                        pushCurrentValues();
                    } catch (e) { showText(node, "Error: " + e.message); }
                }, 100);
            } else if (valuesDidChange) {
                pushCurrentValues();
            }
        }

        /* Poll for widget value changes (500ms) */
        const pollInterval = setInterval(() => {
            if (!node.graph) { clearInterval(pollInterval); return; }
            const cur = getCurrentState();
            if (stateChanged(cur, lastState)) {
                const prev = { ...lastState };
                lastState = cur;
                handleChange(cur, prev);
            }
        }, 500);

        /* Poll for connection changes (2s) -> update warnings */
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

        /* Clean up intervals when node is removed */
        const onRemoved = node.onRemoved;
        node.onRemoved = function () {
            clearInterval(pollInterval);
            clearInterval(connectionPoll);
            onRemoved?.apply(this, arguments);
        };

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

        /* Custom instruction field (optional, overrides style if filled).
         * Guarded against duplicate creation when nodeCreated fires on
         * workflow load. */
        if (!node.widgets?.find(w => w.name === "enhance_instruction")) {
            try {
                const customWidget = ComfyWidgets["STRING"](
                    node, "enhance_instruction",
                    ["STRING", { multiline: false, placeholder: "Custom instruction (optional, overrides style)" }],
                    app
                );
                const w = customWidget.widget;
                w.serialize = false;
                if (!w.value) w.value = "";

                /* In ComfyUI V2, inputEl may not exist or be attached yet.
                 * Apply DOM styling if available, otherwise skip silently. */
                if (w.inputEl) {
                    try {
                        w.inputEl.placeholder = "Custom instruction (optional, overrides style)";
                        w.inputEl.style.fontSize = "10px";
                        w.inputEl.style.opacity = "0.8";
                    } catch (e) { /* ignore styling errors */ }
                }
            } catch (e) {
                console.warn("[TLMS] Could not create enhance_instruction widget:", e);
            }
        }

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

        /* Copy/Paste seed is handled via ComfyUI's native right-click menu
         * on the seed widget. Show Model Info is redundant - info updates
         * live in the info panel when model changes. Removed for clarity. */

        /* (f) Scan for New Models */
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

        /* Helper: save a setting via ComfyUI's settings API */
        async function saveSetting(key, value) {
            try {
                await fetch(`/settings/${key}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(value),
                });
            } catch (e) {}
        }

        /* (h) AI Settings */
        node.addWidget("button", "AI Settings", "", async () => {
            let current = {};
            try {
                const r = await fetch("/the_last_model_switcher/ai_settings");
                if (r.ok) current = await r.json();
            } catch (e) {}

            const curProvider = current.provider || "anthropic";
            const curModel = current.model || "";
            const curHasKey = current.has_key;
            const curBaseUrl = current.base_url || "";

            /* Step 1: Choose provider */
            const providerInput = prompt(
                "AI PROVIDER\n\n" +
                "Choose:\n" +
                "  anthropic  - Claude (cloud, needs API key)\n" +
                "  openai     - GPT models (cloud, needs API key)\n" +
                "  ollama     - Local LLM via Ollama (free, no key)\n" +
                "  custom     - Any OpenAI-compatible endpoint\n\n" +
                `Current: ${curProvider} (key ${curHasKey ? "configured" : "not set"})\n` +
                "(Leave blank to keep current)",
                curProvider
            );
            if (providerInput === null) return;

            const provider = providerInput.trim().toLowerCase() || curProvider;
            const validProviders = ["anthropic", "openai", "ollama", "custom"];
            if (!validProviders.includes(provider)) {
                showText(node, `Invalid provider: "${provider}"\nValid: ${validProviders.join(", ")}`);
                return;
            }
            await saveSetting("tlms.ai_provider", provider);

            /* Step 2: API key (skip for local providers) */
            let apiKeyUpdated = false;
            const needsKey = provider === "anthropic" || provider === "openai";
            if (needsKey) {
                const apiKeyInput = prompt(
                    `API KEY for ${provider}\n\n` +
                    (provider === "anthropic"
                        ? "Get yours at console.anthropic.com"
                        : "Get yours at platform.openai.com/api-keys") +
                    "\n\n(Leave blank to keep current key)"
                );
                if (apiKeyInput === null) return;
                if (apiKeyInput.trim()) {
                    await saveSetting("tlms.ai_api_key", apiKeyInput.trim());
                    apiKeyUpdated = true;
                }
            }

            /* Step 3: Model */
            const defaultModelExamples = {
                anthropic: "e.g. claude-haiku-4-5-20251001, claude-sonnet-4-5",
                openai: "e.g. gpt-4o-mini, gpt-4o",
                ollama: "e.g. llama3.2, qwen2.5, mistral",
                custom: "model name per your endpoint",
            };
            const modelInput = prompt(
                `MODEL NAME\n\n${defaultModelExamples[provider]}\n\n` +
                "(Leave blank to keep current)",
                curModel
            );
            if (modelInput === null) return;
            if (modelInput.trim()) {
                await saveSetting("tlms.ai_model", modelInput.trim());
            }

            /* Step 4: Base URL (for ollama/custom) */
            let baseUrlUpdated = false;
            if (provider === "ollama" || provider === "custom") {
                const defaultUrl = "http://localhost:11434/v1/chat/completions";
                const baseUrlInput = prompt(
                    `BASE URL\n\n` +
                    (provider === "ollama"
                        ? `Default Ollama URL: ${defaultUrl}\n(Ollama usually runs on localhost:11434)`
                        : "Enter the OpenAI-compatible endpoint URL") +
                    "\n\n(Leave blank to use default)",
                    curBaseUrl || defaultUrl
                );
                if (baseUrlInput !== null && baseUrlInput.trim()) {
                    await saveSetting("tlms.ai_base_url", baseUrlInput.trim());
                    baseUrlUpdated = true;
                }
            }

            /* Summary */
            const lines = [];
            lines.push("AI SETTINGS SAVED");
            lines.push("=".repeat(48));
            lines.push("");
            lines.push(`  Provider: ${provider}`);
            if (needsKey) {
                lines.push(`  API Key:  ${apiKeyUpdated ? "updated" : (curHasKey ? "unchanged" : "not set")}`);
            } else {
                lines.push(`  API Key:  not needed (local provider)`);
            }
            lines.push(`  Model:    ${modelInput.trim() || curModel}`);
            if (provider === "ollama" || provider === "custom") {
                lines.push(`  URL:      ${baseUrlUpdated ? "updated" : "default/unchanged"}`);
            }
            lines.push("");
            if (provider === "ollama") {
                lines.push("Make sure Ollama is running:");
                lines.push("  $ ollama serve");
                lines.push("And the model is pulled:");
                lines.push(`  $ ollama pull ${modelInput.trim() || "llama3.2"}`);
                lines.push("");
            }
            lines.push("Click 'Test AI Connection' to verify it works.");
            showText(node, lines.join("\n"));
        }, { serialize: false });

        /* (h2) Test AI Connection */
        node.addWidget("button", "Test AI Connection", "", async () => {
            showText(node, "Testing AI connection...");
            try {
                const r = await fetch("/the_last_model_switcher/ai_test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                });
                const d = await r.json();
                const lines = [];
                if (d.ok) {
                    lines.push("AI CONNECTION OK");
                    lines.push("=".repeat(48));
                    lines.push("");
                    lines.push(`  Provider: ${d.provider}`);
                    lines.push(`  Model:    ${d.model}`);
                    lines.push(`  Response: ${d.response}`);
                    lines.push("");
                    lines.push("AI features are ready to use.");
                } else {
                    lines.push("AI CONNECTION FAILED");
                    lines.push("=".repeat(48));
                    lines.push("");
                    lines.push(d.error || "Unknown error");
                    lines.push("");
                    lines.push("Click 'AI Settings' to check your configuration.");
                }
                showText(node, lines.join("\n"));
            } catch (e) {
                showText(node, "Test failed: " + e.message);
            }
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
        /* Ensure info widget exists before reorder */
        getOrCreateTextWidget(node);

        /*
         * Declarative widget order. Each name is looked up in node.widgets.
         * Widgets found are placed in this order. Any widgets NOT in this
         * list are appended at the end (nothing is ever lost).
         */
        const DESIRED_ORDER = [
            /* Model selection */
            "model",
            "AI Identify Model",
            "Scan for New Models",

            /* Prompt tools */
            "enhance_style",
            "enhance_instruction",
            "AI Enhance Prompt",
            "Apply Enhanced Prompt",

            /* Prompts */
            "positive_prompt",
            "negative_prompt",

            /* Generation settings */
            "width",
            "height",
            "steps",
            "cfg",
            "guidance",

            /* Seed + tools (near generation settings since they affect output) */
            "seed",
            "New Random Seed",
            "Reuse Last Seed",

            /* Advanced */
            "weight_dtype",

            /* Admin tools */
            "AI Settings",
            "Test AI Connection",
            "Edit Presets File",
            "Reload Presets",

            /* Info panel (always last) */
            "_tlms_info",
        ];

        requestAnimationFrame(() => {
            if (!node.widgets || !node.widgets.length) return;

            const widgetsByName = new Map();
            for (const w of node.widgets) {
                widgetsByName.set(w.name, w);
            }

            const reordered = [];
            const used = new Set();

            /* First pass: widgets in desired order */
            for (const name of DESIRED_ORDER) {
                const w = widgetsByName.get(name);
                if (w && !used.has(w)) {
                    reordered.push(w);
                    used.add(w);
                }
            }

            /* Second pass: any widget not in DESIRED_ORDER (preserves them) */
            for (const w of node.widgets) {
                if (!used.has(w)) {
                    reordered.push(w);
                }
            }

            /* IMPORTANT: ComfyUI V2 wraps node.widgets in Vue's shallowReactive.
             * Assigning node.widgets = [...] is a no-op or fails to trigger
             * reactivity. Must mutate the existing array in place.
             * See: rgthree's moveArrayItem pattern. */
            node.widgets.splice(0, node.widgets.length, ...reordered);

            if (node.computeSize) node.setSize(node.computeSize());
        });
    },
});
