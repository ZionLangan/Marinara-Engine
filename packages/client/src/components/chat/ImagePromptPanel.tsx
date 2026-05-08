import { cn } from "../../lib/utils";

interface ImagePromptPanelProps {
  prompt?: string | null;
  meta?: string | null;
  className?: string;
}

export function ImagePromptPanel({ prompt, meta, className }: ImagePromptPanelProps) {
  const promptText = prompt?.trim() ?? "";
  const metaText = meta?.trim() ?? "";

  if (!promptText && !metaText) return null;

  return (
    <div
      className={cn(
        "rounded-lg border border-white/10 bg-neutral-950/95 px-3 py-2 text-left shadow-2xl",
        className,
      )}
    >
      {promptText && (
        <>
          <div className="mb-1 text-[0.6875rem] font-semibold text-white/55">Prompt</div>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[0.75rem] leading-relaxed text-white/85">
            {promptText}
          </p>
        </>
      )}
      {metaText && (
        <p className={cn("text-[0.6875rem] text-white/45", promptText && "mt-1.5 border-t border-white/10 pt-1.5")}>
          {metaText}
        </p>
      )}
    </div>
  );
}
