import test from "node:test";
import assert from "node:assert/strict";
import { LimitedAgentRecovery, type LimitRecheck, type RecoveryStore } from "../server/limited-agents.js";
import { registerHandoff } from "../server/handoff-host.js";
import { scripted, ok, refused } from "./settings-fixtures.js";
import { status } from "./fixtures.js";

const LIMIT = "You've hit your usage limit. Upgrade or try again later.";
const failed = { kind: "failed" as const, error: { message: LIMIT } };
const agent = (id: string) => ({ id, workspaceId: "w1", provider: "codex", cwd: "/x", parentAgentId: null, title: null });
const memoryStore = (): RecoveryStore & { saved: unknown } => {
  const s = { saved: null as unknown, load: async () => s.saved, save: async (v: unknown) => void (s.saved = JSON.parse(JSON.stringify(v))) };
  return s;
};
const ACTIVE = "11111111-1111-4111-8111-111111111111";

type Reply = Awaited<ReturnType<LimitRecheck["runOnceObserved"]>>;
function fakeRecheck(reply: Reply = { outcome: "stay", reason: "belowThreshold", limitObserved: "recorded" }) {
  const calls: string[] = [];
  const recheck: LimitRecheck = {
    runOnceObserved: async (id) => { calls.push(`run-once:${id ?? "plain"}`); return reply; },
    onSwitched: () => void calls.push("switched"),
  };
  return { recheck, calls };
}
/**
 * The active account was activated at 500. Agents opened their session at `openedAt` (default 600: after the activation,
 * so on the current login). The clock reads 1000 when a limited turn starts.
 */
async function make(rc: ReturnType<typeof fakeRecheck>, opts: { timeoutMs?: number; recheckTimeoutMs?: number; activatedAt?: number | null; store?: ReturnType<typeof memoryStore> } = {}) {
  const clock = { t: 1000 };
  const logs: string[] = [];
  const store = opts.store ?? memoryStore();
  const activatedAt = opts.activatedAt === undefined ? 500 : opts.activatedAt;
  const accountUsage = async () => ({ id: ACTIVE, activatedAt: activatedAt ?? undefined, windows: [] }) as never;
  const recovery = new LimitedAgentRecovery(store, async () => true, async () => ACTIVE, () => clock.t, opts.timeoutMs ?? 30_000, (l) => void logs.push(l), accountUsage, undefined, rc.recheck, opts.recheckTimeoutMs, 20);
  return { recovery, clock, logs, store };
}
type Ctx = Awaited<ReturnType<typeof make>>;
/** The agent's session opened at `at` (create / resume / reload). */
const openAt = async (r: Ctx, id: string, at: number, reason = "refresh") => {
  const keep = r.clock.t;
  r.clock.t = at;
  await r.recovery.sessionOpened(id, reason);
  r.clock.t = keep;
};
const limitOn = async (r: Ctx, id: string, turn = "t1") => {
  await r.recovery.turnBefore(agent(id), turn);
  await r.recovery.turnAfter(agent(id), turn, failed);
};
const openAndLimit = async (r: Ctx, id: string, openedAt = 600) => {
  await openAt(r, id, openedAt);
  await limitOn(r, id);
};
const has = (r: { logs: string[] }, re: RegExp) => r.logs.some((l) => re.test(l));
const settle = async (r: Ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await r.recovery.recheckIdle();
};

