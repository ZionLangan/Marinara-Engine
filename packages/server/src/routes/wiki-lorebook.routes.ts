// ──────────────────────────────────────────────
// Routes: Wiki → Lorebook Pipeline (multi-stage SSE wizard)
//
// Stage 1: POST /start            — scrape, returns runId + container candidates
// Stage 2: POST /:runId/enrich    — user picks containers, enrichment streams progress
// Stage 3: POST /:runId/build     — assemble + persist multiple lorebooks
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createConnectionsStorage } from "../services/storage/connections.storage.js";
import { createLorebooksStorage } from "../services/storage/lorebooks.storage.js";
import { createLLMProvider } from "../services/llm/provider-registry.js";
import { scrapeWiki } from "../services/wiki-lorebook/scraper.js";
import { extractContainerCandidates } from "../services/wiki-lorebook/containers.js";
import { suggestCategorizations, generateCategories } from "../services/wiki-lorebook/categorizer.js";
import { enrichPages } from "../services/wiki-lorebook/enricher.js";
import { buildLorebooks, defaultBuildConfig, DEFAULT_SECONDARY_KEYS_40K } from "../services/wiki-lorebook/builder.js";
import { createRun, getRun, updateRun, touchRun, deleteRun } from "../services/wiki-lorebook/run-store.js";
import { logger } from "../lib/logger.js";

const startSchema = z.object({
  wiki: z.string().min(1).max(200),
  seedPage: z.string().min(1).max(300),
  maxDepth: z.number().int().min(0).max(5).default(2),
  maxPages: z.number().int().min(1).max(2000).default(300),
  connectionId: z.string().min(1),
  concurrency: z.number().int().min(1).max(16).default(4),
  sleepMs: z.number().int().min(0).max(5000).default(500),
});

const enrichSchema = z.object({
  selectedContainers: z.array(z.string()).default([]),
});

const suggestCategoriesSchema = z.object({
  description: z.string().min(1).max(500),
});

const buildSchema = z.object({
  namePrefix: z.string().min(1).max(100),
  sharedTag: z.string().min(1).max(60),
  category: z.enum(["world", "character", "npc", "spellbook", "uncategorized"]).default("world"),
  constantPages: z.array(z.string()).default([]),
  secondaryKeys: z.array(z.string()).optional(),
  useSecondaryKeys: z.boolean().default(true),
  deepProbability: z.number().int().min(0).max(100).default(25),
  caseSensitive: z.boolean().default(false),
  matchWholeWords: z.boolean().default(true),
});

async function resolveProvider(connectionId: string, app: FastifyInstance) {
  const connections = createConnectionsStorage(app.db);
  const conn = await connections.getWithKey(connectionId);
  if (!conn) throw new Error("API connection not found");
  let baseUrl = conn.baseUrl;
  if (!baseUrl) {
    const { PROVIDERS } = await import("@marinara-engine/shared");
    const providerDef = PROVIDERS[conn.provider as keyof typeof PROVIDERS];
    baseUrl = providerDef?.defaultBaseUrl ?? "";
  }
  if (!baseUrl && conn.provider === "claude_subscription") baseUrl = "claude-agent-sdk://local";
  if (!baseUrl) throw new Error("No base URL configured for this connection");
  const provider = createLLMProvider(
    conn.provider,
    baseUrl,
    conn.apiKey,
    conn.maxContext,
    conn.openrouterProvider,
    conn.maxTokensOverride,
  );
  return { provider, model: conn.model };
}

