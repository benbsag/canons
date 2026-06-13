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

  const CONFIDENCE_TITLES = {
    sourced: "Found in a reliable source",
    inferred: "Reasoned from related facts",
    not_found: "No reliable information found",
  };

  const listEl = document.getElementById("wine-list");
  const filterInput = document.getElementById("filter-input");

  const viewHome = document.getElementById("view-home");
  const viewAdd = document.getElementById("view-add");
  const viewDetail = document.getElementById("view-detail");

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

  // Ensure there's something to look at on first run.
  seedIfEmpty();

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
    window.scrollTo(0, 0);
  }

  // -------------------------------------------------------------------
  // Home: collection list
  // -------------------------------------------------------------------

  function regionKey(wine) {
    return (wine.tech_facts && wine.tech_facts.region) || "other";
  }

  /**
   * Group wines by region, sort regions alphabetically, and sort wines
   * within a region by producer. Matches the wine-list-page layout in §8.
   */
  function groupByRegion(wines) {
    const groups = new Map();
    for (const wine of wines) {
      const key = regionKey(wine);
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

    detailSaveStatusEl.textContent = "saved";
    setTimeout(() => {
      detailSaveStatusEl.textContent = "";
    }, 1500);
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

    const inputView = panel.querySelector(".research-input");
    const reviewView = panel.querySelector(".research-review");
    const copyBtn = panel.querySelector(".research-copy-btn");
    const copyStatus = panel.querySelector(".research-copy-status");
    const paste = panel.querySelector(".research-paste");
    const errorEl = panel.querySelector(".research-error");
    const cancelBtn = panel.querySelector(".research-cancel-btn");
    const reviewBtn = panel.querySelector(".research-review-btn");
    const previewList = panel.querySelector(".research-preview-list");
    const backBtn = panel.querySelector(".research-back-btn");
    const applyBtn = panel.querySelector(".research-apply-btn");

    let pending = null;

    function close() {
      pending = null;
      panel.hidden = true;
      inputView.hidden = false;
      reviewView.hidden = true;
      paste.value = "";
      errorEl.hidden = true;
      errorEl.textContent = "";
      copyStatus.textContent = "";
      previewList.innerHTML = "";
    }

    trigger.addEventListener("click", () => {
      if (!isReady()) return;
      if (panel.hidden) {
        close();
        panel.hidden = false;
      } else {
        close();
      }
    });

    cancelBtn.addEventListener("click", close);

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
      pending = parsed;
      // Preview against current form state so unsaved edits count as "current".
      renderResearchPreview(previewList, parsed, buildBase());
      inputView.hidden = true;
      reviewView.hidden = false;
    });

    backBtn.addEventListener("click", () => {
      reviewView.hidden = true;
      inputView.hidden = false;
    });

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
  // Boot
  // -------------------------------------------------------------------

  render();

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
