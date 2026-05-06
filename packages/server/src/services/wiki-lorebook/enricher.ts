// ──────────────────────────────────────────────
// LLM Enrichment — rewrite + suggest keys/tier/container
// Port of wiki converter/enrich_with_llm.py, using the
// in-process BaseLLMProvider abstraction instead of OpenAI HTTP.
// ──────────────────────────────────────────────
import type { BaseLLMProvider } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import type { EnrichedPage, EntryTier, ScrapedPage } from "./types.js";

const SYSTEM_PROMPT = `You are processing wiki entries for use as reference material by a roleplay AI. \
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

Return only the JSON object. No code fences. No commentary.`;

const USER_TEMPLATE = (containers: string, title: string, categories: string, content: string) =>
  `Container list (pick at most one for "container", or null):
${containers}

Entry title: ${title}
Entry categories: ${categories}

Entry content:
${content}`;

function buildUserPrompt(page: ScrapedPage, containers: string[]): string {
  const parts: string[] = [];
  for (const s of page.sections) {
    if (!s.text.trim()) continue;
    if (s.heading.startsWith("_")) parts.push(s.text);
    else parts.push(`## ${s.heading}\n${s.text}`);
  }
  let content = parts.join("\n\n") || page.summary;
  if (content.length > 6000) content = content.slice(0, 6000) + " ...";
  const containerBlock = containers.length ? containers.map((c) => `- ${c}`).join("\n") : "(none provided)";
  return USER_TEMPLATE(
    containerBlock,
    page.displayTitle,
    page.categories.join(", ") || "(none)",
    content,
  );
}

/** Best-effort LLM JSON extraction: fence-strip → outer-brace → re-escape. */
export function parseLLMJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const obj = JSON.parse(s);
      return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const a = tryParse(text);
  if (a) return a;

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const block = m[0];
  const b = tryParse(block);
  if (b) return b;

  return tryParse(escapeStringControls(block));
}

function escapeStringControls(s: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = !inStr;
      continue;
    }
    if (inStr && ch === "\n") {
      out += "\\n";
      continue;
    }
    if (inStr && ch === "\r") {
      out += "\\r";
      continue;
    }
    if (inStr && ch === "\t") {
      out += "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

interface ValidationResult {
  ok: boolean;
  reason: string;
}

function validateEnrichment(obj: Record<string, unknown>, containers: Set<string>): ValidationResult {
  for (const f of ["rewritten", "keys", "tier"] as const) {
    if (!(f in obj)) return { ok: false, reason: `missing field: ${f}` };
  }
  if (typeof obj.rewritten !== "string" || obj.rewritten.length < 20) {
    return { ok: false, reason: "rewritten too short or non-string" };
  }
  if (!Array.isArray(obj.keys) || obj.keys.length === 0) {
    return { ok: false, reason: "keys empty or non-list" };
  }
  if (typeof obj.tier !== "string" || !["core", "regional", "deep"].includes(obj.tier)) {
    return { ok: false, reason: `invalid tier: ${String(obj.tier)}` };
  }
  const c = obj.container;
  if (c !== undefined && c !== null) {
    if (typeof c !== "string") return { ok: false, reason: "container is not string or null" };
    if (!containers.has(c)) {
      // Hallucinated container — coerce to null rather than reject.
      obj.container = null;
    }
  }
  return { ok: true, reason: "" };
}

/** Drain an async-generator chat stream into a single string. */
async function drainChat(
  provider: BaseLLMProvider,
  model: string,
  system: string,
  user: string,
  maxTokens = 1500,
): Promise<string> {
  let out = "";
  const gen = provider.chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { model, temperature: 0.2, maxTokens, stream: false },
  );
  for await (const chunk of gen) out += chunk;
  return out;
}

const RESCUE_SYSTEM = `Return ONLY a valid JSON object. No markdown fences. No explanation.`;

