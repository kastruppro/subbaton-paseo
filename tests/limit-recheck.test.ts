import test from "node:test";
import assert from "node:assert/strict";
import { LimitedAgentRecovery, type LimitRecheck, type RecoveryStore } from "../server/limited-agents.js";
import { ReloadLedger } from "../server/reload-ledger.js";
import { registerHandoff } from "../server/handoff-host.js";
import { scripted, ok, refused } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

const LIMIT = "You've hit your usage limit. Upgrade or try again later.";
const failed = { kind: "failed" as const, error: { message: LIMIT } };
const agent = (id: string, createdAt?: string) => ({ id, workspaceId: "w1", provider: "codex", cwd: "/x", parentAgentId: null, title: null, ...(createdAt ? { createdAt } : {}) });
const memoryStore = (): RecoveryStore => {
  const s = { saved: null as unknown, load: async () => s.saved, save: async (v: unknown) => void (s.saved = JSON.parse(JSON.stringify(v))) };
  return s;
};
const ACTIVE = "11111111-1111-4111-8111-111111111111";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

type Reply = Awaited<ReturnType<LimitRecheck["runOnceObserved"]>>;
function fakeRecheck(reply: Reply = { outcome: "stay", reason: "belowThreshold", limitObserved: "recorded" }) {
  const calls: string[] = [];
  const recheck: LimitRecheck = {
    runOnceObserved: async (id) => { calls.push(`run-once:${id ?? "plain"}`); return reply; },
    onSwitched: () => void calls.push("switched"),
  };
  return { recheck, calls };
}
/** A ledger that says every agent was reloaded for the current switch (the common attributed case). */
class AllReloaded extends ReloadLedger {
  override state() { return "done" as const; }
}
/** `attribute: false` models agents the plugin has no reload record for. The recovery has adopted one switch at 1000. */
async function make(rc: ReturnType<typeof fakeRecheck>, opts: { timeoutMs?: number; recheckTimeoutMs?: number; attribute?: boolean; adopt?: boolean } = {}) {
  const clock = { t: 1000 };
  const logs: string[] = [];
  const ledger = opts.attribute === false ? new ReloadLedger() : new AllReloaded();
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, opts.timeoutMs ?? 30_000, (l) => void logs.push(l), undefined, ledger, rc.recheck, opts.recheckTimeoutMs, 20);
  if (opts.adopt !== false) await recovery.adopt("txn:0", ACTIVE);
  return { recovery, clock, logs, ledger };
}
const limitOn = async (r: { recovery: LimitedAgentRecovery }, id: string, turn = "t1", createdAt?: string) => {
  await r.recovery.turnBefore(agent(id, createdAt), turn);
  await r.recovery.turnAfter(agent(id, createdAt), turn, failed);
};
const has = (r: { logs: string[] }, re: RegExp) => r.logs.some((l) => re.test(l));
const settle = async (r: { recovery: LimitedAgentRecovery }) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await r.recovery.recheckIdle();
};

