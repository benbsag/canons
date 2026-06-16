# Automated research setup

The app can research a wine for you by calling Claude. Because a static web page
can't safely hold a secret API key, the call is relayed through a small Supabase
Edge Function (`research-wine`) that holds the key and runs the web search. This
guide gets that function live. It takes about 10 minutes and is a one-time job.

If you skip all of this, the app still works: switch the research panel to
**manual** mode (the toggle at the top of the panel) and use the free
copy-into-Claude flow. Automated mode just won't be available until the function
is deployed.

---

## What you need

- The Supabase project you already use for **sync** (the function lives in the
  same project, so the app finds it automatically once sync is linked).
- An **Anthropic API key** — create one at <https://console.anthropic.com>
  (Settings → API keys). You'll add billing there; this is what the per-wine
  cost (~15–30¢, see below) is charged against.
- The **Supabase CLI** — install with `npm i -g supabase` (or
  `brew install supabase/tap/supabase`).

---

## Steps

### 1. Log in and link the CLI to your project

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

Your project ref is the `xxxx` in `https://xxxx.supabase.co` (also in
Supabase → Project Settings → General).

### 2. Add your secrets

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# optional — defaults shown:
supabase secrets set ANTHROPIC_MODEL=claude-sonnet-4-6
supabase secrets set RESEARCH_MAX_SEARCHES=5
supabase secrets set RESEARCH_MAX_TOKENS=2000
```

Use `claude-opus-4-8` for the model if you want the highest-quality research
(roughly 1.5× the cost). You can change this anytime by re-running the command —
no redeploy needed.

### 3. Deploy the function

```bash
supabase functions deploy research-wine
```

That's it. The function is now at
`https://<your-project-ref>.supabase.co/functions/v1/research-wine`.

### 4. Use it

Open a wine, tap **research this wine**. As long as sync is linked, the panel
opens in **automatic** mode and starts researching — a spinner shows while it
works (10–30s), then the results appear in the review screen for you to check
and apply. Nothing is saved until you tick the boxes and tap **apply selected**.

---

## How access is controlled

The function is gated by Supabase's `verify_jwt` (on by default), so only
callers holding your project's **anon key** — i.e. your app and your synced
devices — can reach it. That's the same key sync already uses.

If you want a second lock (e.g. you're worried about the anon key leaking), set
a shared secret:

```bash
supabase secrets set RESEARCH_SHARED_SECRET=some-long-random-string
```

…then tell the app about it by adding this near the top of `index.html`, before
the other `<script>` tags:

```html
<script>window.WINE_RESEARCH_SECRET = "some-long-random-string";</script>
```

## Using automated research WITHOUT sync

If you want automated research but don't use sync, point the app at the function
directly. Add this to `index.html` before the `<script>` tags:

```html
<script>
  window.WINE_RESEARCH_ENDPOINT = "https://<your-project-ref>.supabase.co/functions/v1/research-wine";
  window.WINE_RESEARCH_KEY = "<your-supabase-anon-key>"; // public by design
</script>
```

The override takes precedence over the sync config.

---

## Cost

Each automated research call costs roughly **15–30¢** on Sonnet 4.6 (a bit more
on Opus). The driver is the web search: Claude runs several searches and the
retrieved page content is billed as input tokens. `RESEARCH_MAX_SEARCHES` caps
that — lower it to cap the cost, raise it for deeper research.

The Supabase side is effectively free at personal scale (500,000 function calls
a month on the free tier). The cost is the Anthropic API, on your key.

For demos or any time you want it free, flip the research panel to **manual**
mode — it stays free and needs none of the above.
