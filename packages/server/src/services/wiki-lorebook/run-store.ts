// ──────────────────────────────────────────────
// In-memory run state for multi-step wiki → lorebook wizard.
// Runs are short-lived (minutes) and do not survive restarts.
// ──────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import type { WikiRunState } from "./types.js";

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SWEEP_MS = 5 * 60 * 1000; // 5 minutes

const runs = new Map<string, WikiRunState>();
let sweeperStarted = false;

function startSweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, run] of runs) {
      if (run.updatedAt < cutoff) runs.delete(id);
    }
  }, SWEEP_MS).unref?.();
}

export function createRun(init: Pick<WikiRunState, "wiki" | "seedPage" | "connectionId" | "concurrency">): WikiRunState {
  startSweeper();
  const now = Date.now();
  const run: WikiRunState = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    phase: "scraping",
    wiki: init.wiki,
    seedPage: init.seedPage,
    connectionId: init.connectionId,
    concurrency: init.concurrency,
    pages: [],
    containerCandidates: [],
    categorySuggestions: [],
    selectedContainers: [],
    enriched: [],
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(id: string): WikiRunState | undefined {
  return runs.get(id);
}

export function updateRun(id: string, patch: Partial<WikiRunState>): WikiRunState | undefined {
  const run = runs.get(id);
  if (!run) return undefined;
  Object.assign(run, patch, { updatedAt: Date.now() });
  return run;
}

/** Refresh updatedAt only, so long-running phases keep the run alive. */
export function touchRun(id: string): boolean {
  const run = runs.get(id);
  if (!run) return false;
  run.updatedAt = Date.now();
  return true;
}

export function deleteRun(id: string): void {
  runs.delete(id);
}
