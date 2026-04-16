import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

/* ═══════════════════════════════════════════════════════════
   THE LAST MODEL SWITCHER by Maxomarai
   ═══════════════════════════════════════════════════════════ */

/* ─── Helpers ─── */
function gcd(a,b){return b===0?a:gcd(b,a%b)}
function aspectStr(w,h){const g=gcd(w,h);return `${w/g}:${h/g}`}

/* ─── Output slot index -> value key mapping ─── */
const OUTPUT_MAP = {
    3: "width",
    4: "height",
    5: "steps",
    6: "cfg",
    7: "guidance",
};

/* ─── Find a widget by name (handles DynamicCombo prefix variants) ─── */
function findWidget(node, name){
    if(!node.widgets) return null;
    /* Try exact match first, then prefix variants */
    const candidates = [name, `model.${name}`, name.replace("model.","")];
    for(const w of node.widgets){
        if(candidates.includes(w.name)) return w;
    }
    /* Fallback: partial match (widget name ends with the target name) */
    for(const w of node.widgets){
        if(w.name && w.name.endsWith(`.${name}`)) return w;
        if(w.name && w.name.endsWith(name)) return w;
    }
    return null;
}

/* ─── Get model name from node ─── */
function getName(node){
    if(node.widgets)for(const w of node.widgets){
        if(w.name==="model"||w.name==="model.model"){
            const v=w.value;
            if(typeof v==="string"&&v)return v.replace(/\s*\[MISSING\]/,"").trim();
            if(typeof v==="object"&&v){const n=v.model||v.value||"";if(n)return String(n).replace(/\s*\[MISSING\]/,"").trim()}
        }
    }
    if(node.widgets_values&&typeof node.widgets_values[0]==="string"&&node.widgets_values[0].length>3){
        return node.widgets_values[0].replace(/\s*\[MISSING\]/,"").trim();
    }
    return "";
}

/* ─── Get selected resolution from node ─── */
function getResolution(node){
    const w = findWidget(node, "resolution");
    return w ? w.value : "";
}

/* ─── Get selected megapixels from node ─── */
function getMegapixels(node){
    const w = findWidget(node, "megapixels");
    return w ? w.value : "";
}

/* ─── Parse megapixel string like "1.0 MP" -> 1.0 ─── */
function parseMp(s){
    if(!s) return 0;
    const m = String(s).match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : 0;
}

/* ─── Scale resolution by megapixels ─── */
function scaleResolution(baseW, baseH, mp){
    if(!mp || mp <= 0) return [baseW, baseH];
    const aspect = baseW / baseH;
    const total = mp * 1024 * 1024;
    const h = Math.sqrt(total / aspect);
    const width = Math.round((h * aspect) / 8) * 8;
    const height = Math.round(h / 8) * 8;
    return [width, height];
}

/* ─── Fetch API ─── */
async function fetchInfo(name){
    const r=await fetch(`/the_last_model_switcher/preset_info?name=${encodeURIComponent(name)}`);
    if(!r.ok)throw new Error("Not found: "+name);
    return r.json();
}

/* ─── Set a widget value on a node by name ─── */
function setWidget(node, name, value){
    if(!node.widgets) return;
    for(const w of node.widgets){
        if(w.name===name){
            w.value = value;
            w.callback?.(value);
            return;
        }
    }
}

/* ─── Resolve width/height from preset info + resolution + megapixels ─── */
function resolveWidthHeight(info, resName, mpStr){
    let baseW = 1024, baseH = 1024;
    if(resName && info.resolutions && info.resolutions[resName]){
        [baseW, baseH] = info.resolutions[resName];
    } else if(info.default_resolution && info.resolutions[info.default_resolution]){
        [baseW, baseH] = info.resolutions[info.default_resolution];
    }
    const mp = parseMp(mpStr);
    if(mp > 0){
        [baseW, baseH] = scaleResolution(baseW, baseH, mp);
    }
    return [baseW, baseH];
}

/* ─── Update only width/height (for resolution/megapixels changes) ─── */
function updateResolution(node, info, resName, mpStr){
    const [w, h] = resolveWidthHeight(info, resName, mpStr);
    setWidget(node, "width", w);
    setWidget(node, "height", h);
    node.setDirtyCanvas(true, true);
}

/* ─── Full populate: width/height + steps/cfg/guidance (for model changes) ─── */
function populateAll(node, info, resName, mpStr){
    const [w, h] = resolveWidthHeight(info, resName, mpStr);
    setWidget(node, "width", w);
    setWidget(node, "height", h);
    setWidget(node, "steps", info.steps);
    setWidget(node, "cfg", info.cfg);
    setWidget(node, "guidance", info.guidance || 0);
    node.setDirtyCanvas(true, true);
}

