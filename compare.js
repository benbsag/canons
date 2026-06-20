// ---------------------------------------------------------------------------
// Wine Cave — comparison engine (Stage 1: model + prompt + parser)
//
// Compares 2+ wines across five dimensions (grape, terroir, vinification,
// tasting, reputation) in a single combined pass. Pure: no DOM, no storage, no
// network — so it can be unit-tested in Node and so the UI / network layers can
// reuse it. The actual API call reuses research-api.js + the research-wine edge
// function (it just relays a prompt); this file only builds the prompt and
// parses the reply, mirroring research.js.
//
// See COMPARE_SPEC.md for the full design. Exposed on window.WineCave.compare.
// ---------------------------------------------------------------------------

(function () {
  const WineCave = window.WineCave;
  const { CONFIDENCE } = WineCave;
  const research = WineCave.research; // shared JSON/confidence helpers

  // The five comparison dimensions, in display order. `key` is stable (used in
  // the JSON + UI); `label` is shown to the user.
  const COMPARE_DIMENSIONS = [
    { key: "grape", label: "grape variety" },
    { key: "terroir", label: "terroir" },
    { key: "vinification", label: "vinification" },
    { key: "tasting", label: "tasting profile" },
    { key: "reputation", label: "reputation" },
  ];
  const DIM_KEYS = COMPARE_DIMENSIONS.map((d) => d.key);

  function makeComparisonId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return "cmp_" + crypto.randomUUID();
    }
    return "cmp_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // -------------------------------------------------------------------------
  // Entries & data model
  // -------------------------------------------------------------------------

  /**
   * Map a catalogue wine onto the comparison dimensions we already know, so the
   * prompt can seed cellar wines instead of re-researching them. Reputation is
   * seeded from expert_context but is expected to be refreshed comparatively.
   */
  function cellarSeed(wine) {
    const tf = (wine && wine.tech_facts) || {};
    const tn = (wine && wine.tasting_notes) || {};
    const terroir = [tf.terroir_type, tf.region, tf.country].filter(Boolean).join(", ");
    return {
      grape: tf.grape_varietals || "",
      terroir,
      vinification: (wine && wine.vinification) || "",
      tasting: tn.notes || "",
      reputation: (wine && wine.expert_context) || "",
    };
  }

  /** A comparison entry referencing a wine already in the cellar. */
  function entryFromCellarWine(wine) {
    return {
      source: "cellar",
      wine_id: wine.id,
      producer: wine.producer || "",
      cuvee: wine.cuvee || "",
      vintage: wine.vintage || null,
    };
  }

  /** A comparison entry for a wine not (yet) in the cellar. */
  function entryFromExternal(p) {
    p = p || {};
    return {
      source: "external",
      producer: p.producer || "",
      cuvee: p.cuvee || "",
      vintage: p.vintage || null,
      added_to_cellar_id: null,
    };
  }

  function emptyField() {
    return { value: "", confidence: CONFIDENCE.NOT_FOUND };
  }

  function emptyDims() {
    const dims = { sources: [] };
    for (const key of DIM_KEYS) dims[key] = emptyField();
    return dims;
  }

  /** Short label for titles: producer, falling back to cuvée. */
  function shortLabel(entry) {
    return (entry && (entry.producer || entry.cuvee)) || "wine";
  }

  /** Full label for prompts: "Producer — Cuvée (Vintage)". */
  function fullLabel(entry) {
    const name = [entry.producer, entry.cuvee].filter(Boolean).join(" — ");
    const v = entry.vintage ? ` (${entry.vintage})` : "";
    return (name || "unknown wine") + v;
  }

  /** "A vs B", or "A vs B (+2)" for larger sets. */
  function comparisonTitle(entries) {
    const labels = (entries || []).map(shortLabel);
    if (labels.length <= 2) return labels.join(" vs ") || "comparison";
    return labels.slice(0, 2).join(" vs ") + ` (+${labels.length - 2})`;
  }

  /** Write a parsed dims list onto entries (by index), filling gaps. */
  function attachDims(entries, dimsList) {
    entries.forEach((e, i) => {
      e.dims = (dimsList && dimsList[i]) || emptyDims();
    });
    return entries;
  }

  /**
   * Build a Comparison object from entries + their parsed dims.
   * @param {Entry[]} entries
   * @param {Object[]} dimsList  aligned to entries by index
   * @param {string} [now] ISO (injectable for tests)
   */
  function createComparison(entries, dimsList, now) {
    const t = now || new Date().toISOString();
    attachDims(entries, dimsList);
    return {
      id: makeComparisonId(),
      title: comparisonTitle(entries),
      created_at: t,
      updated_at: t,
      wines: entries,
    };
  }

  // -------------------------------------------------------------------------
  // Prompt builder (single combined pass over all wines)
  // -------------------------------------------------------------------------

  /**
   * @param {{producer,cuvee,vintage,known?}[]} items
   *   `known` is a cellarSeed() result for cellar wines, or null/undefined for
   *   outside wines (which get searched from scratch).
   * @returns {string}
   */
  function buildComparePrompt(items) {
    const block = [];
    items.forEach((w, i) => {
      block.push(`Wine ${i + 1}:`);
      block.push(`- Producer: ${w.producer || "(unknown)"}`);
      block.push(`- Cuvée: ${w.cuvee || "(unknown)"}`);
      block.push(`- Vintage: ${w.vintage || "NV / unknown"}`);
      if (w.known) {
        const k = w.known;
        const facts = [];
        if (k.grape) facts.push(`  · grape: ${k.grape}`);
        if (k.terroir) facts.push(`  · terroir: ${k.terroir}`);
        if (k.vinification) facts.push(`  · vinification: ${k.vinification}`);
        if (k.tasting) facts.push(`  · tasting: ${k.tasting}`);
        if (k.reputation) facts.push(`  · reputation (existing note): ${k.reputation}`);
        if (facts.length) {
          block.push(
            "  Known facts (already on file — treat as correct, don't re-research; spend effort on reputation + the relative comparison):",
          );
          block.push(...facts);
        }
      }
      block.push("");
    });

    const shape = {
      wines: [
        {
          producer: "echoed / corrected producer",
          cuvee: "echoed / corrected cuvée",
          vintage: "echoed / corrected vintage or NV",
          grape: { value: "grape variety / blend", confidence: "sourced | inferred | not_found" },
          terroir: { value: "region, soils, climate, site character", confidence: "..." },
          vinification: { value: "vessel, maceration, élevage, dosage…", confidence: "..." },
          tasting: { value: "aromatic + palate profile, structure, style", confidence: "..." },
          reputation: {
            value: "standing in the hierarchy, status, rarity, how sought-after, rough price",
            confidence: "...",
          },
          sources: ["https://real-url-you-used"],
        },
      ],
    };

    return [
      "You are comparing specific bottles of wine for a knowledgeable collector.",
      "Compare the wines below across five dimensions and reply with ONLY a JSON",
      "object — no commentary, no markdown fences, just the JSON.",
      "",
      "Wines (keep them in this exact order in your reply):",
      block.join("\n").trimEnd(),
      "",
      "Compare across these dimensions, each written *relative to the other",
      "wines in this set* (not as standalone notes):",
      "1. grape — grape variety / blend.",
      "2. terroir — region, soils, climate, site.",
      "3. vinification — how the wine is made.",
      "4. tasting — aromatic and palate profile, structure, style.",
      "5. reputation — where it sits in the hierarchy, its status, rarity, how",
      "   sought-after it is, and rough price/scarcity. This is the comparative",
      "   heart of the task — be specific about how these wines rank against",
      "   one another.",
      "",
      "Rules:",
      "- Use only concrete, verifiable facts; never invent details.",
      "- Where 'known facts' are given for a wine, treat them as correct and do",
      "  not re-derive them — focus on reputation and the relative comparison.",
      '- For every field include "confidence": "sourced" (found in a reliable',
      '  source), "inferred" (reasoned), or "not_found" (unknown). If not found,',
      '  still include the field with value "" and confidence "not_found".',
      "- Keep each value concise — one to three sentences.",
      '- "sources" for each wine must be real URLs you actually consulted.',
      "- Return the wines in the SAME ORDER as listed above.",
      "",
      "Return exactly this JSON shape:",
      JSON.stringify(shape, null, 2),
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Parser
  // -------------------------------------------------------------------------

  /**
   * Parse a combined comparison reply into a dims list aligned by index.
   * @param {string} text   raw assistant text (JSON, possibly fenced)
   * @param {number} [count] expected number of wines (pads/truncates to this)
   * @returns {Object[]}  one dims object per wine
   */
  function parseCompareResponse(text, count) {
    const raw = research.extractJsonObject(text);
    const arr = raw && Array.isArray(raw.wines)
      ? raw.wines
      : Array.isArray(raw)
        ? raw
        : null;
    if (!arr) {
      throw new Error("That doesn't look like the comparison JSON the request asked for.");
    }
    const n = typeof count === "number" && count > 0 ? count : arr.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const w = arr[i] || {};
      const dims = { sources: research.normalizeSources(w.sources) };
      for (const key of DIM_KEYS) {
        dims[key] = research.normalizeField(w[key]);
      }
      out.push(dims);
    }
    return out;
  }

  window.WineCave.compare = {
    COMPARE_DIMENSIONS,
    DIM_KEYS,
    makeComparisonId,
    cellarSeed,
    entryFromCellarWine,
    entryFromExternal,
    emptyDims,
    shortLabel,
    fullLabel,
    comparisonTitle,
    attachDims,
    createComparison,
    buildComparePrompt,
    parseCompareResponse,
  };
})();
