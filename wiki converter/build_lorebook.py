#!/usr/bin/env python3
"""
build_lorebook.py — Convert scraped (and optionally LLM-enriched) wiki JSON
into one or more SillyTavern / Marinara Engine compatible lorebook files.

If the input has been processed by enrich_with_llm.py, this script will:
  - Use the LLM-rewritten content (terse, structured) instead of summarized prose
  - Use LLM-suggested keys (tighter than regex extraction)
  - Split output into multiple lorebooks based on tier:
      * <name>_core.json      — always-on / core setting (tier="core")
      * <name>_<container>.json — per-container regional lorebooks
      * <name>_atmosphere.json — flavor entries (tier="deep") with low probability
      * <name>_misc.json       — regional entries with no container assigned

If the input is raw scraped JSON, it falls back to the original heuristic
behavior (single lorebook, regex key extraction, summarized content).

Usage with enriched data:
    python build_lorebook.py \\
        --in enriched.json \\
        --out-dir lorebooks/ \\
        --name calixis \\
        --constant-page "The_Calixis_Sector"

Usage with raw scraped data (legacy):
    python build_lorebook.py \\
        --in scraped.json \\
        --out calixis_lorebook.json \\
        --name "Calixis Sector" \\
        --constant-page "The_Calixis_Sector"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Token counting
# ---------------------------------------------------------------------------

def _make_token_counter():
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        return lambda s: len(enc.encode(s))
    except ImportError:
        return lambda s: max(1, len(s) // 4)


count_tokens = _make_token_counter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Default secondary keys: "is this RP even in the right setting?"
# AND-ANY logic means an entry only fires if its primary key AND at least one
# of these appears in recent context. Customize per setting.
DEFAULT_SECONDARY_KEYS_40K = [
    "Imperium", "Imperial", "Inquisitor", "Inquisition", "Emperor",
    "Adeptus", "Calixis", "Throne", "Heretic", "xenos",
]


# ---------------------------------------------------------------------------
# Heuristic content/key extraction (legacy fallback)
# ---------------------------------------------------------------------------

SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z“\"])")

def split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    return [s.strip() for s in SENTENCE_END.split(text) if s.strip()]


def heuristic_summarize(sections: list[dict[str, str]], max_tokens: int) -> str:
    if not sections:
        return ""
    out_parts: list[str] = []
    used = 0
    lead = sections[0]["text"]
    for sent in split_sentences(lead):
        cost = count_tokens(sent) + 1
        if used + cost > max_tokens:
            break
        out_parts.append(sent)
        used += cost
    for sec in sections[1:]:
        if used >= max_tokens * 0.9:
            break
        heading = sec["heading"]
        heading_text = "" if heading.startswith("_") else f" [{heading}]"
        sentences = split_sentences(sec["text"])
        added_for_section = 0
        for sent in sentences:
            if added_for_section >= 2:
                break
            cost = count_tokens(sent) + count_tokens(heading_text) + 1
            if used + cost > max_tokens:
                break
            if added_for_section == 0 and heading_text:
                sent = heading_text.strip() + " " + sent
            out_parts.append(sent)
            used += cost
            added_for_section += 1
    return " ".join(out_parts)


# Words/patterns disallowed as standalone keys
STOPWORD_KEYS = {
    "the", "of", "a", "an", "and", "or",
    "lord", "lady", "sir", "house", "system", "world", "sector",
    "planet", "city", "noble", "nobles", "imperium", "inquisitor",
    "inquisition", "emperor", "adeptus", "saint", "cardinal",
}
GENERIC_TAILS = {
    "sector", "system", "world", "sub-sector", "subsector",
    "nebula", "reach", "abyss", "expanse", "marches", "cabal",
    "synod", "conclave", "house", "wiki", "the", "city", "planet",
}
TITLE_PREFIXES = (
    "Lord", "Lady", "Sir", "Saint", "St.", "Inquisitor",
    "Lord Inquisitor", "Sector Governor", "Governor", "Cardinal",
    "Arch-Cardinal", "Arch-Magos", "Magos", "Captain",
    "Lord Militant", "Lord Marshal", "Lord Sector",
    "Canoness", "Senior Astropath",
)
PAREN_RE = re.compile(r"\s*\([^)]*\)$")
LEADING_THE_RE = re.compile(r"^The\s+", re.IGNORECASE)


def _strip_titles(name: str) -> str:
    for prefix in sorted(TITLE_PREFIXES, key=len, reverse=True):
        pat = re.compile(rf"^{re.escape(prefix)}\s+", re.IGNORECASE)
        m = pat.match(name)
        if m:
            return name[m.end():].strip()
    return name


def heuristic_keys(display_title: str, summary: str) -> list[str]:
    """Medium-strict key extraction: full name, common variants, and surname
    only if it's clearly a distinctive proper noun."""
    keys: list[str] = []

    def add(k: str):
        k = k.strip().strip(".,;:")
        if not k or k.lower() in STOPWORD_KEYS or len(k) < 3:
            return
        words = k.split()
        if len(words) > 2:
            internal = " ".join(words[1:-1]).lower()
            if re.search(r"\b(or|and|is|was)\b", internal):
                return
        if k not in keys:
            keys.append(k)

    add(display_title)
    no_the = LEADING_THE_RE.sub("", display_title).strip()
    if no_the != display_title:
        add(no_the)
    no_paren = PAREN_RE.sub("", display_title).strip()
    if no_paren != display_title:
        add(no_paren)
    de_titled = _strip_titles(no_paren)
    if de_titled != no_paren and de_titled:
        add(de_titled)

    # Surname/last word — only if it's a "distinctive" proper noun.
    # Heuristic: 5+ chars, capitalized, not in generic-tails set.
    # 3-4 chars are dropped (too risky for false triggers like "Hax").
    name_for_lastword = de_titled if de_titled else no_paren
    words = name_for_lastword.split()
    if len(words) > 1:
        last = words[-1]
        if (last.lower() not in STOPWORD_KEYS
                and len(last) >= 5
                and last[0].isupper()
                and last.lower() not in GENERIC_TAILS):
            add(last)

    return keys


