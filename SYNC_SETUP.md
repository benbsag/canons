# Syncing your cellar across devices

CANONS can sync your wines between devices with **no accounts and no login** —
just a shared "cellar code." It uses a small free database (Supabase) to hold
one shared cellar. Anyone who never sets this up keeps a private, local cellar,
so new users always start with a clean slate.

You only do the Supabase setup **once**. After that, linking a new device is a
single paste.

---

## 1. Create the free database (one time, ~5 minutes)

1. Go to https://supabase.com and sign up (the free tier is plenty for this).
2. Click **New project**. Give it any name, pick a region near you, and set a
   database password (you won't need it again for this). Wait ~1 minute for it
   to finish provisioning.
3. In the left sidebar open **SQL Editor → New query**, paste the block below,
   and click **Run**. This creates the table the app reads and writes.

   ```sql
   create table if not exists public.cellars (
     code text primary key,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   alter table public.cellars enable row level security;

   create policy "cellar access" on public.cellars
     for all to anon, authenticated
     using (true) with check (true);
   ```

4. In the left sidebar open **Project Settings → API** and copy two values:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public** key (under *Project API keys*) — a long string starting `eyJ…`

   (Use the **anon public** key, not the `service_role` key.)

---

## 2. Link your first device

1. In CANONS, open **Settings** (the gear icon) → scroll to **sync**.
2. Tap **set up new cellar**.
3. Paste your **Project URL** and **anon public key**.
4. Tap **generate** to make a cellar code (or type your own memorable one).
5. Tap **create & link**.

Your current wines are now uploaded to the shared cellar. 🎉

---

## 3. Link your other devices

1. On the device that's already linked: **Settings → sync → copy sync code**.
   This copies one bundled code containing everything the other device needs.
2. Send it to your other device however you like (Messages, Notes, email).
3. On the other device: **Settings → sync**, paste it into the box, and tap
   **link this device**.
   - If that device already had wines, you'll be asked whether to use the
     shared cellar (replacing what's there) or merge both together.

Do the same for each person/device you want to share with — they all use the
**same sync code**.

---

## How syncing behaves

- Changes sync automatically a moment after you add, edit, delete, or research
  a wine, and again whenever you reopen the app. There's also a **sync now**
  button.
- If two devices edit while offline, they reconcile per-wine: the most recent
  edit of each wine wins, and a deletion sticks unless that wine was edited more
  recently somewhere else. You won't lose a whole cellar to a stale copy.
- **Unlink** stops a device syncing; its wines stay on that device.

## A note on privacy

The cellar code is the *only* thing protecting your data — there are no
passwords. Anyone who has your sync code (or who digs the public key out of the
app) can read or change that cellar. For a few friends sharing wine notes that's
fine, but don't put anything sensitive in there, and don't post the sync code
publicly. If you ever want to cut access, change the cellar code (set up a new
one) and re-link your devices.