test("five limits in the same second: ONE run-once with --limit-observed for the active account", async () => {
  const rc = fakeRecheck({ outcome: "switched", reason: "thresholdReached", limitObserved: "recorded" });
  const r = await make(rc);
  for (const id of ["a", "b", "c", "d", "e"]) await limitOn(r, id);
  await settle(r);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`, "switched"]);
  assert.ok(has(r, /recheck started provider=codex account=11111111/));
  assert.ok(has(r, /recheck run-once limitObserved=recorded reason=none decision=switched reason=thresholdReached/), r.logs.join("\n"));
  assert.equal(r.logs.filter((l) => /recheck skipped reason=already running/.test(l)).length, 1, "the skip is logged once per burst");
});
test("an ignored observation is logged with its reason and the decision still comes from the normal evaluation", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "autoOff" });
  const r = await make(rc);
  await limitOn(r, "a");
  await settle(r);
  assert.ok(has(r, /recheck run-once limitObserved=ignored reason=autoOff decision=stay reason=belowThreshold/), r.logs.join("\n"));
  assert.ok(!rc.calls.includes("switched"));
});
test("an older CLI without the flag (invalidInput): fall back ONCE to a plain run-once and say so", async () => {
  const calls: string[] = [];
  const recheck: LimitRecheck = {
    runOnceObserved: async (id) => {
      calls.push(`run-once:${id ?? "plain"}`);
      return id ? { outcome: "invalidInput" } : { outcome: "stay", reason: "belowThreshold" };
    },
  };
  const clock = { t: 1000 };
  const logs: string[] = [];
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 30_000, (l) => void logs.push(l), undefined, new AllReloaded(), recheck, undefined, 5);
  await recovery.adopt("txn:0", ACTIVE);
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recovery.recheckIdle();
  assert.deepEqual(calls, [`run-once:${ACTIVE}`, "run-once:plain"], "exactly one fallback");
  assert.ok(logs.some((l) => /recheck limitObserved=unsupported \(invalidInput\), fell back to plain run-once decision=stay reason=belowThreshold/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /CLI too old/.test(l)));
});
test("a second burst inside 60 s starts nothing; after 60 s a new limit rechecks again", async () => {
  const rc = fakeRecheck();
  const r = await make(rc);
  await limitOn(r, "a");
  await settle(r);
  const before = rc.calls.length;
  r.clock.t += 30;
  await limitOn(r, "b");
  await settle(r);
  assert.equal(rc.calls.length, before, "no second recheck inside 60 s");
  assert.ok(has(r, /recheck skipped reason=within 60 s of the last recheck/));
  r.clock.t += 31;
  await limitOn(r, "c");
  await settle(r);
  assert.ok(rc.calls.length > before, "a limit after the window rechecks");
});
test("a stay decision is logged and never retried inside the window", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "recorded" });
  const r = await make(rc);
  await limitOn(r, "a");
  await settle(r);
  assert.ok(has(r, /decision=stay reason=belowThreshold/));
  r.clock.t += 10;
  await limitOn(r, "b");
  await settle(r);
  assert.equal(rc.calls.filter((c) => c.startsWith("run-once")).length, 1);
});
test("every positive Codex limit starts the recheck, also without a continuation candidate", async () => {
  const off = fakeRecheck();
  const clock = { t: 1000 };
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => false, async () => ACTIVE, () => clock.t, 30_000, () => {}, undefined, new AllReloaded(), off.recheck, undefined, 20);
  await recovery.adopt("txn:0", ACTIVE);
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recovery.recheckIdle();
  assert.deepEqual(off.calls, [`run-once:${ACTIVE}`]);
  const rc = fakeRecheck();
  const r = await make(rc);
  await r.recovery.turnBefore(agent("b"), null);
  await r.recovery.turnAfter(agent("b"), null, failed);
  await settle(r);
  assert.ok(rc.calls.some((c) => c.startsWith("run-once")), "a limit without a turn id still rechecks");
  const quiet = fakeRecheck();
  const q = await make(quiet);
  await q.recovery.turnBefore(agent("c"), "t1");
  await q.recovery.turnAfter(agent("c"), "t1", { kind: "failed", error: { message: "Network unreachable" } });
  await q.recovery.turnAfter(agent("c"), "t2", { kind: "completed" });
  await q.recovery.recheckIdle();
  assert.deepEqual(quiet.calls, []);
  const bare = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 30_000, () => {});
  await bare.turnBefore(agent("a"), "t1");
  await bare.turnAfter(agent("a"), "t1", failed);
  await bare.recheckIdle();
});
test("a continuation that hits a limit again also rechecks", async () => {
  const rc = fakeRecheck();
  const r = await make(rc);
  await limitOn(r, "a");
  await settle(r);
  const before = rc.calls.length;
  r.clock.t += 120;
  await r.recovery.adopt("txn:1", ACTIVE);
  let st = "idle"; // already reloaded for the switch (the ledger says so)
  const fake = {
    list: async () => [{ id: "a", provider: "codex", status: st, activeTurn: false }],
    reload: async () => void (st = "idle"),
    send: async () => {},
  };
  await r.recovery.run(fake as never);
  r.clock.t += 120;
  await r.recovery.turnBefore(agent("a"), "t2");
  await r.recovery.turnAfter(agent("a"), "t2", failed);
  await settle(r);
  assert.ok(rc.calls.length > before, "the continuation's limit rechecks as well");
  assert.ok(has(r, /continuation hit a limit again/));
});
test("the run-once step is bounded like the CLI call; a real timeout is logged as timeout", async () => {
  const stuck: LimitRecheck = { runOnceObserved: () => new Promise(() => {}) };
  const logs: string[] = [];
  const clock = { t: 1000 };
  const timed = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 20, (l) => void logs.push(l), undefined, new AllReloaded(), stuck, 30, 5);
  await timed.adopt("txn:0", ACTIVE);
  await timed.turnBefore(agent("a"), "t1");
  await timed.turnAfter(agent("a"), "t1", failed);
  await timed.recheckIdle();
  assert.ok(logs.some((l) => /recheck skipped reason=timeout/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /unexpected error/.test(l)));
});

// Attribution: --limit-observed names the CURRENT account, so only an agent that provably runs on the current login may report it.
test("attribution: an agent still on the old login after a switch (mid-turn) never marks the new account", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold" });
  const r = await make(rc, { attribute: false });
  await limitOn(r, "old", "t1", iso(500)); // created before the switch at 1000, never reloaded for it
  await settle(r);
  assert.deepEqual(rc.calls, ["run-once:plain"], "plain run-once, no flag");
  assert.ok(has(r, /recheck run-once limitObserved=skipped reason=agent not on the current login decision=stay reason=belowThreshold/), r.logs.join("\n"));
});
test("attribution: an agent reloaded for the current switch reports the limit", async () => {
  const rc = fakeRecheck();
  const r = await make(rc, { attribute: false });
  r.ledger.claim("txn:0", "reloaded");
  r.ledger.finish("txn:0", "reloaded", true);
  await limitOn(r, "reloaded", "t1", iso(500));
  await settle(r);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`]);
});
test("attribution: a reload that failed or is still running does not count", async () => {
  for (const finish of [false, null] as const) {
    const rc = fakeRecheck();
    const r = await make(rc, { attribute: false });
    r.ledger.claim("txn:0", "x");
    if (finish !== null) r.ledger.finish("txn:0", "x", finish);
    await limitOn(r, "x", "t1", iso(500));
    await settle(r);
    assert.deepEqual(rc.calls, ["run-once:plain"], String(finish));
  }
});
test("attribution: an agent created after the switch reports the limit", async () => {
  const rc = fakeRecheck();
  const r = await make(rc, { attribute: false });
  await limitOn(r, "new", "t1", iso(1200));
  await settle(r);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`]);
});
test("attribution: unknown (no creation time, no reload record, or no adopted switch) sends no flag and says so", async () => {
  const noInfo = fakeRecheck();
  const a = await make(noInfo, { attribute: false });
  await limitOn(a, "unknown");
  await settle(a);
  assert.deepEqual(noInfo.calls, ["run-once:plain"]);
  assert.ok(has(a, /limitObserved=skipped reason=attribution unknown/), a.logs.join("\n"));
  const noSwitch = fakeRecheck();
  const b = await make(noSwitch, { adopt: false });
  await limitOn(b, "any", "t1", iso(2000));
  await settle(b);
  assert.deepEqual(noSwitch.calls, ["run-once:plain"], "no switch record: nothing proves the agent is on the current login");
  assert.ok(has(b, /limitObserved=skipped reason=attribution unknown/));
});
test("attribution: a login that changed since the adopted switch is not attributed", async () => {
  const rc = fakeRecheck();
  const clock = { t: 1000 };
  const logs: string[] = [];
  let current = ACTIVE;
  const ledger = new AllReloaded();
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => true, async () => current, () => clock.t, 30_000, (l) => void logs.push(l), undefined, ledger, rc.recheck, undefined, 5);
  await recovery.adopt("txn:0", ACTIVE);
  current = "22222222-2222-4222-8222-222222222222"; // a newer switch the plugin has not adopted yet
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recovery.recheckIdle();
  assert.deepEqual(rc.calls, ["run-once:plain"]);
});
test("attribution: in a mixed burst one attributed agent is enough to send the flag", async () => {
  for (const order of [["old", "reloaded"], ["reloaded", "old"]]) {
    const rc = fakeRecheck();
    const r = await make(rc, { attribute: false });
    r.ledger.claim("txn:0", "reloaded");
    r.ledger.finish("txn:0", "reloaded", true);
    for (const id of order) await limitOn(r, id, "t1", iso(500));
    await settle(r);
    assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`], order.join());
  }
  const none = fakeRecheck();
  const r = await make(none, { attribute: false });
  for (const id of ["o1", "o2", "o3"]) await limitOn(r, id, "t1", iso(500));
  await settle(r);
  assert.deepEqual(none.calls, ["run-once:plain"], "only unattributed agents: no flag");
});

