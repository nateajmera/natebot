import { useState } from "react";
import type { Run, Step } from "../lib/types";

/** Screenshots are served from disk by our own server, never inlined. */
const shotUrl = (p: string) => `/api/shot?p=${encodeURIComponent(p)}`;

function duration(run: Run): string {
  const end = run.endedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - run.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "url", "query", "pattern", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

/**
 * An agent turn is a dozen tool calls, not one message. Collapsed it says
 * "6 steps · 2m"; expanded it's the live stream. This is the honest answer to
 * showing an agent's computer screen: you can't, but you can show the work.
 */
export function StepRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const shots: Step[] = run.steps.filter((s) => Boolean(s.shotPath));
  const running = run.status === "running";
  const failed = run.status === "failed" || run.steps.some((s) => s.isError);
  const count = run.steps.length;

  if (count === 0 && !running) return null;

  return (
    <div className="steps">
      <button
        className="steps__toggle"
        aria-expanded={open}
        data-running={running}
        data-failed={failed && !running}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="steps__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 1.5 7 5l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {running && count === 0
          ? "Working…"
          : `${count} step${count === 1 ? "" : "s"} · ${duration(run)}`}
        {shots.length > 0 && (
          <span className="steps__shots" title={`${shots.length} screenshot${shots.length === 1 ? "" : "s"}`}>
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="3.5" width="13" height="9.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="8" cy="8.25" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            {shots.length}
          </span>
        )}
      </button>

      {open && shots.length > 0 && (
        <>
          {/* A flight recorder, not live video: what the browser saw, in order.
              Rendering these costs nothing — the model only pays if it looks. */}
          <div className="filmstrip">
            {shots.map((step, i) => (
              <button
                key={step.toolCallId}
                className="filmstrip__frame"
                onClick={() => setLightbox(step.shotPath ?? null)}
                title={`Step ${i + 1}`}
              >
                <img src={shotUrl(step.shotPath!)} alt={`What the browser saw at step ${i + 1}`} loading="lazy" />
                <span className="filmstrip__num">{i + 1}</span>
              </button>
            ))}
          </div>
          {lightbox && (
            <div className="lightbox" onClick={() => setLightbox(null)} role="presentation">
              <img src={shotUrl(lightbox)} alt="Screenshot, enlarged" />
            </div>
          )}
        </>
      )}

      {open && (
        <div className="steps__list">
          {run.steps.map((step) => (
            <div className="step" key={step.toolCallId}>
              <div className="step__head">
                <span className="step__name" data-error={step.isError}>
                  {step.name}
                </span>
                <span className="step__arg">{summarizeArgs(step.args)}</span>
              </div>
              {step.result && <div className="step__out">{step.result.slice(0, 4000)}</div>}
            </div>
          ))}
          {running && (
            <div className="step">
              <div className="step__head">
                <span className="step__arg">still working…</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
