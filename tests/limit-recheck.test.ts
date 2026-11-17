import test from "node:test";
import assert from "node:assert/strict";
import { LimitedAgentRecovery, type LimitRecheck, type RecoveryStore } from "../server/limited-agents.js";
import { registerHandoff } from "../server/handoff-host.js";
import { scripted, ok, refused } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

const LIMIT = "You've hit your usage limit. Upgrade or try again later.";
const failed = { kind: "failed" as const, error: { message: LIMIT } };
const agent = (id: string) => ({ id, workspaceId: "w1", provider: "codex", cwd: "/x", parentAgentId: null, title: null });
const memoryStore = (): RecoveryStore => {
  const s = { saved: null as unknown, load: async () => s.saved, save: async (v: unknown) => void (s.saved = JSON.parse(JSON.stringify(v))) };
  return s;
};
const ACTIVE = "11111111-1111-4111-8111-111111111111";

type Reply = Awaited<ReturnType<LimitRecheck["runOnceObserved"]>>;
function fakeRecheck(reply: Reply = { outcome: "stay", reason: "belowThreshold", limitObserved: "recorded" }) {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const recheck: LimitRecheck = {
    runOnceObserved: async (id) => { calls.push(`run-once:${id}`); await new Promise<void>((r) => (release = r)); return reply; },
    onSwitched: () => void calls.push("switched"),
  };
  return { recheck, calls, finish: () => release?.() };
}
function make(rc: ReturnType<typeof fakeRecheck>, timeoutMs = 30_000, recheckTimeoutMs?: number) {
  const clock = { t: 1000 };
  const logs: string[] = [];
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, timeoutMs, (l) => void logs.push(l), undefined, undefined, rc.recheck, recheckTimeoutMs);
  return { recovery, clock, logs };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const limitOn = async (r: ReturnType<typeof make>, id: string, turn = "t1") => {
  await r.recovery.turnBefore(agent(id), turn);
  await r.recovery.turnAfter(agent(id), turn, failed);
};
const has = (r: { logs: string[] }, re: RegExp) => r.logs.some((l) => re.test(l));
const settle = async (r: ReturnType<typeof make>, rc: ReturnType<typeof fakeRecheck>) => {
  await tick();
  rc.finish();
  await r.recovery.recheckIdle();
};