test("five limits in the same second: ONE run-once with --limit-observed for the active account", async () => {
  const rc = fakeRecheck({ outcome: "switched", reason: "thresholdReached", limitObserved: "recorded" });
  const r = await make(rc);
  for (const id of ["a", "b", "c", "d", "e"]) await openAndLimit(r, id);
  await settle(r);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`, "switched"]);
  assert.ok(has(r, /recheck started provider=codex account=11111111/));
  assert.ok(has(r, /recheck run-once limitObserved=recorded reason=none decision=switched reason=thresholdReached/), r.logs.join("\n"));
  assert.equal(r.logs.filter((l) => /recheck skipped reason=already running/.test(l)).length, 1, "the skip is logged once per burst");
});
test("an ignored observation is logged with its reason and the decision still comes from the normal evaluation", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "implausible" });
  const r = await make(rc);
  await openAndLimit(r, "a");
  await settle(r);
  assert.ok(has(r, /recheck run-once limitObserved=ignored reason=implausible decision=stay reason=belowThreshold/), r.logs.join("\n"));
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
  const r = await make({ recheck, calls });
  await openAndLimit(r, "a");
  await settle(r);
  assert.deepEqual(calls, [`run-once:${ACTIVE}`, "run-once:plain"], "exactly one fallback");
  assert.ok(has(r, /recheck limitObserved=unsupported \(invalidInput\), fell back to plain run-once decision=stay reason=belowThreshold/), r.logs.join("\n"));
  assert.ok(!has(r, /CLI too old/));
});
test("a second burst inside 60 s starts nothing; after 60 s a new limit rechecks again", async () => {
  const rc = fakeRecheck();
  const r = await make(rc);
  await openAndLimit(r, "a");
  await settle(r);
  const before = rc.calls.length;
  r.clock.t += 30;
  await openAndLimit(r, "b");
  await settle(r);
  assert.equal(rc.calls.length, before, "no second recheck inside 60 s");
  assert.ok(has(r, /recheck skipped reason=within 60 s of the last recheck/));
  r.clock.t += 31;
  await openAndLimit(r, "c");
  await settle(r);
  assert.ok(rc.calls.length > before, "a limit after the window rechecks");
});
test("a stay decision is logged and never retried inside the window", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "recorded" });
  const r = await make(rc);
  await openAndLimit(r, "a");
  await settle(r);
  assert.ok(has(r, /decision=stay reason=belowThreshold/));
  r.clock.t += 10;
  await openAndLimit(r, "b");
  await settle(r);
  assert.equal(rc.calls.filter((c) => c.startsWith("run-once")).length, 1);
});
test("every positive Codex limit starts the recheck, also without a continuation candidate", async () => {
  const off = fakeRecheck();
  const clock = { t: 1000 };
  const recovery = new LimitedAgentRecovery(memoryStore(), async () => false, async () => ACTIVE, () => clock.t, 30_000, () => {}, undefined, undefined, off.recheck, undefined, 20);
  await recovery.turnBefore(agent("a"), "t1");
  await recovery.turnAfter(agent("a"), "t1", failed);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await recovery.recheckIdle();
  assert.equal(off.calls.length, 1);
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
  await openAndLimit(r, "a");
  await settle(r);
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
  await settle(r);
  assert.ok(rc.calls.length > before, "the continuation's limit rechecks as well");
  assert.ok(has(r, /continuation hit a limit again/));
});
test("the run-once step is bounded like the CLI call; a real timeout is logged as timeout", async () => {
  const stuck: LimitRecheck = { runOnceObserved: () => new Promise(() => {}) };
  const logs: string[] = [];
  const clock = { t: 1000 };
  const timed = new LimitedAgentRecovery(memoryStore(), async () => true, async () => ACTIVE, () => clock.t, 20, (l) => void logs.push(l), undefined, undefined, stuck, 30, 5);
  await timed.turnBefore(agent("a"), "t1");
  await timed.turnAfter(agent("a"), "t1", failed);
  await timed.recheckIdle();
  assert.ok(logs.some((l) => /recheck skipped reason=timeout/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /unexpected error/.test(l)));
});

// Attribution: --limit-observed names the CURRENT account. The session-open time of an agent (agent.open.before) says which
// login its Codex app-server runs on: opened after the account was activated = current login.
test("attribution: an agent opened BEFORE the account was activated (old login, mid-turn after a switch) never marks the new account", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold" });
  const r = await make(rc);
  await openAndLimit(r, "old", 400); // activated at 500
  await settle(r);
  assert.deepEqual(rc.calls, ["run-once:plain"], "plain run-once, no flag");
  assert.ok(has(r, /recheck run-once limitObserved=skipped reason=agent not on the current login decision=stay reason=belowThreshold/), r.logs.join("\n"));
});
test("attribution: opened after the activation and before the turn started: flag", async () => {
  const rc = fakeRecheck();
  const r = await make(rc);
  await openAt(r, "ok", 600);
  r.clock.t = 900;
  await r.recovery.turnBefore(agent("ok"), "t1");
  r.clock.t = 1000;
  await r.recovery.turnAfter(agent("ok"), "t1", failed);
  await settle(r);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`]);
});
test("attribution: a reload between the turn ending and the hook (#9) is not evidence for the limited turn: no flag", async () => {
  const rc = fakeRecheck();
  const r = await make(rc);
  await openAt(r, "gap", 400); // the agent's process is from before the activation
  r.clock.t = 900;
  await r.recovery.turnBefore(agent("gap"), "t1"); // the turn starts on the old process
  await openAt(r, "gap", 950); // the handoff reloads it after the turn ended, before the hook runs
  r.clock.t = 1000;
  await r.recovery.turnAfter(agent("gap"), "t1", failed);
  await settle(r);
  assert.deepEqual(rc.calls, ["run-once:plain"]);
  assert.ok(has(r, /limitObserved=skipped reason=agent not on the current login/));
});
test("attribution: unknown (no open record) sends the flag and says the core's plausibility gate applies", async () => {
  const rc = fakeRecheck({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "implausible" });
  const r = await make(rc);
  await limitOn(r, "never-opened");
  await settle(r);
  assert.deepEqual(rc.calls, [`run-once:${ACTIVE}`]);
  assert.ok(has(r, /recheck attribution unknown, sent \(core plausibility gate applies\)/), r.logs.join("\n"));
});
test("attribution: unknown turn start, or no activation time, is unknown and sends the flag", async () => {
  const noTurn = fakeRecheck();
  const a = await make(noTurn);
  await openAt(a, "x", 600);
  await a.recovery.turnAfter(agent("x"), "t9", failed); // the plugin never saw this turn start (restarted mid-turn)
  await settle(a);
  assert.deepEqual(noTurn.calls, [`run-once:${ACTIVE}`]);
  const noRef = fakeRecheck();
  const b = await make(noRef, { activatedAt: null });
  await openAndLimit(b, "y", 100);
  await settle(b);
  assert.deepEqual(noRef.calls, [`run-once:${ACTIVE}`], "no activation time to compare with");
  assert.ok(has(b, /attribution unknown, sent/));
});
test("attribution: open times survive a plugin restart and are pruned with the agent", async () => {
  const store = memoryStore();
  const first = await make(fakeRecheck(), { store });
  await openAt(first, "old", 400);
  await openAt(first, "kept", 600);
  await first.recovery.archived("kept");
  const rc = fakeRecheck();
  const second = await make(rc, { store }); // a new plugin process over the same state file
  await limitOn(second, "old");
  await settle(second);
  assert.deepEqual(rc.calls, ["run-once:plain"], "the old agent is still known to be old");
  const rc2 = fakeRecheck();
  const third = await make(rc2, { store });
  second.clock.t += 0;
  await limitOn(third, "kept");
  await settle(third);
  assert.ok(has(third, /attribution unknown, sent/), "an archived agent's open record is gone");
});
test("attribution: in a mixed burst one attributed or unknown agent is enough; known-old agents never count", async () => {
  for (const [label, setup, expectFlag] of [
    ["old + current", async (r: Ctx) => { await openAndLimit(r, "o", 400); await openAndLimit(r, "c", 600); }, true],
    ["current + old", async (r: Ctx) => { await openAndLimit(r, "c", 600); await openAndLimit(r, "o", 400); }, true],
    ["old + unknown", async (r: Ctx) => { await openAndLimit(r, "o", 400); await limitOn(r, "u"); }, true],
    ["old + old", async (r: Ctx) => { await openAndLimit(r, "o1", 400); await openAndLimit(r, "o2", 300); }, false],
  ] as const) {
    const rc = fakeRecheck();
    const r = await make(rc);
    await setup(r);
    await settle(r);
    assert.deepEqual(rc.calls, [expectFlag ? `run-once:${ACTIVE}` : "run-once:plain"], label);
  }
});