export async function wikiLorebookRoutes(app: FastifyInstance) {
  const lorebooks = createLorebooksStorage(app.db);

  // ────────────── Stage 1: scrape ──────────────
  app.post("/start", async (req, reply) => {
    const input = startSchema.parse(req.body);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (type: string, data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    const run = createRun({
      wiki: input.wiki,
      seedPage: input.seedPage,
      connectionId: input.connectionId,
      concurrency: input.concurrency,
    });
    send("run_started", { runId: run.id });

    try {
      const pages = await scrapeWiki({
        wiki: input.wiki,
        seedPage: input.seedPage,
        maxDepth: input.maxDepth,
        maxPages: input.maxPages,
        sleepMs: input.sleepMs,
        onProgress: (info) => send("scrape_progress", info),
      });
      const candidates = extractContainerCandidates(pages);
      send("scanning_categories", { status: "analyzing" });
      const { provider: scanProvider, model: scanModel } = await resolveProvider(run.connectionId, app);
      const suggestions = await suggestCategorizations(pages, scanProvider, scanModel);
      updateRun(run.id, { pages, containerCandidates: candidates, categorySuggestions: suggestions, phase: "awaiting-curation" });
      send("containers_ready", {
        runId: run.id,
        pageCount: pages.length,
        candidates,
        suggestions,
      });
      send("done", { phase: "awaiting-curation" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Scrape failed";
      logger.error(err, "[wiki-lorebook] scrape failed");
      send("error", msg);
      deleteRun(run.id);
    } finally {
      reply.raw.end();
    }
  });

  // ────────────── Stage 2: enrich ──────────────
  app.post("/:runId/enrich", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const input = enrichSchema.parse(req.body);
    const run = getRun(runId);
    if (!run) return reply.status(404).send({ error: "Run not found or expired" });
    if (run.phase !== "awaiting-curation" && run.phase !== "awaiting-build") {
      return reply.status(409).send({ error: `Run is in phase ${run.phase}` });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (type: string, data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    try {
      const { provider, model } = await resolveProvider(run.connectionId, app);
      updateRun(runId, { selectedContainers: input.selectedContainers, phase: "enriching" });
      send("enrich_started", { total: run.pages.length, concurrency: run.concurrency });

      const enriched = await enrichPages({
        pages: run.pages,
        containers: input.selectedContainers,
        provider,
        model,
        concurrency: run.concurrency,
        onProgress: (p) => send("enrich_progress", p),
        onTouch: () => touchRun(runId),
      });

      updateRun(runId, { enriched, phase: "awaiting-build" });
      send("enrich_done", {
        completed: enriched.filter((e) => !e.enrichmentError).length,
        failed: enriched.filter((e) => !!e.enrichmentError).length,
        total: enriched.length,
      });
      send("done", { phase: "awaiting-build" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Enrichment failed";
      logger.error(err, "[wiki-lorebook] enrich failed");
      send("error", msg);
    } finally {
      reply.raw.end();
    }
  });

  // ────────────── Custom category generation ──────────────
  app.post("/:runId/suggest-categories", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const input = suggestCategoriesSchema.parse(req.body);
    const run = getRun(runId);
    if (!run) return reply.status(404).send({ error: "Run not found or expired" });

    try {
      const { provider, model } = await resolveProvider(run.connectionId, app);
      const categories = await generateCategories(run.pages, input.description, provider, model);
      return reply.send({ categories });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Category generation failed";
      logger.warn(err, "[wiki-lorebook] suggest-categories failed");
      return reply.status(422).send({ error: msg });
    }
  });

  // ────────────── Stage 3: build + save ──────────────
  app.post("/:runId/build", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const input = buildSchema.parse(req.body);
    const run = getRun(runId);
    if (!run) return reply.status(404).send({ error: "Run not found or expired" });
    if (run.phase !== "awaiting-build") {
      return reply.status(409).send({ error: `Run is in phase ${run.phase}` });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (type: string, data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    try {
      updateRun(runId, { phase: "building" });
      const cfg = defaultBuildConfig({
        secondaryKeys: input.secondaryKeys ?? DEFAULT_SECONDARY_KEYS_40K,
        useSecondaryKeys: input.useSecondaryKeys,
        deepProbability: input.deepProbability,
        caseSensitiveKeys: input.caseSensitive,
        matchWholeWords: input.matchWholeWords,
        constantPages: new Set(input.constantPages.map((p) => p.replace(/ /g, "_"))),
      });

      const result = buildLorebooks(run.enriched, cfg);
      send("build_summary", {
        bucketCount: result.buckets.length,
        bucketSizes: result.buckets.map((b) => ({ label: b.label, count: b.entries.length })),
        skipped: { empty: result.skipped.empty, duplicate: result.skipped.duplicate },
      });

      const saved: Array<{ id: string; name: string; entryCount: number; label: string }> = [];
      for (const bucket of result.buckets) {
        const lbName = `${input.namePrefix} — ${bucket.label}`;
        const lb = await lorebooks.create({
          name: lbName.slice(0, 200),
          description: `Generated from ${run.wiki} wiki (seed: ${run.seedPage})`,
          category: input.category,
          tags: [input.sharedTag],
          generatedBy: "wiki-import",
        });
        if (!lb) {
          send("save_error", { bucket: bucket.label, message: "create returned null" });
          continue;
        }
        const lbId = (lb as unknown as { id: string }).id;
        await lorebooks.bulkCreateEntries(
          lbId,
          bucket.entries.map(({ __tier, __container, __constant, ...e }) => {
            void __tier;
            void __container;
            void __constant;
            return e;
          }),
        );
        saved.push({ id: lbId, name: lbName, entryCount: bucket.entries.length, label: bucket.label });
        send("saved", saved[saved.length - 1]);
        touchRun(runId);
      }

      updateRun(runId, { phase: "done" });
      send("done", { saved, skipped: result.skipped });
      // Free memory; client has all the IDs now.
      deleteRun(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Build failed";
      logger.error(err, "[wiki-lorebook] build failed");
      send("error", msg);
    } finally {
      reply.raw.end();
    }
  });

  // ────────────── Cancel / cleanup ──────────────
  app.delete("/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    deleteRun(runId);
    return reply.send({ ok: true });
  });
}
