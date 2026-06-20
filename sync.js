// ---------------------------------------------------------------------------
// Wine Cave — sync layer (optional, account-free)
//
// Lets a small group share one cellar across devices without logins. The model
// is a single "cellar code" (a secret) that names a row in a hosted store
// (Supabase / PostgREST). Whoever holds the code reads and writes that row.
//
// Setup lives in one bundled "sync code" (Supabase URL + anon key + cellar
// code, base64-encoded). Paste it on another device and that device joins the
// same cellar. Devices that never set this up stay purely local — a new user
// starts with a clean, private cellar.
//
// Conflict handling is delegated to WineCave.mergeCellars (per-wine, newest
// edit wins, with tombstones for deletions), so two devices editing offline
// converge instead of clobbering each other.
//
// Exposed on window.WineCave.sync. Depends on storage.js (loaded first).
// ---------------------------------------------------------------------------

(function () {
  const WineCave = window.WineCave;
  const CONFIG_KEY = "wineCave:sync:v1";
  const TOKEN_PREFIX = "wcsync1:";

  let config = readConfig(); // { url, key, code, lastSync } | null

  // -------------------------------------------------------------------------
  // Config persistence
  // -------------------------------------------------------------------------

  function readConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c && c.url && c.key && c.code ? c : null;
    } catch (err) {
      return null;
    }
  }

  function writeConfig(c) {
    config = c;
    if (c) localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CONFIG_KEY);
  }

  function isLinked() {
    return Boolean(config);
  }

  function getConfig() {
    return config ? { ...config } : null;
  }

  function setLastSync(iso) {
    if (!config) return;
    config = { ...config, lastSync: iso };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  // -------------------------------------------------------------------------
  // Sync code (shareable token) — base64url of { url, key, code }
  // -------------------------------------------------------------------------

  function base64UrlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlDecode(str) {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return decodeURIComponent(escape(atob(b64)));
  }

  function makeToken(c) {
    const src = c || config;
    if (!src) return "";
    return TOKEN_PREFIX + base64UrlEncode(JSON.stringify({ url: src.url, key: src.key, code: src.code }));
  }

  function parseToken(token) {
    const t = String(token || "").trim();
    if (!t.startsWith(TOKEN_PREFIX)) throw new Error("That doesn't look like a sync code.");
    let obj;
    try {
      obj = JSON.parse(base64UrlDecode(t.slice(TOKEN_PREFIX.length)));
    } catch (err) {
      throw new Error("That sync code is unreadable — copy the whole thing and try again.");
    }
    if (!obj || !obj.url || !obj.key || !obj.code) throw new Error("That sync code is missing some details.");
    return { url: String(obj.url).replace(/\/+$/, ""), key: String(obj.key), code: String(obj.code) };
  }

  function randomCode() {
    // A short, human-copyable secret. ~62 bits — plenty when it's the only
    // thing gating a 2–3 person cellar.
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    const buf = new Uint8Array(12);
    (crypto || window.crypto).getRandomValues(buf);
    for (const b of buf) out += alphabet[b % alphabet.length];
    return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8, 12);
  }

  // -------------------------------------------------------------------------
  // Supabase REST (PostgREST) — table `cellars(code text pk, data jsonb,
  // updated_at timestamptz)`. The anon key is public by design; the cellar
  // code is the secret that selects the row.
  // -------------------------------------------------------------------------

  function headers(c) {
    return {
      apikey: c.key,
      Authorization: "Bearer " + c.key,
      "Content-Type": "application/json",
    };
  }

  /** Fetch the remote cellar document, or null if the row doesn't exist yet. */
  async function pull(c) {
    c = c || config;
    if (!c) throw new Error("Sync isn't set up.");
    const url = `${c.url}/rest/v1/cellars?code=eq.${encodeURIComponent(c.code)}&select=data`;
    const res = await fetch(url, { headers: headers(c) });
    if (!res.ok) throw new Error(await describeError(res));
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const data = rows[0].data || {};
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return {
      wines: Array.isArray(data.wines) ? data.wines : [],
      tombstones: obj(data.tombstones),
      // Comparisons (absent in pre-v2 remote docs → empty).
      comparisons: Array.isArray(data.comparisons) ? data.comparisons : [],
      comparison_tombstones: obj(data.comparison_tombstones),
    };
  }

  /** Upsert the cellar document into the remote row. */
  async function push(cellar, c) {
    c = c || config;
    if (!c) throw new Error("Sync isn't set up.");
    const url = `${c.url}/rest/v1/cellars?on_conflict=code`;
    const body = JSON.stringify([
      { code: c.code, data: cellar, updated_at: new Date().toISOString() },
    ]);
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers(c), Prefer: "resolution=merge-duplicates,return=minimal" },
      body,
    });
    if (!res.ok) throw new Error(await describeError(res));
  }

  async function describeError(res) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.message || body.hint || body.error || "";
    } catch (err) {
      /* non-JSON error body */
    }
    if (res.status === 401 || res.status === 403) {
      return "Sync was refused — check the sync code / Supabase key and table access.";
    }
    if (res.status === 404) {
      return "Sync target not found — is the `cellars` table created in Supabase?";
    }
    return `Sync failed (${res.status})${detail ? ": " + detail : ""}.`;
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  /**
   * Pull remote, merge with local, write the merged result locally, then push
   * it back so every device converges. Returns { changed } where `changed`
   * means the local cellar was altered (so the UI should re-render).
   */
  async function syncNow() {
    if (!config) throw new Error("Sync isn't set up.");
    const before = JSON.stringify(WineCave.getAllWines());
    const remote = (await pull()) || {};

    // Wines (existing path).
    const merged = WineCave.mergeCellars(WineCave.getCellar(), {
      wines: remote.wines,
      tombstones: remote.tombstones,
    });
    WineCave.applyCellar(merged);

    // Comparisons — same newest-edit-wins merge, reusing mergeCellars (it keys
    // by id + updated_at, which comparisons also have). Skipped gracefully if
    // the comparison store isn't loaded.
    let mergedCmp = { wines: [], tombstones: {} };
    const cs = WineCave.compareStore;
    if (cs && cs.getDoc) {
      const localCmp = cs.getDoc();
      mergedCmp = WineCave.mergeCellars(
        { wines: localCmp.comparisons, tombstones: localCmp.tombstones },
        { wines: remote.comparisons, tombstones: remote.comparison_tombstones },
      );
      cs.applyDoc({ comparisons: mergedCmp.wines, tombstones: mergedCmp.tombstones });
    }

    await push({
      wines: merged.wines,
      tombstones: merged.tombstones,
      comparisons: mergedCmp.wines,
      comparison_tombstones: mergedCmp.tombstones,
    });
    setLastSync(new Date().toISOString());
    const after = JSON.stringify(WineCave.getAllWines());
    return { changed: before !== after };
  }

  // Coalesce bursts of edits into a single sync a moment later.
  let timer = null;
  let onChange = null;

  function setOnChange(fn) {
    onChange = fn;
  }

  function scheduleSync(delay = 1500) {
    if (!config) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      runSync();
    }, delay);
  }

  function runSync() {
    if (!config) return Promise.resolve({ changed: false });
    return syncNow()
      .then((result) => {
        if (result.changed && typeof onChange === "function") onChange();
        return result;
      })
      .catch((err) => {
        console.warn("Wine Cave: sync failed", err);
        return { changed: false, error: err };
      });
  }

  /**
   * Link this device to a cellar. `joinReplace` decides what happens when the
   * remote already holds a cellar: true replaces this device's wines with the
   * remote ones (joining someone else's cellar); false merges both. Either way
   * the result is pushed back so both ends converge.
   */
  async function link(cfg, joinReplace) {
    const c = { url: cfg.url.replace(/\/+$/, ""), key: cfg.key, code: cfg.code };
    const remote = await pull(c); // validates connection + reveals existing data
    writeConfig({ ...c, lastSync: null });
    if (remote && (remote.wines || []).length && joinReplace) {
      WineCave.applyCellar(remote);
    }
    return syncNow();
  }

  /** Peek at a remote cellar before committing to link (for the join prompt). */
  async function preview(cfg) {
    return pull({ url: cfg.url.replace(/\/+$/, ""), key: cfg.key, code: cfg.code });
  }

  function unlink() {
    clearTimeout(timer);
    writeConfig(null);
  }

  WineCave.sync = {
    isLinked,
    getConfig,
    makeToken,
    parseToken,
    randomCode,
    preview,
    link,
    unlink,
    pull,
    syncNow,
    runSync,
    scheduleSync,
    setOnChange,
  };
})();