// Service and host level: real argv through the trusted CLI port, and the adopted switch flows into the existing handoff.
const A = "11111111-1111-4111-8111-111111111111";
const B = "55555555-5555-4555-8555-555555555555";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hostHarness(runOnceReply: Record<string, unknown> | "old" = { outcome: "switched", reason: "thresholdReached", limitObserved: "recorded", switch: { postSwitchVerification: "verified" } }) {
  const { cli, service } = scripted();
  const base = status.providers[0]!.accounts[0]!;
  const active = { v: B };
  const activated = { at: Date.now() / 1000 - 1000 };
  cli.on(["status"], () => ok({
    ...status,
    providers: [{ ...status.providers[0], provider: "codex", accounts: [
      { ...base, id: B, alias: "Old", active: active.v === B, windows: [], activatedAt: activated.at },
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
  /** Paseo opens the agent's session (create / resume / reload): the plugin records when. */
  const opened = (id: string, reason = "refresh") => hooks.get("agent.open.before")!({ request: { agentId: id, provider: "codex", reason } }, { paseo });
  const limited = async (id: string, turn = "t1") => {
    const a = { id, provider: "codex", workspaceId: `w-${id}` };
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
  return { cli, service, host, calls, limited, state, paseo, adoptInitial, opened, activated };
}
const codexCalls = (cli: { calls: { argv: string[] }[] }) => cli.calls.map((c) => c.argv).filter((a) => a[0] === "codex" && (a[1] === "usage" || a[1] === "auto"));

test("host: a limit makes ONE call 'codex auto run-once --limit-observed <active> --json'; the switch flows through the existing handoff once per agent", async () => {
  const h = await hostHarness();
  await h.adoptInitial();
  h.calls.length = 0;
  for (const id of ["c1", "c2"]) await h.opened(id);
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
  await h.opened("c1");
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
  await h.opened("c1");
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

test("host: an agent opened before the account was activated (still on the old login) hits the limit: plain run-once, the new account is not reported", async () => {
  const h = await hostHarness({ outcome: "stay", reason: "belowThreshold" });
  await h.adoptInitial();
  h.activated.at = Date.now() / 1000 + 1000; // the account was activated after the agent's session opened
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.opened("old");
    await h.limited("old");
    await sleep(400);
  } finally {
    console.log = original;
  }
  assert.deepEqual(codexCalls(h.cli), [["codex", "auto", "run-once", "--json"]], "no --limit-observed");
  assert.ok(lines.some((l) => /limitObserved=skipped reason=agent not on the current login/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /session opened agent=old reason=refresh/.test(l)), "the open is logged so the owner can confirm the hook fires");
  h.host.cleanup();
});
test("host: an agent whose session open was never seen (unknown) reports the limit; the core's plausibility gate applies", async () => {
  const h = await hostHarness({ outcome: "stay", reason: "belowThreshold", limitObserved: "ignored", limitObservedReason: "implausible" });
  await h.adoptInitial();
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    await h.limited("never-opened");
    await sleep(400);
  } finally {
    console.log = original;
  }
  assert.deepEqual(codexCalls(h.cli), [["codex", "auto", "run-once", "--limit-observed", B, "--json"]]);
  assert.ok(lines.some((l) => /attribution unknown, sent \(core plausibility gate applies\)/.test(l)), lines.join("\n"));
  h.host.cleanup();
});
