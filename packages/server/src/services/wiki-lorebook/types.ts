// ──────────────────────────────────────────────
// Wiki → Lorebook Pipeline — Internal Types
// ──────────────────────────────────────────────

export interface ScrapedSection {
  heading: string;
  text: string;
}

export interface ScrapedPage {
  title: string;
  displayTitle: string;
  url: string;
  summary: string;
  sections: ScrapedSection[];
  links: string[];
  categories: string[];
  depth: number;
}

export interface ContainerCandidate {
  name: string;
  category: string;
}

export interface CategorySuggestion {
  strategy: string;
  description: string;
  categories: string[];
}

export type EntryTier = "core" | "regional" | "deep";

export interface EnrichedPage extends ScrapedPage {
  rewritten?: string;
  llmKeys?: string[];
  tier?: EntryTier;
  container?: string | null;
  enrichmentError?: string | null;
}

export type WikiRunPhase = "scraping" | "awaiting-curation" | "enriching" | "awaiting-build" | "building" | "done";

export interface WikiRunState {
  id: string;
  createdAt: number;
  updatedAt: number;
  phase: WikiRunPhase;
  // Stage 1 inputs
  wiki: string;
  seedPage: string;
  connectionId: string;
  concurrency: number;
  // Stage 1+ outputs
  pages: ScrapedPage[];
  containerCandidates: ContainerCandidate[];
  categorySuggestions: CategorySuggestion[];
  // Stage 2 inputs
  selectedContainers: string[];
  // Stage 3 outputs
  enriched: EnrichedPage[];
}
