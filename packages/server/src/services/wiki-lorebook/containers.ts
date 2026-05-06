// ──────────────────────────────────────────────
// Container Candidate Extraction
// Port of wiki converter/extract_containers.py
// ──────────────────────────────────────────────
import type { ContainerCandidate, ScrapedPage } from "./types.js";

const CONTAINER_CATEGORY_PATTERNS = [
  "sub-sector",
  "subsector",
  "sub sector",
  "sector",
  "system",
  "world",
  "planet",
  "forge world",
  "hive world",
  "agri world",
  "death world",
  "shrine world",
  "feudal world",
  "feral world",
  "frontier world",
  "organisation",
  "organization",
  "faction",
  "house",
  "cult",
  "creed",
  "church",
];

function isContainerCategory(cat: string): boolean {
  const cl = cat.toLowerCase();
  return CONTAINER_CATEGORY_PATTERNS.some((p) => cl.includes(p));
}

/**
 * Detect candidate "container" pages from scraped data. Each page is
 * assigned at most one candidate slot, derived from its first matching
 * category. Output is deduplicated by name and sorted by category.
 */
export function extractContainerCandidates(pages: ScrapedPage[]): ContainerCandidate[] {
  const seen = new Set<string>();
  const out: ContainerCandidate[] = [];
  for (const p of pages) {
    for (const cat of p.categories) {
      if (!isContainerCategory(cat)) continue;
      if (seen.has(p.displayTitle)) break;
      seen.add(p.displayTitle);
      out.push({ name: p.displayTitle, category: cat });
      break;
    }
  }
  out.sort((a, b) => {
    const c = a.category.localeCompare(b.category);
    return c !== 0 ? c : a.name.localeCompare(b.name);
  });
  return out;
}