// Service and host level: real argv through the trusted CLI port, and the adopted switch flows into the existing handoff.
const A = "11111111-1111-4111-8111-111111111111";
const B = "55555555-5555-4555-8555-555555555555";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hostHarness(runOnceReply: Record<string, unknown> | "old" = { outcome: "switched", reason: "thresholdReached", limitObserved: "recorded", switch: { postSwitchVerification: "verified" } }) {
  const { cli, service } = scripted();
  const base = status.providers[0]!.accounts[0]!;
  const active = { v: B };
  cli.on(["status"], () => ok({
    ...status,
    providers: [{ ...status.providers[0], provider: "codex", accounts: [
      { ...base, id: B, alias: "Old", active: active.v === B, windows: [] },
      { ...base, id: A, alias: "New", active: active.v === A, windows: [] },
    ] }],
  }));
  await service.status();
  let events: unknown[] = [];
  cli.on(["events"], () => ok({ events }));
  cli.on(["codex", "auto", "run-once"], (argv) => {
    if (runOnceReply === "old" && argv.includes("--limit-observed")) return refused("invalidInput");
    if (runOnceReply === "old") return ok({ outcome: "stay", reason: "belowThreshold" });
    if (runOnceReply.outcome === "switched") {
      active.v = A;
      events = [{ id: "ev1", at: Date.now() / 1000 + 1, provider: "codex", kind: "automaticSwitch", target: A, transaction: "T9" }];
    }
    return ok(runOnceReply);
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
  const limited = async (id: string, turn = "t1", createdAt?: string) => {
    const a = { id, provider: "codex", workspaceId: `w-${id}`, ...(createdAt ? { createdAt } : {}) };
    state.set(id, "running");
    await hooks.get("agent.turn.before")!({ agent: a, turnId: turn }, { paseo });
    state.set(id, "error");
    await hooks.get("agent.turn.after")!({ agent: a, turnId: turn, outcome: { kind: "failed", error: { message: LIMIT } } }, { paseo });
  };
  /** The poller (or the app) switched to the account that is active now: the handoff adopts it and reloads the idle agents. */
  const adoptInitial = async () => {
    await host.coordinator.init();
    await sleep(15);
    events = [{ id: "ev0", at: Date.now() / 1000, provider: "codex", kind: "automaticSwitch", target: B, transaction: "T0" }];
    await sleep(5);
    await host.coordinator.tick(host.capture({ paseo }));
    await sleep(100);
  };
  return { cli, service, host, calls, limited, state, paseo, adoptInitial };
}
const codexCalls = (cli: { calls: { argv: string[] }[] }) => cli.calls.map((c) => c.argv).filter((a) => a[0] === "codex" && (a[1] === "usage" || a[1] === "auto"));

test("host: a limit makes ONE call 'codex auto run-once --limit-observed <active> --json'; the switch flows through the existing handoff once per agent", async () => {
  const h = await hostHarness();
  await h.adoptInitial();
  h.calls.length = 0;
  for (const id of ["c1", "c2"]) await h.limited(id);
  await sleep(300);
  assert.deepEqual(codexCalls(h.cli), [["codex", "auto", "run-once", "--limit-observed", B, "--json"]], "no usage refresh, no extra issuer request");
  await h.host.coordinator.tick(h.host.capture({ paseo: h.paseo }));
  await sleep(80);
  for (const id of ["c1", "c2"]) {
    assert.equal(h.calls.filter((c) => c === `reload:${id}`).length, 1, h.calls.join(","));
    assert.equal(h.calls.filter((c) => c.startsWith(`send:${id}:`)).length, 1);
  }
  h.host.cleanup();
});
test("host: an older CLI without the flag falls back to one plain run-once, no 'CLI too old'", async () => {
  const h = await hostHarness("old");
  await h.adoptInitial();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("c1");
    await sleep(500);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => /recheck limitObserved=unsupported \(invalidInput\), fell back to plain run-once decision=stay reason=belowThreshold/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /CLI too old/.test(l)));
  h.host.cleanup();
});
test("host: recorded and ignored answers are logged and a stay does not trigger the handoff", async () => {
  const h = await hostHarness({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "autoOff" });
  await h.adoptInitial();
  h.calls.length = 0;
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("c1");
    await sleep(400);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => /recheck run-once limitObserved=ignored reason=autoOff decision=stay reason=belowThreshold/.test(l)), lines.join("\n"));
  assert.equal(h.calls.filter((c) => c.startsWith("reload")).length, 0);
  h.host.cleanup();
});

test("host: after a switch an agent that was running (not reloaded) hits the limit: plain run-once, the new account is not reported", async () => {
  const h = await hostHarness({ outcome: "stay", reason: "belowThreshold" });
  h.state.set("old", "running");
  await h.adoptInitial(); // c1 and c2 are reloaded, "old" keeps running on the previous login
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("old", "t1", new Date(Date.now() - 3_600_000).toISOString());
    await sleep(400);
  } finally {
    console.log = original;
  }
  assert.deepEqual(codexCalls(h.cli), [["codex", "auto", "run-once", "--json"]], "no --limit-observed");
  assert.ok(lines.some((l) => /limitObserved=skipped reason=agent not on the current login/.test(l)), lines.join("\n"));
  h.host.cleanup();
});
