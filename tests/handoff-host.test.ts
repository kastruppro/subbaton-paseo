import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileHandoffStore } from "../server/handoff-store.js";
import { registerHandoff } from "../server/handoff-host.js";
import { scripted, ok } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

test("handoff state file is owner-only, atomic and refuses symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subbaton-handoff-"));
  try {
    const path = join(dir, "nested", "handoff-v1.json");
    const store = fileHandoffStore(path);
    assert.equal(await store.load(), null);
    const state = { schemaVersion: 1 as const, handoffs: { codex: null, agy: null }, eventWatermark: 5, handledSwitches: [], notice: null };
    await store.save(state);
    assert.deepEqual(await store.load(), state);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
    const link = join(dir, "link.json");
    await writeFile(join(dir, "real.json"), "{}");
    await symlink(join(dir, "real.json"), link);
    await assert.rejects(fileHandoffStore(link).load());
    // Review L3: an unreadable file is moved aside, not overwritten.
    await writeFile(path, "{broken");
    const kept = await store.setAside!();
    assert.match(kept ?? "", /^handoff-v1\.json\.unreadable-\d+$/);
    assert.equal(await store.load(), null);
    assert.equal(await readFile(join(dir, "nested", kept!), "utf8"), "{broken");
    assert.equal(await fileHandoffStore(join(dir, "missing.json")).setAside!(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const target = "11111111-1111-4111-8111-111111111111";
test("host wiring registers the RPCs, uses the context's agent API and nudges on turn end", async () => {
  const { cli, service } = scripted();
  cli.on(["status"], ok({ ...status, providers: [{ ...status.providers[0], provider: "codex" }] }));
  await service.status();
  cli.on(["codex", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "not-requested" }));
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  let removed = 0;
  const reloads: string[] = [];
  let running = true;
  const paseo = {
    agents: {
      async list() {
        return { entries: [{ agent: { id: "c1", provider: "codex", status: running ? "running" : "idle", activeTurn: running ? { turnId: "t" } : null } }], pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: (id: string) => ({ reload: async () => void reloads.push(id) }),
    },
  };
  let saved: unknown = null;
  const host = registerHandoff(
    {
      registerSettings: (() => ({ read: async () => ({ status: "ready", revision: "1", values: { reloadCodexAfterAutomaticSwitch: false, restartCodexDaemon: false, idleWaitMinutes: 30 } }), subscribe: () => () => {} })) as never,
      handle: ((contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, handler)) as never,
      addHook: ((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
        hooks.set(name, handler);
        return () => removed++;
      }) as never,
    },
    service,
    { load: async () => null, save: async (s) => void (saved = s) },
    60_000,
  );
  assert.deepEqual([...handlers.keys()].sort(), ["handoff.control", "handoff.request", "handoff.status"]);
  const requested = (await handlers.get("handoff.request")!({ provider: "codex", target }, { paseo })) as { result: { outcome: string } };
  assert.equal(requested.result.outcome, "success");
  await host.coordinator.tick(host.capture({ paseo }));
  // No global gate for Codex: the switch ran and the running agent is reloaded only once it is idle.
  assert.equal(host.coordinator.status().handoffs.codex?.phase, "reopening");
  assert.deepEqual(reloads, []);
  running = false;
  await hooks.get("agent.turn.after")!({ agent: { id: "c1" } }, { paseo });
  await host.coordinator.tick(host.capture({ paseo }));
  assert.deepEqual(reloads, ["c1"]);
  assert.equal(host.coordinator.status().handoffs.codex?.phase, "done");
  assert.ok(saved);
  assert.equal(((await handlers.get("handoff.request")!({ provider: "claude", target }, {})) as { result: { code: string } }).result.code, "invalidInput");
  host.cleanup();
  assert.equal(removed, 3);
});

test("host wiring continues a limited Codex agent once after a verified switch with a daemon restart", async () => {
  const { cli, service } = scripted();
  cli.on(["status"], ok({ ...status, providers: [{ ...status.providers[0], provider: "codex" }] }));
  await service.status();
  cli.on(["codex", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "restarted", transaction: "T1" }));
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const calls: string[] = [];
  let agentStatus = "error";
  const paseo = {
    agents: {
      async list() {
        return { entries: [{ agent: { id: "c1", provider: "codex", status: agentStatus, activeTurn: null } }], pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: (id: string) => ({
        reload: async () => { calls.push(`reload:${id}`); agentStatus = "idle"; },
        send: async (text: string) => void calls.push(`send:${id}:${text}`),
      }),
    },
  };
  const settingsValue = { reloadCodexAfterAutomaticSwitch: false, restartCodexDaemon: true, idleWaitMinutes: 30, resumeLimitedCodexAgents: true };
  const host = registerHandoff(
    {
      registerSettings: (() => ({ read: async () => ({ status: "ready", revision: "1", values: settingsValue }), subscribe: () => () => {} })) as never,
      handle: ((contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, handler)) as never,
      addHook: ((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => {}; }) as never,
    },
    service,
    { load: async () => null, save: async () => {} },
    60_000,
    { load: async () => null, save: async () => {} },
  );
  const agent = { id: "c1", provider: "codex", workspaceId: "w-other" };
  await hooks.get("agent.turn.before")!({ agent, turnId: "t1" }, { paseo });
  await hooks.get("agent.turn.after")!({ agent, turnId: "t1", outcome: { kind: "failed", error: { message: "You've hit your usage limit." } } }, { paseo });
  await new Promise((r) => setTimeout(r, 5));
  await handlers.get("handoff.request")!({ provider: "codex", target }, { paseo });
  await host.coordinator.tick(host.capture({ paseo }));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ["reload:c1", "send:c1:Continue the previous task from where it stopped because of the usage limit."]);
  // a duplicate nudge never sends again
  await hooks.get("agent.turn.after")!({ agent: { ...agent, id: "other" }, turnId: "x", outcome: { kind: "completed" } }, { paseo });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter((c) => c.startsWith("send:")).length, 1);
  host.cleanup();
});

// Manual switch with the daemon restart opt-in off: the plugin's own reload of the agent adopts the login.
const other = "55555555-5555-4555-8555-555555555555";
async function manualFlow(opts: { activeAfter?: string; secondLimitAfterSwitch?: boolean; restart?: boolean }) {
  const { cli, service } = scripted();
  const two = (active: string) => ({
    ...status,
    providers: [{ ...status.providers[0], provider: "codex", accounts: [
      { ...status.providers[0]!.accounts[0]!, id: other, alias: "Old", active: active === other },
      { ...status.providers[0]!.accounts[0]!, id: target, alias: "New", active: active === target },
    ] }],
  });
  cli.on(["status"], ok(two(opts.activeAfter ?? target)));
  await service.status();
  cli.on(["codex", "switch"], ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "not-requested", transaction: "T7" }));
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const calls: string[] = [];
  const state = new Map<string, string>([["c1", "error"], ["c2", "idle"]]);
  const paseo = {
    agents: {
      async list() {
        return { entries: [...state].map(([id, st]) => ({ agent: { id, provider: "codex", status: st, activeTurn: null } })), pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: (id: string) => ({
        reload: async () => { calls.push(`reload:${id}`); state.set(id, "idle"); },
        send: async (text: string) => void calls.push(`send:${id}:${text}`),
      }),
    },
  };
  const values = { reloadCodexAfterAutomaticSwitch: false, restartCodexDaemon: opts.restart ?? false, idleWaitMinutes: 30, resumeLimitedCodexAgents: true };
  const host = registerHandoff(
    {
      registerSettings: (() => ({ read: async () => ({ status: "ready", revision: "1", values }), subscribe: () => () => {} })) as never,
      handle: ((contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, handler)) as never,
      addHook: ((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => {}; }) as never,
    },
    service,
    { load: async () => null, save: async () => {} },
    60_000,
    { load: async () => null, save: async () => {} },
  );
  const limited = async (id: string, turn: string) => {
    const agent = { id, provider: "codex", workspaceId: `w-${id}` };
    await hooks.get("agent.turn.before")!({ agent, turnId: turn }, { paseo });
    await hooks.get("agent.turn.after")!({ agent, turnId: turn, outcome: { kind: "failed", error: { message: "You've hit your usage limit." } } }, { paseo });
  };
  await limited("c1", "t1");
  await new Promise((r) => setTimeout(r, 5));
  await handlers.get("handoff.request")!({ provider: "codex", target }, { paseo });
  await host.coordinator.tick(host.capture({ paseo }));
  await new Promise((r) => setTimeout(r, 30));
  if (opts.secondLimitAfterSwitch) {
    // c2 ends in a limit after the switch, on the new login: a second limited account, not recoverable.
    await new Promise((r) => setTimeout(r, 5));
    await limited("c2", "t5");
    await new Promise((r) => setTimeout(r, 30));
  }
  host.cleanup();
  return { calls, cli };
}
const sendText = "Continue the previous task from where it stopped because of the usage limit.";
test("manual switch with the restart opt-in off continues the limited agent exactly once", async () => {
  const { calls, cli } = await manualFlow({});
  assert.deepEqual(calls.filter((c) => c.startsWith("send:")), [`send:c1:${sendText}`]);
  assert.equal(calls.filter((c) => c === "reload:c1").length, 1);
  assert.ok(!cli.calls.some((c) => c.argv.includes("restart")), "no daemon restart");
});
test("the switch target is no longer active at the recheck: nothing is reloaded or sent", async () => {
  const { calls } = await manualFlow({ activeAfter: other });
  // the verified switch still reloads every agent that is not running (c1 stopped in an error), once; recovery sends nothing
  assert.deepEqual(calls.filter((c) => c.includes("c1")), ["reload:c1"]);
  assert.deepEqual(calls.filter((c) => c.startsWith("send:")), []);
});
test("a second limited account after the switch is not continued", async () => {
  const { calls } = await manualFlow({ secondLimitAfterSwitch: true });
  assert.deepEqual(calls.filter((c) => c.startsWith("send:")), [`send:c1:${sendText}`]);
  assert.ok(!calls.some((c) => c.startsWith("send:c2")));
});
