import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    const state = { schemaVersion: 1 as const, handoffs: { codex: null, agy: null }, eventWatermark: 5 };
    await store.save(state);
    assert.deepEqual(await store.load(), state);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
    const link = join(dir, "link.json");
    await writeFile(join(dir, "real.json"), "{}");
    await symlink(join(dir, "real.json"), link);
    await assert.rejects(fileHandoffStore(link).load());
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
  assert.equal(removed, 1);
});
