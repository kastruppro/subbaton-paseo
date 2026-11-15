import test from "node:test";
import assert from "node:assert/strict";
import { registerHandoff } from "../server/handoff-host.js";
import { scripted, ok } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

// Real HandoffCoordinator + handoff-host wiring + LimitedAgentRecovery on a fake Paseo agent API.
// Invariant: every Codex agent that is not running a turn is reloaded exactly once per adopted switch.
const A = "11111111-1111-4111-8111-111111111111";
const B = "55555555-5555-4555-8555-555555555555";
const text = "Continue the previous task from where it stopped because of the usage limit.";
const nowSec = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harness(opts: { agents: Record<string, string>; reloadAuto?: boolean; intervalMs?: number; windows?: unknown[] }) {
  const { cli, service } = scripted();
  const active = { v: A };
  const base = status.providers[0]!.accounts[0]!;
  cli.on(["status"], () => ok({
    ...status,
    providers: [{ ...status.providers[0], provider: "codex", accounts: [
      { ...base, id: B, alias: "Old", active: active.v === B, windows: opts.windows ?? [] },
      { ...base, id: A, alias: "New", active: active.v === A, windows: opts.windows ?? [] },
    ] }],
  }));
  await service.status();
  let events: unknown[] = [];
  cli.on(["events"], () => ok({ events }));
  let tx = 0;
  cli.on(["codex", "switch"], (argv) => {
    active.v = argv[argv.length - 1] === B || argv.includes(B) ? B : A;
    return ok({ outcome: "switched", postSwitchVerification: "verified", daemonOutcome: "not-requested", transaction: `T${++tx}` });
  });
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const calls: string[] = [];
  const state = new Map(Object.entries(opts.agents));
  const paseo = {
    agents: {
      async list() {
        return { entries: [...state].map(([id, st]) => ({ agent: { id, provider: "codex", status: st, activeTurn: st === "running" ? { turnId: "x" } : null } })), pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: (id: string) => ({
        reload: async () => { calls.push(`reload:${id}`); state.set(id, "idle"); },
        send: async (message: string) => void calls.push(`send:${id}:${message}`),
      }),
    },
  };
  const values = { reloadCodexAfterAutomaticSwitch: opts.reloadAuto ?? true, restartCodexDaemon: false, idleWaitMinutes: 30, resumeLimitedCodexAgents: true };
  const host = registerHandoff(
    {
      registerSettings: (() => ({ read: async () => ({ status: "ready", revision: "1", values }), subscribe: () => () => {} })) as never,
      handle: ((contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => handlers.set(contract.name, handler)) as never,
      addHook: ((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => {}; }) as never,
    },
    service,
    { load: async () => null, save: async () => {} },
    opts.intervalMs ?? 60_000,
    { load: async () => null, save: async () => {} },
  );
  const tick = () => host.coordinator.tick(host.capture({ paseo }));
  const settle = () => sleep(30);
  const limited = async (id: string, turn = "t1") => {
    const agent = { id, provider: "codex", workspaceId: `w-${id}` };
    state.set(id, "running");
    await hooks.get("agent.turn.before")!({ agent, turnId: turn }, { paseo });
    state.set(id, "error");
    await hooks.get("agent.turn.after")!({ agent, turnId: turn, outcome: { kind: "failed", error: { message: "You've hit your usage limit." } } }, { paseo });
  };
  /** The poller (or the app / CLI) switched Codex to `target`; the plugin sees it in the event log. */
  const externalSwitch = async (target: string, id: string) => {
    await host.coordinator.init(); // sets the event watermark without polling
    await sleep(15);
    active.v = target as typeof active.v;
    events = [{ id, at: nowSec(), provider: "codex", kind: "automaticSwitch", target }];
    await sleep(5);
  };
  const manualSwitch = async (target: string) => {
    await handlers.get("handoff.request")!({ provider: "codex", target }, { paseo });
    await tick();
    await settle();
  };
  const count = (c: string) => calls.filter((x) => x === c).length;
  const sends = () => calls.filter((c) => c.startsWith("send:"));
  return { calls, state, tick, settle, limited, externalSwitch, manualSwitch, count, sends, host, events: (v: unknown[]) => void (events = v), active, cleanup: () => host.cleanup() };
}

test("manual switch with idle, idle and error agents (one limited): exactly 3 reloads and 1 continuation", async () => {
  const h = await harness({ agents: { a: "idle", b: "idle", c: "idle" } });
  await h.limited("c");
  await sleep(5);
  await h.manualSwitch(A);
  assert.deepEqual([h.count("reload:a"), h.count("reload:b"), h.count("reload:c")], [1, 1, 1]);
  assert.deepEqual(h.sends(), [`send:c:${text}`]);
  await h.tick(); await h.settle();
  assert.equal(h.calls.length, 4, "nothing more happens on later ticks");
  h.cleanup();
});

test("owner incident: two agents hit the limit after an adoption; the next switch reloads each once and continues each once", async () => {
  const h = await harness({ agents: { a: "idle", b: "idle" } });
  await h.externalSwitch(A, "ev1");
  await h.tick(); await h.settle(); await h.tick(); await h.settle();
  const reloadsAfterFirst = h.calls.length; // the first switch reloaded the idle agents
  assert.deepEqual(h.sends(), []);
  await h.limited("a"); await h.limited("b");
  await h.settle();
  assert.equal(h.sends().length, 0, "the limit hit the current login: no continuation from the same switch");
  assert.equal(h.calls.length, reloadsAfterFirst);
  await h.manualSwitch(B);
  assert.equal(h.calls.length - reloadsAfterFirst, 4, "one reload and one continuation each");
  assert.deepEqual(h.sends().sort(), [`send:a:${text}`, `send:b:${text}`]);
  assert.equal(h.count("reload:a"), 2);
  assert.equal(h.count("reload:b"), 2);
  h.cleanup();
});

test("automatic switch: a busy agent is reloaded once it becomes idle, the others exactly once", async () => {
  const h = await harness({ agents: { a: "idle", b: "running", c: "error" } });
  await h.externalSwitch(A, "ev2");
  await h.tick(); await h.settle();
  assert.equal(h.count("reload:b"), 0, "a running turn is never interrupted");
  h.state.set("b", "idle");
  await h.tick(); await h.settle(); await h.tick(); await h.settle();
  assert.deepEqual([h.count("reload:a"), h.count("reload:b"), h.count("reload:c")], [1, 1, 1]);
  h.cleanup();
});

test("a parked agent (limit after the switch, no evidence) is reloaded but gets no message", async () => {
  const h = await harness({ agents: { a: "idle", p: "idle" } });
  await h.externalSwitch(A, "ev3");
  await h.limited("p");
  await h.tick(); await h.settle(); await h.tick(); await h.settle();
  assert.equal(h.count("reload:p"), 1);
  assert.equal(h.count("reload:a"), 1);
  assert.deepEqual(h.sends(), []);
  h.cleanup();
});

test("a candidate recorded after the reopen tick does not get a second reload", async () => {
  const h = await harness({ agents: { a: "error" } });
  await h.manualSwitch(A);
  assert.equal(h.count("reload:a"), 1);
  await h.limited("a", "t9");
  await h.tick(); await h.settle();
  assert.equal(h.count("reload:a"), 1);
  assert.deepEqual(h.sends(), []);
  h.cleanup();
});

test("the interval runs recovery: a parked candidate continues once the target shows a fresh usable reading, without another reload", async () => {
  const windows = [
    { id: "codex:primary_window", label: "5h", usedPercent: 10, resetsAt: nowSec() + 9000, stale: false, inferred: false, fetchedAt: nowSec() + 500 },
    { id: "codex:secondary_window", label: "7d", usedPercent: 10, resetsAt: nowSec() + 90000, stale: false, inferred: false, fetchedAt: nowSec() + 500 },
  ];
  const h = await harness({ agents: { p: "idle" }, intervalMs: 20, windows });
  await h.externalSwitch(A, "ev4");
  await h.limited("p");
  await sleep(150);
  assert.equal(h.count("reload:p"), 1);
  assert.deepEqual(h.sends(), [`send:p:${text}`]);
  h.cleanup();
});
