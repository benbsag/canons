// ---------------------------------------------------------------------------
// Wine Cave — research layer (Phase B)
//
// "Dossier paste-back" engine: the app is a static, local-first page with no
// server, so it cannot research a wine on its own. Instead it (1) builds a
// ready-made research request for a specific bottle, which the user runs in an
// assistant like Claude or ChatGPT, and (2) parses the JSON the user pastes
// back, mapping each fact onto the wine with a per-field confidence flag and a
// list of sources.
//
// Everything here is pure (no DOM, no storage) so it can be unit-tested in
// Node and so a different engine (e.g. a direct API call) could reuse it later.
// Exposed on window.WineCave.research.
// ---------------------------------------------------------------------------

(function () {
  const { CONFIDENCE } = window.WineCave;

  // The fields research can fill or correct, in display order. `key` is stable
  // and used for confidence_flags; `label` is shown in the preview UI. The
  // identity fields (producer/cuvée/vintage) are included so research can fix
  // spelling and accent errors in what the user typed.
  const RESEARCH_FIELDS = [
    { key: "producer", label: "producer" },
    { key: "cuvee", label: "cuvée" },
    { key: "vintage", label: "vintage" },
    { key: "region", label: "region" },
    { key: "country", label: "country" },
    { key: "colour", label: "colour" },
    { key: "terroir_type", label: "terroir type" },
    { key: "grape_varietals", label: "grape varietals" },
    { key: "vinification", label: "vinification" },
    { key: "tasting_notes", label: "tasting notes" },
    { key: "drinking_window", label: "drinking window" },
    { key: "expert_context", label: "context" },
  ];

  const FIELD_KEYS = RESEARCH_FIELDS.map((f) => f.key);

  // Read/write a research field's value on a wine. Keeps the mapping between
  // the flat research keys and the wine's nested shape in one place.
  function getWineFieldValue(wine, key) {
    switch (key) {
      case "producer":
        return wine.producer || "";
      case "cuvee":
        return wine.cuvee || "";
      case "vintage":
        return wine.vintage || "";
      case "vinification":
        return wine.vinification || "";
      case "expert_context":
        return wine.expert_context || "";
      case "tasting_notes":
        return (wine.tasting_notes && wine.tasting_notes.notes) || "";
      case "drinking_window":
        return (wine.tasting_notes && wine.tasting_notes.drinking_window) || "";
      default:
        return (wine.tech_facts && wine.tech_facts[key]) || "";
    }
  }

  function setWineFieldValue(wine, key, value) {
    switch (key) {
      case "producer":
        wine.producer = value;
        wine.tech_facts = { ...wine.tech_facts, producer: value };
        break;
      case "cuvee":
        wine.cuvee = value;
        break;
      case "vintage":
        wine.vintage = value;
        wine.tech_facts = { ...wine.tech_facts, year: value };
        break;
      case "vinification":
        wine.vinification = value;
        break;
      case "expert_context":
        wine.expert_context = value;
        break;
      case "tasting_notes":
        wine.tasting_notes = { ...wine.tasting_notes, notes: value };
        break;
      case "drinking_window":
        wine.tasting_notes = { ...wine.tasting_notes, drinking_window: value };
        break;
      default:
        wine.tech_facts = { ...wine.tech_facts, [key]: value };
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 1. Build the research request
  // -------------------------------------------------------------------------

  /**
   * Produce the text the user copies into an assistant. Asks for a strict JSON
   * shape, concrete facts only, explicit confidence per field, and real source
   * URLs. @param {Wine} wine @returns {string}
   */
  function buildResearchPrompt(wine) {
    const identity = [
      `- Producer: ${wine.producer || "(unknown)"}`,
      `- Cuvée: ${wine.cuvee || "(unknown)"}`,
      `- Vintage: ${wine.vintage || "NV / unknown"}`,
    ].join("\n");

    const shape = {
      producer: { value: "corrected canonical producer name", confidence: "sourced | inferred | not_found" },
      cuvee: { value: "corrected canonical cuvée name", confidence: "..." },
      vintage: { value: "corrected vintage, or NV", confidence: "..." },
      region: { value: "", confidence: "sourced | inferred | not_found" },
      country: { value: "", confidence: "sourced | inferred | not_found" },
      colour: { value: "rouge / blanc / rosé / orange", confidence: "..." },
      terroir_type: { value: "", confidence: "..." },
      grape_varietals: { value: "", confidence: "..." },
      vinification: { value: "concrete facts only — maceration, élevage, vessel, ageing", confidence: "..." },
      tasting_notes: { value: "", confidence: "..." },
      drinking_window: { value: "e.g. now–2030", confidence: "..." },
      expert_context: {
        value: "subjective context a natural-wine insider would value (see rules)",
        confidence: "...",
      },
      sources: ["https://real-url-you-used"],
    };

    return [
      "You are helping catalogue a specific bottle of wine for a personal cellar.",
      "Research the wine below and reply with ONLY a JSON object — no commentary,",
      "no markdown fences, just the JSON.",
      "",
      "Wine:",
      identity,
      "",
      "Rules:",
      "- Use only concrete, verifiable facts. Never invent details.",
      "- The producer, cuvée and vintage I gave may contain spelling, accent or",
      "  formatting errors. Return the corrected canonical form of each (proper",
      "  accents, diacritics and capitalisation). If already correct, echo it back.",
      '- For every field include a "confidence": "sourced" if you found it in a',
      '  reliable source, "inferred" if reasoned from related facts, or',
      '  "not_found" if you have no reliable information.',
      '- If a fact is not found, still include the field with value "" and',
      '  confidence "not_found".',
      "- Keep vinification and tasting notes factual and concise.",
      '- "expert_context" is the one subjective field. Write 2–4 sentences of the',
      "  context a knowledgeable natural-wine person would care about: where this",
      "  cuvée sits in the producer's lineup, how it compares to peer producers and",
      "  to recent vintages, overall quality and reputation, production volume,",
      "  scarcity and rough price, and notable bars/restaurants/shops known to pour",
      "  or stock it. Ground it in reliable sources, but you may reasonably",
      "  extrapolate where an expert would — mark it \"inferred\" when you do.",
      '- "sources" must be real URLs you actually consulted.',
      "",
      "Return exactly this JSON shape:",
      JSON.stringify(shape, null, 2),
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // 2. Parse the pasted response
  // -------------------------------------------------------------------------

  // Repair the "smart" characters mobile keyboards (notably iOS Smart
  // Punctuation) substitute into pasted text. These break JSON.parse even when
  // the reply looked correct on screen — the usual cause of a paste that works
  // on a Mac but fails on an iPhone. Only ASCII-equivalent substitutions are
  // made, so a JSON object that was already valid is unaffected.
  function normalizeSmartCharacters(s) {
    return s
      // Curly / typographic double quotes → straight "
      .replace(/[“”„‟″‶«»]/g, '"')
      // Curly / typographic single quotes, primes, backticks → straight '
      .replace(/[‘’‚‛′‵´`]/g, "'")
      // Dashes that get "smartened" (en/em/minus) → hyphen
      .replace(/[‐‑‒–—−]/g, "-")
      // Non-breaking / unusual spaces → normal space
      .replace(/[  -   　]/g, " ")
      // Zero-width characters and BOM → removed
      .replace(/[​-‍﻿]/g, "");
  }

  /** Pull the first {...} JSON object out of arbitrary pasted text. */
  function extractJsonObject(text) {
    if (typeof text !== "string") throw new Error("Nothing to read.");
    let s = text.trim();
    if (!s) throw new Error("Paste the assistant's reply first.");

    // Strip ``` or ```json fences if present.
    s = s.replace(/```(?:json)?/gi, "").trim();

    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("That doesn't look like the JSON the request asked for.");
    }
    const slice = s.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (err) {
      // Fallback: the text may carry smart quotes / unicode whitespace from a
      // mobile keyboard. Repair those and try once more before giving up.
      try {
        return JSON.parse(normalizeSmartCharacters(slice));
      } catch (err2) {
        throw new Error("The pasted text isn't valid JSON — copy the whole reply and try again.");
      }
    }
  }

  function normalizeConfidence(rawConfidence, value) {
    const c = String(rawConfidence || "").toLowerCase().trim();
    if (c === CONFIDENCE.SOURCED || c === CONFIDENCE.INFERRED || c === CONFIDENCE.NOT_FOUND) {
      return c;
    }
    // No usable flag: guess from whether there's a value at all.
    return value ? CONFIDENCE.INFERRED : CONFIDENCE.NOT_FOUND;
  }

  /** Coerce a raw field (object {value,confidence} or bare string) to a pair. */
  function normalizeField(raw) {
    let value = "";
    let confidence = "";
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      value = raw.value == null ? "" : String(raw.value).trim();
      confidence = raw.confidence;
    } else if (raw != null) {
      value = String(raw).trim();
    }
    return { value, confidence: normalizeConfidence(confidence, value) };
  }

  function cleanString(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === "null") return null;
    return s;
  }

  function normalizeWinemakers(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((w) => ({
        name: cleanString(w && w.name) || "",
        email: cleanString(w && w.email),
        phone: cleanString(w && w.phone),
        instagram: cleanString(w && w.instagram),
      }))
      .filter((w) => w.name);
  }

  function normalizeSources(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      const s = cleanString(item);
      if (!s || !/^https?:\/\//i.test(s) || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  /**
   * Parse pasted assistant output into a normalized structure:
   * { fields: { key: {value, confidence} }, winemakers: [], sources: [] }
   * Throws a friendly Error if the text can't be read.
   */
  function parseResearchResponse(text) {
    const raw = extractJsonObject(text);
    const fields = {};
    for (const key of FIELD_KEYS) {
      fields[key] = normalizeField(raw[key]);
    }
    return {
      fields,
      winemakers: normalizeWinemakers(raw.winemakers),
      sources: normalizeSources(raw.sources),
    };
  }

  // -------------------------------------------------------------------------
  // 3. Apply selected results to a wine (non-destructive by choice)
  // -------------------------------------------------------------------------

  /** Deep-ish clone so callers can preview without mutating the stored wine. */
  function cloneWine(wine) {
    return {
      ...wine,
      tech_facts: { ...wine.tech_facts },
      tasting_notes: { ...wine.tasting_notes },
      confidence_flags: { ...wine.confidence_flags },
      sources: [...(wine.sources || [])],
      winemakers: (wine.winemakers || []).map((w) => ({ ...w })),
    };
  }

  /**
   * Return a new wine with the accepted research applied.
   * - Only keys in `acceptedKeys` are written.
   * - A field with an empty value records its confidence flag but never clears
   *   an existing value.
   * - Winemakers (accept key "winemakers") are appended if their name is new.
   * - Sources are always merged + de-duplicated when anything is applied.
   * - last_researched is stamped.
   *
   * @param {Wine} wine
   * @param {{fields:Object,winemakers:Array,sources:Array}} normalized
   * @param {string[]} acceptedKeys  field keys, plus optional "winemakers"
   * @param {string} [now]           ISO timestamp (injectable for tests)
   * @returns {Wine}
   */
  function applyResearchToWine(wine, normalized, acceptedKeys, now) {
    const accepted = new Set(acceptedKeys || []);
    const next = cloneWine(wine);

    for (const key of FIELD_KEYS) {
      if (!accepted.has(key)) continue;
      const field = normalized.fields[key];
      if (!field) continue;
      if (field.value) {
        setWineFieldValue(next, key, field.value);
      }
      next.confidence_flags = { ...next.confidence_flags, [key]: field.confidence };
    }

    if (accepted.has("winemakers")) {
      const existing = new Set(next.winemakers.map((w) => (w.name || "").toLowerCase()));
      for (const wm of normalized.winemakers) {
        if (existing.has(wm.name.toLowerCase())) continue;
        existing.add(wm.name.toLowerCase());
        next.winemakers.push(wm);
      }
    }

    // Merge sources (dedupe, preserving order).
    const seen = new Set(next.sources);
    for (const src of normalized.sources) {
      if (!seen.has(src)) {
        seen.add(src);
        next.sources.push(src);
      }
    }

    next.last_researched = now || new Date().toISOString();
    return next;
  }

  window.WineCave.research = {
    RESEARCH_FIELDS,
    FIELD_KEYS,
    getWineFieldValue,
    setWineFieldValue,
    buildResearchPrompt,
    parseResearchResponse,
    applyResearchToWine,
    // Low-level helpers shared with the comparison engine (compare.js) so the
    // JSON-extraction, smart-quote repair and confidence handling stay in one
    // place.
    extractJsonObject,
    normalizeField,
    normalizeSources,
  };
})();
