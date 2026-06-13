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
  const searchWineBtn = document.getElementById("search-wine-btn");
  const addBackBtn = document.getElementById("add-back-btn");
  const addForm = document.getElementById("add-form");
  const addFieldsContainer = document.getElementById("add-fields");

  const detailBackBtn = document.getElementById("detail-back-btn");
  const detailDeleteBtn = document.getElementById("detail-delete-btn");
  const detailForm = document.getElementById("detail-form");
  const detailFieldsContainer = document.getElementById("detail-fields");
  const detailMetaEl = document.getElementById("detail-meta");
  const detailSaveStatusEl = document.getElementById("detail-save-status");

  // Research panel (dossier paste-back)
  const researchToggleBtn = document.getElementById("research-toggle-btn");
  const researchPanel = document.getElementById("research-panel");
  const researchInputView = document.getElementById("research-input");
  const researchReviewView = document.getElementById("research-review");
  const researchCopyBtn = document.getElementById("research-copy-btn");
  const researchCopyStatus = document.getElementById("research-copy-status");
  const researchPaste = document.getElementById("research-paste");
  const researchError = document.getElementById("research-error");
  const researchCancelBtn = document.getElementById("research-cancel-btn");
  const researchReviewBtn = document.getElementById("research-review-btn");
  const researchPreviewList = document.getElementById("research-preview-list");
  const researchBackBtn = document.getElementById("research-back-btn");
  const researchApplyBtn = document.getElementById("research-apply-btn");

  const fieldsTemplate = document.getElementById("wine-fields-template");
  const winemakerRowTemplate = document.getElementById("winemaker-row-template");

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
      winemakersList: container.querySelector(".winemakers-list"),
      addWinemakerBtn: container.querySelector(".add-winemaker-btn"),
      userNotes: container.querySelector(".f-user-notes"),
      photoPreview: container.querySelector(".f-photo-preview"),
      photoEmpty: container.querySelector(".photo-empty"),
      photoTools: container.querySelector(".photo-tools"),
      photoInputs: [...container.querySelectorAll(".f-photo-input, .f-photo-input-replace")],
      photoRemove: container.querySelector(".photo-remove"),
      photoData: null,
    };
  }

  function setActiveStatus(refs, status) {
    for (const btn of refs.statusButtons) {
      btn.classList.toggle("is-active", btn.dataset.status === status);
    }
  }

  // -------------------------------------------------------------------
  // Label photo: captured/attached, downscaled, stored as a JPEG data URL
  // (keeps localStorage small — full-res phone photos would blow the quota).
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

  function addWinemakerRow(winemakersList, data = {}) {
    const frag = winemakerRowTemplate.content.cloneNode(true);
    const row = frag.querySelector(".winemaker-row");
    row.querySelector(".wm-name").value = data.name || "";
    row.querySelector(".wm-email").value = data.email || "";
    row.querySelector(".wm-phone").value = data.phone || "";
    row.querySelector(".wm-instagram").value = data.instagram || "";
    row.querySelector(".remove-winemaker").addEventListener("click", () => row.remove());
    winemakersList.appendChild(row);
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
    refs.userNotes.value = wine.user_notes || "";
    setPhoto(refs, wine.label_photo);
    refs.winemakersList.innerHTML = "";
    for (const winemaker of wine.winemakers || []) {
      addWinemakerRow(refs.winemakersList, winemaker);
    }
    renderProvenance(refs, wine);
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
    const winemakers = [...refs.winemakersList.querySelectorAll(".winemaker-row")]
      .map((row) => ({
        name: row.querySelector(".wm-name").value.trim(),
        email: row.querySelector(".wm-email").value.trim() || null,
        phone: row.querySelector(".wm-phone").value.trim() || null,
        instagram: row.querySelector(".wm-instagram").value.trim() || null,
      }))
      .filter((w) => w.name);

    const producer = refs.producer.value.trim();
    const vintage = refs.vintage.value.trim();

    return {
      ...base,
      producer,
      cuvee: refs.cuvee.value.trim(),
      vintage: vintage || null,
      status,
      label_photo: refs.photoData ?? null,
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
      user_notes: refs.userNotes.value.trim(),
      winemakers,
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

    const cuvee = document.createElement("span");
    cuvee.className = "wine-cuvee";
    cuvee.textContent = wine.cuvee;
    main.appendChild(cuvee);

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

  // "hunt" — jump to the quick filter. On a long, scrolled list the header
  // (and its filter) is off-screen; this brings it back, focuses, and selects
  // any existing query so you can type straight over it. (Online lookup is
  // Phase B; for now hunt == "let me search what I already have".)
  searchWineBtn.addEventListener("click", () => {
    window.scrollTo(0, 0);
    filterInput.focus();
    filterInput.select();
  });

  // -------------------------------------------------------------------
  // Add Wine
  // -------------------------------------------------------------------

  let addRefs = null;
  let addSelectedStatus = STATUS.EN_CAVE;

  addWineBtn.addEventListener("click", () => {
    addRefs = instantiateFields(addFieldsContainer);
    addSelectedStatus = STATUS.EN_CAVE;
    setActiveStatus(addRefs, addSelectedStatus);

    for (const btn of addRefs.statusButtons) {
      btn.addEventListener("click", () => {
        addSelectedStatus = btn.dataset.status;
        setActiveStatus(addRefs, addSelectedStatus);
      });
    }
    addRefs.addWinemakerBtn.addEventListener("click", () => addWinemakerRow(addRefs.winemakersList));
    wirePhotoField(addRefs);

    showView("add");
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

    const base = createWine();
    const wine = readFieldsIntoWine(addRefs, base, addSelectedStatus);
    if (addSelectedStatus === STATUS.AUSGETRUNKEN) {
      wine.date_status_changed = new Date().toISOString();
    }

    saveWine(wine);
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
    wirePhotoField(detailRefs);
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
    detailRefs.addWinemakerBtn.addEventListener("click", () => addWinemakerRow(detailRefs.winemakersList));

    renderDetailMeta();
    detailSaveStatusEl.textContent = "";
    closeResearch();
    showView("detail");
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

  let pendingResearch = null;

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

  function closeResearch() {
    pendingResearch = null;
    researchPanel.hidden = true;
    researchInputView.hidden = false;
    researchReviewView.hidden = true;
    researchPaste.value = "";
    researchError.hidden = true;
    researchError.textContent = "";
    researchCopyStatus.textContent = "";
    researchPreviewList.innerHTML = "";
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

  function renderResearchPreview(parsed, baseWine) {
    researchPreviewList.innerHTML = "";

    for (const f of RESEARCH_FIELDS) {
      const field = parsed.fields[f.key];
      if (!field || !field.value) continue;
      const current = window.WineCave.research.getWineFieldValue(baseWine, f.key);
      const willOverwrite = Boolean(current) && current !== field.value;
      researchPreviewList.appendChild(
        makePreviewRow({
          key: f.key,
          label: f.label,
          confidence: field.confidence,
          proposed: field.value,
          current,
          willOverwrite,
          checked: !current, // preselect only when the field is empty
        })
      );
    }

    if (parsed.winemakers.length) {
      researchPreviewList.appendChild(
        makePreviewRow({
          key: "winemakers",
          label: "winemakers",
          confidence: null,
          proposed: parsed.winemakers.map((w) => w.name).join(", "),
          current: "",
          willOverwrite: false,
          checked: true,
        })
      );
    }

    if (parsed.sources.length) {
      const note = document.createElement("p");
      note.className = "research-sources-note";
      const n = parsed.sources.length;
      note.textContent = `${n} source${n > 1 ? "s" : ""} will be added.`;
      researchPreviewList.appendChild(note);
    }

    if (!researchPreviewList.children.length) {
      const p = document.createElement("p");
      p.className = "research-empty";
      p.textContent = "The reply didn't contain any new facts to add.";
      researchPreviewList.appendChild(p);
    }
  }

  researchToggleBtn.addEventListener("click", () => {
    if (researchPanel.hidden) {
      closeResearch();
      researchPanel.hidden = false;
    } else {
      closeResearch();
    }
  });

  researchCancelBtn.addEventListener("click", closeResearch);

  researchCopyBtn.addEventListener("click", () => {
    if (!currentWine) return;
    copyText(buildResearchPrompt(currentWine)).then((ok) => {
      researchCopyStatus.textContent = ok ? "copied" : "couldn't copy — select the text manually";
      setTimeout(() => {
        researchCopyStatus.textContent = "";
      }, 2500);
    });
  });

  researchReviewBtn.addEventListener("click", () => {
    if (!currentWine || !detailRefs) return;
    researchError.hidden = true;
    let parsed;
    try {
      parsed = parseResearchResponse(researchPaste.value);
    } catch (err) {
      researchError.textContent = err.message;
      researchError.hidden = false;
      return;
    }
    pendingResearch = parsed;
    // Preview against the current form state so unsaved edits count as "current".
    const baseWine = readFieldsIntoWine(detailRefs, currentWine, currentWine.status);
    renderResearchPreview(parsed, baseWine);
    researchInputView.hidden = true;
    researchReviewView.hidden = false;
  });

  researchBackBtn.addEventListener("click", () => {
    researchReviewView.hidden = true;
    researchInputView.hidden = false;
  });

  researchApplyBtn.addEventListener("click", () => {
    if (!pendingResearch || !currentWine || !detailRefs) return;
    const acceptedKeys = [...researchPreviewList.querySelectorAll(".preview-check")]
      .filter((c) => c.checked)
      .map((c) => c.dataset.key);

    // Fold in any unsaved form edits, then layer the accepted research on top.
    const base = readFieldsIntoWine(detailRefs, currentWine, currentWine.status);
    currentWine = applyResearchToWine(base, pendingResearch, acceptedKeys);
    saveWine(currentWine);

    writeWineToFields(detailRefs, currentWine);
    renderDetailMeta();
    closeResearch();

    detailSaveStatusEl.textContent = "researched";
    setTimeout(() => {
      detailSaveStatusEl.textContent = "";
    }, 1800);
  });

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
