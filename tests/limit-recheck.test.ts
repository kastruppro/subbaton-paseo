import test from "node:test";
import assert from "node:assert/strict";
import { LimitedAgentRecovery, type LimitRecheck, type RecoveryStore } from "../server/limited-agents.js";
import { registerHandoff } from "../server/handoff-host.js";
import { scripted, ok } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

const LIMIT = "You've hit your usage limit. Upgrade or try again later.";
const failed = { kind: "failed" as const, error: { message: LIMIT } };
const agent = (id: string) => ({ id, workspaceId: "w1", provider: "codex", cwd: "/x", parentAgentId: null, title: null });
const memoryStore = (): RecoveryStore => {
  const s = { saved: null as unknown, load: async () => s.saved, save: async (v: unknown) => void (s.saved = JSON.parse(JSON.stringify(v))) };
  return s;
};
const ACTIVE = "11111111-1111-4111-8111-111111111111";

function fakeRecheck(opts: { refresh?: { ok: true; cached?: boolean } | { ok: false; reason: string }; auto?: "on" | "off" | "paused" | null; outcome?: { outcome: string; reason?: string } } = {}) {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const recheck: LimitRecheck = {
    autoState: async () => { calls.push("autoState"); return opts.auto === undefined ? "on" : opts.auto; },
    refresh: async (id) => { calls.push(`refresh:${id}`); await new Promise<void>((r) => (release = r)); return opts.refresh ?? { ok: true }; },
    runOnce: async () => { calls.push("run-once"); return opts.outcome ?? { outcome: "stay", reason: "belowThreshold" }; },
    onSwitched: () => void calls.push("switched"),
  };
  return { recheck, calls, finishRefresh: () => release?.() };
}
function make(rc: ReturnType<typeof fakeRecheck>) {
  const clock = { t: 1000 };
  const logs: string[] = [];
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 30_000, (l) => void logs.push(l), undefined, undefined, rc.recheck);
  return { recovery, clock, logs };
}
const limitOn = async (r: ReturnType<typeof make>, id: string, turn = "t1") => {
  await r.recovery.turnBefore(agent(id), turn);
  await r.recovery.turnAfter(agent(id), turn, failed);
};
const has = (r: { logs: string[] }, re: RegExp) => r.logs.some((l) => re.test(l));

