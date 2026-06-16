// ---------------------------------------------------------------------------
// Wine Cave — automated research engine (network layer)
//
// The free, manual "dossier paste-back" engine lives in research.js and stays
// pure (no DOM, no network). THIS file is the optional automated path: it sends
// the same prompt to a Supabase Edge Function (research-wine), which holds the
// secret Anthropic key and runs the web search, then returns the model's text.
// The caller parses that text with the existing WineCave.research parser, so
// the review/verify/apply pipeline is identical for both engines.
//
// Endpoint resolution (first match wins):
//   1. window.WINE_RESEARCH_ENDPOINT  — explicit override, lets you use
//      automated research WITHOUT sync. Optionally with WINE_RESEARCH_KEY.
//   2. The sync config (storage shared with sync.js) — the function lives in
//      the same Supabase project, so when sync is linked this needs zero extra
//      setup: endpoint = <project>/functions/v1/research-wine, auth = anon key.
//
// Exposed on window.WineCave.researchApi.
// ---------------------------------------------------------------------------

(function () {
  const WineCave = window.WineCave;

  /** @returns {{url:string, key:string, secret:string}|null} */
  function resolveEndpoint() {
    // 1. Explicit override (works with no sync set up).
    if (window.WINE_RESEARCH_ENDPOINT) {
      return {
        url: String(window.WINE_RESEARCH_ENDPOINT),
        key: window.WINE_RESEARCH_KEY ? String(window.WINE_RESEARCH_KEY) : "",
        secret: window.WINE_RESEARCH_SECRET ? String(window.WINE_RESEARCH_SECRET) : "",
      };
    }
    // 2. Derive from the sync config — same Supabase project as sync.
    const cfg =
      WineCave.sync && typeof WineCave.sync.getConfig === "function"
        ? WineCave.sync.getConfig()
        : null;
    if (cfg && cfg.url && cfg.key) {
      return {
        url: cfg.url.replace(/\/+$/, "") + "/functions/v1/research-wine",
        key: cfg.key,
        secret: window.WINE_RESEARCH_SECRET ? String(window.WINE_RESEARCH_SECRET) : "",
      };
    }
    return null;
  }

  /** Whether the automated path can run right now. */
  function isConfigured() {
    return Boolean(resolveEndpoint());
  }

  /**
   * Research a wine via the proxy. Reuses buildResearchPrompt so the request is
   * identical to the manual path. Returns { text, usage, model }; throws a
   * friendly Error on failure (or an AbortError if cancelled via opts.signal).
   *
   * @param {Object} wine
   * @param {{signal?: AbortSignal}} [opts]
   */
  async function fetchResearch(wine, opts) {
    opts = opts || {};
    const ep = resolveEndpoint();
    if (!ep) {
      throw new Error(
        "Automated research isn't set up yet — link sync (it shares your Supabase project) or switch to manual research.",
      );
    }

    const prompt = WineCave.research.buildResearchPrompt(wine);

    const headers = { "Content-Type": "application/json" };
    if (ep.key) {
      headers["apikey"] = ep.key;
      headers["Authorization"] = "Bearer " + ep.key;
    }
    if (ep.secret) headers["x-research-secret"] = ep.secret;

    let res;
    try {
      res = await fetch(ep.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt }),
        signal: opts.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      throw new Error("Couldn't reach the research service — check your connection.");
    }

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      /* fall through to status handling below */
    }

    if (!res.ok) {
      const msg = (data && data.error) || `Research failed (${res.status}).`;
      throw new Error(msg);
    }
    if (!data || typeof data.text !== "string" || !data.text.trim()) {
      throw new Error("The research service returned an empty result.");
    }
    return data; // { text, usage, model }
  }

  WineCave.researchApi = { isConfigured, resolveEndpoint, fetchResearch };
})();
