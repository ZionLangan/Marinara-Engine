#!/usr/bin/env python3
"""
enrich_with_llm.py — Process scraped wiki entries through an LLM to produce
rewritten content, suggested trigger keys, importance tier, and container
assignment.

Targets any OpenAI-compatible chat completions endpoint:
  - OpenAI proper       (--base-url https://api.openai.com/v1)
  - OpenRouter          (--base-url https://openrouter.ai/api/v1)
  - Local LM Studio     (--base-url http://localhost:1234/v1)
  - Ollama              (--base-url http://localhost:11434/v1)
  - Anthropic via OAI compat layer, etc.

Resumable: writes results incrementally to the output file. Re-run the same
command and it picks up where it left off.

Usage:
    python enrich_with_llm.py \\
        --in scraped.json \\
        --out enriched.json \\
        --containers containers.txt \\
        --base-url https://openrouter.ai/api/v1 \\
        --model openai/gpt-4o-mini \\
        --api-key-env OPENROUTER_API_KEY \\
        --concurrency 6
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import requests


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are processing wiki entries for use as reference material by a roleplay AI. \
Your job is to convert verbose wiki prose into terse, structured reference notes \
that an AI can scan quickly to maintain consistency.

For each entry you receive, return ONLY a JSON object (no prose, no markdown \
fences) with these fields:

- "rewritten": Reference-style content, max ~250 tokens. MUST start with a \
  header on its own line in the format "[Name — short type tag]" where the \
  type tag is one of: NPC, Location, Sub-sector, Planet, Forge World, Hive World, \
  Faction, Organization, House, Event, Concept, Artifact. Body should use short \
  declarative sentences or fragments. Preserve all proper nouns and concrete \
  details (numbers, titles, dates, names of related entities). Drop wiki rhetoric \
  ("It is little wonder that...", "Many believe..."). Drop in-universe quotation \
  blocks unless very short and key.

- "keys": A list of 1-6 trigger phrases that, if mentioned in chat, should \
  bring up this entry. Rules:
    * Full canonical name MUST be the first key.
    * Include common variants (with/without "The", with/without honorifics).
    * Include surname or distinctive last word ONLY if it is unambiguously \
      proper-noun-like and unlikely to appear in unrelated contexts. \
      "Caidin" yes; "Hax" maybe; "Smith" never; "Lord" never; "Sector" never.
    * Include alternate names ("known as the Tyrant Star") if explicitly \
      stated in the entry.
    * NEVER include generic English words, profession names, or category \
      words ("noble", "inquisitor", "world", "city").
    * Keys must be at least 4 characters unless they are a clearly proper noun.

- "tier": One of:
    * "core" — fundamental setting elements that are always relevant in any \
      scene set in this universe (the sector itself, the major institutions \
      like the Inquisition).
    * "regional" — specific to a place, faction, or person; relevant when \
      that place/faction/person is in play. This is the default for most \
      entries.
    * "deep" — minor or atmospheric detail rarely needed; a flavor entry \
      that adds color when it happens to fire.

- "container": If the entry's relevance is geographically or organizationally \
  scoped, the name of the container it belongs to (a planet, sub-sector, \
  faction, or noble house), chosen FROM THE PROVIDED CONTAINER LIST ONLY. \
  If the entry doesn't clearly belong to one container (e.g., a sector-wide \
  concept, the Imperium itself), use null. An entry can belong to at most \
  ONE container — pick the most specific one.

Return only the JSON object. No code fences. No commentary."""


USER_TEMPLATE = """Container list (pick at most one for "container", or null):
{containers}

Entry title: {title}
Entry categories: {categories}

Entry content:
{content}"""


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: int = 60):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def chat(self, system: str, user: str, max_tokens: int = 1000, temperature: float = 0.2) -> str:
        url = f"{self.base_url}/chat/completions"
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        # Some endpoints (newer OpenAI, OpenRouter) support response_format:
        # use it if you want, but it's not universal across local servers.
        # We rely on prompting + parsing instead for portability.

        for attempt in range(3):
            try:
                r = self.session.post(url, json=payload, timeout=self.timeout)
                if r.status_code == 429:
                    wait = 2 ** attempt
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                data = r.json()
                return data["choices"][0]["message"]["content"]
            except requests.HTTPError as e:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
            except requests.RequestException as e:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")


