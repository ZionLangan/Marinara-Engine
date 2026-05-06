# Fandom Wiki → Marinara Engine / SillyTavern Lorebook

A four-stage pipeline for turning a Fandom (or other MediaWiki-based) wiki
into one or more keyword-triggered lorebooks compatible with **Marinara
Engine** and **SillyTavern**.

```
scrape_wiki.py        →  scraped.json
extract_containers.py →  containers.txt    (you edit this)
enrich_with_llm.py    →  enriched.json     (LLM rewrite + classify)
build_lorebook.py     →  *.json            (one or many lorebooks)
```

The LLM enrichment step is optional but strongly recommended for any
lorebook over ~50 entries. It produces tighter keys, better-structured
content, and per-entry tier/container assignments that let you split
output into multiple lorebooks for selective binding.

---

## Install

```bash
pip install requests beautifulsoup4 tiktoken
```

Python 3.10+ required.

---

## Stage 1 — Scrape the wiki

```bash
python scrape_wiki.py \
    --wiki calixipedia \
    --seed "The_Calixis_Sector" \
    --max-depth 3 \
    --max-pages 700 \
    --sleep 0.5 \
    --out scraped.json
```

Notes:
- `--sleep 0.5` is polite; don't go below 0.2.
- `--max-depth` past 3 produces a lot of marginal content; consider 2–3.
- Resumability: not implemented (the scrape is fast enough that re-running
  is fine if you change parameters).

---

## Stage 2 — Extract and curate the container list

This produces a candidate list of "containers" — places, sub-sectors, factions,
houses — that other entries can be assigned to during enrichment.

```bash
python extract_containers.py --in scraped.json --out containers.txt
```

**Now open `containers.txt` in a text editor.** Delete entries that aren't
real containers (you'll see the script defaults to grouping by category, so
some lines will be NPCs or events that got grouped under a category that
matched a container pattern). Aim for 20–60 lines for a typical
sector-sized scrape — too many containers and the LLM will scatter
assignments; too few and most entries land in `misc`.

---

## Stage 3 — LLM enrichment

This is where the lorebook quality jumps. Each entry is sent to an
OpenAI-compatible chat endpoint with a structured prompt; the LLM returns
JSON containing rewritten content, suggested keys, importance tier, and
container assignment.

### Configuring the endpoint

The script targets any OpenAI-compatible `/v1/chat/completions` endpoint.
Some examples:

```bash
# OpenAI directly
--base-url https://api.openai.com/v1 --model gpt-4o-mini --api-key-env OPENAI_API_KEY

# OpenRouter (cheapest, lots of model options)
--base-url https://openrouter.ai/api/v1 --model openai/gpt-4o-mini --api-key-env OPENROUTER_API_KEY

# Local LM Studio (free if you have a decent model)
--base-url http://localhost:1234/v1 --model your-loaded-model --api-key-env LMSTUDIO_KEY
# (LM Studio ignores the key but the env var must be set)

# Local Ollama
--base-url http://localhost:11434/v1 --model llama3.1:8b --api-key-env OLLAMA_KEY
```

### Running it

```bash
export OPENROUTER_API_KEY=sk-or-...

python enrich_with_llm.py \
    --in scraped.json \
    --out enriched.json \
    --containers containers.txt \
    --base-url https://openrouter.ai/api/v1 \
    --model openai/gpt-4o-mini \
    --api-key-env OPENROUTER_API_KEY \
    --concurrency 6
```

For 700 entries with gpt-4o-mini you should expect:
- ~10–20 minutes wallclock with `--concurrency 6`
- ~$1–3 in API costs
- Some entries (5–10%) will fail validation and be skipped

The script is **resumable**. If it crashes or you cancel it, re-run the same
command and it picks up where it left off. Failed entries can be retried
by re-running.

### Sanity-check the output before stage 4

```bash
python3 -c "
import json
data = json.load(open('enriched.json'))
print(f'Total: {len(data)}')
errors = sum(1 for d in data if d.get(\"enrichment_error\"))
tiers = {}
containers = {}
for d in data:
    tiers[d.get('tier', 'unknown')] = tiers.get(d.get('tier', 'unknown'), 0) + 1
    c = d.get('container') or '(none)'
    containers[c] = containers.get(c, 0) + 1
print(f'Errors: {errors}')
print(f'Tiers: {tiers}')
print(f'Top containers: {sorted(containers.items(), key=lambda x: -x[1])[:10]}')
"
```

A healthy distribution looks roughly like: 5–15% core, 60–80% regional,
15–25% deep, with regional entries spread across most of your containers.
If 90% of entries are tagged "deep", your container list was too sparse;
if everything is "regional" with no container, your container list was off.

---

## Stage 4 — Build the lorebook(s)

### Multi-lorebook mode (recommended for enriched data)

```bash
python build_lorebook.py \
    --in enriched.json \
    --out-dir lorebooks/ \
    --name calixis \
    --constant-page "The_Calixis_Sector" \
    --case-sensitive
```

