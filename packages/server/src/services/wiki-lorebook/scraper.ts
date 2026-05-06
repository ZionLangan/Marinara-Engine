// ──────────────────────────────────────────────
// Wiki Scraper — MediaWiki API client (BFS crawl)
// Port of wiki converter/scrape_wiki.py
// ──────────────────────────────────────────────
import * as cheerio from "cheerio";
import { logger } from "../../lib/logger.js";
import type { ScrapedPage, ScrapedSection } from "./types.js";

const USER_AGENT = "MarinaraEngine-LorebookBuilder/1.0";
const API_TIMEOUT_MS = 10_000;

const NAMESPACE_SKIP =
  /^(File|Image|Category|Template|User|User_talk|Talk|Forum|Help|Special|MediaWiki|Module|Project|Blog|Thread|Board|Message_Wall):/i;

const SECTION_SKIP = new Set([
  "references",
  "external links",
  "see also",
  "gallery",
  "trivia",
  "notes",
  "sources",
  "appearances",
  "navigation",
]);

const NOISE_SELECTORS = [
  ".mw-editsection",
  ".reference",
  ".mw-references-wrap",
  ".references",
  ".navbox",
  ".infobox",
  ".portable-infobox",
  ".thumb",
  ".gallery",
  ".toc",
  "#toc",
  ".hatnote",
  ".noprint",
  ".mw-empty-elt",
  ".mw-collapsible-toggle",
  ".error",
  "style",
  "script",
];

function resolveHost(wiki: string): string {
  return wiki.includes(".") ? wiki : `${wiki}.fandom.com`;
}

function cleanText(s: string): string {
  return s.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
}

function parseHtml(html: string): { summary: string; sections: ScrapedSection[] } {
  const $ = cheerio.load(html);
  for (const sel of NOISE_SELECTORS) $(sel).remove();

  const body = $(".mw-parser-output").first();
  const children = body.length ? body.children() : $.root().children();

  const sections: ScrapedSection[] = [];
  let currentHeading = "_lead";
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    sections.push({ heading: currentHeading, text: cleanText(buffer.join(" ")) });
    buffer = [];
  };

  children.each((_i, el) => {
    if (el.type !== "tag") return;
    const tag = el.tagName?.toLowerCase();
    const $el = $(el);
    if (tag === "h2" || tag === "h3") {
      flush();
      currentHeading = $el.text().replace(/\s+/g, " ").trim() || "_lead";
    } else if (tag === "p") {
      const txt = $el.text().replace(/\s+/g, " ").trim();
      if (txt) buffer.push(txt);
    } else if (tag === "ul" || tag === "ol") {
      $el.children("li").each((_j, li) => {
        const txt = $(li).text().replace(/\s+/g, " ").trim();
        if (txt) buffer.push(`• ${txt}`);
      });
    }
  });
  flush();

  const filtered = sections.filter(
    (s) => !SECTION_SKIP.has(s.heading.toLowerCase()) && s.text.trim().length > 0,
  );
  const summary = filtered[0]?.text ?? "";
  return { summary, sections: filtered };
}

interface ParseApiResponse {
  parse?: {
    title: string;
    displaytitle?: string;
    text?: string;
    links?: Array<{ ns?: number; title?: string; exists?: boolean }>;
    categories?: Array<{ category?: string; hidden?: string | boolean }>;
  };
  error?: { info?: string };
}

async function fetchPage(host: string, title: string, sleepMs: number): Promise<ScrapedPage | null> {
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  const params = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "text|links|categories|displaytitle",
    redirects: "1",
    disabletoc: "1",
    format: "json",
    formatversion: "2",
  });
  const url = `https://${host}/api.php?${params.toString()}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let data: ParseApiResponse;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn("[wiki-scraper] HTTP %d on %s", res.status, title);
      return null;
    }
    data = (await res.json()) as ParseApiResponse;
  } catch (err) {
    logger.warn(err, "[wiki-scraper] fetch failed for %s", title);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (data.error || !data.parse) {
    if (data.error) logger.warn("[wiki-scraper] API error on %s: %s", title, data.error.info);
    return null;
  }

  const parse = data.parse;
  const canonical = parse.title.replace(/ /g, "_");
  let display = parse.displaytitle ?? parse.title;
  display = display.replace(/<[^>]+>/g, "");

  const html = parse.text ?? "";
  const { summary, sections } = parseHtml(html);

  const links: string[] = [];
  for (const link of parse.links ?? []) {
    if ((link.ns ?? 0) !== 0) continue;
    if (link.exists === false) continue;
    const target = (link.title ?? "").replace(/ /g, "_");
    if (target && !NAMESPACE_SKIP.test(target)) links.push(target);
  }

  const categories: string[] = [];
  for (const cat of parse.categories ?? []) {
    if (cat.hidden) continue;
    const name = (cat.category ?? "").replace(/_/g, " ");
    if (name) categories.push(name);
  }

  const pageUrl = `https://${host}/wiki/${encodeURIComponent(canonical)}`;

  return {
    title: canonical,
    displayTitle: display,
    url: pageUrl,
    summary,
    sections,
    links,
    categories,
    depth: 0,
  };
}

export interface ScrapeOptions {
  wiki: string;
  seedPage: string;
  maxDepth: number;
  maxPages: number;
  sleepMs?: number;
  signal?: AbortSignal;
  onProgress?: (info: { fetched: number; queued: number; current: string }) => void;
}

/** BFS crawl from the seed page. Returns fetched pages in crawl order. */
export async function scrapeWiki(opts: ScrapeOptions): Promise<ScrapedPage[]> {
  const host = resolveHost(opts.wiki);
  const sleepMs = opts.sleepMs ?? 500;
  const seed = opts.seedPage.replace(/ /g, "_");
  const queue: Array<{ title: string; depth: number }> = [{ title: seed, depth: 0 }];
  const seen = new Set<string>();
  const pages: ScrapedPage[] = [];

  while (queue.length > 0 && pages.length < opts.maxPages) {
    if (opts.signal?.aborted) throw new Error("Scrape aborted");
    const { title, depth } = queue.shift()!;
    if (seen.has(title)) continue;
    seen.add(title);
    if (NAMESPACE_SKIP.test(title)) continue;

    const page = await fetchPage(host, title, sleepMs);
    if (!page) {
      opts.onProgress?.({ fetched: pages.length, queued: queue.length, current: title });
      continue;
    }

    page.depth = depth;
    pages.push(page);

    if (depth < opts.maxDepth) {
      for (const link of page.links) {
        if (!seen.has(link)) queue.push({ title: link, depth: depth + 1 });
      }
    }
    opts.onProgress?.({ fetched: pages.length, queued: queue.length, current: title });
  }

  return pages;
}
