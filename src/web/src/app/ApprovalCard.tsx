import { useState } from "react";
import type { ApprovalDecision } from "../lib/types";

/**
 * Approvals are inline cards, not modals: they sit in the thread where they
 * happened and stay in history after you answer. The amber here is the same
 * amber on the sidebar dot — one colour, one meaning, two places.
 */
export function ApprovalCard({
  payload,
  resolved,
  onResolve,
}: {
  payload: Record<string, unknown>;
  resolved: boolean;
  onResolve: (decision: ApprovalDecision, note?: string) => void;
}) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");

  // The gateway nests everything under `request`; the top level carries only
  // the id. Reading the wrong level renders an empty card.
  const request = (payload.request ?? payload) as Record<string, unknown>;
  const command =
    (typeof request.command === "string" && request.command) ||
    (Array.isArray(request.command) && request.command.join(" ")) ||
    "";
  const cwd = typeof request.cwd === "string" ? request.cwd : "";
  const warning = typeof request.warningText === "string" ? request.warningText : "";
  const analysis = (request.commandAnalysis ?? {}) as Record<string, unknown>;
  const riskKinds = Array.isArray(analysis.riskKinds) ? (analysis.riskKinds as string[]) : [];
  const warningLines = Array.isArray(analysis.warningLines) ? (analysis.warningLines as string[]) : [];
  const tool = typeof request.agentId === "string" && request.agentId ? request.agentId : "A bot";

  // Never offer a decision the gateway would reject.
  const allowed = Array.isArray(request.allowedDecisions)
    ? (request.allowedDecisions as string[])
    : ["allow-once", "deny"];
  const canAlways = allowed.includes("allow-always");

  return (
    <div className={`card card--attention${resolved ? " card--resolved" : ""}`}>
      <div className="card__title">{resolved ? "You answered this" : `${tool} needs you`}</div>
      <div className="card__meta">
        {resolved ? "Permission request" : "wants to run this command"}
        {cwd ? ` in ${cwd}` : ""}
      </div>
      {command && <div className="card__pre">{command}</div>}
      {(warning || warningLines.length > 0 || riskKinds.length > 0) && (
        <div className="card__warn">
          {warning || warningLines.join("\n") || `Flagged: ${riskKinds.join(", ")}`}
        </div>
      )}

      {!resolved &&
        (other ? (
          <div className="card__other">
            <input
              autoFocus
              value={note}
              placeholder="Tell it what to do instead"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) onResolve("deny", note.trim());
              }}
            />
            <button className="btn" disabled={!note.trim()} onClick={() => onResolve("deny", note.trim())}>
              Send
            </button>
          </div>
        ) : (
          <div className="card__actions">
            <button className="btn btn--primary" onClick={() => onResolve("allow-once")}>
              Allow
            </button>
            {canAlways && (
              <button className="btn" onClick={() => onResolve("allow-always")}>
                Always allow
              </button>
            )}
            <button className="btn" onClick={() => onResolve("deny")}>
              No
            </button>
            <button className="btn btn--ghost" onClick={() => setOther(true)}>
              Something else
            </button>
          </div>
        ))}
    </div>
  );
}
