// ---------------------------------------------------------------------------
// Wine Cave — data layer
//
// Local-first storage for the wine collection (Open Decision 1: local-first
// to start; this module is the single seam to swap in a cloud backend later
// without touching the rest of the app — every other file only calls the
// functions exported here).
//
// Plain script (not an ES module) so the app can be opened directly via
// file:// without a server — everything is exposed on window.WineCave.
// ---------------------------------------------------------------------------

(function () {
  const STORAGE_KEY = "wineCave:wines:v1";
  // Deletions are remembered as tombstones { id: ISO-timestamp } so a delete on
  // one device can win over a stale copy on another when syncing.
  const TOMBSTONE_KEY = "wineCave:tombstones:v1";
  // Tombstones older than this are pruned so the list can't grow forever. A
  // device offline longer than this could in theory resurrect a deleted wine.
  const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 365; // 1 year

  // Stable internal keys for ownership status. Display strings live in
  // STATUS_LABELS so the wording can change without touching data or logic.
  const STATUS = {
    EN_CAVE: "en_cave",
    AUSGETRUNKEN: "ausgetrunken",
    ENVIE: "envie",
  };

  const STATUS_LABELS = {
    [STATUS.EN_CAVE]: "En cave",
    [STATUS.AUSGETRUNKEN]: "Ausgetrunken",
    [STATUS.ENVIE]: "Envie",
  };

  // Confidence flag values used per-field on researched content (Phase B).
  const CONFIDENCE = {
    SOURCED: "sourced",
    INFERRED: "inferred",
    NOT_FOUND: "not_found",
  };

  /**
   * @typedef {Object} Winemaker
   * @property {string} name
   * @property {string|null} email
   * @property {string|null} phone
   * @property {string|null} instagram
   */

  /**
   * @typedef {Object} Wine
   * @property {string} id
   * @property {string} producer
   * @property {string} cuvee
   * @property {string|null} vintage          - e.g. "2021" or "NV"
   * @property {string} status                - one of STATUS values
   * @property {string} date_added            - ISO timestamp
   * @property {string|null} date_status_changed - ISO timestamp, e.g. date finished
   * @property {string|null} label_photo      - data URL or path, optional
   * @property {string} user_notes
   * @property {Object} tech_facts
   * @property {string} tech_facts.grape_varietals
   * @property {string} tech_facts.producer
   * @property {string} tech_facts.year
   * @property {string} tech_facts.terroir_type
   * @property {string} tech_facts.colour
   * @property {string} tech_facts.country
   * @property {string} tech_facts.region
   * @property {string} vinification          - narrative, concrete facts only
   * @property {Object} tasting_notes
   * @property {string} tasting_notes.notes
   * @property {string} tasting_notes.drinking_window
   * @property {Winemaker[]} winemakers
   * @property {string[]} sources             - URLs / citations
   * @property {Object.<string,string>} confidence_flags - field -> CONFIDENCE value
   * @property {string|null} last_researched  - ISO timestamp
   */

  /**
   * Build a fully-shaped Wine object, filling in defaults for any field not
   * supplied. Keeps the category structure (§5) consistent everywhere so new
   * categories can be added later without a migration.
   * @param {Partial<Wine>} [partial]
   * @returns {Wine}
   */
  function createWine(partial = {}) {
    const now = new Date().toISOString();
    return {
      id: partial.id || generateId(),
      updated_at: partial.updated_at || now,
      producer: partial.producer ?? "",
      cuvee: partial.cuvee ?? "",
      vintage: partial.vintage ?? null,
      status: partial.status || STATUS.EN_CAVE,
      bottles: partial.bottles ?? 1,
      date_added: partial.date_added || now,
      date_status_changed: partial.date_status_changed ?? null,
      label_photo: partial.label_photo ?? null,
      user_notes: partial.user_notes ?? "",
      expert_context: partial.expert_context ?? "",
      tech_facts: {
        grape_varietals: "",
        producer: partial.producer ?? "",
        year: partial.vintage ?? "",
        terroir_type: "",
        colour: "",
        country: "",
        region: "",
        ...(partial.tech_facts || {}),
      },
      vinification: partial.vinification ?? "",
      tasting_notes: {
        notes: "",
        drinking_window: "",
        ...(partial.tasting_notes || {}),
      },
      winemakers: partial.winemakers ?? [],
      sources: partial.sources ?? [],
      confidence_flags: partial.confidence_flags ?? {},
      last_researched: partial.last_researched ?? null,
      // True for stubs added from a comparison: identity (+ seeded context) is
      // set but the catalogue fields still need a full research pass.
      needs_research: partial.needs_research ?? false,
    };
  }

  function generateId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "wine_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Read every wine from storage. @returns {Wine[]} */
  function getAllWines() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error("Wine Cave: failed to read storage", err);
      return [];
    }
  }

  function writeAllWines(wines) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wines));
  }

  /** Look up a single wine by id. @returns {Wine|undefined} */
  function getWine(id) {
    return getAllWines().find((w) => w.id === id);
  }

  /**
   * Insert or update a wine (matched by id).
   * @param {Wine} wine
   * @returns {Wine}
   */
  function saveWine(wine) {
    // Stamp the edit time so sync can tell which device's copy is newest. This
    // is the user-edit path; the sync layer writes via applyCellar() instead,
    // which preserves timestamps so merging stays stable.
    wine.updated_at = new Date().toISOString();
    const wines = getAllWines();
    const idx = wines.findIndex((w) => w.id === wine.id);
    if (idx === -1) {
      wines.push(wine);
    } else {
      wines[idx] = wine;
    }
    writeAllWines(wines);
    return wine;
  }

  /** Remove a wine by id, leaving a tombstone so the delete can sync. */
  function deleteWine(id) {
    writeAllWines(getAllWines().filter((w) => w.id !== id));
    const tombstones = getTombstones();
    tombstones[id] = new Date().toISOString();
    writeTombstones(tombstones);
  }

  // -------------------------------------------------------------------------
  // Tombstones + whole-cellar helpers (used by the sync layer)
  // -------------------------------------------------------------------------

  function getTombstones() {
    try {
      const raw = localStorage.getItem(TOMBSTONE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function writeTombstones(tombstones) {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(pruneTombstones(tombstones)));
  }

  function pruneTombstones(tombstones) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    const out = {};
    for (const [id, iso] of Object.entries(tombstones || {})) {
      if (parseTime(iso) >= cutoff) out[id] = iso;
    }
    return out;
  }

  /** The whole local cellar as one document, for syncing. */
  function getCellar() {
    return { wines: getAllWines(), tombstones: getTombstones() };
  }

  /** Replace the local cellar verbatim (no re-stamping) — used by sync. */
  function applyCellar(cellar) {
    const wines = Array.isArray(cellar && cellar.wines) ? cellar.wines : [];
    const tombstones = (cellar && cellar.tombstones) || {};
    writeAllWines(wines);
    writeTombstones(tombstones);
    return getCellar();
  }

  function parseTime(iso) {
    const t = Date.parse(iso);
    return isNaN(t) ? 0 : t;
  }

  // A wine's effective modified time: its updated_at, falling back to when it
  // was added (older records pre-date the updated_at field).
  function wineTime(wine) {
    return parseTime(wine && wine.updated_at) || parseTime(wine && wine.date_added);
  }

  /**
   * Merge two cellars into one, convergently (order-independent):
   *  - For a wine present on both sides, the copy with the newer edit time wins.
   *  - A deletion (tombstone) beats a wine only if the delete is newer than the
   *    wine's last edit; a later edit "resurrects" the wine and clears the
   *    tombstone.
   * Pure: returns { wines, tombstones } without touching storage.
   */
  function mergeCellars(a, b) {
    a = a || { wines: [], tombstones: {} };
    b = b || { wines: [], tombstones: {} };

    const winesById = new Map();
    for (const w of a.wines || []) winesById.set(w.id, w);
    for (const w of b.wines || []) {
      const cur = winesById.get(w.id);
      if (!cur || wineTime(w) >= wineTime(cur)) winesById.set(w.id, w);
    }

    const tombstones = {};
    for (const src of [a.tombstones || {}, b.tombstones || {}]) {
      for (const [id, iso] of Object.entries(src)) {
        if (!tombstones[id] || parseTime(iso) > parseTime(tombstones[id])) tombstones[id] = iso;
      }
    }

    const wines = [];
    for (const [id, w] of winesById) {
      const tomb = tombstones[id] ? parseTime(tombstones[id]) : 0;
      if (tomb > wineTime(w)) continue; // deletion wins → drop the wine
      wines.push(w); // wine wins…
      delete tombstones[id]; // …so its tombstone (if any) is obsolete
    }

    return { wines, tombstones: pruneTombstones(tombstones) };
  }

  /**
   * Replace the whole collection (used by Import / restore-from-backup). Every
   * incoming record is passed through createWine so missing/older fields are
   * filled with defaults and the shape stays consistent.
   * @param {Partial<Wine>[]} wines
   * @returns {Wine[]} the normalized, stored wines
   */
  function replaceAllWines(wines) {
    const normalized = (Array.isArray(wines) ? wines : []).map((w) => createWine(w));
    writeAllWines(normalized);
    return normalized;
  }

  /**
   * Change a wine's ownership status, recording date_status_changed when
   * transitioning to Ausgetrunken (and clearing it otherwise).
   * @param {string} id
   * @param {string} status - one of STATUS values
   */
  function setWineStatus(id, status) {
    const wine = getWine(id);
    if (!wine) return undefined;
    wine.status = status;
    wine.date_status_changed = status === STATUS.AUSGETRUNKEN ? new Date().toISOString() : null;
    saveWine(wine);
    return wine;
  }

  /**
   * Live filter across the fields a person would actually search by:
   * producer, cuvée, vintage, region, country, grape varietals, colour,
   * terroir, notes. Multiple whitespace-separated terms are AND-matched, so
   * "jura 2018" narrows to Jura wines from 2018 (matches the placeholder's
   * comma-separated promise rather than requiring one contiguous string).
   * @param {Wine[]} wines
   * @param {string} query
   * @returns {Wine[]}
   */
  function filterWines(wines, query) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return wines;
    return wines.filter((w) => {
      const haystack = [
        w.producer,
        w.cuvee,
        w.vintage,
        w.tech_facts?.region,
        w.tech_facts?.country,
        w.tech_facts?.grape_varietals,
        w.tech_facts?.colour,
        w.tech_facts?.terroir_type,
        w.user_notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }

  /**
   * Seed the catalogue with a few sample wines on first run so the design and
   * collection view have something real to show. No-op if data already exists.
   */
  function seedIfEmpty() {
    if (getAllWines().length > 0) return;

    const samples = [
      createWine({
        producer: "Domaine Bernaudeau",
        cuvee: "Les Nourrissons",
        vintage: "2020",
        status: STATUS.EN_CAVE,
        tech_facts: {
          grape_varietals: "Cabernet Franc",
          colour: "Rouge",
          country: "France",
          region: "Anjou",
        },
      }),
      createWine({
        producer: "Pierre Overnoy",
        cuvee: "Pupillin",
        vintage: "2018",
        status: STATUS.EN_CAVE,
        tech_facts: {
          grape_varietals: "Poulsard",
          colour: "Rouge",
          country: "France",
          region: "Jura",
        },
      }),
      createWine({
        producer: "Domaine Belluard",
        cuvee: "Les Alpes",
        vintage: "2021",
        status: STATUS.ENVIE,
        tech_facts: {
          grape_varietals: "Gringet",
          colour: "Blanc",
          country: "France",
          region: "Savoie",
        },
      }),
      createWine({
        producer: "Clos Saron",
        cuvee: "Le Vin Est une Fete",
        vintage: "2017",
        status: STATUS.AUSGETRUNKEN,
        date_status_changed: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
        tech_facts: {
          grape_varietals: "Pinot Noir",
          colour: "Rouge",
          country: "USA",
          region: "Sierra Foothills",
        },
      }),
      createWine({
        producer: "Domaine de la Pinte",
        cuvee: "Chardonnay Tradition",
        vintage: "2019",
        status: STATUS.EN_CAVE,
        tech_facts: {
          grape_varietals: "Chardonnay",
          colour: "Blanc",
          country: "France",
          region: "Jura",
        },
      }),
      createWine({
        producer: "Le Clos du Tue-Boeuf",
        cuvee: "Petite Vigne",
        vintage: "NV",
        status: STATUS.EN_CAVE,
        tech_facts: {
          grape_varietals: "Gamay",
          colour: "Rouge",
          country: "France",
          region: "Loire",
        },
      }),
    ];

    writeAllWines(samples);
  }

  // Public surface, attached to window so plain <script> tags can use it.
  window.WineCave = {
    STATUS,
    STATUS_LABELS,
    CONFIDENCE,
    createWine,
    getAllWines,
    getWine,
    saveWine,
    deleteWine,
    setWineStatus,
    filterWines,
    seedIfEmpty,
    replaceAllWines,
    getTombstones,
    getCellar,
    applyCellar,
    mergeCellars,
  };
})();
