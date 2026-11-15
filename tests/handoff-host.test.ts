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
  assert.equal(host.coordinator.status().handoffs.codex?.phase, "waiting");
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
