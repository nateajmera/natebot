import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITIES,
  capabilitiesFromPlanTools,
  mcpToolPrefix,
  parseCapabilityMap,
  parseConnectionMap,
  readScope,
  writeScopes,
} from "../dist/server/scoping.js";

/**
 * Scoping decides what a bot is allowed to touch, so the interesting cases are
 * all about what happens to the things a caller did *not* mention. These run
 * against a fake gateway rather than the real one: the point is the deny list
 * we compute and the patch we send, not OpenClaw's reply.
 */

/** A stand-in gateway that records what it was asked to write. */
function fakeGateway({ agents = [], servers = {}, onPatch } = {}) {
  const calls = [];
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      if (method === "config.get") {
        return Promise.resolve({
          hash: `hash-${calls.length}`,
          config: { agents: { list: agents }, mcp: { servers } },
        });
      }
      if (method === "config.patch") {
        if (onPatch) return onPatch(params, calls);
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

/** The deny list from the most recent config.patch. */
function denyWritten(gateway, agentId = "bot") {
  const patch = gateway.calls.filter((c) => c.method === "config.patch").at(-1);
  assert.ok(patch, "expected a config.patch");
  const parsed = JSON.parse(patch.params.raw);
  const entry = parsed.agents.list.find((a) => a.id === agentId);
  assert.ok(entry, `expected agent ${agentId} in the patch`);
  return entry.tools.deny;
}

/* ------------------------------------------------------------ MCP prefixes */

test("mcp tool prefixes follow OpenClaw's normalisation", () => {
  assert.equal(mcpToolPrefix("sentry"), "sentry");
  // Documented example: non-[a-z0-9_-] becomes '-'.
  assert.equal(mcpToolPrefix("Outlook Graph"), "outlook-graph");
  // A name that does not start with a letter gets the mcp- prefix.
  assert.equal(mcpToolPrefix("1password"), "mcp-1password");
});

/* ------------------------------------------------------------- plan tools */

test("plan tools scope only the capabilities the manager reasons about", () => {
  const scoped = capabilitiesFromPlanTools(["bash", "browser"]);
  assert.deepEqual(scoped, { files: false, shell: true, web: false, browser: true });
  // Memory, schedules and other bots are absent, not false: no plan ever
  // expressed a view on them, so they must keep whatever they had.
  assert.equal("memory" in scoped, false);
  assert.equal("schedule" in scoped, false);
  assert.equal("bots" in scoped, false);
});

test("a plan naming nothing recognisable leaves the bot unscoped", () => {
  // The failure mode this guards against is stripping a bot down to nothing on
  // the strength of a word we simply failed to parse.
  assert.equal(capabilitiesFromPlanTools(["gmail", "salesforce"]), null);
  assert.equal(capabilitiesFromPlanTools([]), null);
});

test("plan tool names are matched loosely", () => {
  assert.deepEqual(capabilitiesFromPlanTools(["Bash", "Web Search"]), {
    files: false,
    shell: true,
    web: true,
    browser: false,
  });
});

/* ------------------------------------------------------------------ input */

test("malformed intent is dropped rather than guessed at", () => {
  assert.deepEqual(parseCapabilityMap({ shell: false, nonsense: true, files: "yes" }), {
    shell: false,
  });
  assert.deepEqual(parseCapabilityMap(["shell"]), {});
  assert.deepEqual(parseCapabilityMap(null), {});
  assert.deepEqual(parseConnectionMap({ solum: true, bad: 1 }), { solum: true });
});

/* ------------------------------------------------------------------ reading */

test("an untouched bot can reach everything", async () => {
  const gateway = fakeGateway({ agents: [{ id: "bot" }] });
  const scope = await readScope(gateway, "bot", "worker");
  assert.equal(scope.capabilities.length, CAPABILITIES.length);
  assert.ok(scope.capabilities.every((c) => c.enabled));
  assert.deepEqual(scope.connections, []);
});

test("a half-written deny list still reads as on", async () => {
  // 'files' denies group:fs. Something unrelated in the deny list must not be
  // mistaken for it, or the drawer would claim a capability is gone when the
  // bot can still use it.
  const gateway = fakeGateway({
    agents: [{ id: "bot", tools: { deny: ["some_other_tool"] } }],
  });
  const scope = await readScope(gateway, "bot", "worker");
  assert.ok(scope.capabilities.every((c) => c.enabled));
});

/* ------------------------------------------------------------------ writing */

test("a capability the caller did not mention keeps its stored value", async () => {
  // The regression test for the bug this design replaced: a keep-list made
  // every unmentioned row an implicit revocation.
  const gateway = fakeGateway({
    agents: [{ id: "bot", tools: { deny: ["browser", "solum__*"] } }],
    servers: { solum: {} },
  });

  const result = await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { shell: false } },
  ]);

  assert.equal(result.ok, true);
  const deny = denyWritten(gateway);
  assert.ok(deny.includes("group:runtime"), "shell was asked to go off");
  assert.ok(deny.includes("browser"), "browser was not mentioned, so it stays off");
  assert.ok(deny.includes("solum__*"), "connections were not mentioned, so they stay as they were");
});