test("five limits in the same second: one refresh of the active account and one run-once", async () => {
  const rc = fakeRecheck({ outcome: { outcome: "switched", reason: "thresholdReached" } });
  const r = make(rc);
  for (const id of ["a", "b", "c", "d", "e"]) await limitOn(r, id);
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.deepEqual(rc.calls, [`refresh:${ACTIVE}`, "autoState", "run-once", "switched"]);
  assert.ok(has(r, /recheck started provider=codex account=11111111/));
  assert.ok(has(r, /recheck read provider=codex account=11111111/));
  assert.ok(has(r, /recheck run-once decision=switched reason=thresholdReached/));
  assert.equal(r.logs.filter((l) => /recheck skipped reason=already running/.test(l)).length, 1, "the skip is logged once per burst");
});
test("a second burst inside 60 s starts nothing; after 60 s a new limit rechecks again", async () => {
  const rc = fakeRecheck();
  const r = make(rc);
  await limitOn(r, "a");
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  const before = rc.calls.length;
  r.clock.t += 30;
  await limitOn(r, "b");
  await r.recovery.recheckIdle();
  assert.equal(rc.calls.length, before, "no second recheck inside 60 s");
  assert.ok(has(r, /recheck skipped reason=within 60 s of the last recheck/));
  r.clock.t += 31;
  await limitOn(r, "c");
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.ok(rc.calls.length > before, "a limit after the window rechecks");
});
test("a refused refresh means no run-once, and the reason is logged", async () => {
  const rc = fakeRecheck({ refresh: { ok: false, reason: "rate limited" } });
  const r = make(rc);
  await limitOn(r, "a");
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.deepEqual(rc.calls, [`refresh:${ACTIVE}`]);
  assert.ok(has(r, /recheck skipped reason=refresh refused \(rate limited\)/));
});
test("automatic switching off or paused: refresh only, no run-once", async () => {
  for (const auto of ["off", "paused"] as const) {
    const rc = fakeRecheck({ auto });
    const r = make(rc);
    await limitOn(r, "a");
    await new Promise((resolve) => setImmediate(resolve));
    rc.finishRefresh();
    await r.recovery.recheckIdle();
    assert.ok(!rc.calls.includes("run-once"), auto);
    assert.ok(has(r, new RegExp(`recheck skipped reason=automatic switching ${auto}`)), r.logs.join("\n"));
  }
});
test("a stay decision is logged and never retried inside the window", async () => {
  const rc = fakeRecheck({ outcome: { outcome: "stay", reason: "belowThreshold" } });
  const r = make(rc);
  await limitOn(r, "a");
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.ok(has(r, /recheck run-once decision=stay reason=belowThreshold/));
  assert.ok(!rc.calls.includes("switched"));
  r.clock.t += 10;
  await limitOn(r, "b");
  await r.recovery.recheckIdle();
  assert.equal(rc.calls.filter((c) => c === "run-once").length, 1);
});
test("(a) every positive Codex limit starts the recheck, also without a continuation candidate", async () => {
  // setting off: no candidate is recorded, the recheck still runs
  const off = fakeRecheck();
  const clock = { t: 1000 };
  const logs: string[] = [];
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => false, async () => ACTIVE, () => clock.t, 30_000, (l) => void logs.push(l), undefined, undefined, off.recheck);
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await new Promise((resolve) => setImmediate(resolve));
  off.finishRefresh();
  await recovery.recheckIdle();
  assert.deepEqual(off.calls, [`refresh:${ACTIVE}`, "autoState", "run-once"]);
  // no turn id, and a continuation that hits the limit again
  const rc = fakeRecheck();
  const r = make(rc);
  await r.recovery.turnBefore(agent("b"), null);
  await r.recovery.turnAfter(agent("b"), null, failed);
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.ok(rc.calls.includes("run-once"), "a limit without a turn id still rechecks");
  // a failure that is not a limit never rechecks
  const quiet = fakeRecheck();
  const q = make(quiet);
  await q.recovery.turnBefore(agent("c"), "t1");
  await q.recovery.turnAfter(agent("c"), "t1", { kind: "failed", error: { message: "Network unreachable" } });
  await q.recovery.turnAfter(agent("c"), "t2", { kind: "completed" });
  await q.recovery.recheckIdle();
  assert.deepEqual(quiet.calls, []);
  // without a recheck dependency nothing breaks
  const bare = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 30_000, () => {});
  await bare.turnBefore(agent("a"), "t1");
  await bare.turnAfter(agent("a"), "t1", failed);
  await bare.recheckIdle();
});
test("(a) a continuation that hits a limit again also rechecks", async () => {
  const rc = fakeRecheck();
  const r = make(rc);
  const port = { agents: [] as unknown[] };
  void port;
  // record the first limit, adopt a switch and let the continuation go out
  await limitOn(r, "a");
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  const before = rc.calls.length;
  r.clock.t += 120;
  await r.recovery.adopt("txn:1", ACTIVE);
  let st = "error";
  const fake = {
    list: async () => [{ id: "a", provider: "codex", status: st, activeTurn: false }],
    reload: async () => void (st = "idle"),
    send: async () => {},
  };
  await r.recovery.run(fake as never);
  r.clock.t += 120;
  await r.recovery.turnBefore(agent("a"), "t2"); // our continuation's turn
  await r.recovery.turnAfter(agent("a"), "t2", failed); // hits the limit again
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.ok(rc.calls.length > before, "the continuation's limit rechecks as well");
  assert.ok(has(r, /continuation hit a limit again/));
});
test("(b) a refresh that takes longer than 30 s is not cut off; a real timeout is logged as timeout", async () => {
  const slow = fakeRecheck();
  const clock = { t: 1000 };
  const logs: string[] = [];
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 20, (l) => void logs.push(l), undefined, undefined, slow.recheck);
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await new Promise((resolve) => setTimeout(resolve, 60)); // longer than the short per-call timeout used elsewhere
  slow.finishRefresh();
  await recovery.recheckIdle();
  assert.ok(slow.calls.includes("run-once"), "the refresh is bounded like the CLI call, not by the short timeout");
  // a refresh that never answers is a timeout, not an unexpected error
  const stuckLogs: string[] = [];
  const stuck: LimitRecheck = { autoState: async () => "on", refresh: () => new Promise(() => {}), runOnce: async () => ({ outcome: "stay" }) };
  const timed = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 20, (l) => void stuckLogs.push(l), undefined, undefined, stuck, 30);
  await timed.turnBefore(agent("a"), "t1");
  await timed.turnAfter(agent("a"), "t1", failed);
  await timed.recheckIdle();
  assert.ok(stuckLogs.some((l) => /recheck skipped reason=timeout/.test(l)), stuckLogs.join("\n"));
  assert.ok(!stuckLogs.some((l) => /unexpected error/.test(l)));
});
test("a cached refresh (inside the request floor) is not logged as fresh and still runs run-once", async () => {
  const rc = fakeRecheck({ refresh: { ok: true, cached: true } });
  const r = make(rc);
  await limitOn(r, "a");
  await new Promise((resolve) => setImmediate(resolve));
  rc.finishRefresh();
  await r.recovery.recheckIdle();
  assert.ok(has(r, /recheck read provider=codex account=11111111 cached/), r.logs.join("\n"));
  assert.ok(!has(r, /recheck read provider=codex account=\S+ fresh$/));
  assert.ok(rc.calls.includes("run-once"));
});

