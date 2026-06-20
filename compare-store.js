// ---------------------------------------------------------------------------
// Wine Cave — comparison store (local-first)
//
// Persists saved comparisons in localStorage. Per COMPARE_SPEC.md §11 the first
// build is local-only; comparisons are included in export/import (Stage 5) for
// backup, and cross-device sync is a planned additive fast-follow. Kept as a
// thin, single-seam module so swapping in sync later doesn't touch the UI.
//
// Exposed on window.WineCave.compareStore.
// ---------------------------------------------------------------------------

(function () {
  const STORAGE_KEY = "wineCave:comparisons:v1";

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
    return comparison;
  }

  function remove(id) {
    writeAll(readAll().filter((c) => c.id !== id));
  }

  window.WineCave.compareStore = { list, get, save, remove };
})();