# ---------------------------------------------------------------------------
# Content header — applied whether or not the entry was LLM-rewritten
# ---------------------------------------------------------------------------

def ensure_header(content: str, display_title: str, type_tag: str = "") -> str:
    """Ensure the content begins with a [Title — type] header line.

    LLM-rewritten content already has this; raw heuristic content does not.
    Idempotent — checks first.
    """
    content = content.lstrip()
    # Already has a [..] header at start?
    if content.startswith("["):
        first_line = content.split("\n", 1)[0]
        if "]" in first_line:
            return content
    header = f"[{display_title}"
    if type_tag:
        header += f" — {type_tag}"
    header += "]"
    return f"{header}\n{content}"


# ---------------------------------------------------------------------------
# Per-entry assembly
# ---------------------------------------------------------------------------

@dataclass
class BuildConfig:
    max_tokens: int = 350
    default_depth: int = 4
    default_position: int = 0
    secondary_keys: list[str] | None = None
    use_secondary_keys: bool = True
    deep_probability: int = 25  # for tier=deep entries
    case_sensitive_keys: bool = False
    match_whole_words: bool = True


def build_entry(
    page: dict[str, Any],
    cfg: BuildConfig,
    constant: bool,
    order: int,
    is_enriched: bool,
) -> dict[str, Any] | None:
    display = page["display_title"]
    categories = page.get("categories", [])
    url = page.get("url", "")

    # Pick content source
    if is_enriched and page.get("rewritten"):
        content = page["rewritten"]
        keys = list(page.get("llm_keys", []))
        type_tag = ""  # already in the rewritten header
    else:
        content = heuristic_summarize(page.get("sections", []), cfg.max_tokens)
        if not content:
            content = page.get("summary", "")
        keys = heuristic_keys(display, page.get("summary", ""))
        # Derive a type tag from categories
        type_tag = _category_to_tag(categories)

    # Apply header to content
    content = ensure_header(content, display, type_tag)

    if not keys or count_tokens(content) < 15:
        return None

    tier = page.get("tier", "regional")  # default if no enrichment
    container = page.get("container")

    # Probability: deep-tier entries fire less often, others always
    probability = cfg.deep_probability if tier == "deep" else 100

    # Comment for human readability in the lorebook editor
    comment_bits = [display]
    if tier:
        comment_bits.append(f"({tier})")
    if container:
        comment_bits.append(f"in {container}")
    if categories:
        comment_bits.append(f"[{', '.join(categories[:2])}]")
    if url:
        comment_bits.append(url)
    comment = " ".join(comment_bits)

    secondary = cfg.secondary_keys if cfg.use_secondary_keys else []
    selective_logic = 0  # AND-ANY: primary AND at least one secondary
    if not secondary:
        selective_logic = 0

    return {
        "key": keys,
        "keysecondary": list(secondary) if secondary else [],
        "comment": comment,
        "content": content,
        "constant": constant,
        "vectorized": False,
        "selective": True,
        "selectiveLogic": selective_logic,
        "addMemo": True,
        "order": order,
        "position": cfg.default_position,
        "disable": False,
        "excludeRecursion": tier == "deep",   # flavor entries shouldn't trigger others
        "preventRecursion": tier == "core",   # core/setting overviews shouldn't cascade
        "delayUntilRecursion": False,
        "probability": probability,
        "useProbability": True,
        "depth": cfg.default_depth,
        "group": "",
        "groupOverride": False,
        "groupWeight": 100,
        "scanDepth": None,
        "caseSensitive": cfg.case_sensitive_keys,
        "matchWholeWords": cfg.match_whole_words,
        "useGroupScoring": None,
        "automationId": "",
        "role": 0,
        "sticky": 0,
        "cooldown": 0,
        "delay": 0,
        # Internal bookkeeping; stripped before output:
        "_tier": tier,
        "_container": container,
    }