// Service and host level: real argv through the trusted CLI port, and the adopted switch flows into the existing handoff.
const A = "11111111-1111-4111-8111-111111111111";
const B = "55555555-5555-4555-8555-555555555555";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hostHarness(autoEnabled: boolean | undefined = true, usageReply: unknown = { status: "ok" }) {
  const { cli, service } = scripted();
  const base = status.providers[0]!.accounts[0]!;
  const active = { v: B };
  cli.on(["status"], () => ok({
    ...status,
    providers: [{ ...status.providers[0], provider: "codex", ...(autoEnabled === undefined ? {} : { auto: { enabled: autoEnabled, paused: false, lastAutomaticSwitchAt: null } }), accounts: [
      { ...base, id: B, alias: "Old", active: active.v === B, windows: [] },
      { ...base, id: A, alias: "New", active: active.v === A, windows: [] },
    ] }],
  }));
  await service.status();
  let events: unknown[] = [];
  cli.on(["events"], () => ok({ events }));
  cli.on(["codex", "usage"], ok(usageReply));
  cli.on(["codex", "auto", "run-once"], () => {
    active.v = A;
    events = [{ id: "ev1", at: Date.now() / 1000 + 1, provider: "codex", kind: "automaticSwitch", target: A, transaction: "T9" }];
    return ok({ outcome: "switched", reason: "thresholdReached", switch: { postSwitchVerification: "verified" } });
  });
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const calls: string[] = [];
  const state = new Map([["c1", "idle"], ["c2", "idle"]]);
  const paseo = {
    agents: {
      async list() { return { entries: [...state].map(([id, st]) => ({ agent: { id, provider: "codex", status: st, activeTurn: null } })), pageInfo: { hasMore: false, nextCursor: null } }; },
      ref: (id: string) => ({ reload: async () => void (calls.push(`reload:${id}`), state.set(id, "idle")), send: async (m: string) => void calls.push(`send:${id}:${m}`) }),
    },
  };
  const host = registerHandoff(
    {
      registerSettings: (() => ({ read: async () => ({ status: "ready", revision: "1", values: { reloadCodexAfterAutomaticSwitch: true, restartCodexDaemon: false, idleWaitMinutes: 30, resumeLimitedCodexAgents: true } }), subscribe: () => () => {} })) as never,
      handle: (() => {}) as never,
      addHook: ((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { hooks.set(name, handler); return () => {}; }) as never,
    },
    service,
    { load: async () => null, save: async () => {} },
    60_000,
    { load: async () => null, save: async () => {} },
  );
  const limited = async (id: string, turn = "t1") => {
    const a = { id, provider: "codex", workspaceId: `w-${id}` };
    state.set(id, "running");
    await hooks.get("agent.turn.before")!({ agent: a, turnId: turn }, { paseo });
    state.set(id, "error");
    await hooks.get("agent.turn.after")!({ agent: a, turnId: turn, outcome: { kind: "failed", error: { message: LIMIT } } }, { paseo });
  };
  return { cli, service, host, calls, limited, state, paseo };
}
const codexCalls = (cli: { calls: { argv: string[] }[] }) => cli.calls.map((c) => c.argv).filter((a) => a[0] === "codex" && (a[1] === "usage" || a[1] === "auto"));

test("host: limits refresh the active account with the exact argv, run auto once, and the switch flows through the existing handoff once per agent", async () => {
  const h = await hostHarness();
  await h.host.coordinator.init();
  await sleep(15);
  for (const id of ["c1", "c2"]) await h.limited(id);
  await sleep(150);
  assert.deepEqual(codexCalls(h.cli), [["codex", "usage", B, "--refresh", "--json"], ["codex", "auto", "run-once", "--json"]]);
  // the adopted switch is polled at once (not after the 60 s event poll) and handled by the handoff and the recovery
  await h.host.coordinator.tick(h.host.capture({ paseo: h.paseo }));
  await sleep(80);
  assert.equal(h.calls.filter((c) => c === "reload:c1").length, 1, h.calls.join(","));
  assert.equal(h.calls.filter((c) => c === "reload:c2").length, 1);
  assert.equal(h.calls.filter((c) => c.startsWith("send:c1:")).length, 1);
  assert.equal(h.calls.filter((c) => c.startsWith("send:c2:")).length, 1);
  h.host.cleanup();
});
test("host: automatic switching off in the status means a read only", async () => {
  const h = await hostHarness(false);
  await h.limited("c1");
  await sleep(100);
  assert.deepEqual(codexCalls(h.cli), [["codex", "usage", B, "--refresh", "--json"]]);
  h.host.cleanup();
});
test("host: a rate-limited refresh stops the recheck before run-once", async () => {
  const h = await hostHarness(true, { status: "rate-limited" });
  await h.limited("c1");
  await sleep(100);
  assert.deepEqual(codexCalls(h.cli), [["codex", "usage", B, "--refresh", "--json"]]);
  h.host.cleanup();
});

test("host: a refresh answered from the cache (cached:true) is not trusted as fresh", async () => {
  const h = await hostHarness(true, { status: "ok", cached: true });
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("c1");
    await sleep(120);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => /recheck read provider=codex account=55555555 cached/.test(l)), lines.join("\n"));
  assert.deepEqual(codexCalls(h.cli).map((a) => a[1]), ["usage", "auto"], "run-once still runs, no worse than before");
  h.host.cleanup();
});