test("turning something back on removes only its own entry", async () => {
  const gateway = fakeGateway({
    agents: [{ id: "bot", tools: { deny: ["group:runtime", "browser"] } }],
  });

  await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { shell: true } },
  ]);

  const deny = denyWritten(gateway);
  assert.equal(deny.includes("group:runtime"), false);
  assert.ok(deny.includes("browser"));
});

test("deny entries this app did not write are left alone", async () => {
  // Someone may have denied a specific tool by hand. A toggle here has no
  // business dropping it.
  const gateway = fakeGateway({
    agents: [{ id: "bot", tools: { deny: ["some_hand_picked_tool"] } }],
  });

  await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { web: false } },
  ]);

  const deny = denyWritten(gateway);
  assert.ok(deny.includes("some_hand_picked_tool"));
  assert.ok(deny.includes("group:web"));
});

test("the manager cannot be cut off from its own team", async () => {
  const gateway = fakeGateway({ agents: [{ id: "commander" }] });

  // Ask for absolutely everything to be taken away.
  const result = await writeScopes(gateway, [
    {
      agentId: "commander",
      kind: "manager",
      capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c.id, false])),
    },
  ]);

  const deny = denyWritten(gateway, "commander");
  assert.equal(
    deny.includes("group:sessions"),
    false,
    "dispatch is structural — refused at the server, not merely hidden in the UI",
  );
  assert.equal(result.scopes.commander.capabilities.find((c) => c.id === "bots").enabled, true);
  assert.equal(result.scopes.commander.capabilities.find((c) => c.id === "bots").locked, true);
});

test("a shrinking deny list declares the array replacement", async () => {
  // Without this the gateway refuses the write outright.
  const gateway = fakeGateway({
    agents: [{ id: "bot", tools: { deny: ["group:runtime"] } }],
  });
  await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { shell: true } },
  ]);
  const patch = gateway.calls.filter((c) => c.method === "config.patch").at(-1);
  assert.deepEqual(patch.params.replacePaths, ["agents.list[].tools.deny"]);
  assert.equal(typeof patch.params.baseHash, "string");
});

test("a whole team is written in one patch", async () => {
  // Control-plane writes are capped at three a minute, so a three-bot plan
  // written one at a time would sit exactly on the limit.
  const gateway = fakeGateway({ agents: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  await writeScopes(gateway, [
    { agentId: "a", kind: "worker", capabilities: { shell: false } },
    { agentId: "b", kind: "worker", capabilities: { web: false } },
    { agentId: "c", kind: "worker", capabilities: { files: false } },
  ]);
  const patches = gateway.calls.filter((c) => c.method === "config.patch");
  assert.equal(patches.length, 1);
  assert.equal(JSON.parse(patches[0].params.raw).agents.list.length, 3);
});

test("a reply lost to the gateway reload counts as success", async () => {
  const gateway = fakeGateway({
    agents: [{ id: "bot" }],
    onPatch: () => Promise.reject(new Error("gateway request timed out: config.patch")),
  });
  const result = await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { shell: false } },
  ]);
  // Reporting failure here would send someone clicking again into the limit.
  assert.equal(result.ok, true);
  assert.equal(result.scopes.bot.capabilities.find((c) => c.id === "shell").enabled, false);
});

test("a stale base hash is retried once against fresh config", async () => {
  let attempts = 0;
  const gateway = fakeGateway({
    agents: [{ id: "bot" }],
    onPatch: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("config hash mismatch"))
        : Promise.resolve({ ok: true });
    },
  });

  const result = await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { shell: false } },
  ]);

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  // The retry must re-read, not replay the hash it already knows is stale.
  assert.equal(gateway.calls.filter((c) => c.method === "config.get").length, 2);
});

test("a genuine write failure is reported, not swallowed", async () => {
  const gateway = fakeGateway({
    agents: [{ id: "bot" }],
    onPatch: () => Promise.reject(new Error("rate limit exceeded")),
  });
  const result = await writeScopes(gateway, [
    { agentId: "bot", kind: "worker", capabilities: { shell: false } },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /rate limit/);
});