# ---------------------------------------------------------------------------
# JSON parsing — LLMs return imperfect JSON
# ---------------------------------------------------------------------------

def parse_llm_json(text: str) -> dict[str, Any] | None:
    """Best-effort parsing of LLM output that should be JSON.

    Real LLMs frequently emit JSON where string values contain literal
    newlines instead of \\n escapes. Strict json.loads rejects this. We
    fall back to a permissive pass that re-escapes raw control characters
    inside double-quoted strings.
    """
    # Strip code fences
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text)

    def try_parse(s: str) -> dict[str, Any] | None:
        try:
            obj = json.loads(s)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None

    # Attempt 1: as-is
    obj = try_parse(text)
    if obj:
        return obj

    # Attempt 2: extract first {...} block
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    block = m.group(0)
    obj = try_parse(block)
    if obj:
        return obj

    # Attempt 3: re-escape raw control chars inside double-quoted strings
    fixed = _escape_string_controls(block)
    return try_parse(fixed)


def _escape_string_controls(s: str) -> str:
    """Walk a JSON-ish string and escape literal \\n, \\r, \\t inside
    double-quoted string values, while leaving structural JSON alone.

    Rough state machine: track whether we're inside a "..." string,
    whether the previous char was a backslash (so we don't double-escape).
    """
    out: list[str] = []
    in_string = False
    escaped = False
    for ch in s:
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\" and in_string:
            out.append(ch)
            escaped = True
            continue
        if ch == '"':
            out.append(ch)
            in_string = not in_string
            continue
        if in_string and ch == "\n":
            out.append("\\n")
            continue
        if in_string and ch == "\r":
            out.append("\\r")
            continue
        if in_string and ch == "\t":
            out.append("\\t")
            continue
        out.append(ch)
    return "".join(out)


def validate_enrichment(obj: dict[str, Any], containers: set[str]) -> tuple[bool, str]:
    """Sanity-check an LLM enrichment. Returns (ok, reason)."""
    if not isinstance(obj, dict):
        return False, "not a dict"
    for f in ("rewritten", "keys", "tier"):
        if f not in obj:
            return False, f"missing field: {f}"
    if not isinstance(obj["rewritten"], str) or len(obj["rewritten"]) < 20:
        return False, "rewritten too short or non-string"
    if not isinstance(obj["keys"], list) or not obj["keys"]:
        return False, "keys empty or non-list"
    if obj["tier"] not in {"core", "regional", "deep"}:
        return False, f"invalid tier: {obj['tier']!r}"
    container = obj.get("container")
    if container is not None:
        if not isinstance(container, str):
            return False, "container is not string or null"
        if container not in containers:
            # LLM hallucinated a container. Coerce to None rather than reject.
            obj["container"] = None
    return True, ""


# ---------------------------------------------------------------------------
# Per-entry processing
# ---------------------------------------------------------------------------

def build_user_prompt(page: dict[str, Any], containers: list[str]) -> str:
    # Concatenate sections for content
    sections = page.get("sections", [])
    parts: list[str] = []
    for s in sections:
        h = s.get("heading", "_lead")
        text = s.get("text", "")
        if not text.strip():
            continue
        if h.startswith("_"):
            parts.append(text)
        else:
            parts.append(f"## {h}\n{text}")
    content = "\n\n".join(parts) or page.get("summary", "")

    # Truncate aggressively to avoid blowing the context — most lorebook entries
    # only need the lead anyway.
    if len(content) > 6000:
        content = content[:6000] + " ..."

    container_block = "\n".join(f"- {c}" for c in containers) or "(none provided)"
    return USER_TEMPLATE.format(
        containers=container_block,
        title=page["display_title"],
        categories=", ".join(page.get("categories", [])) or "(none)",
        content=content,
    )


def enrich_one(client: LLMClient, page: dict[str, Any], containers: list[str]) -> dict[str, Any]:
    """Process a single page. Returns the page dict with enrichment fields added."""
    user = build_user_prompt(page, containers)
    container_set = set(containers)

    enriched = dict(page)
    enriched["enrichment_error"] = None

    try:
        raw = client.chat(SYSTEM_PROMPT, user, max_tokens=800, temperature=0.2)
    except Exception as e:
        enriched["enrichment_error"] = f"api: {e}"
        return enriched

    parsed = parse_llm_json(raw)
    if parsed is None:
        enriched["enrichment_error"] = f"unparseable: {raw[:200]!r}"
        return enriched

    ok, reason = validate_enrichment(parsed, container_set)
    if not ok:
        enriched["enrichment_error"] = f"invalid: {reason}"
        return enriched

    enriched["rewritten"] = parsed["rewritten"]
    enriched["llm_keys"] = parsed["keys"]
    enriched["tier"] = parsed["tier"]
    enriched["container"] = parsed.get("container")
    return enriched