def _category_to_tag(categories: list[str]) -> str:
    """Pick a short type tag from wiki categories. Used for non-enriched entries."""
    cat_set = {c.lower() for c in categories}
    rules = [
        ({"sub-sector", "sub-sectors", "subsector", "subsectors"}, "Sub-sector"),
        ({"forge worlds", "forge world"}, "Forge World"),
        ({"hive worlds", "hive world"}, "Hive World"),
        ({"agri worlds", "agri world"}, "Agri World"),
        ({"shrine worlds", "shrine world"}, "Shrine World"),
        ({"death worlds", "death world"}, "Death World"),
        ({"feudal worlds", "feudal world"}, "Feudal World"),
        ({"feral worlds", "feral world"}, "Feral World"),
        ({"frontier worlds", "frontier world"}, "Frontier World"),
        ({"planets", "worlds"}, "Planet"),
        ({"locations", "regions"}, "Location"),
        ({"organisations", "organizations", "factions"}, "Faction"),
        ({"nobility", "noble houses", "houses"}, "House"),
        ({"characters", "individuals", "people"}, "NPC"),
        ({"events"}, "Event"),
    ]
    for cat_keys, tag in rules:
        if cat_set & cat_keys:
            return tag
    return ""


# ---------------------------------------------------------------------------
# Lorebook assembly
# ---------------------------------------------------------------------------

