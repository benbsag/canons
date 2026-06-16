// ---------------------------------------------------------------------------
// Wine Cave — research proxy (Supabase Edge Function)
//
// The app is a static, local-first page and cannot hold a secret API key, so
// automated research is relayed through this function. The browser sends the
// ready-made research prompt (built client-side by research.js); this function
// adds the secret Anthropic key, enables the web-search tool so facts are
// grounded in real sources, and returns the model's raw text. The client then
// parses that text with its existing parser and shows it for review.
//
// Secrets / config (set with `supabase secrets set NAME=value`):
//   ANTHROPIC_API_KEY      (required) — your Anthropic API key
//   ANTHROPIC_MODEL        (optional) — default "claude-sonnet-4-6"
//   RESEARCH_MAX_SEARCHES  (optional) — web-search cap per call, default 5
//   RESEARCH_MAX_TOKENS    (optional) — output token cap, default 2000
//   RESEARCH_SHARED_SECRET (optional) — if set, callers must send a matching
//                                       `x-research-secret` header (extra gate
//                                       on top of Supabase's anon-key auth)
//
// Access is gated by Supabase (verify_jwt defaults to true), so only callers
// holding your project's anon key — i.e. your app / synced devices — can reach
// it. RESEARCH_SHARED_SECRET adds a second lock if you want one.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
const MAX_SEARCHES = Number(Deno.env.get("RESEARCH_MAX_SEARCHES") ?? "5");
const MAX_TOKENS = Number(Deno.env.get("RESEARCH_MAX_TOKENS") ?? "2000");
const SHARED_SECRET = Deno.env.get("RESEARCH_SHARED_SECRET") ?? "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-research-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const SYSTEM =
  "You research a single wine and reply with ONLY the requested JSON object — " +
  "no preamble, no explanation, no markdown code fences. Use the web search " +
  "tool to ground every fact in real, citable sources; never invent details.";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);
  }
  if (SHARED_SECRET && req.headers.get("x-research-secret") !== SHARED_SECRET) {
    return json({ error: "Not authorised." }, 401);
  }

  let body: { prompt?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: "Missing 'prompt'." }, 400);
  if (prompt.length > 8000) return json({ error: "Prompt is too long." }, 400);

  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES },
    ],
    messages: [{ role: "user", content: prompt }],
  };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ error: "Couldn't reach the model service." }, 502);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const e = await res.json();
      detail = e?.error?.message || "";
    } catch {
      /* non-JSON error body */
    }
    return json(
      { error: `Research failed (${res.status})${detail ? ": " + detail : ""}.` },
      502,
    );
  }

  const data = await res.json();

  // The final assistant message may be split into several text blocks
  // (interleaved with web_search tool use); concatenate the text ones.
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b?.text ?? "")
        .join("\n")
        .trim()
    : "";

  if (!text) return json({ error: "The model returned no text." }, 502);

  return json({ text, usage: data?.usage ?? null, model: data?.model ?? MODEL });
});