# ---------------------------------------------------------------------------
# Resumable runner
# ---------------------------------------------------------------------------

def load_progress(out_path: Path) -> dict[str, dict[str, Any]]:
    """Load already-enriched entries, keyed by page title."""
    if not out_path.exists():
        return {}
    try:
        existing = json.loads(out_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"  ! Existing output file is corrupt, starting over", file=sys.stderr)
        return {}
    return {p["title"]: p for p in existing if "rewritten" in p and not p.get("enrichment_error")}


def save_progress(out_path: Path, enriched_map: dict[str, dict[str, Any]], lock: threading.Lock):
    with lock:
        data = list(enriched_map.values())
        tmp = out_path.with_suffix(out_path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(out_path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--containers", required=True, type=Path,
                    help="Path to curated container list (text file, one name per line)")
    ap.add_argument("--base-url", required=True,
                    help="OpenAI-compatible API base URL (e.g. https://openrouter.ai/api/v1)")
    ap.add_argument("--model", required=True, help="Model name (e.g. openai/gpt-4o-mini)")
    ap.add_argument("--api-key-env", default="OPENAI_API_KEY",
                    help="Env var holding the API key (default: OPENAI_API_KEY)")
    ap.add_argument("--concurrency", type=int, default=4, help="Parallel requests (default: 4)")
    ap.add_argument("--limit", type=int, default=None, help="Process at most N entries (for testing)")
    ap.add_argument("--save-every", type=int, default=10, help="Checkpoint frequency (default: 10)")
    args = ap.parse_args()

    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        print(f"ERROR: env var {args.api_key_env} not set", file=sys.stderr)
        return 1

    # Load containers
    containers: list[str] = []
    for line in args.containers.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            containers.append(line)
    print(f"Loaded {len(containers)} containers from {args.containers}")

    # Load scraped pages
    pages = json.loads(args.input.read_text(encoding="utf-8"))
    print(f"Loaded {len(pages)} scraped pages from {args.input}")

    # Load any existing progress
    done = load_progress(args.out)
    print(f"Resuming: {len(done)} entries already enriched")

    todo = [p for p in pages if p["title"] not in done]
    if args.limit:
        todo = todo[:args.limit]
    print(f"To enrich: {len(todo)} entries")

    if not todo:
        print("Nothing to do. Output is up to date.")
        return 0

    client = LLMClient(args.base_url, api_key, args.model)
    lock = threading.Lock()
    completed = 0
    errors = 0

    print(f"Starting enrichment with {args.concurrency} workers...")
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        future_to_title = {
            pool.submit(enrich_one, client, p, containers): p["title"]
            for p in todo
        }
        for fut in as_completed(future_to_title):
            title = future_to_title[fut]
            try:
                result = fut.result()
            except Exception as e:
                print(f"  ! {title}: hard failure {e}", file=sys.stderr)
                errors += 1
                continue

            if result.get("enrichment_error"):
                print(f"  ! {title}: {result['enrichment_error']}", file=sys.stderr)
                errors += 1
            else:
                done[title] = result
                completed += 1

            if completed and completed % args.save_every == 0:
                save_progress(args.out, done, lock)
                elapsed = time.time() - t0
                rate = completed / elapsed if elapsed else 0
                remaining = len(todo) - completed - errors
                eta = remaining / rate if rate else 0
                print(f"  [{completed}/{len(todo)}] errors={errors} "
                      f"rate={rate:.1f}/s eta={eta:.0f}s")

    # Final save
    save_progress(args.out, done, lock)
    elapsed = time.time() - t0
    print(f"\nDone. Enriched {completed} entries, {errors} errors, "
          f"in {elapsed:.0f}s ({completed/elapsed:.1f}/s)")
    print(f"Wrote {args.out}")
    if errors:
        print(f"Re-run the same command to retry failed entries.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