def assemble_lorebook(name: str, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Wrap a list of entries into the SillyTavern lorebook envelope."""
    indexed: dict[str, dict[str, Any]] = {}
    for i, e in enumerate(entries):
        # Strip our internal fields before emitting
        clean = {k: v for k, v in e.items() if not k.startswith("_")}
        indexed[str(i)] = clean
    return {
        "name": name,
        "entries": indexed,
        "originalData": None,
    }


def write_lorebook(path: Path, name: str, entries: list[dict[str, Any]]):
    if not entries:
        return
    lb = assemble_lorebook(name, entries)
    path.write_text(json.dumps(lb, indent=2, ensure_ascii=False), encoding="utf-8")
    avg = sum(count_tokens(e["content"]) for e in entries) / len(entries)
    print(f"  Wrote {path} — {len(entries)} entries, avg {avg:.0f} tokens")


def slug(s: str) -> str:
    s = re.sub(r"[^\w\-]+", "_", s).strip("_").lower()
    return s or "unnamed"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="input", required=True, type=Path)
    ap.add_argument("--out", type=Path, help="Single output file (legacy single-lorebook mode)")
    ap.add_argument("--out-dir", type=Path, help="Output directory (multi-lorebook mode, requires enriched input)")
    ap.add_argument("--name", required=True,
                    help="Lorebook display name (single mode) or filename prefix (multi mode)")
    ap.add_argument("--max-tokens", type=int, default=350)
    ap.add_argument("--constant-page", action="append", default=[],
                    help="Page title(s) to mark as constant/always-on. Repeatable.")
    ap.add_argument("--default-depth", type=int, default=4)
    ap.add_argument("--no-secondary-keys", action="store_true",
                    help="Disable AND-secondary-key gating")
    ap.add_argument("--secondary-keys", nargs="*", default=None,
                    help="Custom list of secondary keys (default: 40k setting words)")
    ap.add_argument("--no-whole-words", action="store_true",
                    help="Disable matchWholeWords (allow substring matches)")
    ap.add_argument("--case-sensitive", action="store_true",
                    help="Match keys case-sensitively (recommended for short surnames)")
    ap.add_argument("--deep-probability", type=int, default=25,
                    help="Probability percent for tier=deep entries (default: 25)")
    args = ap.parse_args()

    if not args.out and not args.out_dir:
        print("ERROR: must specify --out or --out-dir", file=sys.stderr)
        return 1

    pages = json.loads(args.input.read_text(encoding="utf-8"))
    print(f"Loaded {len(pages)} pages from {args.input}")

    # Detect whether input is enriched
    is_enriched = any("rewritten" in p for p in pages)
    print(f"Enriched data: {is_enriched}")
    if args.out_dir and not is_enriched:
        print("WARN: --out-dir without enriched data will produce only a 'misc' lorebook.", file=sys.stderr)

    cfg = BuildConfig(
        max_tokens=args.max_tokens,
        default_depth=args.default_depth,
        secondary_keys=args.secondary_keys if args.secondary_keys is not None else DEFAULT_SECONDARY_KEYS_40K,
        use_secondary_keys=not args.no_secondary_keys,
        deep_probability=args.deep_probability,
        case_sensitive_keys=args.case_sensitive,
        match_whole_words=not args.no_whole_words,
    )
    constant_titles = {t.replace(" ", "_") for t in args.constant_page}

    # Sort: constant, then by tier (core > regional > deep), then by depth
    tier_rank = {"core": 0, "regional": 1, "deep": 2}
    def sort_key(p):
        return (
            p["title"] not in constant_titles,
            tier_rank.get(p.get("tier", "regional"), 1),
            p.get("depth", 99),
            p["display_title"],
        )

    sorted_pages = sorted(pages, key=sort_key)

    all_entries: list[dict[str, Any]] = []
    skipped = {"empty": 0, "duplicate": 0, "error": 0}
    seen_primary: set[str] = set()

    for i, page in enumerate(sorted_pages):
        if page.get("enrichment_error"):
            skipped["error"] += 1
            continue

        is_constant = page["title"] in constant_titles
        tier = page.get("tier", "regional")
        if is_constant:
            order = 1000 + i
        elif tier == "core":
            order = 800
        elif tier == "regional":
            order = 500
        else:
            order = 200

        entry = build_entry(page, cfg, constant=is_constant, order=order, is_enriched=is_enriched)
        if entry is None:
            skipped["empty"] += 1
            continue

        primary = entry["key"][0]
        if primary in seen_primary:
            skipped["duplicate"] += 1
            continue
        seen_primary.add(primary)

        all_entries.append(entry)

    print(f"Built {len(all_entries)} entries (skipped: "
          f"{skipped['empty']} empty, {skipped['duplicate']} duplicate, "
          f"{skipped['error']} enrichment-error)")

    # Single-lorebook mode
    if args.out:
        write_lorebook(args.out, args.name, all_entries)
        return 0

    # Multi-lorebook mode
    args.out_dir.mkdir(parents=True, exist_ok=True)

    core_entries: list[dict[str, Any]] = []
    deep_entries: list[dict[str, Any]] = []
    by_container: dict[str, list[dict[str, Any]]] = {}
    misc_entries: list[dict[str, Any]] = []

    for e in all_entries:
        tier = e.get("_tier", "regional")
        container = e.get("_container")
        if tier == "core" or e["constant"]:
            core_entries.append(e)
        elif tier == "deep":
            deep_entries.append(e)
        elif container:
            by_container.setdefault(container, []).append(e)
        else:
            misc_entries.append(e)

    write_lorebook(args.out_dir / f"{args.name}_core.json",
                   f"{args.name} — core", core_entries)
    write_lorebook(args.out_dir / f"{args.name}_atmosphere.json",
                   f"{args.name} — atmosphere", deep_entries)
    if misc_entries:
        write_lorebook(args.out_dir / f"{args.name}_misc.json",
                       f"{args.name} — misc", misc_entries)
    for container, entries in sorted(by_container.items()):
        path = args.out_dir / f"{args.name}_{slug(container)}.json"
        write_lorebook(path, f"{args.name} — {container}", entries)

    print(f"\nMulti-lorebook output written to {args.out_dir}/")
    print("Recommended Marinara/SillyTavern setup:")
    print(f"  - Bind {args.name}_core.json globally or to your character card.")
    print(f"  - Bind {args.name}_atmosphere.json globally — entries fire {cfg.deep_probability}% of the time.")
    if by_container:
        print(f"  - Bind per-container books to specific chats when relevant:")
        for container in sorted(by_container)[:5]:
            print(f"      {args.name}_{slug(container)}.json — for scenes in {container}")
        if len(by_container) > 5:
            print(f"      ... and {len(by_container)-5} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
