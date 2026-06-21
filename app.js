(function () {
  const {
    getAllWines,
    getWine,
    saveWine,
    deleteWine,
    setWineStatus,
    createWine,
    filterWines,
    seedIfEmpty,
    replaceAllWines,
    STATUS,
    STATUS_LABELS,
    CONFIDENCE,
  } = window.WineCave;

  const {
    RESEARCH_FIELDS,
    buildResearchPrompt,
    parseResearchResponse,
    applyResearchToWine,
  } = window.WineCave.research;

  // Automated research engine (network). Falls back to a no-op stub if the
  // script didn't load, so the manual flow always works.
  const researchApi =
    window.WineCave.researchApi || { isConfigured: () => false, fetchResearch: () => Promise.reject(new Error("Research engine not loaded.")) };

  const CONFIDENCE_TITLES = {
    sourced: "Found in a reliable source",
    inferred: "Reasoned from related facts",
    not_found: "No reliable information found",
  };

  // -------------------------------------------------------------------
  // Themes — add a new style here (and a matching html[data-theme] block
  // in styles.css) and it appears in the settings menu automatically.
  // `swatches` are just for the menu preview: [paper, ink, accent].
  // -------------------------------------------------------------------
  const THEMES = [
    { id: "paper", label: "Paper", swatches: ["#f3ede1", "#1c1a17", "#8e3b2f"] },
    { id: "marble", label: "Marble", swatches: ["#eef0ec", "#20231f", "#3f5c4c"] },
    { id: "swiss-white", label: "Swiss White", swatches: ["#ffffff", "#000000"] },
    { id: "swiss-black", label: "Swiss Black", swatches: ["#000000", "#ffffff"] },
    { id: "swiss-primary", label: "Swiss Primary", swatches: ["#e30613", "#0047ff", "#00a14b", "#c8930a"] },
    { id: "comic", label: "Comic", swatches: ["#e6261f", "#f7c000", "#3aa53b", "#1f8fd6", "#8e44ad"] },
  ];
  const DEFAULT_THEME = "paper";
  const THEME_KEY = "canons:theme:v1";

  // Swiss Primary palette — each wine entry gets one, picked deterministically
  // from its id so the colour is stable across re-renders (no flicker while
  // filtering) yet varied across the list. Golden is darkened to read on white.
  const PRIMARY_COLOURS = ["#e30613", "#0047ff", "#00a14b", "#c8930a"];

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  function primaryColour(wine) {
    const seed = wine.id || wine.producer || wine.cuvee || "";
    return PRIMARY_COLOURS[hashString(seed) % PRIMARY_COLOURS.length];
  }

  function readSavedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (err) {
      return null;
    }
  }

  function currentThemeId() {
    const saved = readSavedTheme();
    return THEMES.some((t) => t.id === saved) ? saved : DEFAULT_THEME;
  }

  function applyTheme(id) {
    document.documentElement.dataset.theme = id;
  }

  // Apply immediately so there's no flash of the default theme.
  applyTheme(currentThemeId());

  // -------------------------------------------------------------------
  // Comic theme — rainbow letters. Each letter of display text becomes a
  // coloured <span> cycling the rainbow. CSS can't colour letters
  // individually, so this is done in JS. It's idempotent (guarded by
  // data-rainbow-orig) and reversible (restores the stored innerHTML).
  // Inputs/textareas are skipped — form controls render text single-colour.
  // -------------------------------------------------------------------
  const RAINBOW = ["#e6261f", "#f06f24", "#f7c000", "#3aa53b", "#1f8fd6", "#3b41c5", "#8e44ad"];
  const RAINBOW_SELECTOR = [
    ".brand", ".region-label", ".wine-producer", ".wine-cuvee", ".wine-vintage",
    ".wine-envie-tag", ".stamp", ".empty-state", ".section-label",
    ".field label", ".add-btn-large", ".save-btn", ".research-trigger",
    ".action-link", ".status-option", ".research-help", ".research-label",
    ".settings-title", ".settings-label",
  ].join(", ");

  function rainbowizeElement(el) {
    if (el.dataset.rainbowOrig !== undefined) return; // already done
    // Leave finished (ausgetrunken) entries greyed — don't rainbow them.
    if (el.closest && el.closest(".wine-entry--finished")) return;
    el.dataset.rainbowOrig = el.innerHTML;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    for (const textNode of textNodes) {
      const tag = textNode.parentNode.nodeName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE") continue;
      const text = textNode.nodeValue;
      if (!text.replace(/\s/g, "")) continue;
      const frag = document.createDocumentFragment();
      let i = 0;
      for (const ch of text) {
        if (/\s/.test(ch)) {
          frag.appendChild(document.createTextNode(ch));
          continue;
        }
        const span = document.createElement("span");
        span.textContent = ch;
        span.style.color = RAINBOW[i % RAINBOW.length];
        frag.appendChild(span);
        i++;
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  function applyRainbow(root) {
    if (currentThemeId() !== "comic") return;
    (root || document).querySelectorAll(RAINBOW_SELECTOR).forEach(rainbowizeElement);
  }

  function clearRainbow() {
    document.querySelectorAll("[data-rainbow-orig]").forEach((el) => {
      el.innerHTML = el.dataset.rainbowOrig;
      delete el.dataset.rainbowOrig;
    });
  }

  const listEl = document.getElementById("wine-list");
  const filterInput = document.getElementById("filter-input");

  const settingsBtn = document.getElementById("settings-btn");
  const settingsOverlay = document.getElementById("settings-overlay");
  const settingsClose = document.getElementById("settings-close");
  const themeListEl = document.getElementById("theme-list");
  const exportBtn = document.getElementById("export-btn");
  const importInput = document.getElementById("import-input");
  const backupStatus = document.getElementById("backup-status");

  const viewHome = document.getElementById("view-home");
  const viewAdd = document.getElementById("view-add");
  const viewDetail = document.getElementById("view-detail");
  const viewCompare = document.getElementById("view-compare");
  const viewCompareBuild = document.getElementById("view-compare-build");
  const viewCompareDetail = document.getElementById("view-compare-detail");

  const addWineBtn = document.getElementById("add-wine-btn");
  const addBackBtn = document.getElementById("add-back-btn");
  const addForm = document.getElementById("add-form");
  const addFieldsContainer = document.getElementById("add-fields");

  const detailBackBtn = document.getElementById("detail-back-btn");
  const detailDeleteBtn = document.getElementById("detail-delete-btn");
  const detailForm = document.getElementById("detail-form");
  const detailFieldsContainer = document.getElementById("detail-fields");
  const detailMetaEl = document.getElementById("detail-meta");
  const detailSaveStatusEl = document.getElementById("detail-save-status");

  // Research panel (dossier paste-back) — its trigger + mount live inside the
  // shared wine-fields template, so each form gets its own under the vintage.
  const researchPanelTemplate = document.getElementById("research-panel-template");

  const fieldsTemplate = document.getElementById("wine-fields-template");

  // Research controllers are created per form open (wired to the in-form
  // trigger + mount), so they live as mutable references.
  let detailResearch = null;
  let addResearch = null;

  const sync = window.WineCave.sync;

  // Ensure there's something to look at on first run — but never seed sample
  // wines onto a device that's linked to a shared cellar (they'd sync upward).
  if (!sync.isLinked()) seedIfEmpty();

  // -------------------------------------------------------------------
  // Shared field-set: cloned into Add and Detail views from <template>
  // -------------------------------------------------------------------

  function instantiateFields(container) {
    container.innerHTML = "";
    container.appendChild(fieldsTemplate.content.cloneNode(true));
    return getFieldRefs(container);
  }

  function getFieldRefs(container) {
    return {
      container,
      producer: container.querySelector(".f-producer"),
      cuvee: container.querySelector(".f-cuvee"),
      vintage: container.querySelector(".f-vintage"),
      statusButtons: [...container.querySelectorAll(".status-option")],
      region: container.querySelector(".f-region"),
      country: container.querySelector(".f-country"),
      colour: container.querySelector(".f-colour"),
      terroir: container.querySelector(".f-terroir"),
      grapes: container.querySelector(".f-grapes"),
      vinification: container.querySelector(".f-vinification"),
      tastingNotes: container.querySelector(".f-tasting-notes"),
      drinkingWindow: container.querySelector(".f-drinking-window"),
      expertContext: container.querySelector(".f-expert-context"),
      bottlesInput: container.querySelector(".f-bottles"),
      bottlesMinus: container.querySelector(".bottles-minus"),
      bottlesPlus: container.querySelector(".bottles-plus"),
      userNotes: container.querySelector(".f-user-notes"),
      researchTrigger: container.querySelector(".research-trigger"),
      researchMount: container.querySelector(".research-mount"),
    };
  }

  function setActiveStatus(refs, status) {
    for (const btn of refs.statusButtons) {
      btn.classList.toggle("is-active", btn.dataset.status === status);
    }
  }

  // -------------------------------------------------------------------
  // Label photo — TEMPORARILY REMOVED from the UI (the label field was taken
  // out for now). These helpers and the wine.label_photo data field are kept
  // intact so the field can be re-added later without rebuilding it. Nothing
  // calls wirePhotoField/setPhoto while the field is hidden.
  // -------------------------------------------------------------------

  const PHOTO_MAX_DIM = 1200;

  function fileToDownscaledDataUrl(file, maxDim = PHOTO_MAX_DIM) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("image decode failed"));
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setPhoto(refs, dataUrl) {
    refs.photoData = dataUrl || null;
    const has = Boolean(refs.photoData);
    if (has) refs.photoPreview.src = refs.photoData;
    else refs.photoPreview.removeAttribute("src");
    refs.photoPreview.hidden = !has;
    refs.photoEmpty.hidden = has;
    refs.photoTools.hidden = !has;
  }

  function wirePhotoField(refs) {
    setPhoto(refs, refs.photoData);
    for (const input of refs.photoInputs) {
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          setPhoto(refs, await fileToDownscaledDataUrl(file));
        } catch (err) {
          console.error("Wine Cave: could not read photo", err);
        } finally {
          input.value = ""; // let the same file be re-selected later
        }
      });
    }
    refs.photoRemove.addEventListener("click", () => setPhoto(refs, null));
  }

  // Auto-grow: textareas with .autogrow expand to fit their content so all
  // text is visible without scrolling or a manual resize handle. scrollHeight
  // is only meaningful when the element is visible, so autoGrowAll is also
  // called once a view is shown.
  function autoGrowEl(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function autoGrowAll(refs) {
    refs.container.querySelectorAll("textarea.autogrow").forEach(autoGrowEl);
  }

  function wireAutoGrow(refs) {
    refs.container.querySelectorAll("textarea.autogrow").forEach((el) => {
      el.addEventListener("input", () => autoGrowEl(el));
    });
  }

  // Bottle count / stock level: manual entry plus +/- steppers, clamped >= 0.
  function clampBottles(value) {
    let n = parseInt(value, 10);
    if (isNaN(n) || n < 0) n = 0;
    return n;
  }

  function wireBottles(refs) {
    refs.bottlesMinus.addEventListener("click", () => {
      refs.bottlesInput.value = Math.max(0, clampBottles(refs.bottlesInput.value) - 1);
    });
    refs.bottlesPlus.addEventListener("click", () => {
      refs.bottlesInput.value = clampBottles(refs.bottlesInput.value) + 1;
    });
    refs.bottlesInput.addEventListener("change", () => {
      refs.bottlesInput.value = clampBottles(refs.bottlesInput.value);
    });
  }

  /** Populate a field-set with an existing wine's values. */
  function writeWineToFields(refs, wine) {
    refs.producer.value = wine.producer || "";
    refs.cuvee.value = wine.cuvee || "";
    refs.vintage.value = wine.vintage || "";
    setActiveStatus(refs, wine.status);
    refs.region.value = wine.tech_facts?.region || "";
    refs.country.value = wine.tech_facts?.country || "";
    refs.colour.value = wine.tech_facts?.colour || "";
    refs.terroir.value = wine.tech_facts?.terroir_type || "";
    refs.grapes.value = wine.tech_facts?.grape_varietals || "";
    refs.vinification.value = wine.vinification || "";
    refs.tastingNotes.value = wine.tasting_notes?.notes || "";
    refs.drinkingWindow.value = wine.tasting_notes?.drinking_window || "";
    refs.expertContext.value = wine.expert_context || "";
    refs.bottlesInput.value = clampBottles(wine.bottles ?? 1);
    refs.userNotes.value = wine.user_notes || "";
    renderProvenance(refs, wine);
    autoGrowAll(refs);
  }

  function prettyUrl(url) {
    return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }

  /**
   * Show research provenance on a field-set: a confidence dot beside each
   * researched field and a sources list. Idempotent — clears prior dots first.
   */
  function renderProvenance(refs, wine) {
    const container = refs.container;
    container.querySelectorAll(".confidence-dot.injected").forEach((d) => d.remove());

    const flags = wine.confidence_flags || {};
    const flagKeys = Object.keys(flags);
    for (const key of flagKeys) {
      const labelEl = container.querySelector(`[data-cf="${key}"]`);
      if (!labelEl) continue;
      const dot = document.createElement("span");
      dot.className = "confidence-dot injected";
      dot.dataset.confidence = flags[key];
      dot.title = CONFIDENCE_TITLES[flags[key]] || flags[key];
      labelEl.appendChild(dot);
    }

    const block = container.querySelector(".provenance-block");
    const legend = container.querySelector(".confidence-legend");
    const list = container.querySelector(".sources-list");
    if (!block) return;

    const sources = wine.sources || [];
    list.innerHTML = "";
    for (const url of sources) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = prettyUrl(url);
      li.appendChild(a);
      list.appendChild(li);
    }

    if (legend) legend.hidden = flagKeys.length === 0;
    list.hidden = sources.length === 0;
    block.hidden = flagKeys.length === 0 && sources.length === 0;
  }

  /** Build an updated wine object from a field-set, layered onto `base`. */
  function readFieldsIntoWine(refs, base, status) {
    const producer = refs.producer.value.trim();
    const vintage = refs.vintage.value.trim();

    return {
      ...base,
      producer,
      cuvee: refs.cuvee.value.trim(),
      vintage: vintage || null,
      status,
      bottles: clampBottles(refs.bottlesInput.value),
      // Label field is hidden for now; preserve any previously stored photo.
      label_photo: base.label_photo ?? null,
      tech_facts: {
        ...base.tech_facts,
        producer,
        year: vintage,
        region: refs.region.value.trim(),
        country: refs.country.value.trim(),
        colour: refs.colour.value.trim(),
        terroir_type: refs.terroir.value.trim(),
        grape_varietals: refs.grapes.value.trim(),
      },
      vinification: refs.vinification.value.trim(),
      tasting_notes: {
        ...base.tasting_notes,
        notes: refs.tastingNotes.value.trim(),
        drinking_window: refs.drinkingWindow.value.trim(),
      },
      expert_context: refs.expertContext.value.trim(),
      user_notes: refs.userNotes.value.trim(),
    };
  }

  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso)
      .toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
      .toLowerCase();
  }

  // -------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------

  function showView(name) {
    viewHome.hidden = name !== "home";
    viewAdd.hidden = name !== "add";
    viewDetail.hidden = name !== "detail";
    viewCompare.hidden = name !== "compare";
    viewCompareBuild.hidden = name !== "compare-build";
    viewCompareDetail.hidden = name !== "compare-detail";
    window.scrollTo(0, 0);
  }

  // -------------------------------------------------------------------
  // Home: collection list
  // -------------------------------------------------------------------

  // Map detailed sub-regions to a high-level region so the home list clusters
  // neighbours (e.g. Anjou + Touraine -> Loire). The precise sub-region is
  // retained on the wine entry itself. Keys are lowercased + accent-stripped.
  const REGION_MACRO = {
    // Loire
    loire: "Loire", anjou: "Loire", saumur: "Loire", touraine: "Loire", muscadet: "Loire",
    sancerre: "Loire", "pouilly-fume": "Loire", vouvray: "Loire", chinon: "Loire",
    bourgueil: "Loire", montlouis: "Loire", savennieres: "Loire", "coteaux du layon": "Loire",
    quincy: "Loire", reuilly: "Loire", cheverny: "Loire", jasnieres: "Loire", "saint-pourcain": "Loire",
    // Burgundy
    burgundy: "Burgundy", bourgogne: "Burgundy", chablis: "Burgundy", "cote de beaune": "Burgundy",
    "cote de nuits": "Burgundy", "cote chalonnaise": "Burgundy", macon: "Burgundy", maconnais: "Burgundy",
    beaune: "Burgundy", meursault: "Burgundy", "puligny-montrachet": "Burgundy",
    "chassagne-montrachet": "Burgundy", pommard: "Burgundy", volnay: "Burgundy",
    "nuits-saint-georges": "Burgundy", "gevrey-chambertin": "Burgundy", "chambolle-musigny": "Burgundy",
    "vosne-romanee": "Burgundy", marsannay: "Burgundy", "saint-aubin": "Burgundy", "auxey-duresses": "Burgundy",
    // Beaujolais
    beaujolais: "Beaujolais", morgon: "Beaujolais", fleurie: "Beaujolais", brouilly: "Beaujolais",
    "cote de brouilly": "Beaujolais", chenas: "Beaujolais", julienas: "Beaujolais",
    chiroubles: "Beaujolais", regnie: "Beaujolais", "saint-amour": "Beaujolais", "moulin-a-vent": "Beaujolais",
    // Jura
    jura: "Jura", arbois: "Jura", pupillin: "Jura", "chateau-chalon": "Jura", etoile: "Jura",
    "l'etoile": "Jura", "cotes du jura": "Jura",
    // Savoie
    savoie: "Savoie", apremont: "Savoie", abymes: "Savoie", chignin: "Savoie",
    // Rhône
    rhone: "Rhône", "cote-rotie": "Rhône", condrieu: "Rhône", hermitage: "Rhône",
    "crozes-hermitage": "Rhône", cornas: "Rhône", "saint-joseph": "Rhône",
    "chateauneuf-du-pape": "Rhône", gigondas: "Rhône", vacqueyras: "Rhône", ardeche: "Rhône",
    // Other France
    alsace: "Alsace", champagne: "Champagne", languedoc: "Languedoc", minervois: "Languedoc",
    corbieres: "Languedoc", faugeres: "Languedoc", "pic saint-loup": "Languedoc",
    "terrasses du larzac": "Languedoc", roussillon: "Roussillon", "cotes catalanes": "Roussillon",
    banyuls: "Roussillon", maury: "Roussillon", provence: "Provence", bandol: "Provence",
    cassis: "Provence", bordeaux: "Bordeaux", medoc: "Bordeaux", "saint-emilion": "Bordeaux",
    pomerol: "Bordeaux", graves: "Bordeaux", "pessac-leognan": "Bordeaux", "sud-ouest": "Sud-Ouest",
    gaillac: "Sud-Ouest", cahors: "Sud-Ouest", jurancon: "Sud-Ouest", madiran: "Sud-Ouest",
    irouleguy: "Sud-Ouest", auvergne: "Auvergne", "cotes d'auvergne": "Auvergne",
    // A few common non-French
    piedmont: "Piedmont", piemonte: "Piedmont", langhe: "Piedmont", barolo: "Piedmont",
    barbaresco: "Piedmont", tuscany: "Tuscany", toscana: "Tuscany", chianti: "Tuscany",
    sicily: "Sicily", sicilia: "Sicily", etna: "Sicily", veneto: "Veneto", friuli: "Friuli",
    "emilia-romagna": "Emilia-Romagna", "sierra foothills": "California", california: "California",
    napa: "California", sonoma: "California", "willamette valley": "Oregon", oregon: "Oregon",
    mosel: "Mosel", rheingau: "Rheingau", pfalz: "Pfalz", catalonia: "Catalonia",
    catalunya: "Catalonia", penedes: "Catalonia", galicia: "Galicia", "ribeira sacra": "Galicia",
  };

  // If an exact match fails, a region containing one of these words still maps
  // (e.g. "Hautes-Côtes du Jura" -> Jura).
  const REGION_ANCHORS = [
    ["jura", "Jura"], ["loire", "Loire"], ["savoie", "Savoie"], ["beaujolais", "Beaujolais"],
    ["bourgogne", "Burgundy"], ["burgundy", "Burgundy"], ["rhone", "Rhône"], ["alsace", "Alsace"],
    ["champagne", "Champagne"], ["languedoc", "Languedoc"], ["roussillon", "Roussillon"],
    ["provence", "Provence"], ["bordeaux", "Bordeaux"], ["piemonte", "Piedmont"], ["piedmont", "Piedmont"],
    ["toscana", "Tuscany"], ["tuscany", "Tuscany"], ["sicilia", "Sicily"], ["sicily", "Sicily"],
    ["etna", "Sicily"], ["california", "California"], ["oregon", "Oregon"], ["mosel", "Mosel"],
  ];

  function normalizeRegion(s) {
    return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  }

  function macroRegion(wine) {
    const raw = (wine.tech_facts && wine.tech_facts.region) || "";
    const key = normalizeRegion(raw);
    if (!key) return "other";
    if (REGION_MACRO[key]) return REGION_MACRO[key];
    for (const [anchor, macro] of REGION_ANCHORS) {
      if (key.includes(anchor)) return macro;
    }
    return raw; // fall back to whatever was entered, as its own group
  }

  /**
   * Group wines by high-level region, sort regions alphabetically, and sort
   * wines within a region by producer.
   */
  function groupByRegion(wines) {
    const groups = new Map();
    for (const wine of wines) {
      const key = macroRegion(wine);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(wine);
    }
    for (const wines of groups.values()) {
      wines.sort((a, b) => a.producer.localeCompare(b.producer));
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  /**
   * Classify a wine into a colour/type for the home-list dot, from the free-text
   * colour field. Sparkling is checked first (a wine can be e.g. "blanc" AND
   * sparkling). Returns null when it can't be determined (no dot shown).
   */
  function wineType(wine) {
    const c = ((wine.tech_facts && wine.tech_facts.colour) || "").toLowerCase();
    if (!c) return null;
    if (/(spark|p[eé]t|pet-?nat|mousse|cr[eé]mant|champagne|frizz|bubb|sekt|cava|prosecc|espumos|lambrusc)/.test(c)) return "sparkling";
    if (/(orange|amber|skin)/.test(c)) return "orange";
    if (/(ros[eé]|rosad|rosat|pink)/.test(c)) return "rose";
    if (/(blanc|white|bianco|blanco|wei)/.test(c)) return "white";
    if (/(rouge|red|rosso|tinto|noir|negr)/.test(c)) return "red";
    return null;
  }

  function makeTypeDot(type) {
    const dot = document.createElement("span");
    dot.className = "type-dot";
    dot.dataset.type = type;
    dot.title = type;
    return dot;
  }

  function renderWineEntry(wine) {
    const li = document.createElement("li");
    li.className = "wine-entry";
    if (wine.status === STATUS.AUSGETRUNKEN) {
      li.classList.add("wine-entry--finished");
    }
    // Swiss Primary: colour the whole entry with its assigned primary.
    if (currentThemeId() === "swiss-primary") {
      li.style.color = primaryColour(wine);
    }
    li.addEventListener("click", () => openDetail(wine.id));

    const row = document.createElement("div");
    row.className = "wine-row";

    const main = document.createElement("div");
    main.className = "wine-main";

    const producer = document.createElement("span");
    producer.className = "wine-producer";
    producer.textContent = wine.producer;
    main.appendChild(producer);

    const cuveeLine = document.createElement("div");
    cuveeLine.className = "wine-cuvee-line";
    const type = wineType(wine);
    if (type) cuveeLine.appendChild(makeTypeDot(type));
    const cuvee = document.createElement("span");
    cuvee.className = "wine-cuvee";
    cuvee.textContent = wine.cuvee;
    cuveeLine.appendChild(cuvee);
    main.appendChild(cuveeLine);

    if (wine.status === STATUS.ENVIE) {
      const tag = document.createElement("span");
      tag.className = "wine-envie-tag";
      tag.textContent = STATUS_LABELS[STATUS.ENVIE];
      main.appendChild(tag);
    }

    if (wine.needs_research) {
      const tag = document.createElement("span");
      tag.className = "wine-needs-tag";
      tag.textContent = "needs info";
      main.appendChild(tag);
    }

    row.appendChild(main);

    const vintage = document.createElement("span");
    vintage.className = "wine-vintage";
    vintage.textContent = wine.vintage || "NV";
    row.appendChild(vintage);

    li.appendChild(row);

    if (wine.status === STATUS.AUSGETRUNKEN) {
      const stamp = document.createElement("span");
      stamp.className = "stamp";
      stamp.textContent = STATUS_LABELS[STATUS.AUSGETRUNKEN];
      li.appendChild(stamp);
    }

    return li;
  }

  function render(query = "") {
    const all = getAllWines();
    const visible = filterWines(all, query);

    listEl.innerHTML = "";

    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = all.length === 0
        ? "The cellar is empty — add a wine to begin."
        : "Nothing matches that search.";
      listEl.appendChild(empty);
      applyRainbow(listEl);
      return;
    }

    for (const [region, wines] of groupByRegion(visible)) {
      const group = document.createElement("div");
      group.className = "region-group";

      const label = document.createElement("p");
      label.className = "region-label";
      label.textContent = region;
      group.appendChild(label);

      const ul = document.createElement("ul");
      ul.className = "wine-list";
      for (const wine of wines) {
        ul.appendChild(renderWineEntry(wine));
      }
      group.appendChild(ul);

      listEl.appendChild(group);
    }
    applyRainbow(listEl);
  }

  filterInput.addEventListener("input", (e) => {
    render(e.target.value);
  });

  // -------------------------------------------------------------------
  // Add Wine
  // -------------------------------------------------------------------

  let addRefs = null;
  let addSelectedStatus = STATUS.EN_CAVE;
  // The wine being built in the Add view. Holds anything research adds
  // (facts, confidence flags, sources) until you tap save.
  let addDraft = null;

  addWineBtn.addEventListener("click", () => {
    addRefs = instantiateFields(addFieldsContainer);
    addDraft = createWine();
    addSelectedStatus = STATUS.EN_CAVE;
    setActiveStatus(addRefs, addSelectedStatus);

    for (const btn of addRefs.statusButtons) {
      btn.addEventListener("click", () => {
        addSelectedStatus = btn.dataset.status;
        setActiveStatus(addRefs, addSelectedStatus);
      });
    }
    wireBottles(addRefs);
    wireAutoGrow(addRefs);
    addResearch = createResearchController({
      trigger: addRefs.researchTrigger,
      mount: addRefs.researchMount,
      isReady: () => Boolean(addRefs),
      buildBase: () => readFieldsIntoWine(addRefs, addDraft, addSelectedStatus),
      onApplied: (updated) => {
        // Don't save yet — fold the research into the draft and fill the form
        // so you can review/adjust, then tap save to add the wine.
        addDraft = updated;
        addSelectedStatus = updated.status;
        writeWineToFields(addRefs, updated);
        setActiveStatus(addRefs, addSelectedStatus);
        autoGrowAll(addRefs);
      },
    });

    showView("add");
    autoGrowAll(addRefs);
    applyRainbow(addFieldsContainer);
    addRefs.producer.focus();
  });

  addBackBtn.addEventListener("click", () => {
    showView("home");
  });

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!addRefs) return;

    if (!addRefs.producer.value.trim()) {
      addRefs.producer.focus();
      return;
    }
    if (!addRefs.cuvee.value.trim()) {
      addRefs.cuvee.focus();
      return;
    }

    // Build on addDraft so any research already applied (facts, confidence
    // flags, sources, last_researched) is carried into the saved wine.
    const wine = readFieldsIntoWine(addRefs, addDraft || createWine(), addSelectedStatus);
    if (addSelectedStatus === STATUS.AUSGETRUNKEN) {
      wine.date_status_changed = new Date().toISOString();
    }

    saveWine(wine);
    sync.scheduleSync();
    if (addResearch) addResearch.close();
    showView("home");
    render(filterInput.value);
  });

  // -------------------------------------------------------------------
  // Wine detail
  // -------------------------------------------------------------------

  let currentWine = null;
  let detailRefs = null;

  function renderDetailMeta() {
    const parts = [`added ${formatDate(currentWine.date_added)}`];
    if (currentWine.status === STATUS.AUSGETRUNKEN && currentWine.date_status_changed) {
      parts.push(`finished ${formatDate(currentWine.date_status_changed)}`);
    }
    if (currentWine.last_researched) {
      parts.push(`researched ${formatDate(currentWine.last_researched)}`);
    }
    detailMetaEl.textContent = parts.join("  ·  ");
  }

  function openDetail(id) {
    const wine = getWine(id);
    if (!wine) return;

    currentWine = wine;
    detailRefs = instantiateFields(detailFieldsContainer);
    wireBottles(detailRefs);
    wireAutoGrow(detailRefs);
    writeWineToFields(detailRefs, currentWine);

    for (const btn of detailRefs.statusButtons) {
      btn.addEventListener("click", () => {
        // One tap to change status (§4.5) — persists immediately, separate
        // from the rest of the form which is saved explicitly.
        currentWine = setWineStatus(currentWine.id, btn.dataset.status);
        setActiveStatus(detailRefs, currentWine.status);
        renderDetailMeta();
        sync.scheduleSync();
      });
    }

    detailResearch = createResearchController({
      trigger: detailRefs.researchTrigger,
      mount: detailRefs.researchMount,
      isReady: () => Boolean(currentWine && detailRefs),
      buildBase: () => readFieldsIntoWine(detailRefs, currentWine, currentWine.status),
      onApplied: (updated) => {
        currentWine = updated;
        saveWine(currentWine);
        sync.scheduleSync();
        writeWineToFields(detailRefs, currentWine);
        renderDetailMeta();
        autoGrowAll(detailRefs);
        detailSaveStatusEl.textContent = "researched";
        setTimeout(() => {
          detailSaveStatusEl.textContent = "";
        }, 1800);
      },
    });

    renderDetailMeta();
    detailSaveStatusEl.textContent = "";
    showView("detail");
    autoGrowAll(detailRefs);
    applyRainbow(detailFieldsContainer);
  }

  detailBackBtn.addEventListener("click", () => {
    showView("home");
    render(filterInput.value);
  });

  detailDeleteBtn.addEventListener("click", () => {
    if (!currentWine) return;
    const label = [currentWine.producer, currentWine.cuvee].filter(Boolean).join(" — ");
    if (!confirm(`Remove "${label}" from the cellar? This can't be undone.`)) return;

    deleteWine(currentWine.id);
    sync.scheduleSync();
    currentWine = null;
    showView("home");
    render(filterInput.value);
  });

  detailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentWine || !detailRefs) return;

    if (!detailRefs.producer.value.trim()) {
      detailRefs.producer.focus();
      return;
    }
    if (!detailRefs.cuvee.value.trim()) {
      detailRefs.cuvee.focus();
      return;
    }

    // Status is controlled separately (one tap, persisted immediately above).
    currentWine = readFieldsIntoWine(detailRefs, currentWine, currentWine.status);
    saveWine(currentWine);
    sync.scheduleSync();

    // Save & close: fold the changes in, then return to the cellar.
    if (detailResearch) detailResearch.close();
    showView("home");
    render(filterInput.value);
  });

  // -------------------------------------------------------------------
  // Research (dossier paste-back)
  // -------------------------------------------------------------------

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function makePreviewRow({ key, label, confidence, proposed, current, willOverwrite, checked }) {
    const row = document.createElement("label");
    row.className = "preview-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "preview-check";
    check.dataset.key = key;
    check.checked = checked;
    row.appendChild(check);

    const body = document.createElement("span");
    body.className = "preview-body";

    const head = document.createElement("span");
    head.className = "preview-head";
    const labelEl = document.createElement("span");
    labelEl.className = "preview-label";
    labelEl.textContent = label;
    head.appendChild(labelEl);
    if (confidence) {
      const dot = document.createElement("span");
      dot.className = "confidence-dot";
      dot.dataset.confidence = confidence;
      dot.title = CONFIDENCE_TITLES[confidence] || confidence;
      head.appendChild(dot);
    }
    if (willOverwrite) {
      const badge = document.createElement("span");
      badge.className = "preview-overwrite";
      badge.textContent = "replaces existing";
      head.appendChild(badge);
    }
    body.appendChild(head);

    const proposedEl = document.createElement("span");
    proposedEl.className = "preview-proposed";
    proposedEl.textContent = proposed;
    body.appendChild(proposedEl);

    if (willOverwrite) {
      const cur = document.createElement("span");
      cur.className = "preview-current";
      cur.textContent = `currently: ${current}`;
      body.appendChild(cur);
    }

    row.appendChild(body);
    return row;
  }

  function renderResearchPreview(listEl, parsed, baseWine) {
    listEl.innerHTML = "";

    for (const f of RESEARCH_FIELDS) {
      const field = parsed.fields[f.key];
      if (!field || !field.value) continue;
      const current = window.WineCave.research.getWineFieldValue(baseWine, f.key);
      const willOverwrite = Boolean(current) && current !== field.value;
      // Preselect when the field is empty, or when research is confident
      // ("sourced") — so corrections to what you typed (accents, spelling)
      // apply by default while staying easy to untick.
      const checked = !current || field.confidence === CONFIDENCE.SOURCED;
      listEl.appendChild(
        makePreviewRow({
          key: f.key,
          label: f.label,
          confidence: field.confidence,
          proposed: field.value,
          current,
          willOverwrite,
          checked,
        })
      );
    }

    if (parsed.sources.length) {
      const note = document.createElement("p");
      note.className = "research-sources-note";
      const n = parsed.sources.length;
      note.textContent = `${n} source${n > 1 ? "s" : ""} will be added.`;
      listEl.appendChild(note);
    }

    if (!listEl.children.length) {
      const p = document.createElement("p");
      p.className = "research-empty";
      p.textContent = "The reply didn't contain any new facts to add.";
      listEl.appendChild(p);
    }
  }

  /**
   * Wire one research panel (cloned from the template) to a context. The
   * callbacks decouple the panel from where it lives:
   *   isReady()      → is there a form to act on?
   *   buildBase()    → a wine object from the current form state (+ identity)
   *   onApplied(win) → persist/render the researched wine
   * Used for both the Detail view (saves immediately) and the Add view
   * (fills the form; the wine is saved later when you tap save).
   */
  function createResearchController({ trigger, mount, isReady, buildBase, onApplied }) {
    const panel = researchPanelTemplate.content.firstElementChild.cloneNode(true);
    mount.appendChild(panel);

    const chooserView = panel.querySelector(".research-chooser");
    const chooseAi = panel.querySelector(".research-choose-ai");
    const chooseFree = panel.querySelector(".research-choose-free");

    const loadingView = panel.querySelector(".research-loading");
    const loadingCancel = panel.querySelector(".research-loading-cancel");

    const failView = panel.querySelector(".research-fail");
    const failMsg = panel.querySelector(".research-fail-msg");
    const failCancel = panel.querySelector(".research-fail-cancel");
    const failManual = panel.querySelector(".research-fail-manual");
    const retryBtn = panel.querySelector(".research-retry-btn");

    const inputView = panel.querySelector(".research-input");
    const reviewView = panel.querySelector(".research-review");
    const copyBtn = panel.querySelector(".research-copy-btn");
    const copyStatus = panel.querySelector(".research-copy-status");
    const paste = panel.querySelector(".research-paste");
    // Scope to the manual input view — the fail view also has a .research-error.
    const errorEl = inputView.querySelector(".research-error");
    const cancelBtn = panel.querySelector(".research-cancel-btn");
    const reviewBtn = panel.querySelector(".research-review-btn");
    const previewList = panel.querySelector(".research-preview-list");
    const backBtn = panel.querySelector(".research-back-btn");
    const applyBtn = panel.querySelector(".research-apply-btn");

    let pending = null;
    let inFlight = null; // AbortController for an active API call

    // Show exactly one of the panel's views.
    function showView(name) {
      chooserView.hidden = name !== "chooser";
      loadingView.hidden = name !== "loading";
      failView.hidden = name !== "fail";
      inputView.hidden = name !== "input";
      reviewView.hidden = name !== "review";
    }

    function abortInFlight() {
      if (inFlight) {
        inFlight.abort();
        inFlight = null;
      }
    }

    // Abort any running call and return to the choice screen.
    function toChooser() {
      abortInFlight();
      errorEl.hidden = true;
      showView("chooser");
    }

    function close() {
      abortInFlight();
      pending = null;
      panel.hidden = true;
      showView("chooser");
      paste.value = "";
      errorEl.hidden = true;
      errorEl.textContent = "";
      copyStatus.textContent = "";
      previewList.innerHTML = "";
    }

    // Drop a parsed result into the existing review/verify screen.
    function toReview(parsed) {
      pending = parsed;
      // Preview against current form state so unsaved edits count as "current".
      renderResearchPreview(previewList, parsed, buildBase());
      showView("review");
    }

    function showFailure(message) {
      failMsg.textContent = message;
      showView("fail");
    }

    // Run the automated API research: loading → parse → review.
    function startAuto() {
      if (!isReady()) return;
      const base = buildBase();
      if (!base.producer) {
        showFailure("Enter a producer first, then research.");
        return;
      }
      if (!researchApi.isConfigured()) {
        showFailure(
          "AI research isn't set up yet — link sync (it shares your Supabase project), or use free search instead.",
        );
        return;
      }

      abortInFlight();
      const controller = new AbortController();
      inFlight = controller;
      showView("loading");

      researchApi
        .fetchResearch(base, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          inFlight = null;
          let parsed;
          try {
            parsed = parseResearchResponse(result.text);
          } catch (err) {
            showFailure(
              "The research came back but couldn't be read as data. Try again, or use free search.",
            );
            return;
          }
          toReview(parsed);
        })
        .catch((err) => {
          if (controller.signal.aborted || (err && err.name === "AbortError")) return;
          inFlight = null;
          showFailure((err && err.message) || "Research failed. Try again.");
        });
    }

    // Show the free copy/paste flow.
    function showManual() {
      abortInFlight();
      errorEl.hidden = true;
      showView("input");
    }

    // Opening the panel always lands on the chooser — no auto-spend.
    trigger.addEventListener("click", () => {
      if (!isReady()) return;
      if (panel.hidden) {
        close();
        panel.hidden = false;
        showView("chooser");
      } else {
        close();
      }
    });

    // Chooser: pick AI (paid) or free (manual).
    chooseAi.addEventListener("click", startAuto);
    chooseFree.addEventListener("click", showManual);

    // Loading state controls.
    loadingCancel.addEventListener("click", toChooser);

    // Failure state controls.
    failCancel.addEventListener("click", toChooser);
    failManual.addEventListener("click", showManual);
    retryBtn.addEventListener("click", startAuto);

    // Manual flow.
    cancelBtn.addEventListener("click", toChooser);

    copyBtn.addEventListener("click", () => {
      if (!isReady()) return;
      const base = buildBase();
      if (!base.producer) {
        copyStatus.textContent = "enter a producer first";
        setTimeout(() => {
          copyStatus.textContent = "";
        }, 2500);
        return;
      }
      copyText(buildResearchPrompt(base)).then((ok) => {
        copyStatus.textContent = ok ? "copied" : "couldn't copy — select the text manually";
        setTimeout(() => {
          copyStatus.textContent = "";
        }, 2500);
      });
    });

    reviewBtn.addEventListener("click", () => {
      if (!isReady()) return;
      errorEl.hidden = true;
      let parsed;
      try {
        parsed = parseResearchResponse(paste.value);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        return;
      }
      toReview(parsed);
    });

    backBtn.addEventListener("click", toChooser);

    applyBtn.addEventListener("click", () => {
      if (!pending || !isReady()) return;
      const acceptedKeys = [...previewList.querySelectorAll(".preview-check")]
        .filter((c) => c.checked)
        .map((c) => c.dataset.key);
      const updated = applyResearchToWine(buildBase(), pending, acceptedKeys);
      onApplied(updated);
      close();
    });

    return { close };
  }

  // -------------------------------------------------------------------
  // Settings: theme switcher
  // -------------------------------------------------------------------

  function setTheme(id) {
    applyTheme(id);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch (err) {
      /* private mode / quota — theme just won't persist */
    }
    clearRainbow(); // restore any rainbow text before switching
    renderThemeList();
    // Re-render the list so per-entry colours (Swiss Primary) apply or clear.
    render(filterInput.value);
    // Re-apply rainbow to chrome + forms if the new theme is Comic (no-op otherwise).
    applyRainbow(document);
  }

  function renderThemeList() {
    const active = currentThemeId();
    themeListEl.innerHTML = "";
    for (const theme of THEMES) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "theme-option";
      // Each row previews itself: scope the row to its own theme.
      option.dataset.theme = theme.id;
      if (theme.id === active) option.classList.add("is-active");

      const swatches = document.createElement("span");
      swatches.className = "theme-swatches";
      for (const colour of theme.swatches) {
        const sw = document.createElement("span");
        sw.className = "theme-swatch";
        sw.style.background = colour;
        swatches.appendChild(sw);
      }
      option.appendChild(swatches);

      const name = document.createElement("span");
      name.className = "theme-name";
      name.textContent = theme.label;
      option.appendChild(name);
      // The Comic row previews its rainbow letters regardless of active theme.
      if (theme.id === "comic") rainbowizeElement(name);

      if (theme.id === active) {
        const check = document.createElement("span");
        check.className = "theme-check";
        check.textContent = "✓";
        option.appendChild(check);
      }

      option.addEventListener("click", () => setTheme(theme.id));
      themeListEl.appendChild(option);
    }
  }

  function openSettings() {
    renderThemeList();
    renderSync();
    showSettingsPage("main");
    settingsOverlay.hidden = false;
    applyRainbow(settingsOverlay);
  }

  function closeSettings() {
    resolveInline(false); // cancel any open prompt
    settingsOverlay.hidden = true;
    showSettingsPage("main");
  }

  settingsBtn.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  // -------------------------------------------------------------------
  // Backup / restore — export the whole cellar to a JSON file, and import
  // one back. Import replaces the current collection (restore semantics).
  // -------------------------------------------------------------------

  function flashBackupStatus(text) {
    backupStatus.textContent = text;
    setTimeout(() => {
      backupStatus.textContent = "";
    }, 3000);
  }

  exportBtn.addEventListener("click", () => {
    const wines = getAllWines();
    const comparisons = compareStore.list();
    const payload = {
      app: "CANONS",
      version: 2,
      exportedAt: new Date().toISOString(),
      wines,
      comparisons,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `canons-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const cmpNote = comparisons.length
      ? ` + ${comparisons.length} comparison${comparisons.length === 1 ? "" : "s"}`
      : "";
    flashBackupStatus(`exported ${wines.length} wine${wines.length === 1 ? "" : "s"}${cmpNote}`);
  });

  importInput.addEventListener("change", () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => {
      flashBackupStatus("couldn't read that file");
      importInput.value = "";
    };
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const wines = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.wines)
          ? parsed.wines
          : null;
        if (!wines) throw new Error("no wines in file");

        const current = getAllWines().length;
        const ok = confirm(
          `Import ${wines.length} wine${wines.length === 1 ? "" : "s"} from this backup?\n\n` +
            `This replaces your current ${current} wine${current === 1 ? "" : "s"}.`
        );
        if (!ok) {
          importInput.value = "";
          return;
        }

        const saved = replaceAllWines(wines);
        // Restore comparisons too if the backup carries them (v2+). Absent in
        // old backups — leave existing comparisons untouched in that case.
        let cmpNote = "";
        if (parsed && Array.isArray(parsed.comparisons)) {
          compareStore.replaceAll(parsed.comparisons);
          const n = parsed.comparisons.length;
          cmpNote = ` + ${n} comparison${n === 1 ? "" : "s"}`;
        }
        sync.scheduleSync();
        render(filterInput.value);
        flashBackupStatus(`imported ${saved.length} wine${saved.length === 1 ? "" : "s"}${cmpNote}`);
      } catch (err) {
        console.error("Wine Cave: import failed", err);
        flashBackupStatus("that file isn't a CANONS backup");
      } finally {
        importInput.value = "";
      }
    };
    reader.readAsText(file);
  });

  // -------------------------------------------------------------------
  // Sync (optional, account-free) — settings UI + auto-sync triggers
  // -------------------------------------------------------------------

  const settingsPageMain = document.getElementById("settings-page-main");
  const settingsPageAdvanced = document.getElementById("settings-page-advanced");
  const settingsAdvancedBtn = document.getElementById("settings-advanced-btn");
  const settingsBackBtn = document.getElementById("settings-back-btn");

  const syncLinked = document.getElementById("sync-linked");
  const syncSetup = document.getElementById("sync-setup");
  const syncWhen = document.getElementById("sync-when");
  const syncStatus = document.getElementById("sync-status");
  const syncConfirm = document.getElementById("sync-confirm");
  const syncConfirmMsg = document.getElementById("sync-confirm-msg");
  const syncConfirmYes = document.getElementById("sync-confirm-yes");
  const syncConfirmNo = document.getElementById("sync-confirm-no");

  // Show one of the two settings pages (main = appearance, advanced = data/sync).
  function showSettingsPage(name) {
    settingsPageMain.hidden = name !== "main";
    settingsPageAdvanced.hidden = name !== "advanced";
  }

  settingsAdvancedBtn.addEventListener("click", () => {
    renderSync();
    showSettingsPage("advanced");
  });
  settingsBackBtn.addEventListener("click", () => {
    resolveInline(false); // cancel any open prompt before leaving
    showSettingsPage("main");
  });

  // "how does this work?" — toggle the sync/backup explainer (collapsed by default).
  const syncHelpToggle = document.getElementById("sync-help-toggle");
  const syncHelpPanel = document.getElementById("sync-help-panel");
  syncHelpToggle.addEventListener("click", () => {
    const open = syncHelpPanel.hidden;
    syncHelpPanel.hidden = !open;
    syncHelpToggle.setAttribute("aria-expanded", String(open));
    syncHelpToggle.textContent = open ? "hide" : "how does this work?";
  });

  // Inline, non-blocking confirm — native confirm()/alert() are unreliable in
  // an installed PWA (they can freeze the page), so we ask in the panel itself.
  // Resolves true/false; only one prompt is live at a time.
  let confirmResolver = null;
  function askInline(message, yesLabel = "ok", noLabel = "cancel") {
    syncConfirmMsg.textContent = message;
    syncConfirmYes.textContent = yesLabel;
    syncConfirmNo.textContent = noLabel;
    syncConfirm.hidden = false;
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }
  function resolveInline(value) {
    syncConfirm.hidden = true;
    const r = confirmResolver;
    confirmResolver = null;
    if (r) r(value);
  }
  syncConfirmYes.addEventListener("click", () => resolveInline(true));
  syncConfirmNo.addEventListener("click", () => resolveInline(false));
  const syncTokenInput = document.getElementById("sync-token-input");
  const syncNewForm = document.getElementById("sync-new-form");
  const syncUrlInput = document.getElementById("sync-url-input");
  const syncKeyInput = document.getElementById("sync-key-input");
  const syncCodeInput = document.getElementById("sync-code-input");

  const syncJoinBtn = document.getElementById("sync-join-btn");
  const syncNewBtn = document.getElementById("sync-new-btn");
  const syncGenBtn = document.getElementById("sync-gen-btn");
  const syncCreateBtn = document.getElementById("sync-create-btn");
  const syncNowBtn = document.getElementById("sync-now-btn");
  const syncCopyBtn = document.getElementById("sync-copy-btn");
  const syncUnlinkBtn = document.getElementById("sync-unlink-btn");

  function flashSyncStatus(text, persist) {
    syncStatus.textContent = text;
    if (!persist) {
      setTimeout(() => {
        if (syncStatus.textContent === text) syncStatus.textContent = "";
      }, 3500);
    }
  }

  function renderSync() {
    const linked = sync.isLinked();
    syncLinked.hidden = !linked;
    syncSetup.hidden = linked;
    if (linked) {
      const cfg = sync.getConfig();
      syncWhen.textContent = cfg && cfg.lastSync ? `last synced ${formatDate(cfg.lastSync)}` : "";
    } else {
      syncNewForm.hidden = true;
      syncTokenInput.value = "";
    }
  }

  // Re-render the cellar when a background sync pulls in changes from another
  // device. Only disrupts the home list; an open editor is left alone.
  sync.setOnChange(() => render(filterInput.value));

  syncNewBtn.addEventListener("click", () => {
    syncNewForm.hidden = !syncNewForm.hidden;
    if (!syncNewForm.hidden && !syncCodeInput.value) syncCodeInput.value = sync.randomCode();
  });

  syncGenBtn.addEventListener("click", () => {
    syncCodeInput.value = sync.randomCode();
  });

  // Disable a button for the duration of an async action so it can't be tapped
  // twice or left in a half-finished state — errors are surfaced, never swallow
  // the UI. (Combined with inline confirms, this is what keeps the panel from
  // getting "stuck" mid-sync.)
  function runBusy(btn, fn) {
    return async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        flashSyncStatus((err && err.message) || "something went wrong");
      } finally {
        btn.disabled = false;
      }
    };
  }

  // Join an existing cellar from a pasted sync code.
  syncJoinBtn.addEventListener(
    "click",
    runBusy(syncJoinBtn, async () => {
      let cfg;
      try {
        cfg = sync.parseToken(syncTokenInput.value);
      } catch (err) {
        flashSyncStatus(err.message);
        return;
      }
      flashSyncStatus("linking…", true);
      const remote = await sync.preview(cfg);
      const remoteCount = remote ? (remote.wines || []).length : 0;
      const localCount = getAllWines().length;
      let joinReplace = true;
      if (remoteCount && localCount) {
        joinReplace = await askInline(
          `This cellar already has ${remoteCount} wine${remoteCount === 1 ? "" : "s"}. ` +
            `Use it on this device, or merge your ${localCount} into it?`,
          "use shared",
          "merge both"
        );
      }
      await sync.link(cfg, joinReplace);
      renderSync();
      render(filterInput.value);
      flashSyncStatus("linked — your devices now share this cellar");
    })
  );

  // Set up a brand-new shared cellar from Supabase details.
  syncCreateBtn.addEventListener(
    "click",
    runBusy(syncCreateBtn, async () => {
      const url = syncUrlInput.value.trim();
      const key = syncKeyInput.value.trim();
      const code = syncCodeInput.value.trim();
      if (!url || !key || !code) {
        flashSyncStatus("fill in the URL, key and code first");
        return;
      }
      flashSyncStatus("linking…", true);
      // New cellar from this device: push local wines up (no replace).
      await sync.link({ url, key, code }, false);
      renderSync();
      flashSyncStatus("linked — copy the sync code onto your other devices");
    })
  );

  syncNowBtn.addEventListener(
    "click",
    runBusy(syncNowBtn, async () => {
      flashSyncStatus("syncing…", true);
      const result = await sync.runSync();
      renderSync();
      flashSyncStatus(result.error ? (result.error.message || "sync failed") : "synced");
    })
  );

  syncCopyBtn.addEventListener("click", () => {
    const token = sync.makeToken();
    if (!token) return;
    copyText(token).then((ok) => {
      flashSyncStatus(ok ? "sync code copied — paste it on your other device" : "couldn't copy");
    });
  });

  syncUnlinkBtn.addEventListener("click", async () => {
    const ok = await askInline(
      "Unlink this device? Your wines stay here but stop syncing.",
      "unlink",
      "cancel"
    );
    if (!ok) return;
    sync.unlink();
    renderSync();
    flashSyncStatus("unlinked");
  });

  // Pull in others' changes when the app regains focus (e.g. switching back to
  // it on the phone), and once on boot.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sync.scheduleSync(300);
  });

  // -------------------------------------------------------------------
  // Compare module (Stage 2: run + results UI)
  // -------------------------------------------------------------------

  const compareEngine = window.WineCave.compare;
  const compareStore = window.WineCave.compareStore;

  const compareBtn = document.getElementById("compare-btn");
  const compareBackBtn = document.getElementById("compare-back-btn");
  const compareNewBtn = document.getElementById("compare-new-btn");
  const compareListEl = document.getElementById("compare-list");

  const compareBuildBackBtn = document.getElementById("compare-build-back-btn");
  const compareBuildTitle = document.getElementById("compare-build-title");
  const compareExtend = document.getElementById("compare-extend");
  const compareExtendTitle = document.getElementById("compare-extend-title");
  const comparePinned = document.getElementById("compare-pinned");
  const compareChosenEl = document.getElementById("compare-chosen");
  const compareAddCellarBtn = document.getElementById("compare-add-cellar-btn");
  const compareAddOutsideBtn = document.getElementById("compare-add-outside-btn");
  const compareCellarPicker = document.getElementById("compare-cellar-picker");
  const compareCellarSearch = document.getElementById("compare-cellar-search");
  const compareCellarResults = document.getElementById("compare-cellar-results");
  const compareOutsideForm = document.getElementById("compare-outside-form");
  const compareOutProducer = document.getElementById("compare-out-producer");
  const compareOutCuvee = document.getElementById("compare-out-cuvee");
  const compareOutGrape = document.getElementById("compare-out-grape");
  const compareOutVintage = document.getElementById("compare-out-vintage");
  const compareOutAddBtn = document.getElementById("compare-out-add-btn");
  const compareBuildHint = document.getElementById("compare-build-hint");

  const compareRun = document.getElementById("compare-run");
  const compareChooser = document.getElementById("compare-chooser");
  const compareChooseAi = document.getElementById("compare-choose-ai");
  const compareChooseFree = document.getElementById("compare-choose-free");
  const compareLoading = document.getElementById("compare-loading");
  const compareLoadingCancel = document.getElementById("compare-loading-cancel");
  const compareFail = document.getElementById("compare-fail");
  const compareFailMsg = document.getElementById("compare-fail-msg");
  const compareFailFree = document.getElementById("compare-fail-free");
  const compareFailCancel = document.getElementById("compare-fail-cancel");
  const compareRetryBtn = document.getElementById("compare-retry-btn");
  const compareManual = document.getElementById("compare-manual");
  const compareCopyBtn = document.getElementById("compare-copy-btn");
  const compareCopyStatus = document.getElementById("compare-copy-status");
  const comparePaste = document.getElementById("compare-paste");
  const compareManualError = document.getElementById("compare-manual-error");
  const compareManualCancel = document.getElementById("compare-manual-cancel");
  const compareManualReview = document.getElementById("compare-manual-review");

  const compareCardsEl = document.getElementById("compare-cards");
  const compareDotsEl = document.getElementById("compare-dots");
  const compareDetailTitle = document.getElementById("compare-detail-title");
  const compareDetailBackBtn = document.getElementById("compare-detail-back-btn");
  const compareDeleteBtn = document.getElementById("compare-delete-btn");
  const compareAddWineBtn = document.getElementById("compare-add-wine-btn");
  const comparePromote = document.getElementById("compare-promote");
  const comparePromoteList = document.getElementById("compare-promote-list");
  const comparePromoteBtn = document.getElementById("compare-promote-btn");
  const comparePromoteStatus = document.getElementById("compare-promote-status");

  let compareEntries = []; // entries being built
  let compareInFlight = null; // AbortController for an active run
  let currentComparisonId = null;
  let currentComparison = null; // the loaded comparison object (for promote)
  let compareExtendTarget = null; // id of the comparison being extended, or null
  let compareDeleteArmed = false;
  let compareDeleteTimer = null;

  function compareEntryLabel(entry) {
    const name = [entry.producer, entry.cuvee].filter(Boolean).join(" — ") || "unknown wine";
    return entry.vintage ? `${name} (${entry.vintage})` : name;
  }

  // ---- Saved list ----
  function openCompareList() {
    abortCompare();
    renderCompareList();
    showView("compare");
  }

  function renderCompareList() {
    const items = compareStore.list();
    compareListEl.innerHTML = "";
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "compare-empty";
      p.textContent = "No comparisons yet. Start one to compare wines side by side.";
      compareListEl.appendChild(p);
      return;
    }
    for (const c of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "compare-row";
      const title = document.createElement("p");
      title.className = "compare-row-title";
      title.textContent = c.title || "comparison";
      const meta = document.createElement("p");
      meta.className = "compare-row-meta";
      const n = (c.wines || []).length;
      meta.textContent = `${n} wine${n === 1 ? "" : "s"} · ${formatDate(c.updated_at)}`;
      row.appendChild(title);
      row.appendChild(meta);
      row.addEventListener("click", () => openComparison(c.id));
      compareListEl.appendChild(row);
    }
  }

  // ---- Builder ----
  function resetBuilder() {
    abortCompare();
    compareEntries = [];
    comparePaste.value = "";
    compareManualError.hidden = true;
    compareCellarPicker.hidden = true;
    compareCellarSearch.value = "";
    compareCellarResults.innerHTML = "";
    compareOutsideForm.hidden = true;
  }

  // Pin the chosen-wines block just below the sticky header (measured, so it
  // sits flush regardless of header height / extend banner).
  function setPinnedTop() {
    const header = viewCompareBuild.querySelector(".view-header");
    if (header && comparePinned) comparePinned.style.top = header.offsetHeight + "px";
  }

  function startNewComparison() {
    resetBuilder();
    compareExtendTarget = null;
    compareExtend.hidden = true;
    compareBuildTitle.textContent = "New comparison";
    renderChosen();
    showView("compare-build");
    setPinnedTop();
  }

  // Extend the open comparison: seed the builder with its wines, in extend mode.
  function extendComparison() {
    if (!currentComparison) return;
    resetBuilder();
    compareExtendTarget = currentComparison.id;
    compareEntries = (currentComparison.wines || []).map((e) => ({
      source: e.source,
      wine_id: e.wine_id,
      producer: e.producer,
      cuvee: e.cuvee,
      vintage: e.vintage,
      grape: e.grape || "",
      added_to_cellar_id: e.added_to_cellar_id || null,
    }));
    compareExtendTitle.textContent = currentComparison.title || "comparison";
    compareExtend.hidden = false;
    const buildRadio = compareExtend.querySelector('input[value="build"]');
    if (buildRadio) buildRadio.checked = true;
    compareBuildTitle.textContent = "Add a wine";
    renderChosen();
    showView("compare-build");
    setPinnedTop();
  }

  function extendMode() {
    const r = compareExtend.querySelector('input[name="compare-extend-mode"]:checked');
    return r ? r.value : "build";
  }

  function renderChosen() {
    compareChosenEl.innerHTML = "";
    compareEntries.forEach((entry, i) => {
      const li = document.createElement("li");
      li.className = "compare-chosen-item";
      const span = document.createElement("span");
      span.className = "compare-chosen-name";
      span.textContent = compareEntryLabel(entry);
      const src = document.createElement("span");
      src.className = "compare-chosen-src";
      src.textContent = entry.source === "cellar" ? "  · in cellar" : "  · outside";
      span.appendChild(src);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "compare-chosen-remove";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "Remove");
      rm.addEventListener("click", () => {
        compareEntries.splice(i, 1);
        renderChosen();
      });
      li.appendChild(span);
      li.appendChild(rm);
      compareChosenEl.appendChild(li);
    });

    const ready = compareEntries.length >= 2;
    compareRun.hidden = !ready;
    compareBuildHint.hidden = ready;
    if (ready) showCompareRunView("chooser");
  }

  function alreadyHasCellar(wineId) {
    return compareEntries.some((e) => e.source === "cellar" && e.wine_id === wineId);
  }

  // Search-first: nothing shows until you type, then matches appear. Uses the
  // same rich field search as the cellar (producer, region, grape, etc.).
  function renderCellarResults() {
    const q = compareCellarSearch.value.trim();
    compareCellarResults.innerHTML = "";
    if (!q) {
      const p = document.createElement("p");
      p.className = "compare-build-hint";
      p.textContent = "type to search — producer, region, grape…";
      compareCellarResults.appendChild(p);
      return;
    }
    const wines = filterWines(getAllWines(), q);
    if (!wines.length) {
      const p = document.createElement("p");
      p.className = "compare-build-hint";
      p.textContent = "no matches";
      compareCellarResults.appendChild(p);
      return;
    }
    wines.slice(0, 50).forEach((w) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "compare-pick-row";
      const label = [w.producer, w.cuvee].filter(Boolean).join(" — ") || "(untitled)";
      b.textContent = w.vintage ? `${label} (${w.vintage})` : label;
      if (alreadyHasCellar(w.id)) {
        b.disabled = true;
        b.textContent += "  ✓";
      }
      b.addEventListener("click", () => {
        if (alreadyHasCellar(w.id)) return;
        compareEntries.push(compareEngine.entryFromCellarWine(w));
        // Collapse the whole picker back to the two buttons + clear it.
        compareCellarPicker.hidden = true;
        compareCellarSearch.value = "";
        compareCellarResults.innerHTML = "";
        renderChosen();
      });
      compareCellarResults.appendChild(b);
    });
  }

  compareBtn.addEventListener("click", openCompareList);
  compareBackBtn.addEventListener("click", () => showView("home"));
  compareNewBtn.addEventListener("click", startNewComparison);
  compareBuildBackBtn.addEventListener("click", () => {
    abortCompare();
    if (compareExtendTarget) {
      const target = compareExtendTarget;
      compareExtendTarget = null;
      openComparison(target);
    } else {
      openCompareList();
    }
  });

  compareAddCellarBtn.addEventListener("click", () => {
    compareOutsideForm.hidden = true;
    compareCellarPicker.hidden = !compareCellarPicker.hidden;
    if (!compareCellarPicker.hidden) {
      compareCellarSearch.value = "";
      renderCellarResults();
      compareCellarSearch.focus();
    }
  });
  compareCellarSearch.addEventListener("input", renderCellarResults);

  compareAddOutsideBtn.addEventListener("click", () => {
    compareCellarPicker.hidden = true;
    compareOutsideForm.hidden = !compareOutsideForm.hidden;
    if (!compareOutsideForm.hidden) compareOutProducer.focus();
  });
  compareOutAddBtn.addEventListener("click", () => {
    const producer = compareOutProducer.value.trim();
    const cuvee = compareOutCuvee.value.trim();
    const grape = compareOutGrape.value.trim();
    const vintage = compareOutVintage.value.trim();
    if (!producer && !cuvee) {
      compareOutProducer.focus();
      return;
    }
    compareEntries.push(
      compareEngine.entryFromExternal({ producer, cuvee, grape, vintage: vintage || null }),
    );
    compareOutProducer.value = "";
    compareOutCuvee.value = "";
    compareOutGrape.value = "";
    compareOutVintage.value = "";
    compareOutsideForm.hidden = true; // collapse back to the two buttons
    renderChosen();
  });

  // ---- Run (AI / free) ----
  function showCompareRunView(name) {
    compareChooser.hidden = name !== "chooser";
    compareLoading.hidden = name !== "loading";
    compareFail.hidden = name !== "fail";
    compareManual.hidden = name !== "manual";
  }

  function abortCompare() {
    if (compareInFlight) {
      compareInFlight.abort();
      compareInFlight = null;
    }
  }

  // Resolve build entries → prompt items (seed cellar wines from catalogue).
  function compareItems() {
    const all = getAllWines();
    return compareEntries.map((entry) => {
      if (entry.source === "cellar") {
        const wine = all.find((w) => w.id === entry.wine_id);
        return {
          producer: entry.producer,
          cuvee: entry.cuvee,
          vintage: entry.vintage,
          known: wine ? compareEngine.cellarSeed(wine) : null,
        };
      }
      return {
        producer: entry.producer,
        cuvee: entry.cuvee,
        vintage: entry.vintage,
        known: entry.grape ? { grape: entry.grape } : null,
      };
    });
  }

  function saveAndOpenComparison(result) {
    const dimsList = result.dims;
    const summary = result.summary || "";
    const entries = compareEntries.map((e) => ({ ...e })); // detach from builder
    let cmp;
    if (compareExtendTarget && extendMode() === "build") {
      // Build on the existing comparison: re-run rewrites all wines + dims,
      // preserving the id, created_at and any promote links.
      const existing = compareStore.get(compareExtendTarget) || {};
      compareEngine.attachDims(entries, dimsList);
      cmp = {
        ...existing,
        id: compareExtendTarget,
        created_at: existing.created_at || new Date().toISOString(),
        title: compareEngine.comparisonTitle(entries),
        summary,
        updated_at: new Date().toISOString(),
        wines: entries,
      };
    } else {
      // New comparison (fresh, or "save as new" when extending).
      cmp = compareEngine.createComparison(entries, dimsList, summary);
    }
    compareStore.save(cmp);
    compareEntries = [];
    compareExtendTarget = null;
    compareExtend.hidden = true;
    openComparison(cmp.id);
  }

  function startCompareAuto() {
    if (compareEntries.length < 2) return;
    if (!researchApi.isConfigured()) {
      compareFailMsg.textContent =
        "AI isn't set up yet — link sync (it shares your Supabase project), or use free compare.";
      showCompareRunView("fail");
      return;
    }
    abortCompare();
    const controller = new AbortController();
    compareInFlight = controller;
    showCompareRunView("loading");
    const prompt = compareEngine.buildComparePrompt(compareItems());
    const count = compareEntries.length;
    researchApi
      .runPrompt(prompt, { signal: controller.signal })
      .then((apiResult) => {
        if (controller.signal.aborted) return;
        compareInFlight = null;
        let parsed;
        try {
          parsed = compareEngine.parseCompareResponse(apiResult.text, count);
        } catch (err) {
          compareFailMsg.textContent =
            "The comparison came back but couldn't be read. Try again, or use free compare.";
          showCompareRunView("fail");
          return;
        }
        saveAndOpenComparison(parsed);
      })
      .catch((err) => {
        if (controller.signal.aborted || (err && err.name === "AbortError")) return;
        compareInFlight = null;
        compareFailMsg.textContent = (err && err.message) || "Comparison failed. Try again.";
        showCompareRunView("fail");
      });
  }

  function showCompareManual() {
    abortCompare();
    compareManualError.hidden = true;
    showCompareRunView("manual");
  }

  compareChooseAi.addEventListener("click", startCompareAuto);
  compareChooseFree.addEventListener("click", showCompareManual);
  compareLoadingCancel.addEventListener("click", () => {
    abortCompare();
    showCompareRunView("chooser");
  });
  compareFailCancel.addEventListener("click", () => showCompareRunView("chooser"));
  compareFailFree.addEventListener("click", showCompareManual);
  compareRetryBtn.addEventListener("click", startCompareAuto);
  compareManualCancel.addEventListener("click", () => showCompareRunView("chooser"));

  compareCopyBtn.addEventListener("click", () => {
    if (compareEntries.length < 2) return;
    copyText(compareEngine.buildComparePrompt(compareItems())).then((ok) => {
      compareCopyStatus.textContent = ok ? "copied" : "couldn't copy — select the text manually";
      setTimeout(() => {
        compareCopyStatus.textContent = "";
      }, 2500);
    });
  });

  compareManualReview.addEventListener("click", () => {
    compareManualError.hidden = true;
    let parsed;
    try {
      parsed = compareEngine.parseCompareResponse(comparePaste.value, compareEntries.length);
    } catch (err) {
      compareManualError.textContent = err.message;
      compareManualError.hidden = false;
      return;
    }
    saveAndOpenComparison(parsed);
  });

  // ---- Detail (swipeable cards) ----
  function openComparison(id) {
    const cmp = compareStore.get(id);
    if (!cmp) {
      openCompareList();
      return;
    }
    currentComparisonId = id;
    currentComparison = cmp;
    compareDeleteArmed = false;
    compareDeleteBtn.textContent = "delete";
    compareDetailTitle.textContent = cmp.title || "comparison";
    renderCompareCards(cmp);
    renderPromote(cmp);
    showView("compare-detail");
    // Reset to the first card once visible — setting scrollLeft while the view
    // is still display:none doesn't take, which left it on the last card.
    requestAnimationFrame(() => {
      compareCardsEl.scrollLeft = 0;
      const dots = compareDotsEl.children;
      for (let k = 0; k < dots.length; k++) dots[k].classList.toggle("is-active", k === 0);
    });
  }

  // List external wines not yet added to the cellar, with checkboxes for bulk
  // add. Hidden when there's nothing left to promote.
  function renderPromote(cmp) {
    comparePromoteList.innerHTML = "";
    comparePromoteStatus.textContent = "";
    const externals = (cmp.wines || [])
      .map((entry, index) => ({ entry, index }))
      .filter((x) => x.entry.source === "external" && !x.entry.added_to_cellar_id);
    comparePromote.hidden = externals.length === 0;
    if (!externals.length) return;
    externals.forEach(({ entry, index }) => {
      const li = document.createElement("li");
      li.className = "compare-promote-item";
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.wineIndex = String(index);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + compareEntryLabel(entry)));
      li.appendChild(label);
      comparePromoteList.appendChild(li);
    });
  }

  // Build a catalogue stub from an external comparison entry: populate the
  // catalogue fields directly from the comparison's dims (simple populate now;
  // full research later). Flagged needs_research.
  function stubWineFromEntry(entry) {
    const d = entry.dims || {};
    const val = (k) => (d[k] && d[k].value) || "";
    const conf = (k) => d[k] && d[k].confidence;
    const partial = {
      producer: entry.producer || "",
      cuvee: entry.cuvee || "",
      vintage: entry.vintage || null,
      vinification: val("vinification"),
      expert_context: val("reputation"),
      tech_facts: {
        grape_varietals: val("grape"),
        terroir_type: val("terroir"),
      },
      tasting_notes: { notes: val("tasting") },
      needs_research: true,
    };
    const flags = {};
    if (val("grape")) flags.grape_varietals = conf("grape");
    if (val("terroir")) flags.terroir_type = conf("terroir");
    if (val("vinification")) flags.vinification = conf("vinification");
    if (val("tasting")) flags.tasting_notes = conf("tasting");
    if (val("reputation")) flags.expert_context = conf("reputation");
    partial.confidence_flags = flags;
    return createWine(partial);
  }

  comparePromoteBtn.addEventListener("click", () => {
    if (!currentComparison) return;
    const checks = [...comparePromoteList.querySelectorAll("input[type=checkbox]:checked")];
    if (!checks.length) {
      comparePromoteStatus.textContent = "select at least one wine";
      return;
    }
    let added = 0;
    checks.forEach((cb) => {
      const idx = Number(cb.dataset.wineIndex);
      const entry = currentComparison.wines[idx];
      if (!entry || entry.added_to_cellar_id) return;
      const saved = saveWine(stubWineFromEntry(entry));
      entry.added_to_cellar_id = saved.id;
      added++;
    });
    if (!added) return;
    currentComparison.updated_at = new Date().toISOString();
    compareStore.save(currentComparison);
    sync.scheduleSync();
    render(filterInput.value); // refresh the cellar list (with "needs info" badges)
    renderCompareCards(currentComparison);
    renderPromote(currentComparison);
    comparePromoteStatus.textContent = `added ${added} to cellar — find ${added === 1 ? "it" : "them"} in your cellar`;
    setTimeout(() => {
      comparePromoteStatus.textContent = "";
    }, 3500);
  });

  // One card per dimension, comparing every wine within it (swipe across the
  // five dimensions, plus a final sources card).
  function renderCompareCards(cmp) {
    compareCardsEl.innerHTML = "";
    compareDotsEl.innerHTML = "";
    const wines = cmp.wines || [];
    const cards = [];

    // First card: high-level summary of the main differences.
    if (cmp.summary) {
      const card = document.createElement("article");
      card.className = "compare-card compare-card--summary";
      const title = document.createElement("p");
      title.className = "compare-card-title";
      title.textContent = "summary";
      const val = document.createElement("p");
      val.className = "compare-dim-value";
      val.textContent = cmp.summary;
      card.appendChild(title);
      card.appendChild(val);
      cards.push(card);
    }

    // A wine's name line inside a card, with an optional confidence dot.
    function wineNameLine(entry, confidence) {
      const p = document.createElement("p");
      p.className = "compare-wine-name";
      if (confidence) {
        const dot = document.createElement("span");
        dot.className = "confidence-dot";
        dot.dataset.confidence = confidence;
        dot.title = CONFIDENCE_TITLES[confidence] || confidence;
        p.appendChild(dot);
      }
      p.appendChild(document.createTextNode(compareEntryLabel(entry)));
      return p;
    }

    for (const d of compareEngine.COMPARE_DIMENSIONS) {
      const card = document.createElement("article");
      card.className = "compare-card";
      const title = document.createElement("p");
      title.className = "compare-card-title";
      title.textContent = d.label;
      card.appendChild(title);

      wines.forEach((entry) => {
        const dims = entry.dims || compareEngine.emptyDims();
        const field = dims[d.key] || { value: "", confidence: "not_found" };
        const block = document.createElement("div");
        block.className = "compare-wine-block";
        block.appendChild(wineNameLine(entry, field.confidence));
        const val = document.createElement("p");
        val.className = "compare-dim-value";
        val.textContent = field.value || "—";
        block.appendChild(val);
        card.appendChild(block);
      });

      cards.push(card);
    }

    // (Sources are still gathered and stored per wine for later use, but not
    // shown as a card here — the comparison view stays punchy.)

    cards.forEach((c) => compareCardsEl.appendChild(c));

    if (cards.length > 1) {
      cards.forEach((_, i) => {
        const dot = document.createElement("span");
        dot.className = "compare-dot" + (i === 0 ? " is-active" : "");
        compareDotsEl.appendChild(dot);
      });
    }
    compareCardsEl.scrollLeft = 0;
  }

  // Update the active position dot as the user swipes.
  compareCardsEl.addEventListener("scroll", () => {
    const dots = compareDotsEl.children;
    if (!dots.length) return;
    const w = compareCardsEl.clientWidth || 1;
    const i = Math.round(compareCardsEl.scrollLeft / w);
    for (let k = 0; k < dots.length; k++) {
      dots[k].classList.toggle("is-active", k === i);
    }
  });

  compareAddWineBtn.addEventListener("click", extendComparison);
  compareDetailBackBtn.addEventListener("click", openCompareList);
  compareDeleteBtn.addEventListener("click", () => {
    if (!currentComparisonId) return;
    // Two-tap confirm (native confirm() is unreliable in an installed PWA, and
    // the inline sync confirm lives in the hidden settings sheet).
    if (!compareDeleteArmed) {
      compareDeleteArmed = true;
      compareDeleteBtn.textContent = "tap again to delete";
      compareDeleteTimer = setTimeout(() => {
        compareDeleteArmed = false;
        compareDeleteBtn.textContent = "delete";
      }, 3000);
      return;
    }
    clearTimeout(compareDeleteTimer);
    compareDeleteArmed = false;
    compareDeleteBtn.textContent = "delete";
    compareStore.remove(currentComparisonId);
    currentComparisonId = null;
    currentComparison = null;
    openCompareList();
  });

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------

  if (sync.isLinked()) sync.scheduleSync(300);
  render();
  applyRainbow(document); // rainbow chrome on load if Comic is the saved theme

  // Register the service worker for installability (PWA). Service workers
  // require http(s) — this silently no-ops when opened via file://.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        /* offline support is a nice-to-have, not load-bearing for the MVP */
      });
    });
  }
})();
