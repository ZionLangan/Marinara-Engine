#!/usr/bin/env python3
"""
scrape_wiki.py — Generic Fandom wiki scraper using the MediaWiki API.

Crawls a Fandom wiki starting from a seed page and produces an intermediate
JSON file (one record per page) suitable for feeding into build_lorebook.py.

Usage:
    python scrape_wiki.py \\
        --wiki calixipedia \\
        --seed "The_Calixis_Sector" \\
        --max-depth 3 \\
        --max-pages 500 \\
        --out scraped.json

The output is plain JSON, not a Marinara/SillyTavern lorebook. The split is
intentional: scraping is slow, lorebook assembly is fast and you'll likely
re-run the converter several times to tune chunking and keys.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

USER_AGENT = (
    "LorebookBuilder/1.0 "
    "(personal use; contact via the wiki if this is a problem)"
)
DEFAULT_SLEEP = 0.5  # seconds between API calls — be polite
API_TIMEOUT = 30

# Pages whose names match these patterns are skipped. Fandom wikis have a lot
# of administrative cruft (Forum:, File:, Category:, User:, etc.) that we
# don't want in a lorebook.
NAMESPACE_SKIP = re.compile(
    r"^("
    r"File|Image|Category|Template|User|User_talk|Talk|Forum|Help|"
    r"Special|MediaWiki|Module|Project|Blog|Thread|Board|Message_Wall"
    r"):",
    re.IGNORECASE,
)

# Section headers we generally don't want in lorebook content.
SECTION_SKIP = {
    "references", "external links", "see also", "gallery",
    "trivia", "notes", "sources", "appearances", "navigation",
}


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class Page:
    title: str            # canonical wiki title (with underscores)
    display_title: str    # human-readable title (with spaces)
    url: str
    summary: str          # first paragraph or two, plaintext
    sections: list[dict[str, str]] = field(default_factory=list)  # [{"heading": ..., "text": ...}]
    links: list[str] = field(default_factory=list)  # outgoing wiki links (titles)
    categories: list[str] = field(default_factory=list)
    depth: int = 0        # crawl depth from seed


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class WikiClient:
    def __init__(self, wiki: str, sleep: float = DEFAULT_SLEEP):
        # Accept either a bare wiki name ("calixipedia") or a full host.
        if "." in wiki:
            self.host = wiki
        else:
            self.host = f"{wiki}.fandom.com"
        self.api = f"https://{self.host}/api.php"
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.sleep = sleep

    def _get(self, **params: Any) -> dict[str, Any]:
        params.setdefault("format", "json")
        params.setdefault("formatversion", "2")
        time.sleep(self.sleep)
        r = self.session.get(self.api, params=params, timeout=API_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def fetch_page(self, title: str) -> Page | None:
        """Fetch a single page using the parse API. Returns None if missing."""
        try:
            data = self._get(
                action="parse",
                page=title,
                prop="text|links|categories|displaytitle",
                redirects="1",
                disabletoc="1",
            )
        except requests.HTTPError as e:
            print(f"  ! HTTP error on {title!r}: {e}", file=sys.stderr)
            return None

        if "error" in data:
            print(f"  ! API error on {title!r}: {data['error'].get('info')}", file=sys.stderr)
            return None

        parse = data.get("parse")
        if not parse:
            return None

        canonical = parse["title"].replace(" ", "_")
        display = parse.get("displaytitle", parse["title"])
        # Strip HTML tags from displaytitle (it sometimes contains <i>, etc.)
        display = re.sub(r"<[^>]+>", "", display)

        html = parse.get("text", "") or ""
        summary, sections = _parse_html(html)

        links = []
        for link in parse.get("links", []):
            if link.get("ns", 0) != 0:  # main namespace only
                continue
            if link.get("exists") is False:  # skip redlinks
                continue
            target = link.get("title", "")
            if target and not NAMESPACE_SKIP.match(target.replace(" ", "_")):
                links.append(target.replace(" ", "_"))

        categories = [
            c.get("category", "").replace("_", " ")
            for c in parse.get("categories", [])
            if not c.get("hidden")
        ]

        url = f"https://{self.host}/wiki/{urllib.parse.quote(canonical)}"

        return Page(
            title=canonical,
            display_title=display,
            url=url,
            summary=summary,
            sections=sections,
            links=links,
            categories=categories,
        )


# ---------------------------------------------------------------------------
# HTML parsing
# ---------------------------------------------------------------------------

# We use a minimal-dependency approach: BeautifulSoup if available, else regex
# fallback. BS4 is strongly recommended though — install it.

def _parse_html(html: str) -> tuple[str, list[dict[str, str]]]:
    """Return (summary, sections) from a parsed wiki page's HTML."""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        # Crude fallback. Won't handle nested tables or infoboxes well.
        text = re.sub(r"<[^>]+>", "", html)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:2000], []

    soup = BeautifulSoup(html, "html.parser")

    # Drop noise: infoboxes, navboxes, edit links, references, tables of
    # contents, image captions, etc.
    NOISE_SELECTORS = [
        ".mw-editsection", ".reference", ".mw-references-wrap", ".references",
        ".navbox", ".infobox", ".portable-infobox", ".thumb", ".gallery",
        ".toc", "#toc", ".hatnote", ".noprint", ".mw-empty-elt",
        ".mw-collapsible-toggle", ".error", "style", "script",
    ]
    for sel in NOISE_SELECTORS:
        for tag in soup.select(sel):
            tag.decompose()

    # Sections are H2-delimited at the top level on most wikis.
    sections: list[dict[str, str]] = []
    current_heading = "_lead"
    current_buffer: list[str] = []

    body = soup.find("div", class_="mw-parser-output") or soup

    for el in body.children:
        name = getattr(el, "name", None)
        if name in ("h2", "h3"):
            # Flush previous section
            if current_buffer:
                sections.append({
                    "heading": current_heading,
                    "text": _clean_text(" ".join(current_buffer)),
                })
                current_buffer = []
            heading_text = el.get_text(" ", strip=True)
            current_heading = heading_text
        elif name == "p":
            txt = el.get_text(" ", strip=True)
            if txt:
                current_buffer.append(txt)
        elif name in ("ul", "ol"):
            for li in el.find_all("li", recursive=False):
                txt = li.get_text(" ", strip=True)
                if txt:
                    current_buffer.append(f"• {txt}")
        # Skip everything else (tables, divs, figures, etc.)

    if current_buffer:
        sections.append({
            "heading": current_heading,
            "text": _clean_text(" ".join(current_buffer)),
        })

    # Filter out junk sections
    sections = [
        s for s in sections
        if s["heading"].lower() not in SECTION_SKIP
        and s["text"].strip()
    ]

    # Lead = first section (usually "_lead")
    summary = sections[0]["text"] if sections else ""
    return summary, sections