This produces:
- `calixis_core.json` — always-on setting overview entries
- `calixis_atmosphere.json` — flavor entries that fire 25% of the time when triggered
- `calixis_<container>.json` — one file per container (planet/sub-sector/faction)
- `calixis_misc.json` — regional entries with no container assignment

### Single-lorebook mode (legacy or unenriched data)

```bash
python build_lorebook.py \
    --in scraped.json \
    --out calixis_lorebook.json \
    --name "Calixis Sector" \
    --constant-page "The_Calixis_Sector"
```

### Useful build flags

| Flag | Effect |
|------|--------|
| `--case-sensitive` | Match keys case-sensitively. Recommended — stops "hax" inside "hacks" from triggering Marius Hax. |
| `--no-secondary-keys` | Disable the AND-secondary-key gate. Default secondaries are 40k-themed. |
| `--secondary-keys X Y Z` | Override the default secondary keys (use for non-40k settings). |
| `--no-whole-words` | Allow substring matches. Don't use unless you know why. |
| `--deep-probability N` | Atmosphere entries fire N% of the time (default 25). |
| `--default-depth N` | How many recent messages to scan for keys (default 4). |

---

## Importing into Marinara Engine

1. Marinara → Settings → Lorebooks → Import.
2. Select each `.json` file. They import as separate lorebooks.
3. Bind them per the recommendations the build script prints:
   - `*_core.json` → globally or to your character card
   - `*_atmosphere.json` → globally (the per-entry probability handles frequency)
   - `*_<container>.json` → bind to specific chats when you're playing in that location

---

## Why the multi-lorebook split matters

A single 700-entry lorebook has two problems:

1. **Token budget.** Even with strict keys, several entries can fire on a
   given turn. With 700 entries the chance of firing junk goes up.
2. **Cross-context contamination.** An RP set in Scintilla doesn't need the
   Markayn Marches' minor noble houses loaded.

Splitting by tier and container fixes both. Core entries are always
loaded (5–15% of total = small, fixed token cost). Container books are
only loaded when relevant. Atmosphere entries fire occasionally for
flavor without dominating context.

---

## Why secondary keys matter

Every entry has a list of "setting" secondary keys (Imperium, Inquisition,
Calixis, Emperor, Adeptus, etc.). Entries only inject when their primary
key matches **AND** at least one secondary key is in recent context.

Result: if you're playing a non-40k RP and someone says "Drusus" (a Roman
name), the Drusus entry doesn't fire because no 40k secondary is in
context. Inside a 40k RP, secondary terms are everywhere, so the gate is
transparent.

For non-40k settings, use `--secondary-keys` to override:

```bash
--secondary-keys Galactic Empire Sith Jedi Force Republic
```

---

## Tuning checklist

Order of things to adjust if results are off:

1. **Too many false triggers.** Add `--case-sensitive`. Trim auto-extracted
   keys in the lorebook editor.
2. **Some entries never trigger.** Add aliases to their key list manually,
   or lower secondary-key requirements.
3. **Context budget exceeded.** Split your container books further; increase
   `--max-tokens` only if entries seem under-informed.
4. **Atmosphere too noisy or too quiet.** Adjust `--deep-probability`.
5. **Wrong tier classification.** Edit the entries' `_tier` in
   `enriched.json` and re-run the build (no need to re-enrich).

---

## Reusing for other wikis

The pipeline is wiki-agnostic. For any Fandom wiki:

```bash
python scrape_wiki.py --wiki <wikiname> --seed "<Page_Name>" --out scraped.json
python extract_containers.py --in scraped.json --out containers.txt
# Edit containers.txt
python enrich_with_llm.py --in scraped.json --out enriched.json \
    --containers containers.txt --base-url ... --model ... --api-key-env ...
python build_lorebook.py --in enriched.json --out-dir lorebooks/ --name <name> \
    --constant-page "<Page_Name>" --secondary-keys <setting words>
```

For non-Fandom MediaWiki sites, pass the full host: `--wiki wiki.example.com`.

---

## Known limitations

- **Infoboxes are dropped during scraping.** They're structured data but
  vary wildly between wikis. If your wiki's infoboxes carry critical info
  (stats, dates, allegiances), edit `scraped.json` to merge them in before
  enrichment.
- **The LLM rewrite can lose nuance.** Subtle in-universe rumors or
  carefully hedged claims sometimes come out flatter. Spot-check the
  enriched output for entries where exact wording matters; you can revert
  individual entries by removing their `rewritten` field.
- **Container assignment is one-to-one.** An NPC who lives on Scintilla
  but works for the Calixian Conclave gets assigned to one or the other,
  not both. Manual edit if it matters.
- **Recursion is off by default.** All entries have `excludeRecursion`
  false except deep-tier and `preventRecursion` false except core-tier.
  Turn on global recursion in Marinara only after testing without it.
