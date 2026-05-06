// ──────────────────────────────────────────────
// LLM-based categorization advisor for the wiki → lorebook wizard.
// Two exported functions:
//   suggestCategorizations — pre-scan a page sample → 2-4 grouping strategies
//   generateCategories     — given user's description + page sample → grounded category list
// ──────────────────────────────────────────────
import type { BaseLLMProvider } from "../llm/base-provider.js";
import { logger } from "../../lib/logger.js";
import type { CategorySuggestion, ScrapedPage } from "./types.js";
import { parseLLMJson } from "./enricher.js";

const MAX_SAMPLE = 40;

/** Pick up to MAX_SAMPLE pages, prioritising lower depth (core) pages. */
function samplePages(pages: ScrapedPage[]): ScrapedPage[] {
  const sorted = [...pages].sort((a, b) => a.depth - b.depth);
  return sorted.slice(0, MAX_SAMPLE);
}

function buildPageList(sample: ScrapedPage[]): string {
  return sample
    .map((p) => {
      const cats = p.categories.slice(0, 4).join(", ");
      return `- ${p.displayTitle}${cats ? ` [${cats}]` : ""}`;
    })
    .join("\n");
}

async function drainCat(
  provider: BaseLLMProvider,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  let out = "";
  const gen = provider.chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { model, temperature: 0.3, maxTokens: 1200, stream: false },
  );
  for await (const chunk of gen) out += chunk;
  return out;
}

const SUGGEST_SYSTEM = `You are helping organize a wiki into separate lorebooks for a tabletop RPG.
Analyze the provided page list and suggest 2-4 distinct strategies for dividing these pages into named lorebook buckets.
Each strategy should reflect a meaningfully different way to organize the content.

Return ONLY a JSON object (no markdown, no explanation):
{
  "strategies": [
    {
      "strategy": "short name (3-6 words)",
      "description": "one sentence describing the grouping logic",
      "categories": ["Category Name 1", "Category Name 2", "..."]
    }
  ]
}

Rules:
- Each strategy should produce 3-12 named categories.
- Category names must be specific and grounded in the actual wiki content (e.g. "Golgenna Reach" not "Sub-sector 1").
- Avoid a generic "Misc" or "Other" category unless truly necessary.
- Strategies must be meaningfully different from each other.
- Only include categories that actually appear or are strongly implied by the page list.`;

const GENERATE_SYSTEM = `You are helping organize a wiki into separate lorebooks for a tabletop RPG.
Given a list of wiki pages and a user's description of how they want to organize them, produce a concrete list of category names grounded in the actual wiki content.

Return ONLY a JSON object:
{"categories": ["Name 1", "Name 2", "..."]}

Rules:
- 3-15 category names.
- Names must be specific and present in (or directly derivable from) the wiki page list.
- Do not invent categories that have no corresponding pages.
- Do not include a generic "Misc" or "Other" unless unavoidable.`;

/**
 * Scan a sample of scraped pages and suggest 2-4 categorization strategies.
 * Returns [] on any failure (caller shows custom-only UI).
 */
export async function suggestCategorizations(
  pages: ScrapedPage[],
  provider: BaseLLMProvider,
  model: string,
): Promise<CategorySuggestion[]> {
  try {
    const sample = samplePages(pages);
    const pageList = buildPageList(sample);
    const user = `Here are ${sample.length} pages from this wiki:\n\n${pageList}\n\nSuggest 2-4 strategies for organizing these into named lorebook buckets.`;
    const raw = await drainCat(provider, model, SUGGEST_SYSTEM, user);
    const parsed = parseLLMJson(raw);
    if (!parsed) return [];
    const strategies = parsed.strategies;
    if (!Array.isArray(strategies)) return [];
    const result: CategorySuggestion[] = [];
    for (const s of strategies) {
      if (
        typeof s === "object" &&
        s !== null &&
        typeof (s as Record<string, unknown>).strategy === "string" &&
        typeof (s as Record<string, unknown>).description === "string" &&
        Array.isArray((s as Record<string, unknown>).categories)
      ) {
        const cats = ((s as Record<string, unknown>).categories as unknown[])
          .filter((c): c is string => typeof c === "string" && c.length > 0);
        if (cats.length >= 2) {
          result.push({
            strategy: (s as Record<string, unknown>).strategy as string,
            description: (s as Record<string, unknown>).description as string,
            categories: cats,
          });
        }
      }
    }
    return result;
  } catch (err) {
    logger.warn(err, "[wiki-categorizer] suggestCategorizations failed");
    return [];
  }
}

/**
 * Given a user's text description and the wiki page sample, generate a
 * grounded list of category names. Throws on failure so the caller can
 * show an error to the user.
 */
export async function generateCategories(
  pages: ScrapedPage[],
  description: string,
  provider: BaseLLMProvider,
  model: string,
): Promise<string[]> {
  const sample = samplePages(pages);
  const pageList = buildPageList(sample);
  const user = `Wiki pages (${sample.length} sampled):\n${pageList}\n\nUser's strategy: "${description}"\n\nGenerate a specific category list that implements this strategy using the actual wiki content above.`;
  const raw = await drainCat(provider, model, GENERATE_SYSTEM, user);
  const parsed = parseLLMJson(raw);
  if (!parsed || !Array.isArray(parsed.categories)) {
    throw new Error("LLM did not return a valid category list");
  }
  const cats = (parsed.categories as unknown[]).filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0,
  );
  if (cats.length < 2) throw new Error("LLM returned fewer than 2 categories");
  return cats;
}
