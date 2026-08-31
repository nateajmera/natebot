/**
 * Which tool calls act *in the user's name*.
 *
 * The rule is the user's: reading is free, but anything that speaks, spends,
 * or destroys on their behalf has to be asked about first. Sending an email
 * and issuing a refund are the two canonical cases.
 *
 * This is deliberately biased toward asking. A needless prompt is an
 * annoyance; a silent refund is a betrayal. But it is not biased so far that
 * everything asks — approval fatigue is a real failure mode, and a person who
 * clicks yes reflexively is no safer than one who was never asked.
 */

export type Severity = "warning" | "critical";

export type Verdict =
  | { needsApproval: false }
  | { needsApproval: true; severity: Severity; verb: string };

/** Reads. These never ask, however they are spelled. */
const READ_PATTERNS = [
  /^(get|list|read|search|fetch|find|query|describe|view|show|retrieve|lookup|count|check|status)[_.-]/i,
  /(_get|_list|_read|_search|_fetch|_find|_query|_describe|_view|_show|_retrieve)$/i,
  /^stripe_api_read$/i,
  /^stripe_api_(search|details)$/i,
  /documentation|docs_search|_docs$/i,
];

/** Irreversible or costly. These ask, and they ask loudly. */
const CRITICAL_PATTERNS = [
  /refund|charge|payout|transfer|invoice_pay|capture|payment/i,
  /delete|destroy|drop|purge|revoke|wipe/i,
  /cancel_subscription|cancel|void/i,
  /stripe_api_write/i,
];

/** Acts in the user's name, but reversibly. */
const WRITE_PATTERNS = [
  /^(send|post|create|update|write|add|set|move|upload|share|invite|reply|comment|publish|merge|close|assign|archive|edit|rename)[_.-]/i,
  /(_send|_post|_create|_update|_write|_add|_set|_move|_upload|_share|_invite|_reply|_comment|_publish)$/i,
  /send_message|send_email|post_message|create_issue|create_pull|open_pr/i,
];

function matches(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
}

/** Plain-language verb for the prompt, derived from the tool's own name. */
function verbFor(name: string): string {
  const cleaned = name.replace(/^mcp__[^_]+__/, "").replace(/[_.-]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : name;
}

export function classify(toolName: string): Verdict {
  const name = String(toolName ?? "");
  if (!name) return { needsApproval: false };

  // A read is a read even if its name also contains a write-ish word
  // ("search_and_update" is not a thing; "get_payment" is).
  if (matches(name, READ_PATTERNS)) return { needsApproval: false };

  if (matches(name, CRITICAL_PATTERNS)) {
    return { needsApproval: true, severity: "critical", verb: verbFor(name) };
  }
  if (matches(name, WRITE_PATTERNS)) {
    return { needsApproval: true, severity: "warning", verb: verbFor(name) };
  }
  return { needsApproval: false };
}

/** One short line naming the action and its target, for the approval card. */
export function describe(toolName: string, params: Record<string, unknown>): string {
  const bits: string[] = [];
  for (const key of ["to", "recipient", "channel", "email", "repo", "url", "amount", "customer", "id", "title"]) {
    const value = params?.[key];
    if (typeof value === "string" && value.trim()) bits.push(`${key}: ${value.slice(0, 60)}`);
    else if (typeof value === "number") bits.push(`${key}: ${value}`);
    if (bits.length >= 3) break;
  }
  return bits.join(" · ").slice(0, 240);
}
