# Wine comparison — specification

Status: **agreed, not yet built** · Last updated: 2026-06-16

A new module for comparing 2+ wines side by side across five dimensions. Wines
may come from the cellar, from outside the cellar, or any mix. Comparisons are
saved, synced, revisitable, and extendable. This document is the reference we
build against.

---

## 1. Concept

A **Comparison** is its own object, separate from the wine catalogue. It holds
2+ wines and an AI-generated (or free / paste-back) side-by-side across five
comparative dimensions. The comparison's content is written in an evaluative,
*relative* tone, which differs from the catalogue's factual cataloguing tone —
so comparison data and catalogue data are stored separately, and promoting a
compared wine into the catalogue triggers the normal research pass to fill the
catalogue schema.

## 2. The five dimensions

1. **Grape variety**
2. **Terroir**
3. **Vinification**
4. **Tasting profile**
5. **Reputation** — place in the hierarchy, status, rarity, how sought-after

These are phrased comparatively (relative to the other wines in the set), unlike
the catalogue's neutral facts.

### Mapping to catalogue fields

| Comparison dimension | Closest catalogue field |
|---|---|
| Grape variety | `tech_facts.grape_varietals` |
| Terroir | `tech_facts.terroir_type` (+ `region`, `country`) |
| Vinification | `vinification` |
| Tasting profile | `tasting_notes.notes` |
| Reputation | `expert_context` (the "context" field) |

The overlap is loose and tonal-different; it is used only to **seed** a
comparison for cellar wines (§5) and to seed the **context** field on promotion
(§8) — never to silently treat comparison text as catalogue facts.

## 3. Data model

```
Comparison {
  id            string
  title         string         // auto from wines, editable
  created_at    ISO
  updated_at    ISO            // bumped when extended / re-run
  wines         Entry[]
}

Entry =
  | { source: "cellar",   wine_id, dims }
  | { source: "external", producer, cuvee, vintage, dims, added_to_cellar_id? }

dims {
  grape:       { value, confidence, /* sourced|inferred|not_found */ }
  terroir:     { value, confidence }
  vinification:{ value, confidence }
  tasting:     { value, confidence }
  reputation:  { value, confidence }
  sources:     string[]   // real URLs consulted for this wine
}
```

- Cellar entries reference a catalogue wine by `wine_id` (kept live, not copied).
- External entries store their identity + `dims` inline (not in the catalogue).
- When an external wine is promoted to the catalogue, `added_to_cellar_id` links
  the two so the comparison can show it as "in your cellar."
- Comparisons persist in their own **local store** and are included in
  export/import so they're backed up. Cross-device **sync is a planned
  fast-follow** (additive, not in the first build); see §11.

## 4. Module & entry points

- A **Compare** entry point on the home screen opens the comparison module.
- The module lists saved comparisons (auto-titled, e.g. "Wine A vs Wine B (+2)")
  with a **new comparison** action.
- Opening a comparison shows the swipeable-card result (§7) plus controls to
  add a wine (§9) and promote external wines (§8).

## 5. Building a comparison

### Wine selection (covers all three cases)

One picker, two ways to add each wine:

- **From the cellar** — searchable list of existing wines.
- **Add an outside wine** — type producer / cuvée / vintage.

Mix freely. This covers cellar-vs-cellar, cellar-vs-outside, and
outside-vs-outside. Minimum 2 wines; soft cap ~6 (keeps cards and cost sane).

### The comparison pass

Dimension 5 and the comparative tone are inherently *relative*, so each run is a
**single combined pass over all the wines at once** (not N isolated lookups) —
cheaper and genuinely comparative.