/* ─── Push values to all connected downstream nodes ─── */
function pushValuesToConnectedNodes(node, vals){
    if(!node.outputs || !vals) return;
    const graph = node.graph || app.graph;
    if(!graph) return;

    for(const [slotIdx, valKey] of Object.entries(OUTPUT_MAP)){
        const output = node.outputs[parseInt(slotIdx)];
        if(!output || !output.links || !output.links.length) continue;
        const value = vals[valKey];
        if(value === undefined) continue;

        for(const linkId of output.links){
            const link = graph.links?.get ? graph.links.get(linkId) : graph.links?.[linkId];
            if(!link) continue;

            const targetNode = graph.getNodeById(link.target_id);
            if(!targetNode || !targetNode.widgets) continue;

            const targetInput = targetNode.inputs?.[link.target_slot];
            if(!targetInput) continue;

            for(const widget of targetNode.widgets){
                if(widget.name === targetInput.name){
                    const numVal = Number(value);
                    const newVal = isNaN(numVal) ? value : numVal;
                    if(widget.value !== newVal){
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

/* ─── Format info as readable text ─── */
function formatInfo(i){
    const lines=[];
    const sep = "=".repeat(48);
    const sep2 = "~".repeat(48);

    lines.push(sep);
    lines.push("  THE LAST MODEL SWITCHER");
    lines.push(`  ${i.name}`);
    lines.push(sep);
    lines.push("");
    if(i.description)lines.push(i.description);
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
    if(i.is_flux)lines.push("  ModelSamplingFlux: auto-applied");
    lines.push(`  Neg prompt: ${i.negative_prompt_supported ? "supported" : "not used"}`);

    if(i.info_text){
        lines.push("");
        lines.push(`  ${i.info_text}`);
    }

    const clips=Object.keys(i.compatible_clips||{});
    if(clips.length){
        lines.push("");
        lines.push("  Compatible CLIPs:");
        clips.forEach(c=>lines.push(`    - ${c}`));
    }

    if(i.missing_files?.length){
        lines.push("");
        lines.push(`  WARNING: Missing: ${i.missing_files.join(", ")}`);
    }

    lines.push("");
    lines.push(sep);
    lines.push("  BY MAXOMARAI");
    lines.push(sep);
    return lines.join("\n");
}

/* ─── Ensure text widget exists on node ─── */
function getOrCreateTextWidget(node){
    let w = node.widgets?.find(w=>w.name==="_tlms_info");
    if(w) return w;

    const widgetData = ComfyWidgets["STRING"](node, "_tlms_info", ["STRING", {multiline:true}], app);
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
function showText(node, text){
    const w = getOrCreateTextWidget(node);
    w.value = text;
    w.inputEl.value = text;
    w.inputEl.style.height = "auto";
    w.inputEl.style.height = w.inputEl.scrollHeight + "px";
    requestAnimationFrame(()=>{
        const sz = node.computeSize();
        node.size[0] = Math.max(node.size[0], sz[0]);
        node.size[1] = Math.max(node.size[1], sz[1]);
        node.setDirtyCanvas(true, true);
    });
}

/* ═══ Extension ═══ */
app.registerExtension({
    name:"Maxomarai.TheLastModelSwitcher",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if(nodeData.name!=="TheLastModelSwitcher") return;

        const OUTPUT_LABELS = ["MODEL","CLIP","VAE","width","height","steps","cfg","guidance"];

        const ox=nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted=function(msg){
            ox?.apply(this,arguments);
            if(msg?.text?.[0]){
                showText(this, msg.text[0]);
            }
            /* Update output slot labels with values & push to connected nodes */
            const vals = msg?.output_values?.[0];
            if(vals && this.outputs){
                for(let i=0; i<this.outputs.length; i++){
                    const out = this.outputs[i];
                    const baseName = OUTPUT_LABELS[i];
                    if(baseName && vals[baseName] !== undefined){
                        out.label = `${baseName}: ${vals[baseName]}`;
                    }
                }
                this.setDirtyCanvas(true, true);
                pushValuesToConnectedNodes(this, vals);
            }
        };
    },

    nodeCreated(node) {
        if(node.comfyClass!=="TheLastModelSwitcher" && node.type!=="TheLastModelSwitcher") return;

        /* Default wider size */
        node.size[0] = Math.max(node.size[0], 380);

        let timer=null;
        let lastModelName = "";

        const ow=node.onWidgetChanged;
        node.onWidgetChanged=function(name,value){
            ow?.apply(this,arguments);

            /*
             * DynamicCombo fires onWidgetChanged for ANY sub-input change
             * (model, clip_variant, resolution, megapixels) - often with
             * just name="model". We detect what actually changed by tracking
             * the model name: same name = sub-input change (res/mp/clip),
             * different name = actual model switch.
             */
            const isRelevant = name==="model" || name==="model.model"
                || name==="model.resolution" || name==="resolution"
                || name==="model.megapixels" || name==="megapixels"
                || name==="model.clip_variant" || name==="clip_variant";

            if(isRelevant){
                clearTimeout(timer);
                timer=setTimeout(async()=>{
                    const n=getName(node);if(!n)return;
                    try{
                        const i=await fetchInfo(n);
                        const resName = getResolution(node);
                        const mpStr = getMegapixels(node);
                        console.log("[TLMS] Widget changed:", name, "| model:", n, "| resolution:", resName, "| megapixels:", mpStr);

                        const actualModelChanged = (n !== lastModelName);
                        lastModelName = n;

                        if(actualModelChanged){
                            /* Model changed -> update everything */
                            populateAll(node, i, resName, mpStr);
                        } else {
                            /* Sub-input changed (resolution/megapixels/clip) -> update width/height only */
                            updateResolution(node, i, resName, mpStr);
                        }

                        showText(node, formatInfo(i));
                    }catch(e){showText(node,"Error: "+e.message)}
                },300);
            }
        };

        node.addWidget("button","Show Model Info","",async()=>{
            const n=getName(node);
            if(!n){showText(node,"No model selected");return}
            showText(node,"Loading...");
            try{const i=await fetchInfo(n);showText(node,formatInfo(i))}
            catch(e){showText(node,"Error: "+e.message)}
        },{serialize:false});

        node.addWidget("button","Reload Presets","",async()=>{
            try{
                const r=await fetch("/the_last_model_switcher/reload");
                const d=await r.json();
                showText(node,`Presets reloaded: ${d.count} models\n\n${d.names.join("\n")}\n\n(Restart ComfyUI to update dropdown)`);
            }catch(e){showText(node,"Error reloading: "+e.message)}
        },{serialize:false});
    },
});