function buildRescuePrompt(page: ScrapedPage, containers: string[]): string {
  const content = (page.sections[0]?.text ?? page.summary).slice(0, 1000);
  const containerBlock = containers.length ? containers.map((c) => `- ${c}`).join("\n") : "(none)";
  return `Title: ${page.displayTitle}
Categories: ${page.categories.join(", ") || "none"}
Containers (pick the most relevant one, or null if none fit):
${containerBlock}

Summarise the following in 2-3 short sentences for a tabletop RPG reference note.
Content: ${content}

Return JSON exactly like this (fill in values, keep the field names):
{"rewritten":"[${page.displayTitle} — TYPE]\\nSUMMARY","keys":["key1","key2"],"tier":"regional","container":null}`;
}

/** Process one page. Always returns an EnrichedPage; failures populate enrichmentError. */
export async function enrichOne(
  page: ScrapedPage,
  containers: string[],
  provider: BaseLLMProvider,
  model: string,
): Promise<EnrichedPage> {
  const enriched: EnrichedPage = { ...page, enrichmentError: null };
  const userPrompt = buildUserPrompt(page, containers);
  const containerSet = new Set(containers);

  let raw: string;
  try {
    raw = await drainChat(provider, model, SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    enriched.enrichmentError = `api: ${err instanceof Error ? err.message : String(err)}`;
    return enriched;
  }

  let parsed = parseLLMJson(raw);
  let v = parsed ? validateEnrichment(parsed, containerSet) : null;

  if (!parsed || !v?.ok) {
    // Rescue retry with a simplified prompt
    try {
      const rescueRaw = await drainChat(provider, model, RESCUE_SYSTEM, buildRescuePrompt(page, containers), 600);
      const rescueParsed = parseLLMJson(rescueRaw);
      if (rescueParsed) {
        const rv = validateEnrichment(rescueParsed, containerSet);
        if (rv.ok) {
          parsed = rescueParsed;
          v = rv;
        }
      }
    } catch {
      // rescue call failed — fall through to heuristic
    }
  }

  if (!parsed || !v?.ok) {
    // Both attempts failed — heuristic fallback handled by builder
    enriched.enrichmentError = "heuristic";
    return enriched;
  }

  enriched.rewritten = parsed.rewritten as string;
  enriched.llmKeys = parsed.keys as string[];
  enriched.tier = parsed.tier as EntryTier;
  enriched.container = (parsed.container as string | null | undefined) ?? null;
  return enriched;
}

/** Bounded-concurrency worker pool — 20-line p-limit replacement. */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i] as T;
      const r = await fn(item, i);
      results[i] = r;
      onResult?.(r, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface EnrichOptions {
  pages: ScrapedPage[];
  containers: string[];
  provider: BaseLLMProvider;
  model: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (info: { completed: number; failed: number; total: number; lastTitle: string; lastError: string | null }) => void;
  /** Called after every page completes so the caller can refresh TTLs etc. */
  onTouch?: () => void;
}

/** Run enrichment across all pages with bounded concurrency. */
export async function enrichPages(opts: EnrichOptions): Promise<EnrichedPage[]> {
  const concurrency = opts.concurrency ?? 4;
  let completed = 0;
  let failed = 0;
  const out = await runWithConcurrency(
    opts.pages,
    concurrency,
    async (page) => {
      if (opts.signal?.aborted) {
        return { ...page, enrichmentError: "aborted" } as EnrichedPage;
      }
      try {
        return await enrichOne(page, opts.containers, opts.provider, opts.model);
      } catch (err) {
        logger.warn(err, "[wiki-enricher] hard failure on %s", page.title);
        return { ...page, enrichmentError: `hard: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    (r) => {
      if (r.enrichmentError) failed++;
      else completed++;
      opts.onProgress?.({
        completed,
        failed,
        total: opts.pages.length,
        lastTitle: r.displayTitle,
        lastError: r.enrichmentError ?? null,
      });
      opts.onTouch?.();
    },
  );
  return out;
}
