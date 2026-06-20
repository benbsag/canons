// ---------------------------------------------------------------------------
// Wine Cave — comparison store (local-first, syncable)
//
// Persists saved comparisons in localStorage. Comparisons are included in
// export/import for backup, and now also sync across devices: getDoc/applyDoc
// expose the comparisons + deletion tombstones as one document, which the sync
// layer merges with the same newest-edit-wins logic used for wines.
//
// Exposed on window.WineCave.compareStore.
// ---------------------------------------------------------------------------

(function () {
  const STORAGE_KEY = "wineCave:comparisons:v1";
  // Deletions are remembered as tombstones { id: ISO } so a delete on one
  // device wins over a stale copy on another when syncing.
  const TOMBSTONE_KEY = "wineCave:comparisonTombstones:v1";
  const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 365; // 1 year

  function readAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      return [];
    }
  }

  function writeAll(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      /* quota / private mode — comparison just won't persist */
    }
  }

  function readTombstones() {
    try {
      const raw = localStorage.getItem(TOMBSTONE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function pruneTombstones(tombstones) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    const out = {};
    for (const [id, iso] of Object.entries(tombstones || {})) {
      const t = Date.parse(iso);
      if (!isNaN(t) && t >= cutoff) out[id] = iso;
    }
    return out;
  }

  function writeTombstones(tombstones) {
    try {
      localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(pruneTombstones(tombstones)));
    } catch (err) {
      /* quota / private mode */
    }
  }

  /** All comparisons, newest-updated first. */
  function list() {
    return readAll().sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
  }

  function get(id) {
    return readAll().find((c) => c.id === id) || null;
  }

  /** Insert or update a comparison (matched by id). Returns the saved object. */
  function save(comparison) {
    if (!comparison || !comparison.id) return comparison;
    const all = readAll();
    const i = all.findIndex((c) => c.id === comparison.id);
    if (i === -1) all.push(comparison);
    else all[i] = comparison;
    writeAll(all);
    // Saving clears any stale tombstone for this id (a re-created comparison
    // wins over its own past deletion).
    const t = readTombstones();
    if (t[comparison.id]) {
      delete t[comparison.id];
      writeTombstones(t);
    }
    return comparison;
  }

  function remove(id) {
    writeAll(readAll().filter((c) => c.id !== id));
    const t = readTombstones();
    t[id] = new Date().toISOString();
    writeTombstones(t);
  }

  /** Replace the whole store (used when restoring an import backup). */
  function replaceAll(comparisons) {
    writeAll(Array.isArray(comparisons) ? comparisons : []);
    writeTombstones({}); // a restore is the new source of truth
  }

  function getTombstones() {
    return readTombstones();
  }

  /** The whole local comparison set as one document, for syncing. */
  function getDoc() {
    return { comparisons: readAll(), tombstones: readTombstones() };
  }

  /** Replace the local comparison set verbatim — used by sync after merging. */
  function applyDoc(doc) {
    writeAll(Array.isArray(doc && doc.comparisons) ? doc.comparisons : []);
    writeTombstones((doc && doc.tombstones) || {});
  }

  window.WineCave.compareStore = {
    list,
    get,
    save,
    remove,
    replaceAll,
    getTombstones,
    getDoc,
    applyDoc,
  };
})();
