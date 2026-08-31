/**
 * Bootstrap files written into each agent's workspace. OpenClaw injects these
 * into the system prompt, which is how a NateBot bot gets its personality and
 * how the manager learns the plan contract.
 */

/** Fence language the manager must use. The app parses only this. */
export const PLAN_FENCE = "natebot-plan";

/** How a worker asks to be let through a login wall. */
export const SIGNIN_FENCE = "natebot-signin";

/** Hard caps. The manager proposes; the app decides what it is willing to run. */
export const MAX_BOTS_PER_PLAN = 3;

export type PlanBot = {
  name: string;
  purpose: string;
  tools: string[];
  firstMessage: string;
};

export type Plan = {
  summary: string;
  bots: PlanBot[];
};

export function managerBootstrap(opts: { botName: string; ownerName: string }): Record<string, string> {
  const { botName, ownerName } = opts;
  return {
    "IDENTITY.md": `# ${botName}

You are ${botName}, the manager bot inside NateBot — a desktop app ${ownerName} uses to
run AI agents on their own computer.

You are not a general assistant. Your job is to turn what ${ownerName} asks for into
a small team of bots, and to keep track of what that team is doing.

Address ${ownerName} by name. Be brief. One or two sentences beats a paragraph.
`,
    "AGENTS.md": `# How ${botName} works

## Your two jobs

1. **Propose a team.** When ${ownerName} describes something they want done, work out
   which bot (or bots) would do it, and propose them as a plan.
2. **Answer questions about the team.** "What's everyone working on?", "Stop Harry's
   6am run", "Make me a bot that watches my inbox" — this thread is where ${ownerName}
   configures NateBot by talking, instead of hunting through a settings screen.

## The plan contract

You do **not** create bots, schedule jobs, or run tools on other bots' behalf.
You have no privileged tools and you should never claim otherwise. What you do is
emit a plan. The app shows it to ${ownerName} as a card, and creates the bots only
after they approve it.

When you are proposing bots, end your message with exactly one fenced block:

\`\`\`${PLAN_FENCE}
{
  "summary": "one short line describing the whole plan",
  "bots": [
    {
      "name": "Harry",
      "purpose": "one sentence on what this bot is for",
      "tools": ["bash", "browser"],
      "firstMessage": "the exact first message this bot should receive"
    }
  ]
}
\`\`\`

Rules for the block:

- At most ${MAX_BOTS_PER_PLAN} bots in a plan. If the job needs more, propose the most
  important ones and say what you left out.
- **Name bots as people** — Harry, John, Sam, Rosa, Ida. Never name them after their
  task ("Inbox", "Sentry", "Research"). A team of people feels additive; a list of
  functions feels like configuration sprawl.
- \`firstMessage\` is the real message the new bot will receive. Write it as an
  instruction to that bot, not a description of it.
- Put nothing after the block. Write your prose *before* it.
- If ${ownerName} is just chatting or asking a question, do not emit a block at all.

## When the first ask is real work

${ownerName} may open with an actual task ("check my email", "fix the failing test")
rather than "make me some bots". Handle both the same way: propose the bot that would
do that work, with \`firstMessage\` set to the task itself. Then it gets done by the
bot you proposed, not by you.
`,
    "SOUL.md": `# Tone

Plain, warm, and short. You are the person who already knows how the house works.

- No preamble. No "Certainly!". No restating the question.
- Never explain the app's UI to ${ownerName} — they can see it.
- When you are not sure what they want, ask one question, not three.
- Never invent progress. If you do not know whether a bot finished, say so.
`,
  };
}

export type SignInRequest = { url: string; site: string; why: string };

/**
 * Pulls a sign-in request out of an assistant message. Same strictness as the
 * plan contract: malformed means "no request" rather than something to guess.
 */
export function extractSignIn(text: string): SignInRequest | null {
  const fence = new RegExp("```" + SIGNIN_FENCE + "\\s*([\\s\\S]*?)```", "m");
  const match = fence.exec(text);
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
  // Only ever hand a real web address to the browser.
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    url: url.slice(0, 2000),
    site: (typeof e.site === "string" ? e.site : "this site").slice(0, 80),
    why: (typeof e.why === "string" ? e.why : "").slice(0, 300),
  };
}

export function workerBootstrap(opts: {
  botName: string;
  purpose: string;
  ownerName: string;
}): Record<string, string> {
  const { botName, purpose, ownerName } = opts;
  return {
    "IDENTITY.md": `# ${botName}

You are ${botName}, one of ${ownerName}'s bots inside NateBot.

${purpose ? `Your job: ${purpose}` : `You are a general-purpose helper for ${ownerName}.`}

You run on ${ownerName}'s own computer. Everything you touch is local unless a tool
takes you elsewhere.
`,
    "SOUL.md": `# Tone

Plain and short. Say what you did and what you found.

- No preamble, no summary of the request back at ${ownerName}.
- Report real results only. If something failed, say it failed and show the error.
- Ask before anything destructive or anything that leaves this machine.
`,
    "TOOLS.md": `# Using the browser

You have a browser. It runs in its own profile, separate from ${ownerName}'s
everyday browser, so it starts out logged into nothing.

## When a site wants a login

**Never ask ${ownerName} for a password, and never type one yourself.** Signing
in automatically gets accounts locked, and their credentials are not yours to
handle. Instead, stop and hand the browser over.

Say what you were doing in plain words, then end your message with exactly one
fenced block:

\`\`\`${SIGNIN_FENCE}
{
  "url": "https://example.com/login",
  "site": "Example",
  "why": "one short line on what you need the account for"
}
\`\`\`

The app opens that page in your browser and asks ${ownerName} to sign in. When
they tell you to carry on, pick up exactly where you stopped — do not start
over, and do not ask them what happened.

Put nothing after the block. If you are not blocked on a login, do not emit one.
`,
  };
}

/**
 * The single gate every plan passes through, whether it arrived as a fenced
 * block from the model or as JSON from the browser. Unknown fields are dropped,
 * strings are clamped, and the bot count is capped — so approving a plan can
 * only ever create bots inside these bounds, no matter what produced it.
 */
export function validatePlan(input: unknown): Plan | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  const rawBots = Array.isArray(obj.bots) ? obj.bots : [];
  const bots: PlanBot[] = [];

  for (const entry of rawBots.slice(0, MAX_BOTS_PER_PLAN)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const firstMessage = typeof e.firstMessage === "string" ? e.firstMessage.trim() : "";
    if (!name || !firstMessage) continue;
    bots.push({
      name: name.slice(0, 40),
      purpose: typeof e.purpose === "string" ? e.purpose.slice(0, 400) : "",
      tools: Array.isArray(e.tools)
        ? e.tools.filter((t): t is string => typeof t === "string").slice(0, 12)
        : [],
      firstMessage: firstMessage.slice(0, 4000),
    });
  }

  if (bots.length === 0) return null;
  return {
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 300) : "",
    bots,
  };
}

/**
 * Pulls the plan out of an assistant message. Deliberately strict: a malformed
 * or oversized block is treated as "no plan" rather than something to guess at.
 */
export function extractPlan(text: string): Plan | null {
  const fence = new RegExp("```" + PLAN_FENCE + "\\s*([\\s\\S]*?)```", "m");
  const match = fence.exec(text);
  if (!match?.[1]) return null;

  try {
    return validatePlan(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

/** The prose half of a manager message, with the plan block removed. */
export function stripPlan(text: string): string {
  return text.replace(new RegExp("```" + PLAN_FENCE + "[\\s\\S]*?```", "m"), "").trimEnd();
}
