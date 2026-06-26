# Wine sharing setup

Lets you tap **share** on any wine and send a short URL (~100 chars) to a
friend. The URL opens a read-only view of that wine — no access to your cellar.

Sharing requires your Supabase project (the same one sync uses) and takes about
5 minutes to set up.

---

## 1. Create the table

In the Supabase dashboard → **SQL editor**, run:

```sql
create table public.shared_wines (
  id   uuid primary key default gen_random_uuid(),
  data jsonb not null,
  created_at timestamptz default now()
);
```

No RLS needed — the Edge Function uses the service-role key and handles access
itself.

---

## 2. Deploy the function

```bash
supabase link --project-ref <your-project-ref>   # skip if already linked
supabase functions deploy share-wine --no-verify-jwt
```

The `--no-verify-jwt` flag is required so that the recipient's browser can
fetch the wine without needing your anon key.

---

## 3. That's it

Open a wine in the app and tap **share** in the top-right corner. The link
copies to your clipboard — paste it anywhere.

The recipient sees: producer, cuvée, vintage, region, grape varietals,
vinification, tasting notes, drinking window, and context. They cannot see your
cellar, your personal notes, or bottle counts.

---

## Sharing without sync

Sharing piggybacks on your sync credentials to reach the Supabase function. If
you want sharing without sync, add this to `index.html` before the `<script>`
tags (same pattern as the research override):

```html
<script>
  window.WINE_SHARE_ENDPOINT = "https://<your-project-ref>.supabase.co/functions/v1/share-wine";
  window.WINE_SHARE_KEY = "<your-supabase-anon-key>";
</script>
```

Then update `detailShareBtn`'s handler in `app.js` to read from
`window.WINE_SHARE_ENDPOINT` / `window.WINE_SHARE_KEY` as a fallback.