def _clean_text(s: str) -> str:
    s = re.sub(r"\[\d+\]", "", s)         # citation markers
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ---------------------------------------------------------------------------
# Crawler
# ---------------------------------------------------------------------------

def crawl(
    client: WikiClient,
    seed: str,
    max_depth: int,
    max_pages: int,
    allowed_categories: set[str] | None = None,
) -> list[Page]:
    """BFS crawl from seed page. Returns list of fetched Page objects."""
    seed = seed.replace(" ", "_")
    queue: list[tuple[str, int]] = [(seed, 0)]
    seen: set[str] = set()
    pages: list[Page] = []

    while queue and len(pages) < max_pages:
        title, depth = queue.pop(0)
        if title in seen:
            continue
        seen.add(title)

        if NAMESPACE_SKIP.match(title):
            continue

        print(f"[{len(pages)+1}/{max_pages}] depth={depth} {title}")
        page = client.fetch_page(title)
        if page is None:
            continue

        # Optional category filter — useful if you want to constrain the crawl
        # (e.g. only "Calixis Sector" pages, not the entire wiki).
        if allowed_categories is not None:
            if not any(c in allowed_categories for c in page.categories):
                # Still followed — we just don't include it. But for now,
                # treat as exclude entirely.
                continue

        page.depth = depth
        pages.append(page)

        if depth < max_depth:
            for link in page.links:
                if link not in seen:
                    queue.append((link, depth + 1))

    return pages


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wiki", required=True, help="Wiki name (e.g. 'calixipedia') or full host")
    ap.add_argument("--seed", required=True, help="Seed page title (e.g. 'The_Calixis_Sector')")
    ap.add_argument("--max-depth", type=int, default=2, help="BFS depth (default: 2)")
    ap.add_argument("--max-pages", type=int, default=300, help="Hard cap on total pages (default: 300)")
    ap.add_argument("--sleep", type=float, default=DEFAULT_SLEEP, help=f"Seconds between API calls (default: {DEFAULT_SLEEP})")
    ap.add_argument("--out", type=Path, default=Path("scraped.json"), help="Output JSON file")
    ap.add_argument("--categories", nargs="*", default=None,
                    help="If set, only include pages with one of these categories")
    args = ap.parse_args()

    client = WikiClient(args.wiki, sleep=args.sleep)
    allowed = set(args.categories) if args.categories else None

    print(f"Scraping {client.host} starting from {args.seed!r}")
    print(f"  max_depth={args.max_depth}, max_pages={args.max_pages}")
    if allowed:
        print(f"  category filter: {sorted(allowed)}")

    pages = crawl(client, args.seed, args.max_depth, args.max_pages, allowed)

    print(f"\nFetched {len(pages)} pages. Writing {args.out}")
    args.out.write_text(
        json.dumps([asdict(p) for p in pages], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