test("five limits in the same second: ONE run-once with --limit-observed for the active account", async () => {
  const rc = fakeRecheck({ outcome: "switched", reason: "thresholdReached", limitObserved: "recorded" });
  const r = make(rc);
  for (const id of ["a", "b", "c", "d", "e"]) await limitOn(r, id);
  await settle(r, rc);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`, "switched"]);
  assert.ok(has(r, /recheck started provider=codex account=11111111/));
  assert.ok(has(r, /recheck run-once limitObserved=recorded reason=none decision=switched reason=thresholdReached/), r.logs.join("\n"));
  assert.equal(r.logs.filter((l) => /recheck skipped reason=already running/.test(l)).length, 1, "the skip is logged once per burst");
});
test("an ignored observation is logged with its reason and the decision still comes from the normal evaluation", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "autoOff" });
  const r = make(rc);
  await limitOn(r, "a");
  await settle(r, rc);
  assert.ok(has(r, /recheck run-once limitObserved=ignored reason=autoOff decision=stay reason=belowThreshold/), r.logs.join("\n"));
  assert.ok(!rc.calls.includes("switched"));
});
test("an older CLI without the flag: 'CLI too old' and nothing else", async () => {
  const rc = fakeRecheck({ outcome: "invalidInput" });
  const r = make(rc);
  await limitOn(r, "a");
  await settle(r, rc);
  assert.ok(has(r, /recheck skipped reason=CLI too old/), r.logs.join("\n"));
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`]);
});
test("a second burst inside 60 s starts nothing; after 60 s a new limit rechecks again", async () => {
  const rc = fakeRecheck();
  const r = make(rc);
  await limitOn(r, "a");
  await settle(r, rc);
  const before = rc.calls.length;
  r.clock.t += 30;
  await limitOn(r, "b");
  await r.recovery.recheckIdle();
  assert.equal(rc.calls.length, before, "no second recheck inside 60 s");
  assert.ok(has(r, /recheck skipped reason=within 60 s of the last recheck/));
  r.clock.t += 31;
  await limitOn(r, "c");
  await settle(r, rc);
  assert.ok(rc.calls.length > before, "a limit after the window rechecks");
});
test("a stay decision is logged and never retried inside the window", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "recorded" });
  const r = make(rc);
  await limitOn(r, "a");
  await settle(r, rc);
  assert.ok(has(r, /decision=stay reason=belowThreshold/));
  r.clock.t += 10;
  await limitOn(r, "b");
  await r.recovery.recheckIdle();
  assert.equal(rc.calls.filter((c) => c.startsWith("run-once")).length, 1);
});
test("every positive Codex limit starts the recheck, also without a continuation candidate", async () => {
  const off = fakeRecheck();
  const clock = { t: 1000 };
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => false, async () => ACTIVE, () => clock.t, 30_000, () => {}, undefined, undefined, off.recheck);
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await tick();
  off.finish();
  await recovery.recheckIdle();
  assert.deepEqual(off.calls, [`run-once:${ACTIVE}`]);
  const rc = fakeRecheck();
  const r = make(rc);
  await r.recovery.turnBefore(agent("b"), null);
  await r.recovery.turnAfter(agent("b"), null, failed);
  await settle(r, rc);
  assert.ok(rc.calls.some((c) => c.startsWith("run-once")), "a limit without a turn id still rechecks");
  const quiet = fakeRecheck();
  const q = make(quiet);
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
  const r = make(rc);
  await limitOn(r, "a");
  await settle(r, rc);
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
  await r.recovery.turnBefore(agent("a"), "t2");
  await r.recovery.turnAfter(agent("a"), "t2", failed);
  await settle(r, rc);
  assert.ok(rc.calls.length > before, "the continuation's limit rechecks as well");
  assert.ok(has(r, /continuation hit a limit again/));
});
test("the run-once step is bounded like the CLI call; a real timeout is logged as timeout", async () => {
  const slow = fakeRecheck();
  const s = make(slow, 20);
  await limitOn(s, "a");
  await new Promise((resolve) => setTimeout(resolve, 60));
  slow.finish();
  await s.recovery.recheckIdle();
  assert.ok(has(s, /decision=stay/), "not cut off by the short per-call timeout");
  const stuck: LimitRecheck = { runOnceObserved: () => new Promise(() => {}) };
  const logs: string[] = [];
  const clock = { t: 1000 };
  const timed = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 20, (l) => void logs.push(l), undefined, undefined, stuck, 30);
  await timed.turnBefore(agent("a"), "t1");
  await timed.turnAfter(agent("a"), "t1", failed);
  await timed.recheckIdle();
  assert.ok(logs.some((l) => /recheck skipped reason=timeout/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /unexpected error/.test(l)));
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
  cli.on(["codex", "auto", "run-once"], () => {
    if (runOnceReply === "old") return refused("invalidInput");
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

test("host: a limit makes ONE call 'codex auto run-once --limit-observed <active> --json'; the switch flows through the existing handoff once per agent", async () => {
  const h = await hostHarness();
  await h.host.coordinator.init();
  await sleep(15);
  for (const id of ["c1", "c2"]) await h.limited(id);
  await sleep(150);
  assert.deepEqual(codexCalls(h.cli), [["codex", "auto", "run-once", "--limit-observed", B, "--json"]], "no usage refresh, no extra issuer request");
  await h.host.coordinator.tick(h.host.capture({ paseo: h.paseo }));
  await sleep(80);
  for (const id of ["c1", "c2"]) {
    assert.equal(h.calls.filter((c) => c === `reload:${id}`).length, 1, h.calls.join(","));
    assert.equal(h.calls.filter((c) => c.startsWith(`send:${id}:`)).length, 1);
  }
  h.host.cleanup();
});
test("host: an older CLI without the flag (invalidInput) logs 'CLI too old' and does nothing else", async () => {
  const h = await hostHarness("old");
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("c1");
    await sleep(120);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => /recheck skipped reason=CLI too old/.test(l)), lines.join("\n"));
  assert.deepEqual(codexCalls(h.cli), [["codex", "auto", "run-once", "--limit-observed", B, "--json"]]);
  h.host.cleanup();
});
test("host: recorded and ignored answers are logged and a stay does not trigger the handoff", async () => {
  const h = await hostHarness({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "autoOff" });
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("c1");
    await sleep(120);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((l) => /recheck run-once limitObserved=ignored reason=autoOff decision=stay reason=belowThreshold/.test(l)), lines.join("\n"));
  assert.equal(h.calls.filter((c) => c.startsWith("reload")).length, 0);
  h.host.cleanup();
});
