// ---------------------------------------------------------------------------
// Wine Cave — share-wine Edge Function
//
// Creates and retrieves read-only wine snapshots for sharing.
//
//   POST { data: wineObject }  →  { id: UUID }
//   GET  ?id=UUID              →  { data: wineObject }
//
// Deployed with --no-verify-jwt so that GET requests from share.html work
// without any authentication. POST is open too — only users who know your
// Supabase URL (i.e. your own devices) can reach it in practice.
//
// The function uses the built-in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// env vars (always available in Edge Functions) to write/read the
// shared_wines table.
// ---------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- POST: store a wine snapshot, return its UUID ----
  if (req.method === "POST") {
    let body: { data?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    if (!body?.data || typeof body.data !== "object") {
      return json({ error: "Missing 'data'." }, 400);
    }

    const { data, error } = await db
      .from("shared_wines")
      .insert({ data: body.data })
      .select("id")
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ id: (data as { id: string }).id });
  }

  // ---- GET: retrieve a wine snapshot by UUID ----
  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json({ error: "Missing 'id'." }, 400);

    const { data, error } = await db
      .from("shared_wines")
      .select("data")
      .eq("id", id)
      .single();

    if (error || !data) return json({ error: "Share not found." }, 404);
    return json({ data: (data as { data: unknown }).data });
  }

  return json({ error: "Method not allowed." }, 405);
});
