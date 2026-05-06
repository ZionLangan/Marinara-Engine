import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Code2, MessageCircle, Pencil, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { useUpdateAgentRunData, type AgentRunRow } from "../../hooks/use-agents";

interface ThoughtBubble {
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
}

interface RoleplayHUDActionsMenuProps {
  isAgentProcessing: boolean;
  thoughtBubbles: ThoughtBubble[];
  clearThoughtBubbles: () => void;
  dismissThoughtBubble: (index: number) => void;
  customAgentRuns: AgentRunRow[];
  customAgentRunsLoading: boolean;
  showEcho: boolean;
  echoChamberOpen: boolean;
  toggleEchoChamber: () => void;
  echoMessageCount: number;
  clearGameState: () => void;
  onRetriggerTrackers?: () => void;
  onRetryFailedAgents?: () => void;
  failedAgentTypes?: string[];
  onClose: () => void;
}

export function RoleplayHUDActionsMenu({
  isAgentProcessing,
  thoughtBubbles,
  clearThoughtBubbles,
  dismissThoughtBubble,
  customAgentRuns,
  customAgentRunsLoading,
  showEcho,
  echoChamberOpen,
  toggleEchoChamber,
  echoMessageCount,
  clearGameState,
  onRetriggerTrackers,
  onRetryFailedAgents,
  failedAgentTypes,
  onClose,
}: RoleplayHUDActionsMenuProps) {
  const uniqueAgentCount = new Set(thoughtBubbles.map((bubble) => bubble.agentId)).size;
  const hasCustomRuns = customAgentRuns.length > 0;
  const hasAnyActivity = isAgentProcessing || thoughtBubbles.length > 0 || hasCustomRuns || customAgentRunsLoading;

  return (
    <>
      {isAgentProcessing && (
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <Sparkles size="0.75rem" className="text-purple-400 animate-pulse" />
          <span className="text-[0.625rem] text-purple-300/80">Agents thinking…</span>
        </div>
      )}
      {!hasAnyActivity && (
        <div className="px-3 py-4 text-center text-[0.625rem] text-white/30">No agent activity yet</div>
      )}
      {thoughtBubbles.length > 0 && (
        <>
          <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
            <span className="text-[0.625rem] text-white/40">
              {uniqueAgentCount} agent{uniqueAgentCount !== 1 ? "s" : ""} triggered
            </span>
            <button
              onClick={clearThoughtBubbles}
              className="text-[0.625rem] text-white/30 hover:text-white/60 transition-colors"
            >
              Clear all
            </button>
          </div>
          <div className="flex flex-col gap-1 p-2">
            {thoughtBubbles.map((bubble, index) => (
              <div
                key={`${bubble.agentId}-${bubble.timestamp}`}
                className="relative rounded-lg bg-white/5 p-2 text-[0.625rem]"
              >
                <button
                  onClick={() => dismissThoughtBubble(index)}
                  className="absolute right-1.5 top-1.5 text-white/20 hover:text-white/60 transition-colors"
                >
                  <X size="0.625rem" />
                </button>
                <div className="pr-4">
                  <span className="font-semibold text-purple-300">{bubble.agentName}</span>
                  <p className="mt-0.5 whitespace-pre-wrap text-white/50 leading-relaxed">{bubble.content}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {(hasCustomRuns || customAgentRunsLoading) && (
        <>
          <div className="flex items-center justify-between border-t border-white/5 px-3 py-1.5">
            <span className="flex items-center gap-1 text-[0.625rem] text-white/40">
              <Code2 size="0.6875rem" className="text-purple-400/60" />
              Custom outputs
            </span>
            <span className="text-[0.5625rem] text-white/25">
              {customAgentRunsLoading ? "Loading…" : hasCustomRuns ? customAgentRuns.length : ""}
            </span>
          </div>
          <div className="flex flex-col gap-1 p-2 pt-0">
            {customAgentRuns.map((run) => (
              <CustomAgentRunItem key={run.id} run={run} />
            ))}
          </div>
        </>
      )}

      <div className="border-t border-white/5 divide-y divide-white/5">
        {showEcho && (
          <button
            onClick={toggleEchoChamber}
            className="flex w-full items-center gap-2 px-3 py-2 text-[0.625rem] transition-colors hover:bg-white/5"
          >
            <MessageCircle size="0.75rem" className={echoChamberOpen ? "text-purple-400" : "text-purple-400/60"} />
            <span className={echoChamberOpen ? "text-purple-300 font-medium" : "text-white/60"}>
              Echo Chamber {echoChamberOpen ? "On" : "Off"}
            </span>
            {echoMessageCount > 0 && (
              <span className="ml-auto flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-purple-500/80 px-1 text-[0.5rem] font-bold text-white">
                {echoMessageCount}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => {
            clearGameState();
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-[0.625rem] text-white/60 transition-colors hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 size="0.75rem" className="text-purple-400/60" />
          <span>Clear Trackers</span>
        </button>
        {onRetriggerTrackers && (
          <button
            onClick={() => {
              onRetriggerTrackers();
              onClose();
            }}
            disabled={isAgentProcessing}
            className="flex w-full items-center gap-2 px-3 py-2 text-[0.625rem] font-medium text-purple-300 transition-colors hover:bg-purple-500/10 disabled:opacity-50"
          >
            <RefreshCw size="0.6875rem" className={isAgentProcessing ? "animate-spin" : ""} />
            {isAgentProcessing ? "Running…" : "Re-run Trackers"}
          </button>
        )}
        {onRetryFailedAgents && failedAgentTypes && failedAgentTypes.length > 0 && (
          <button
            onClick={() => {
              onRetryFailedAgents();
              onClose();
            }}
            disabled={isAgentProcessing}
            className="flex w-full items-center gap-2 px-3 py-2 text-[0.625rem] font-medium text-amber-300 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
          >
            <AlertTriangle size="0.6875rem" className={isAgentProcessing ? "animate-pulse" : ""} />
            {isAgentProcessing ? "Retrying…" : `Retry Failed Agents (${failedAgentTypes.length})`}
          </button>
        )}
      </div>
    </>
  );
}

function CustomAgentRunItem({ run }: { run: AgentRunRow }) {
  const updateRun = useUpdateAgentRunData();
  const mode = getEditableMode(run.resultData);
  const initialDraft = useMemo(() => getEditorValue(run.resultData, mode), [run.resultData, mode]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(initialDraft);
  }, [editing, initialDraft]);

  const preview = getRunPreview(run.resultData);
  const timestamp = formatRunTime(run.createdAt);

  const save = async () => {
    const parsed = parseDraft(run.resultData, mode, draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    await updateRun.mutateAsync({ id: run.id, chatId: run.chatId, resultData: parsed.value });
    setEditing(false);
  };

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.035] p-2 text-[0.625rem]">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-semibold text-purple-300">{run.agentName}</span>
            <span className="rounded bg-white/5 px-1 py-0.5 text-[0.5rem] uppercase tracking-wide text-white/35">
              {run.resultType.replace(/_/g, " ")}
            </span>
            {timestamp && <span className="text-[0.5rem] text-white/25">{timestamp}</span>}
          </div>
          {!editing && (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-black/10 p-1.5 font-sans text-white/50 leading-relaxed">
              {preview || "Empty output"}
            </pre>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing((value) => !value);
            setError(null);
          }}
          className="rounded p-1 text-white/30 transition-colors hover:bg-white/5 hover:text-purple-300"
          title={editing ? "Close editor" : "Edit output"}
        >
          {editing ? <X size="0.6875rem" /> : <Pencil size="0.6875rem" />}
        </button>
      </div>

      {editing && (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            spellCheck={false}
            className="min-h-24 w-full resize-y rounded-md border border-white/10 bg-black/20 px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed text-white/70 outline-none transition-colors placeholder:text-white/25 focus:border-purple-400/40"
          />
          {error && <div className="text-[0.5625rem] text-amber-300">{error}</div>}
          <div className="flex items-center justify-between">
            <span className="text-[0.5625rem] uppercase tracking-wide text-white/25">
              {mode === "json" ? "JSON" : "Text"}
            </span>
            <button
              type="button"
              onClick={save}
              disabled={updateRun.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-purple-400/20 bg-purple-500/10 px-2 py-1 text-[0.5625rem] font-medium text-purple-200 transition-colors hover:bg-purple-500/20 disabled:opacity-50"
            >
              <Check size="0.625rem" />
              {updateRun.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function getEditableMode(data: unknown): "text" | "json" {
  if (typeof data === "string") return "text";
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).text === "string") return "text";
  return "json";
}

function getEditorValue(data: unknown, mode: "text" | "json"): string {
  if (mode === "text") {
    if (typeof data === "string") return data;
    if (data && typeof data === "object") return String((data as Record<string, unknown>).text ?? "");
    return "";
  }
  return JSON.stringify(data ?? {}, null, 2);
}

function parseDraft(
  originalData: unknown,
  mode: "text" | "json",
  draft: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (mode === "text") {
    if (typeof originalData === "string") return { ok: true, value: draft };
    if (originalData && typeof originalData === "object") {
      return { ok: true, value: { ...(originalData as Record<string, unknown>), text: draft } };
    }
    return { ok: true, value: draft };
  }

  try {
    return { ok: true, value: JSON.parse(draft) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

function getRunPreview(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object") {
    const text = (data as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text.trim();
    return JSON.stringify(data, null, 2);
  }
  return data == null ? "" : String(data);
}

function formatRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
