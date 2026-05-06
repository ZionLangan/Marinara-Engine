// ──────────────────────────────────────────────
// Modal: Wiki → Lorebook Wizard
// 3-step pipeline: scrape → curate (LLM categorization) → enrich → build & save
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ChevronDown,
  Globe,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { useConnections } from "../../hooks/use-connections";
import { lorebookKeys } from "../../hooks/use-lorebooks";
import { useUIStore } from "../../stores/ui.store";
import { api } from "../../lib/api-client";

interface Props {
  open: boolean;
  onClose: () => void;
}

type ConnectionRow = { id: string; name: string; provider: string; model: string };
type CategorySuggestion = { strategy: string; description: string; categories: string[] };
type EnrichProgress = { completed: number; failed: number; total: number; lastTitle: string; lastError: string | null };
type SavedLorebook = { id: string; name: string; entryCount: number; label: string };
type ScrapeProgress = { fetched: number; queued: number; current: string };

type Step = "source" | "curate" | "enrich" | "build" | "saved";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "wiki";

export function WikiLorebookModal({ open, onClose }: Props) {
  const { data: rawConnections } = useConnections();
  const openLorebookDetail = useUIStore((s) => s.openLorebookDetail);
  const qc = useQueryClient();

  const connections = (rawConnections ?? []) as ConnectionRow[];

  // ── Step state ──
  const [step, setStep] = useState<Step>("source");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Stage 1 inputs ──
  const [wiki, setWiki] = useState("");
  const [seedPage, setSeedPage] = useState("");
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxPages, setMaxPages] = useState(150);
  const [connectionId, setConnectionId] = useState("");
  const [concurrency, setConcurrency] = useState(4);

  if (!connectionId && connections.length > 0) {
    setConnectionId(connections[0]!.id);
  }

  // ── Stage 1 outputs ──
  const [runId, setRunId] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scrapeProgress, setScrapeProgress] = useState<ScrapeProgress | null>(null);
  const [scanningCategories, setScanningCategories] = useState(false);

  // ── Stage 2: categorization ──
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null); // strategy name or "custom"
  const [customDescription, setCustomDescription] = useState("");
  const [generatingCategories, setGeneratingCategories] = useState(false);
  const [categoryGenError, setCategoryGenError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [newCategoryInput, setNewCategoryInput] = useState("");

  // ── Stage 3 outputs ──
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);

  // ── Stage 4 inputs ──
  const [namePrefix, setNamePrefix] = useState("");
  const [sharedTag, setSharedTag] = useState("");
  const [category, setCategory] = useState<"world" | "character" | "npc" | "spellbook" | "uncategorized">("world");
  const [constantPagesText, setConstantPagesText] = useState("");
  const [deepProbability, setDeepProbability] = useState(25);

  // ── Stage 4 outputs ──
  const [saved, setSaved] = useState<SavedLorebook[]>([]);
  const [building, setBuilding] = useState(false);

  const resetAll = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep("source");
    setError(null);
    setRunId(null);
    setPageCount(0);
    setScrapeProgress(null);
    setScanningCategories(false);
    setSuggestions([]);
    setSelectedStrategy(null);
    setCustomDescription("");
    setGeneratingCategories(false);
    setCategoryGenError(null);
    setCategories([]);
    setNewCategoryInput("");
    setEnrichProgress(null);
    setSaved([]);
    setBuilding(false);
  }, []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    if (runId && step !== "saved") {
      fetch(`/api/wiki-lorebook/${runId}`, { method: "DELETE" }).catch(() => {});
    }
    resetAll();
    onClose();
  }, [onClose, resetAll, runId, step]);

  useEffect(() => {
    if (!open) resetAll();
  }, [open, resetAll]);

  // ────────────── Stage 1: scrape ──────────────
  const handleStartScrape = useCallback(async () => {
    if (!wiki.trim() || !seedPage.trim() || !connectionId) return;
    setError(null);
    setStep("curate");
    setScrapeProgress({ fetched: 0, queued: 0, current: seedPage });
    setSuggestions([]);
    setSelectedStrategy(null);
    setCategories([]);
    setRunId(null);

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      for await (const event of api.streamEvents(
        "/wiki-lorebook/start",
        { wiki: wiki.trim(), seedPage: seedPage.trim(), maxDepth, maxPages, connectionId, concurrency },
        abort.signal,
      )) {
        switch (event.type) {
          case "run_started":
            setRunId((event.data as { runId: string }).runId);
            break;
          case "scrape_progress":
            setScrapeProgress(event.data as ScrapeProgress);
            break;
          case "scanning_categories":
            setScanningCategories(true);
            break;
          case "containers_ready": {
            const d = event.data as { runId: string; pageCount: number; candidates: unknown[]; suggestions: CategorySuggestion[] };
            setRunId(d.runId);
            setPageCount(d.pageCount);
            setScanningCategories(false);
            const suggs = d.suggestions ?? [];
            setSuggestions(suggs);
            if (suggs.length > 0 && suggs[0]) {
              setSelectedStrategy(suggs[0].strategy);
              setCategories(suggs[0].categories);
            } else {
              setSelectedStrategy("custom");
            }
            if (!namePrefix) setNamePrefix(wiki.trim());
            if (!sharedTag) setSharedTag(slugify(wiki));
            break;
          }
          case "error":
            setError(String(event.data));
            setStep("source");
            break;
          case "done":
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Scrape failed");
        setStep("source");
      }
    } finally {
      abortRef.current = null;
    }
  }, [wiki, seedPage, maxDepth, maxPages, connectionId, concurrency, namePrefix, sharedTag]);

  // ── Select a suggested strategy ──
  const handleSelectStrategy = useCallback(
    (s: CategorySuggestion) => {
      setSelectedStrategy(s.strategy);
      setCategories(s.categories);
      setCategoryGenError(null);
    },
    [],
  );

  const handleSelectCustom = useCallback(() => {
    setSelectedStrategy("custom");
    setCategories([]);
    setCategoryGenError(null);
  }, []);

  // ── Generate categories from custom description ──
  const handleGenerateCategories = useCallback(async () => {
    if (!runId || !customDescription.trim()) return;
    setGeneratingCategories(true);
    setCategoryGenError(null);
    try {
      const res = await fetch(`/api/wiki-lorebook/${runId}/suggest-categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: customDescription.trim() }),
      });
      const json = (await res.json()) as { categories?: string[]; error?: string };
      if (!res.ok || json.error) {
        setCategoryGenError(json.error ?? `HTTP ${res.status}`);
      } else {
        setCategories(json.categories ?? []);
      }
    } catch (err) {
      setCategoryGenError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setGeneratingCategories(false);
    }
  }, [runId, customDescription]);

  // ── Category chip editing ──
  const removeCategory = useCallback((name: string) => {
    setCategories((prev) => prev.filter((c) => c !== name));
  }, []);

  const addCategory = useCallback(() => {
    const trimmed = newCategoryInput.trim();
    if (!trimmed) return;
    setCategories((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setNewCategoryInput("");
  }, [newCategoryInput]);

  // ────────────── Stage 2: enrich ──────────────
  const handleStartEnrich = useCallback(async () => {
    if (!runId) return;
    setError(null);
    setStep("enrich");
    setEnrichProgress({ completed: 0, failed: 0, total: pageCount, lastTitle: "", lastError: null });

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      for await (const event of api.streamEvents(
        `/wiki-lorebook/${runId}/enrich`,
        { selectedContainers: categories },
        abort.signal,
      )) {
        switch (event.type) {
          case "enrich_started":
            setEnrichProgress((p) => ({
              completed: 0,
              failed: 0,
              total: (event.data as { total: number }).total,
              lastTitle: p?.lastTitle ?? "",
              lastError: null,
            }));
            break;
          case "enrich_progress":
            setEnrichProgress(event.data as EnrichProgress);
            break;
          case "enrich_done":
            setStep("build");
            break;
          case "error":
            setError(String(event.data));
            setStep("curate");
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Enrichment failed");
        setStep("curate");
      }
    } finally {
      abortRef.current = null;
    }
  }, [runId, categories, pageCount]);

  // ────────────── Stage 3: build ──────────────
  const handleStartBuild = useCallback(async () => {
    if (!runId || !namePrefix.trim() || !sharedTag.trim() || building) return;
    setError(null);
    setSaved([]);
    setBuilding(true);

    const abort = new AbortController();
    abortRef.current = abort;
    const constantPages = constantPagesText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      for await (const event of api.streamEvents(
        `/wiki-lorebook/${runId}/build`,
        {
          namePrefix: namePrefix.trim(),
          sharedTag: sharedTag.trim(),
          category,
          constantPages,
          deepProbability,
        },
        abort.signal,
      )) {
        switch (event.type) {
          case "saved": {
            const lb = event.data as SavedLorebook;
            setSaved((prev) => [...prev, lb]);
            qc.invalidateQueries({ queryKey: lorebookKeys.all });
            break;
          }
          case "done":
            setStep("saved");
            break;
          case "error":
            setError(String(event.data));
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Build failed");
      }
    } finally {
      abortRef.current = null;
      setBuilding(false);
    }
  }, [runId, namePrefix, sharedTag, category, constantPagesText, deepProbability, qc, building]);

  // ────────────── Derived ──────────────
  const canEnrich = !!runId && categories.length > 0;

  return (
    <Modal open={open} onClose={handleClose} title="✦ Generate Lorebook from Wiki" width="max-w-2xl">
      <div className="space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-2 text-[0.6875rem] uppercase tracking-wide text-[var(--muted-foreground)]">
          <StepDot active={step === "source"} done={["curate", "enrich", "build", "saved"].includes(step)} label="1 Source" />
          <ArrowRight size="0.625rem" />
          <StepDot active={step === "curate"} done={["enrich", "build", "saved"].includes(step)} label="2 Curate" />
          <ArrowRight size="0.625rem" />
          <StepDot active={step === "enrich"} done={["build", "saved"].includes(step)} label="3 Enrich" />
          <ArrowRight size="0.625rem" />
          <StepDot active={step === "build" || step === "saved"} done={step === "saved"} label="4 Build" />
        </div>

        {/* ── Step 1: Source ── */}
        {step === "source" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Wiki (e.g. calixipedia)">
                <input
                  value={wiki}
                  onChange={(e) => setWiki(e.target.value)}
                  placeholder="calixipedia"
                  className={inputCls}
                />
              </Field>
              <Field label="Seed page">
                <input
                  value={seedPage}
                  onChange={(e) => setSeedPage(e.target.value)}
                  placeholder="The_Calixis_Sector"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Max depth">
                <input
                  type="number"
                  value={maxDepth}
                  min={0}
                  max={5}
                  onChange={(e) => setMaxDepth(Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))}
                  className={inputCls}
                />
              </Field>
              <Field label="Max pages">
                <input
                  type="number"
                  value={maxPages}
                  min={1}
                  max={2000}
                  onChange={(e) => setMaxPages(Math.max(1, Math.min(2000, parseInt(e.target.value) || 1)))}
                  className={inputCls}
                />
              </Field>
              <Field label={`Concurrency: ${concurrency}`}>
                <input
                  type="range"
                  value={concurrency}
                  min={1}
                  max={12}
                  onChange={(e) => setConcurrency(parseInt(e.target.value))}
                  className="w-full accent-amber-400"
                />
              </Field>
            </div>
            <Field label="LLM Connection (used for categorization and enrichment)">
              <div className="relative">
                <select
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className={`${inputCls} appearance-none pr-8`}
                >
                  {connections.length === 0 && <option value="">No connections available</option>}
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.model})
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size="0.875rem"
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
                />
              </div>
            </Field>
            <button
              onClick={handleStartScrape}
              disabled={!wiki.trim() || !seedPage.trim() || !connectionId}
              className={primaryBtn}
            >
              <Globe size="1rem" /> Scrape Wiki
            </button>
          </div>
        )}

        {/* ── Step 2: Curate ── */}
        {step === "curate" && (
          <div className="space-y-3">
            {/* Scrape progress */}
            {pageCount === 0 && scrapeProgress && (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs">
                <div className="flex items-center gap-2 text-amber-400">
                  <Loader2 size="0.875rem" className="animate-spin" />
                  {scanningCategories
                    ? "Analyzing wiki structure…"
                    : `Fetched ${scrapeProgress.fetched} pages, ${scrapeProgress.queued} queued`}
                </div>
                {!scanningCategories && (
                  <div className="mt-1 truncate font-mono text-[var(--muted-foreground)]">
                    {scrapeProgress.current}
                  </div>
                )}
              </div>
            )}

            {/* Strategy selection */}
            {pageCount > 0 && (
              <>
                <div className="text-xs text-[var(--muted-foreground)]">
                  Scraped <strong className="text-[var(--foreground)]">{pageCount}</strong> pages.
                  {suggestions.length > 0
                    ? " Choose a categorization strategy or describe your own."
                    : " Describe how you want to organize the entries into lorebooks."}
                </div>

                <div className="space-y-2">
                  {suggestions.map((s) => (
                    <button
                      key={s.strategy}
                      onClick={() => handleSelectStrategy(s)}
                      className={`w-full rounded-xl border p-3 text-left text-xs transition-colors ${
                        selectedStrategy === s.strategy
                          ? "border-amber-400/60 bg-amber-400/10 text-[var(--foreground)]"
                          : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:border-amber-400/30 hover:bg-amber-400/5"
                      }`}
                    >
                      <div className="font-semibold text-[var(--foreground)]">{s.strategy}</div>
                      <div className="mt-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">{s.description}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {s.categories.slice(0, 6).map((c) => (
                          <span key={c} className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[0.625rem]">
                            {c}
                          </span>
                        ))}
                        {s.categories.length > 6 && (
                          <span className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
                            +{s.categories.length - 6} more
                          </span>
                        )}
                      </div>
                    </button>
                  ))}

                  {/* Custom strategy */}
                  <button
                    onClick={handleSelectCustom}
                    className={`w-full rounded-xl border p-3 text-left text-xs transition-colors ${
                      selectedStrategy === "custom"
                        ? "border-amber-400/60 bg-amber-400/10"
                        : "border-[var(--border)] bg-[var(--secondary)] hover:border-amber-400/30 hover:bg-amber-400/5"
                    }`}
                  >
                    <div className="font-semibold text-[var(--foreground)]">Custom</div>
                    <div className="mt-0.5 text-[0.6875rem] text-[var(--muted-foreground)]">
                      Describe your own strategy — the LLM will generate categories from the wiki.
                    </div>
                  </button>
                </div>

                {/* Custom description input */}
                {selectedStrategy === "custom" && (
                  <div className="space-y-2">
                    <textarea
                      value={customDescription}
                      onChange={(e) => setCustomDescription(e.target.value)}
                      placeholder="e.g. One lorebook per major sub-sector, grouping all planets and factions within it"
                      rows={3}
                      className={inputCls}
                    />
                    <button
                      onClick={handleGenerateCategories}
                      disabled={generatingCategories || !customDescription.trim() || !runId}
                      className={smallBtn}
                    >
                      {generatingCategories ? (
                        <><Loader2 size="0.75rem" className="animate-spin" /> Generating…</>
                      ) : (
                        <><Sparkles size="0.75rem" /> Generate categories from wiki</>
                      )}
                    </button>
                    {categoryGenError && (
                      <div className="flex items-start gap-1.5 text-[0.6875rem] text-red-400">
                        <AlertCircle size="0.75rem" className="mt-0.5 shrink-0" />
                        {categoryGenError}
                      </div>
                    )}
                  </div>
                )}

                {/* Editable category chips */}
                {categories.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[0.6875rem] text-[var(--muted-foreground)]">
                      Categories (edit freely — each becomes a separate lorebook):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {categories.map((c) => (
                        <span
                          key={c}
                          className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1 text-[0.6875rem]"
                        >
                          {c}
                          <button
                            onClick={() => removeCategory(c)}
                            className="text-[var(--muted-foreground)] hover:text-red-400"
                          >
                            <X size="0.625rem" />
                          </button>
                        </span>
                      ))}
                      <div className="flex items-center gap-1">
                        <input
                          value={newCategoryInput}
                          onChange={(e) => setNewCategoryInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addCategory()}
                          placeholder="Add…"
                          className="h-7 w-24 rounded-full border border-dashed border-[var(--border)] bg-transparent px-2.5 text-[0.6875rem] outline-none focus:border-amber-400/50"
                        />
                        <button
                          onClick={addCategory}
                          disabled={!newCategoryInput.trim()}
                          className="flex items-center justify-center rounded-full border border-dashed border-[var(--border)] p-1 text-[var(--muted-foreground)] hover:border-amber-400/50 hover:text-amber-400 disabled:opacity-30"
                        >
                          <Plus size="0.625rem" />
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <button onClick={handleStartEnrich} disabled={!canEnrich} className={primaryBtn}>
                  <Sparkles size="1rem" /> Enrich {pageCount} entries with {categories.length} categories
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Step 3: Enrich ── */}
        {step === "enrich" && enrichProgress && (
          <div className="space-y-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-amber-400">
                  <Loader2 size="0.875rem" className="animate-spin" />
                  Enriching {enrichProgress.completed + enrichProgress.failed} / {enrichProgress.total}
                </div>
                <div className="text-[var(--muted-foreground)]">
                  ✓ {enrichProgress.completed} · ✗ {enrichProgress.failed}
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--secondary)]">
                <div
                  className="h-full bg-gradient-to-r from-amber-400 to-orange-500 transition-all"
                  style={{
                    width: `${
                      enrichProgress.total
                        ? Math.round(((enrichProgress.completed + enrichProgress.failed) / enrichProgress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              {enrichProgress.lastTitle && (
                <div className="mt-2 truncate font-mono text-[0.6875rem] text-[var(--muted-foreground)]">
                  Last: {enrichProgress.lastTitle}
                  {enrichProgress.lastError ? ` · ${enrichProgress.lastError}` : ""}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step 4: Build ── */}
        {step === "build" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400">
              <CheckCircle size="0.875rem" className="-mt-px mr-1 inline" />
              Enrichment complete. Configure output and create lorebooks.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name prefix">
                <input value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Shared tag">
                <input value={sharedTag} onChange={(e) => setSharedTag(e.target.value)} className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <div className="relative">
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as typeof category)}
                    className={`${inputCls} appearance-none pr-8`}
                  >
                    <option value="world">World</option>
                    <option value="character">Character</option>
                    <option value="npc">NPC</option>
                    <option value="spellbook">Spellbook</option>
                    <option value="uncategorized">Other</option>
                  </select>
                  <ChevronDown
                    size="0.875rem"
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
                  />
                </div>
              </Field>
              <Field label={`Deep-tier probability: ${deepProbability}%`}>
                <input
                  type="range"
                  value={deepProbability}
                  min={0}
                  max={100}
                  onChange={(e) => setDeepProbability(parseInt(e.target.value))}
                  className="w-full accent-amber-400"
                />
              </Field>
            </div>
            <Field label="Constant / always-on pages (comma-separated canonical titles)">
              <textarea
                value={constantPagesText}
                onChange={(e) => setConstantPagesText(e.target.value)}
                rows={2}
                className={inputCls}
                placeholder="The_Calixis_Sector, The_Inquisition"
              />
            </Field>
            <button
              onClick={handleStartBuild}
              disabled={!namePrefix.trim() || !sharedTag.trim() || building}
              className={primaryBtn}
            >
              {building ? (
                <><Loader2 size="1rem" className="animate-spin" /> Building…</>
              ) : (
                <><Sparkles size="1rem" /> Build & Save Lorebooks</>
              )}
            </button>
            {saved.length > 0 && (
              <div className="space-y-1.5">
                {saved.map((lb) => (
                  <div key={lb.id} className="flex items-center gap-2 rounded-lg bg-[var(--secondary)] p-2 text-xs">
                    <CheckCircle size="0.875rem" className="text-emerald-400" />
                    <span className="font-medium">{lb.name}</span>
                    <span className="text-[var(--muted-foreground)]">{lb.entryCount} entries</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Saved summary ── */}
        {step === "saved" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-400">
              <CheckCircle size="1rem" className="-mt-px mr-1 inline" />
              Created {saved.length} lorebook{saved.length === 1 ? "" : "s"} from {wiki}.
            </div>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {saved.map((lb) => (
                <button
                  key={lb.id}
                  onClick={() => {
                    openLorebookDetail(lb.id);
                    handleClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg bg-[var(--secondary)] p-2 text-left text-xs hover:bg-[var(--accent)]"
                >
                  <span className="font-medium">{lb.name}</span>
                  <span className="ml-auto text-[var(--muted-foreground)]">{lb.entryCount} entries</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            <AlertCircle size="0.875rem" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ────────────── Helpers ──────────────
function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 ${
        done
          ? "bg-emerald-500/20 text-emerald-400"
          : active
            ? "bg-amber-400/20 text-amber-400"
            : "bg-[var(--secondary)] text-[var(--muted-foreground)]"
      }`}
    >
      {label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-[var(--muted-foreground)]">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-sm outline-none focus:border-[var(--primary)]/40 focus:ring-1 focus:ring-[var(--primary)]/20";

const primaryBtn =
  "flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg active:scale-[0.98] disabled:opacity-50";

const smallBtn =
  "flex items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2.5 py-1.5 text-[0.6875rem] text-[var(--secondary-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)] disabled:opacity-50";
