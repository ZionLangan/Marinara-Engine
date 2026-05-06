#!/usr/bin/env python3
"""
extract_containers.py — Extract candidate "container" pages (sub-sectors,
planets, major factions) from scraped wiki JSON, for use during LLM
enrichment.

Output is a simple text file where each line is a container name, with
'#'-prefixed comments indicating the category it came from. You're meant
to open this in a text editor, delete entries you don't want, and pass it
to enrich_with_llm.py via --containers.

Usage:
    python extract_containers.py --in scraped.json --out containers.txt
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


# Categories that strongly suggest a page is a "container" — a place or
# faction that other entries might belong to.
CONTAINER_CATEGORY_PATTERNS = [
    "sub-sector", "subsector", "sub sector",
    "sector",
    "system",
    "world", "planet",
    "forge world", "hive world", "agri world", "death world",
    "shrine world", "feudal world", "feral world", "frontier world",
    "organisation", "organization",
    "faction",
    "house",  # noble houses
    "cult", "creed", "church",
]


def is_container_category(cat: str) -> bool:
    cl = cat.lower()
    return any(p in cl for p in CONTAINER_CATEGORY_PATTERNS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    pages = json.loads(args.input.read_text(encoding="utf-8"))

    # Group candidates by their most container-y category
    by_category: dict[str, list[str]] = defaultdict(list)
    for p in pages:
        for cat in p.get("categories", []):
            if is_container_category(cat):
                by_category[cat].append(p["display_title"])
                break  # use first matching category only

    lines: list[str] = []
    lines.append("# Container list — edit this file before running enrichment.")
    lines.append("# Each non-comment line is a 'container' that entries can be assigned to.")
    lines.append("# Delete lines you don't want. Reorder freely.")
    lines.append("# Format: one container name per line.")
    lines.append("")

    for cat in sorted(by_category):
        names = sorted(set(by_category[cat]))
        lines.append(f"# --- {cat} ({len(names)}) ---")
        for n in names:
            lines.append(n)
        lines.append("")

    args.out.write_text("\n".join(lines), encoding="utf-8")
    total = sum(len(set(v)) for v in by_category.values())
    print(f"Wrote {total} container candidates across {len(by_category)} categories to {args.out}")
    print(f"Edit the file, then pass it to enrich_with_llm.py --containers {args.out}")
    return 0


if __name__ == "__main__":
    main()
