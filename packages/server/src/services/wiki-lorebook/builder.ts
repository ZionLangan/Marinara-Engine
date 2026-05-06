// ──────────────────────────────────────────────
// Lorebook Builder — split enriched pages into Marinara lorebooks
// Port of wiki converter/build_lorebook.py, but emits Marinara-native
// CreateLorebookEntryInput shapes (no SillyTavern→Marinara round-trip).
// ──────────────────────────────────────────────
import type { CreateLorebookEntryInput } from "@marinara-engine/shared";
import type { EnrichedPage, EntryTier } from "./types.js";

export const DEFAULT_SECONDARY_KEYS_40K = [
  "Imperium",
  "Imperial",
  "Inquisitor",
  "Inquisition",
  "Emperor",
  "Adeptus",
  "Calixis",
  "Throne",
  "Heretic",
  "xenos",
];

const STOPWORD_KEYS = new Set([
  "the",
  "of",
  "a",
  "an",
  "and",
  "or",
  "lord",
  "lady",
  "sir",
  "house",
  "system",
  "world",
  "sector",
  "planet",
  "city",
  "noble",
  "nobles",
  "imperium",
  "inquisitor",
  "inquisition",
  "emperor",
  "adeptus",
  "saint",
  "cardinal",
]);

const GENERIC_TAILS = new Set([
  "sector",
  "system",
  "world",
  "sub-sector",
  "subsector",
  "nebula",
  "reach",
  "abyss",
  "expanse",
  "marches",
  "cabal",
  "synod",
  "conclave",
  "house",
  "wiki",
  "the",
  "city",
  "planet",
]);

const TITLE_PREFIXES = [
  "Lord Inquisitor",
  "Sector Governor",
  "Lord Militant",
  "Lord Marshal",
  "Lord Sector",
  "Arch-Cardinal",
  "Arch-Magos",
  "Senior Astropath",
  "Inquisitor",
  "Cardinal",
  "Governor",
  "Canoness",
  "Magos",
  "Captain",
  "Saint",
  "St.",
  "Lord",
  "Lady",
  "Sir",
];

function approxTokens(s: string): number {
  return Math.max(1, Math.floor(s.length / 4));
}

function stripTitles(name: string): string {
  for (const prefix of TITLE_PREFIXES) {
    const re = new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i");
    const m = name.match(re);
    if (m) return name.slice(m[0].length).trim();
  }
  return name;
}

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z"“])/;

function splitSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  return t.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
}

function heuristicSummarize(sections: { heading: string; text: string }[], maxTokens: number): string {
  const first = sections[0];
  if (!first) return "";
  const parts: string[] = [];
  let used = 0;
  for (const sent of splitSentences(first.text)) {
    const cost = approxTokens(sent) + 1;
    if (used + cost > maxTokens) break;
    parts.push(sent);
    used += cost;
  }
  for (let i = 1; i < sections.length; i++) {
    if (used >= maxTokens * 0.9) break;
    const sec = sections[i];
    if (!sec) continue;
    const headingText = sec.heading.startsWith("_") ? "" : ` [${sec.heading}]`;
    const sentences = splitSentences(sec.text);
    let added = 0;
    for (let s of sentences) {
      if (added >= 2) break;
      const cost = approxTokens(s) + approxTokens(headingText) + 1;
      if (used + cost > maxTokens) break;
      if (added === 0 && headingText) s = headingText.trim() + " " + s;
      parts.push(s);
      used += cost;
      added++;
    }
  }
  return parts.join(" ");
}