- **Cellar wines:** seed the prompt with their known catalogue facts (grape,
  terroir, vinification, tasting). The model then only fills genuine gaps —
  chiefly **reputation** — and writes the relative synthesis. ("Reuse cellar
  data, fetch only gaps.")
- **Outside wines:** searched from scratch.
- **AI vs free:** the same chooser as research. AI = one combined call via the
  existing edge function (web search on). Free = one combined copy/paste prompt
  covering all wines.
- Output is structured JSON: per-wine `dims` with per-field confidence + real
  source URLs — same provenance model as research.

### Reuse (minimal new surface area)

The existing Supabase `research-wine` edge function is reused unchanged (it
relays a prompt + web search and returns text). New code needed: a comparison
**prompt builder**, a comparison **parser**, the comparison **store**, and the
**UI module**. The AI/free chooser, confidence dots, and sources list are reused.

## 6. (reserved)

## 7. Results presentation — swipeable cards

- One full-width card per wine; swipe horizontally between wines.
- Each card lists all five dimensions, each with a confidence dot, plus a
  sources list at the bottom (consistent with the research panel).
- A wine already in the cellar is badged as such; an external wine shows an
  **add to cellar** control.
- (Possible later enhancement, not core: a "by dimension" toggle that pivots to
  show one dimension across all wines for tighter side-by-side reading.)

## 8. Promoting a wine to the catalogue

From a comparison, any external wine offers **add to cellar** — single, or
**bulk** (select several, add together).

On add, a catalogue **stub** is created carrying:

- **Identity:** producer / cuvée / vintage from the entry.
- **Context:** the comparison's **reputation** text (dim 5) seeded into the
  catalogue `expert_context` ("context") field — the one field whose tone
  matches.
- A link back to the source comparison and a **`needs_research`** flag.
- No other catalogue fields are prefilled (avoids tone contamination).

The stub is flagged "needs info" in the cellar. **No research runs on add** — no
immediate cost ("add as stubs, research later").

Later, running **get wine info** on the stub is the normal full research pass,
seeded with the known identity (so it skips re-deriving names). In the usual
**review/apply** step, the user chooses per field what to accept — including
whether the freshly researched context **overrides** the seeded reputation text.
This is the "partial redo to obtain the missing info" described in the request.

## 9. Extending an existing comparison

Adding a wine to an existing comparison prompts: **create a new comparison**
(including the extra wine) **or build on the existing one**.

- **Build on existing → re-run across all wines.** The combined pass re-runs
  with the new wine included so relative claims (ranking, rarity, how
  sought-after) stay accurate. Every entry's `dims` is rewritten and
  `updated_at` is bumped. Cellar wines are still seeded from their known facts,
  so the re-run is cheaper than a cold one. Costs one combined call.
- **Create new** clones the set + the new wine into a fresh comparison and
  leaves the original frozen.

## 10. Cost

- One combined AI call per comparison run (initial or re-run), in a similar band
  to a single research call, a bit more for more wines. Seeding cellar wines and
  capping the wine count keep it contained.
- Promotion adds **zero** cost until the user runs research on a stub.
- Free mode (paste-back) is always available at no cost.

## 11. Implementation notes / open items

- **Storage & sync (decided: local-first + backup, sync next):** comparisons
  are stored in a **local store** (`wineCave:comparisons:v1`) and **are included
  in export/import** (backup is implemented — export is `version: 2` with a
  `comparisons` array; import restores them when present, leaves them untouched
  for older v1 backups). Cross-device **sync is implemented**: the synced
  document now also carries `{ comparisons, comparison_tombstones }`, merged
  per-object with the same newest-edit-wins logic as wines (the comparison store
  records deletion tombstones, and `mergeCellars` is reused since comparisons
  also key by `id` + `updated_at`). The wine-sync path is untouched. Backward
  compatible: a pre-update client that pushes without comparisons can't wipe
  them permanently — the next updated client restores them from its local copy
  on the following sync. `added_to_cellar_id` references a synced wine id
  (stable across devices), so promote links resolve correctly.
- **Stub flagging:** add a `needs_research` marker (and a visible "needs info"
  badge in the cellar list) distinct from a fully-researched wine with
  `last_researched` set.
- **Prompt/parser:** new `compare` prompt builder + parser live alongside
  `research.js` (kept pure, no DOM/network) so they're unit-testable; the
  network call reuses `research-api.js` / the edge function.

## 12. Out of scope (for now)

- Exporting/sharing a comparison as a file or link.
- Comparing more than the soft cap of ~6 wines.
- A dedicated comparison-only AI model/endpoint (the existing one is reused).
