import type { Plan } from "./types";

/**
 * Display-side plan parsing. The server parses and re-validates the same block
 * before it will create anything, so this copy only decides what to *draw* —
 * a bad parse here can never turn into a bot.
 */
const FENCE = /```natebot-plan\s*([\s\S]*?)```/m;
const MAX_BOTS = 3;

export function extractPlan(text: string): Plan | null {
  const match = FENCE.exec(text);
  if (!match?.[1]) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const raw = Array.isArray(obj.bots) ? obj.bots : [];
  const bots = raw
    .slice(0, MAX_BOTS)
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name.trim() : "";
      const firstMessage = typeof e.firstMessage === "string" ? e.firstMessage.trim() : "";
      if (!name || !firstMessage) return null;
      return {
        name: name.slice(0, 40),
        purpose: typeof e.purpose === "string" ? e.purpose.slice(0, 400) : "",
        tools: Array.isArray(e.tools)
          ? e.tools.filter((t): t is string => typeof t === "string").slice(0, 12)
          : [],
        firstMessage: firstMessage.slice(0, 4000),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  if (bots.length === 0) return null;
  return { summary: typeof obj.summary === "string" ? obj.summary.slice(0, 300) : "", bots };
}

const SIGNIN_FENCE = /```natebot-signin\s*([\s\S]*?)```/m;

export type SignInRequest = { url: string; site: string; why: string };

/** Mirrors the server's parser; the server re-validates before opening anything. */
export function extractSignIn(text: string): SignInRequest | null {
  const match = SIGNIN_FENCE.exec(text);
  if (!match?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  const url = typeof e.url === "string" ? e.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url: url.slice(0, 2000),
    site: (typeof e.site === "string" ? e.site : "this site").slice(0, 80),
    why: (typeof e.why === "string" ? e.why : "").slice(0, 300),
  };
}

export function stripSignIn(text: string): string {
  return text.replace(/```natebot-signin[\s\S]*?```/m, "").trimEnd();
}

export function stripPlan(text: string): string {
  return text.replace(/```natebot-plan[\s\S]*?```/m, "").trimEnd();
}

/** True while the model is still mid-way through emitting a plan block. */
export function hasOpenPlanFence(text: string): boolean {
  const opens = (text.match(/```natebot-plan/g) ?? []).length;
  return opens > 0 && !FENCE.test(text);
}

/**
 * The prose half of a manager message, safe to render at any point during
 * streaming. `stripPlan` alone only matches a *closed* fence, so mid-stream it
 * would let half-written plan JSON spill into the thread.
 */
export function visibleProse(text: string): string {
  if (hasOpenPlanFence(text)) {
    return text.replace(/```natebot-plan[\s\S]*$/m, "").trimEnd();
  }
  return stripPlan(text);
}