function heuristicKeys(displayTitle: string): string[] {
  const keys: string[] = [];
  const add = (raw: string) => {
    const k = raw.trim().replace(/[.,;:]+$/g, "");
    if (!k || STOPWORD_KEYS.has(k.toLowerCase()) || k.length < 3) return;
    const words = k.split(/\s+/);
    if (words.length > 2) {
      const internal = words.slice(1, -1).join(" ").toLowerCase();
      if (/\b(or|and|is|was)\b/.test(internal)) return;
    }
    if (!keys.includes(k)) keys.push(k);
  };
  add(displayTitle);
  const noThe = displayTitle.replace(/^The\s+/i, "").trim();
  if (noThe !== displayTitle) add(noThe);
  const noParen = displayTitle.replace(/\s*\([^)]*\)$/, "").trim();
  if (noParen !== displayTitle) add(noParen);
  const deTitled = stripTitles(noParen);
  if (deTitled && deTitled !== noParen) add(deTitled);

  const nameForLast = deTitled || noParen;
  const words = nameForLast.split(/\s+/);
  if (words.length > 1) {
    const last = words[words.length - 1];
    if (
      last &&
      !STOPWORD_KEYS.has(last.toLowerCase()) &&
      last.length >= 5 &&
      last[0] === last[0]!.toUpperCase() &&
      !GENERIC_TAILS.has(last.toLowerCase())
    ) {
      add(last);
    }
  }
  return keys;
}

function categoryToTag(categories: string[]): string {
  const set = new Set(categories.map((c) => c.toLowerCase()));
  const has = (...cats: string[]) => cats.some((c) => set.has(c));
  if (has("sub-sector", "sub-sectors", "subsector", "subsectors")) return "Sub-sector";
  if (has("forge worlds", "forge world")) return "Forge World";
  if (has("hive worlds", "hive world")) return "Hive World";
  if (has("agri worlds", "agri world")) return "Agri World";
  if (has("shrine worlds", "shrine world")) return "Shrine World";
  if (has("death worlds", "death world")) return "Death World";
  if (has("feudal worlds", "feudal world")) return "Feudal World";
  if (has("feral worlds", "feral world")) return "Feral World";
  if (has("frontier worlds", "frontier world")) return "Frontier World";
  if (has("planets", "worlds")) return "Planet";
  if (has("locations", "regions")) return "Location";
  if (has("organisations", "organizations", "factions")) return "Faction";
  if (has("nobility", "noble houses", "houses")) return "House";
  if (has("characters", "individuals", "people")) return "NPC";
  if (has("events")) return "Event";
  return "";
}

function ensureHeader(content: string, displayTitle: string, typeTag: string): string {
  const trimmed = content.replace(/^\s+/, "");
  if (trimmed.startsWith("[")) {
    const firstLine = trimmed.split("\n", 1)[0] ?? "";
    if (firstLine.includes("]")) return trimmed;
  }
  const header = typeTag ? `[${displayTitle} — ${typeTag}]` : `[${displayTitle}]`;
  return `${header}\n${trimmed}`;
}

export interface BuildConfig {
  maxTokens: number;
  defaultDepth: number;
  defaultPosition: number;
  secondaryKeys: string[];
  useSecondaryKeys: boolean;
  /** 0–100, probability for tier=deep entries. */
  deepProbability: number;
  caseSensitiveKeys: boolean;
  matchWholeWords: boolean;
  /** Page titles (canonical underscore form) to mark as constant/always-on. */
  constantPages: Set<string>;
}

export const defaultBuildConfig = (overrides?: Partial<BuildConfig>): BuildConfig => ({
  maxTokens: 350,
  defaultDepth: 4,
  defaultPosition: 0,
  secondaryKeys: DEFAULT_SECONDARY_KEYS_40K,
  useSecondaryKeys: true,
  deepProbability: 25,
  caseSensitiveKeys: false,
  matchWholeWords: true,
  constantPages: new Set<string>(),
  ...overrides,
});

export type PreparedEntry = Omit<CreateLorebookEntryInput, "lorebookId"> & {
  __tier: EntryTier;
  __container: string | null;
  __constant: boolean;
};

function buildEntry(page: EnrichedPage, cfg: BuildConfig, order: number): PreparedEntry | null {
  const isEnriched = !!page.rewritten;
  let content: string;
  let keys: string[];
  let typeTag = "";

  if (isEnriched && page.rewritten) {
    content = page.rewritten;
    keys = [...(page.llmKeys ?? [])];
  } else {
    content = heuristicSummarize(page.sections, cfg.maxTokens);
    if (!content) content = page.summary;
    keys = heuristicKeys(page.displayTitle);
    typeTag = categoryToTag(page.categories);
  }

  content = ensureHeader(content, page.displayTitle, typeTag);
  if (!keys.length || approxTokens(content) < 15) return null;

  const tier: EntryTier = page.tier ?? "regional";
  const container = page.container ?? null;
  const isConstant = cfg.constantPages.has(page.title);
  const probability = tier === "deep" ? cfg.deepProbability : 100;
  const secondary = cfg.useSecondaryKeys ? cfg.secondaryKeys : [];

  return {
    name: page.displayTitle.slice(0, 200),
    content,
    description: page.url,
    keys,
    secondaryKeys: secondary,
    enabled: true,
    constant: isConstant,
    selective: secondary.length > 0,
    selectiveLogic: "or",
    probability,
    scanDepth: null,
    matchWholeWords: cfg.matchWholeWords,
    caseSensitive: cfg.caseSensitiveKeys,
    useRegex: false,
    position: cfg.defaultPosition,
    depth: cfg.defaultDepth,
    order,
    role: "system",
    sticky: null,
    cooldown: null,
    delay: null,
    ephemeral: null,
    group: "",
    groupWeight: null,
    preventRecursion: tier === "core",
    locked: false,
    tag: container ?? typeTag,
    relationships: {},
    dynamicState: {},
    activationConditions: [],
    schedule: null,
    __tier: tier,
    __container: container,
    __constant: isConstant,
  };
}

export interface BuiltBucket {
  /** Suffix like "core", "atmosphere", "scintilla", "misc". */
  slug: string;
  /** Display name suffix shown in the lorebook list. */
  label: string;
  entries: PreparedEntry[];
}

export interface BuildResult {
  buckets: BuiltBucket[];
  skipped: { empty: number; duplicate: number };
}

function tierOrder(t: EntryTier): number {
  return t === "core" ? 0 : t === "regional" ? 1 : 2;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\w\-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unnamed"
  );
}

/** Build prepared entries and split them into buckets by tier + container. */
export function buildLorebooks(pages: EnrichedPage[], cfg: BuildConfig): BuildResult {
  const skipped = { empty: 0, duplicate: 0 };
  const sorted = [...pages].sort((a, b) => {
    const ac = cfg.constantPages.has(a.title) ? 0 : 1;
    const bc = cfg.constantPages.has(b.title) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const tt = tierOrder(a.tier ?? "regional") - tierOrder(b.tier ?? "regional");
    if (tt !== 0) return tt;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.displayTitle.localeCompare(b.displayTitle);
  });

  const all: PreparedEntry[] = [];
  const seenPrimary = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const page = sorted[i];
    if (!page) continue;
    const tier = page.tier ?? "regional";
    const isConstant = cfg.constantPages.has(page.title);
    const order = isConstant ? 1000 + i : tier === "core" ? 800 : tier === "regional" ? 500 : 200;

    const e = buildEntry(page, cfg, order);
    if (!e) {
      skipped.empty++;
      continue;
    }
    const primary = e.keys?.[0];
    if (!primary) {
      skipped.empty++;
      continue;
    }
    if (seenPrimary.has(primary)) {
      skipped.duplicate++;
      continue;
    }
    seenPrimary.add(primary);
    all.push(e);
  }

  const core: PreparedEntry[] = [];
  const deep: PreparedEntry[] = [];
  const byContainer = new Map<string, PreparedEntry[]>();
  const misc: PreparedEntry[] = [];

  for (const e of all) {
    if (e.__tier === "core" || e.__constant) core.push(e);
    else if (e.__tier === "deep") deep.push(e);
    else if (e.__container) {
      const arr = byContainer.get(e.__container) ?? [];
      arr.push(e);
      byContainer.set(e.__container, arr);
    } else misc.push(e);
  }

  const buckets: BuiltBucket[] = [];
  if (core.length) buckets.push({ slug: "core", label: "core", entries: core });
  if (deep.length) buckets.push({ slug: "atmosphere", label: "atmosphere", entries: deep });
  for (const [container, entries] of [...byContainer.entries()].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  )) {
    buckets.push({ slug: slugify(container), label: container, entries });
  }
  if (misc.length) buckets.push({ slug: "misc", label: "misc", entries: misc });

  return { buckets, skipped };
}
