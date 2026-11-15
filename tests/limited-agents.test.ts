import test from "node:test";
import assert from "node:assert/strict";
import {
  LimitedAgentRecovery,
  continuationText,
  isLimitFailure,
  paidEligible,
  type RecoveryStore,
} from "../server/limited-agents.js";
import type { AgentPort, AgentSnapshot } from "../server/handoff.js";

const LIMIT = "You've hit your usage limit. Upgrade or try again later.";
const failed = (message = LIMIT, code?: string) => ({ kind: "failed" as const, error: { message, ...(code ? { code } : {}) } });
const codexAgent = (id: string, workspaceId: string | null = "w1") => ({ id, workspaceId, provider: "codex", cwd: "/x", parentAgentId: null, title: null });

class Fake implements AgentPort {
  agents = new Map<string, AgentSnapshot>();
  calls: string[] = [];
  reloadFails = new Set<string>();
  onReload: ((id: string) => void) | null = null;
  async list() { return [...this.agents.values()]; }
  async reload(id: string) {
    this.calls.push(`reload:${id}`);
    this.onReload?.(id);
    if (this.reloadFails.has(id)) throw new Error("reload failed");
    const a = this.agents.get(id);
    if (a) this.agents.set(id, { ...a, status: "idle", activeTurn: false });
  }
  async send(id: string, text: string) { this.calls.push(`send:${id}:${text}`); }
  add(id: string, patch: Partial<AgentSnapshot> = {}) {
    this.agents.set(id, { id, provider: "codex", status: "error", activeTurn: false, ...patch });
  }
  sends() { return this.calls.filter((c) => c.startsWith("send:")); }
}
const memoryStore = (): RecoveryStore & { saved: unknown } => {
  const s = { saved: null as unknown, load: async () => s.saved, save: async (v: unknown) => void (s.saved = JSON.parse(JSON.stringify(v))) };
  return s;
};
type Usage = { v: unknown };
function make(opts: { store?: RecoveryStore; resume?: { v: boolean }; account?: { v: string | null }; clock?: { t: number }; usage?: Usage } = {}) {
  const store = opts.store ?? memoryStore();
  const resume = opts.resume ?? { v: true };
  const account = opts.account ?? { v: "acct-A" };
  const clock = opts.clock ?? { t: 1000 };
  const logs: string[] = [];
  const recovery = new LimitedAgentRecovery(store, async () => resume.v, async () => account.v, () => clock.t, 30_000, (line) => void logs.push(line), opts.usage ? async () => opts.usage!.v as never : undefined);
  return { recovery, store, resume, account, clock, logs };
}
/** A limited turn ends for `id`, then the switch is adopted. */
async function limit(r: ReturnType<typeof make>, id: string, turn = "t1", workspaceId = "w1") {
  await r.recovery.turnBefore(codexAgent(id, workspaceId), turn);
  await r.recovery.turnAfter(codexAgent(id, workspaceId), turn, failed());
  r.clock.t += 10;
}
const adopt = async (r: ReturnType<typeof make>, key = "txn:1") => {
  r.clock.t += 1;
  await r.recovery.adopt(key, r.account.v as string);
};

test("limit detection: structured code or an anchored terminal message only", () => {
  assert.equal(isLimitFailure(failed()), true);
  assert.equal(isLimitFailure(failed("You’ve hit your usage limit.")), true);
  assert.equal(isLimitFailure(failed("whatever", "usage_limit_reached")), true);
  assert.equal(isLimitFailure(failed('Error: the user wrote "You\'ve hit your usage limit." in a file')), false);
  assert.equal(isLimitFailure(failed("Network unreachable")), false);
  assert.equal(isLimitFailure({ kind: "completed" }), false);
  assert.equal(isLimitFailure({ kind: "canceled", reason: "user" }), false);
});

test("a real limit turn is continued exactly once after adoption, in any workspace", async () => {
  const r = make(), port = new Fake();
  port.add("a", {}); port.add("b", {});
  await limit(r, "a", "t1", "w1");
  await limit(r, "b", "t9", "w2");
  await adopt(r);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, ["reload:a", `send:a:${continuationText}`, "reload:b", `send:b:${continuationText}`]);
  await r.recovery.run(port);
  await adopt(r, "txn:1");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 2);
});

test("quotes, completed turns, other failures and other providers never become candidates", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed('He said "You\'ve hit your usage limit."'));
  await r.recovery.turnBefore({ ...codexAgent("c"), provider: "claude" }, "t1");
  await r.recovery.turnAfter({ ...codexAgent("c"), provider: "claude" }, "t1", failed());
  await r.recovery.turnAfter(codexAgent("d"), "t1", { kind: "completed" });
  await adopt(r);
  port.add("c", { provider: "claude" });
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

test("a limit without a turn ID is ambiguous and ineligible", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await r.recovery.turnAfter(codexAgent("a"), null, failed());
  await adopt(r);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

test("a newer turn, a cancellation, an archive or user activity invalidates the candidate", async () => {
  for (const invalidate of [
    (r: ReturnType<typeof make>) => r.recovery.turnBefore(codexAgent("a"), "t2"),
    (r: ReturnType<typeof make>) => r.recovery.turnAfter(codexAgent("a"), "t2", { kind: "canceled", reason: "user" }),
    (r: ReturnType<typeof make>) => r.recovery.archived("a"),
    (r: ReturnType<typeof make>) => r.recovery.turnAfter(codexAgent("a"), "t2", { kind: "completed" }),
  ]) {
    const r = make(), port = new Fake();
    port.add("a");
    await limit(r, "a");
    await invalidate(r);
    await adopt(r);
    await r.recovery.run(port);
    assert.deepEqual(port.calls, []);
  }
});

test("a limit that ended after the switch was adopted is not recovered by that switch (second limited account)", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await adopt(r);
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed());
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

test("owner incident: a limit after an adoption is kept and continued once by the next adoption", async () => {
  const r = make(), port = new Fake();
  port.add("a"); port.add("b");
  await adopt(r, "txn:1");
  for (const id of ["a", "b"]) {
    await r.recovery.turnBefore(codexAgent(id), "t1");
    await r.recovery.turnAfter(codexAgent(id), "t1", failed());
  }
  r.clock.t += 10;
  await r.recovery.run(port);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, [], "the same switch never continues them");
  assert.equal(r.logs.filter((l) => /waiting for the next switch agent=a/.test(l)).length, 1, "logged once");
  assert.ok(!has(r, /skipped agent=a/));
  r.account.v = "acct-B";
  await adopt(r, "txn:2");
  await r.recovery.run(port);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, ["reload:a", `send:a:${continuationText}`, "reload:b", `send:b:${continuationText}`]);
});

test("re-adopting the same switch does not release a waiting candidate", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await adopt(r, "txn:1");
  await limit(r, "a");
  await adopt(r, "txn:1");
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

test("user activity drops a candidate that waits for the next switch", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await adopt(r, "txn:1");
  await limit(r, "a");
  await r.recovery.run(port);
  await r.recovery.turnBefore(codexAgent("a"), "t2");
  await adopt(r, "txn:2");
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  assert.ok(has(r, /candidate dropped agent=a reason=turn started again/));
});

test("a plugin restart loses a waiting candidate (in-memory by design)", async () => {
  const store = memoryStore();
  const r = make({ store }), port = new Fake();
  port.add("a");
  await adopt(r, "txn:1");
  await limit(r, "a");
  const again = make({ store });
  await adopt(again, "txn:2");
  await again.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

test("busy, archived, missing and wrong-provider agents are skipped without sending", async () => {
  const r = make(), port = new Fake();
  port.add("busy", { status: "running", activeTurn: true });
  port.add("wrong", { provider: "claude" });
  for (const id of ["busy", "gone", "wrong"]) await limit(r, id);
  await adopt(r);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  // a busy agent waits and is continued once idle again, still only once
  port.agents.set("busy", { id: "busy", provider: "codex", status: "error", activeTurn: false });
  await r.recovery.run(port);
  assert.deepEqual(port.sends(), [`send:busy:${continuationText}`]);
});

test("setting off disables continuation, also when switched off between checks", async () => {
  const r = make({ resume: { v: false } }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  const second = make(), port2 = new Fake();
  port2.add("a");
  await limit(second, "a");
  await adopt(second);
  port2.onReload = () => { second.resume.v = false; };
  await second.recovery.run(port2);
  assert.deepEqual(port2.calls, ["reload:a"]);
});

test("a newer switch supersedes the pending recovery; both switch kinds are accepted", async () => {
  const r = make(), port = new Fake();
  port.add("a", { status: "running", activeTurn: true });
  await limit(r, "a");
  await adopt(r, "txn:1");
  await r.recovery.run(port);
  await adopt(r, "event:auto-2"); // an automatic switch supersedes the manual one
  port.agents.set("a", { id: "a", provider: "codex", status: "error", activeTurn: false });
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
});

test("adoption needs the same current login; a login change aborts before reload and before send", async () => {
  let r = make({ account: { v: "acct-A" } }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  r.clock.t += 1;
  await r.recovery.adopt("txn:1", "acct-B"); // target differs from the active login
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  r = make(); port = new Fake(); port.add("a");
  await limit(r, "a");
  await adopt(r);
  r.account.v = "acct-C";
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  r = make(); port = new Fake(); port.add("a");
  await limit(r, "a");
  await adopt(r);
  port.onReload = () => { r.account.v = "acct-C"; };
  await r.recovery.run(port);
  assert.deepEqual(port.calls, ["reload:a"]);
});

test("a failed reload consumes the attempt; no send, no retry for the same switch", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  port.reloadFails.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, ["reload:a"]);
});

test("new activity during the reload cancels the send", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  port.onReload = () => void r.recovery.turnBefore(codexAgent("a"), "t2");
  await r.recovery.run(port);
  assert.deepEqual(port.calls, ["reload:a"]);
});

test("the agent must be idle again after the reload", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  port.onReload = (id) => { port.agents.set(id, { id, provider: "codex", status: "running", activeTurn: true }); };
  port.reload = async function (this: Fake, id: string) { this.calls.push(`reload:${id}`); this.agents.set(id, { id, provider: "codex", status: "running", activeTurn: true }); } as never;
  await r.recovery.run(port);
  assert.deepEqual(port.calls, ["reload:a"]);
});

test("a send failure consumes the attempt", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  port.send = async (id: string, text: string) => { port.calls.push(`send:${id}:${text}`); throw new Error("send failed"); };
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
});

test("plugin restart: consumed attempts persist, candidates are not rebuilt from history", async () => {
  const store = memoryStore();
  let r = make({ store }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
  // restart: a fresh instance with the same store sees the old limit in agent history only
  r = make({ store }); 
  await r.recovery.adopt("txn:1", "acct-A");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
  await r.recovery.adopt("txn:2", "acct-A");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
});

test("a continuation that hits a limit again is never continued automatically, across switches and restarts", async () => {
  const store = memoryStore();
  let r = make({ store }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r, "txn:1");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
  // the continuation turn starts (tagged) and ends in a limit again, then the plugin restarts
  await r.recovery.turnBefore(codexAgent("a"), "t2");
  r = make({ store });
  await r.recovery.turnAfter(codexAgent("a"), "t2", failed());
  await adopt(r, "txn:2");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
  await adopt(r, "txn:3");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
  // new user activity establishes a new task: a later limit is eligible again
  await r.recovery.turnBefore(codexAgent("a"), "t3");
  await r.recovery.turnAfter(codexAgent("a"), "t3", failed());
  r.clock.t += 5;
  await adopt(r, "txn:4");
  port.add("a");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 2);
});

test("a completed continuation ends the automation lineage", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  await r.recovery.turnBefore(codexAgent("a"), "t2");
  await r.recovery.turnAfter(codexAgent("a"), "t2", { kind: "completed" });
  assert.equal((r.store as ReturnType<typeof memoryStore>).saved !== null, true);
  await r.recovery.turnBefore(codexAgent("a"), "t3");
  await r.recovery.turnAfter(codexAgent("a"), "t3", failed());
  r.clock.t += 5;
  await adopt(r, "txn:2");
  port.add("a");
  await r.recovery.run(port);
  assert.equal(port.sends().length, 2);
});

test("an unreadable or foreign store fails closed without throwing", async () => {
  const broken: RecoveryStore = { load: async () => { throw new Error("bad"); }, save: async () => {} };
  const r = make({ store: broken }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

test("no send capability means nothing is reloaded", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  (port as { send?: unknown }).send = undefined;
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

import { handoffSettings } from "../shared/handoff.js";
test("resumeLimitedCodexAgents defaults to true and is host-scoped; older stored settings parse", () => {
  assert.equal(handoffSettings.scope, "host");
  assert.equal(handoffSettings.schema.parse({}).resumeLimitedCodexAgents, true);
  assert.equal(handoffSettings.schema.parse({ restartCodexDaemon: false }).resumeLimitedCodexAgents, true);
  assert.equal(handoffSettings.schema.parse({ resumeLimitedCodexAgents: false }).resumeLimitedCodexAgents, false);
  assert.equal(handoffSettings.schema.parse({}).restartCodexDaemon, false, "resume default never enables the daemon restart");
});

test("a limit that ended after the switch time is a second limited account, even if adopted later", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  r.clock.t = 2100;
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed()); // ended at 2100
  r.clock.t = 2200;
  await r.recovery.adopt("txn:late", "acct-A", 2050); // the switch happened at 2050
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  port.add("b");
  r.clock.t = 2000;
  await r.recovery.turnBefore(codexAgent("b"), "t1");
  await r.recovery.turnAfter(codexAgent("b"), "t1", failed()); // ended at 2000, before the switch
  r.clock.t = 2200;
  await r.recovery.adopt("txn:late2", "acct-A", 2050);
  await r.recovery.run(port);
  assert.deepEqual(port.sends(), [`send:b:${continuationText}`]);
});

test("P9-2: an unknown switch target fails closed; the target must be the login that is current", async () => {
  let r = make(), port = new Fake();
  port.add("a");
  await limit(r, "a");
  r.clock.t += 1;
  await r.recovery.adopt("event:1", null as never); // target unknown
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  r = make({ account: { v: "acct-C" } }); port = new Fake(); port.add("a");
  await limit(r, "a");
  r.clock.t += 1;
  await r.recovery.adopt("event:2", "acct-B"); // switched to B, but C is current at the idle boundary
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
});

/** A store whose n-th save from now can be held, to reproduce the persistence races. */
function heldStore() {
  const s = {
    saved: null as unknown,
    saves: 0,
    holdAt: -1,
    waiter: null as (() => void) | null,
    reached: null as (() => void) | null,
    load: async () => s.saved,
    save: async (v: unknown) => {
      s.saves++;
      s.saved = JSON.parse(JSON.stringify(v));
      if (s.saves === s.holdAt) {
        s.reached?.();
        await new Promise<void>((r) => (s.waiter = r));
      }
    },
    /** Hold the save that is `n` saves away; resolves once it is suspended. */
    holdNext(n: number): Promise<void> {
      s.holdAt = s.saves + n;
      return new Promise((r) => (s.reached = r));
    },
    release() { s.holdAt = -1; s.waiter?.(); s.waiter = null; },
  };
  return s;
}
const settle = () => new Promise((x) => setTimeout(x, 5));

test("P9-1: an archive or new activity while the consume save is pending prevents the reload", async () => {
  for (const invalidate of [
    (r: ReturnType<typeof make>) => r.recovery.archived("a"),
    (r: ReturnType<typeof make>) => r.recovery.turnBefore(codexAgent("a"), "t2"),
    (r: ReturnType<typeof make>) => r.recovery.turnAfter(codexAgent("a"), "t2", { kind: "canceled", reason: "user" }),
  ]) {
    const store = heldStore();
    const r = make({ store }), port = new Fake();
    port.add("a");
    await limit(r, "a");
    await adopt(r);
    const suspended = store.holdNext(1); // the consume save
    const running = r.recovery.run(port);
    await suspended;
    void invalidate(r);
    await settle();
    store.release();
    await running;
    assert.deepEqual(port.calls, []);
  }
});

test("P9-1: new activity, an archive, a setting or login change while the lineage save is pending prevents the send", async () => {
  for (const invalidate of [
    (r: ReturnType<typeof make>) => r.recovery.turnBefore(codexAgent("a"), "t2"),
    (r: ReturnType<typeof make>) => r.recovery.archived("a"),
    (r: ReturnType<typeof make>) => void (r.resume.v = false),
    (r: ReturnType<typeof make>) => void (r.account.v = "acct-C"),
  ]) {
    const store = heldStore();
    const r = make({ store }), port = new Fake();
    port.add("a");
    await limit(r, "a");
    await adopt(r);
    const suspended = store.holdNext(2); // consume save, then the lineage save before the send
    const running = r.recovery.run(port);
    await suspended;
    assert.deepEqual(port.calls, ["reload:a"]);
    void invalidate(r);
    await settle();
    store.release();
    await running;
    assert.deepEqual(port.sends(), [], "no message after the invalidation");
  }
});

test("P9-1: without any invalidation a held save only delays the single continuation", async () => {
  const store = heldStore();
  const r = make({ store }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  const suspended = store.holdNext(1);
  const running = r.recovery.run(port);
  await suspended;
  await settle();
  store.release();
  await running;
  assert.equal(port.sends().length, 1);
});

// ---- plugin log: every decision leaves one greppable line, without secrets ----
const PREFIX = "[subbaton] limited-agents:";
const longAgent = (id: string) => `${id}-0123456789abcdef-0123456789abcdef`;
const has = (r: ReturnType<typeof make>, text: RegExp) => r.logs.some((l) => text.test(l));
function assertSafe(r: ReturnType<typeof make>) {
  assert.ok(r.logs.length > 0);
  for (const line of r.logs) {
    assert.ok(line.startsWith(PREFIX), line);
    assert.ok(!/\n/.test(line), "one line per decision");
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(line), `no e-mail addresses or aliases like them: ${line}`);
    assert.ok(!/(sk-[A-Za-z0-9]|Bearer|eyJ[A-Za-z0-9]|refresh|access_?token|auth\.json|password|secret|usage limit\.)/i.test(line), `no secrets or agent output: ${line}`);
    assert.ok(!line.includes("0123456789abcdef-0123"), `agent IDs are shortened: ${line}`);
    assert.ok(line.length < 300, line);
  }
}

test("log: a limited agent that is continued once explains every step", async () => {
  const r = make(), port = new Fake();
  port.add(longAgent("agentA"));
  await r.recovery.turnBefore(codexAgent(longAgent("agentA")), "turn-1");
  await r.recovery.turnAfter(codexAgent(longAgent("agentA")), "turn-1", failed("whatever", "usage_limit_reached"));
  r.clock.t += 10;
  await adopt(r, "txn:T1");
  await r.recovery.run(port);
  const text = r.logs.join("\n");
  assert.match(text, /limit detected agent=agentA-0 provider=codex via=code/);
  assert.match(text, /switch adopted key=txn:T1 account=acct-A/);
  assert.match(text, /attempt persisted agent=agentA-0/);
  assert.match(text, /login recheck before reload ok account=acct-A/);
  assert.match(text, /reload started agent=agentA-0/);
  assert.match(text, /reload finished agent=agentA-0/);
  assert.match(text, /login recheck after reload ok account=acct-A/);
  assert.match(text, /continuation sent agent=agentA-0/);
  assert.equal(r.logs.filter((l) => /continuation sent/.test(l)).length, 1);
  assertSafe(r);
  await r.recovery.run(port);
  assert.equal(r.logs.filter((l) => /continuation sent/.test(l)).length, 1, "a second run logs nothing new to send");
});

test("log: text matches are named as text, and quotes or unrelated failures are not logged as detections", async () => {
  const r = make();
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed());
  assert.ok(has(r, /limit detected agent=a provider=codex via=text/));
  await r.recovery.turnBefore(codexAgent("b"), "t1");
  await r.recovery.turnAfter(codexAgent("b"), "t1", failed("Network unreachable"));
  assert.ok(!r.logs.some((l) => /agent=b/.test(l) && /detected/.test(l)));
  assertSafe(r);
});

test("log: an agent the owner stopped or restarted is dropped with the reason", async () => {
  const stopped = make(), port = new Fake();
  port.add("a");
  await limit(stopped, "a");
  await stopped.recovery.turnAfter(codexAgent("a"), "t2", { kind: "canceled", reason: "user" });
  await adopt(stopped);
  await stopped.recovery.run(port);
  assert.ok(has(stopped, /candidate dropped agent=a reason=canceled/));
  assert.deepEqual(port.calls, []);
  assertSafe(stopped);
  const again = make();
  await limit(again, "a");
  await again.recovery.turnBefore(codexAgent("a"), "t2");
  assert.ok(has(again, /candidate dropped agent=a reason=turn started again/));
  const archived = make();
  await limit(archived, "a");
  await archived.recovery.archived("a");
  assert.ok(has(archived, /candidate dropped agent=a reason=archived/));
});

test("log: a limit that ended after the switch (second exhausted account) waits for the next switch", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await adopt(r, "txn:T9");
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed());
  await r.recovery.run(port);
  assert.ok(has(r, /waiting for the next switch agent=a/));
  assert.ok(!has(r, /continuation sent/));
  assertSafe(r);
});

test("log: a continuation that hit a limit again is suppressed, and the setting off is logged", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  await r.recovery.turnBefore(codexAgent("a"), "t2");
  await r.recovery.turnAfter(codexAgent("a"), "t2", failed());
  assert.ok(has(r, /continuation hit a limit again agent=a, suppressed until new activity/));
  const off = make({ resume: { v: false } });
  await off.recovery.turnBefore(codexAgent("a"), "t1");
  await off.recovery.turnAfter(codexAgent("a"), "t1", failed());
  assert.ok(has(off, /candidate not recorded agent=a reason=setting off/));
  assertSafe(r);
  assertSafe(off);
});

test("log: adoption is refused with the reason when the target is not the active login", async () => {
  const r = make({ account: { v: "acct-C" } });
  r.clock.t += 1;
  await r.recovery.adopt("event:2", "acct-B");
  assert.ok(has(r, /adoption refused key=event:2 reason=target acct-B is not the active login acct-C/));
  await r.recovery.adopt("event:3", null as never);
  assert.ok(has(r, /adoption refused key=event:3 reason=switch target unknown/));
  assertSafe(r);
});

test("log: an untrusted state file is logged once and nothing is sent", async () => {
  const broken: RecoveryStore = { load: async () => { throw new Error("EACCES /Users/x/secret.json"); }, save: async () => {} };
  const r = make({ store: broken }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r);
  await r.recovery.run(port);
  assert.ok(has(r, /state file unreadable, continuation disabled until it is fixed/));
  assert.equal(r.logs.filter((l) => /state file unreadable/.test(l)).length, 1);
  assert.ok(!r.logs.some((l) => l.includes("secret.json") || l.includes("EACCES")), "error text is never logged");
  assert.deepEqual(port.calls, []);
  assertSafe(r);
});

test("log: reload and send failures, a login change and the consumed attempt are explained", async () => {
  const failing = make(), port = new Fake();
  port.add("a");
  port.reloadFails.add("a");
  await limit(failing, "a");
  await adopt(failing);
  await failing.recovery.run(port);
  assert.ok(has(failing, /reload failed agent=a, attempt consumed, no message/));
  await adopt(failing, "txn:1");
  await failing.recovery.run(port);
  assertSafe(failing);
  const changed = make(), port2 = new Fake();
  port2.add("a");
  await limit(changed, "a");
  await adopt(changed);
  port2.onReload = () => { changed.account.v = "acct-C"; };
  await changed.recovery.run(port2);
  assert.ok(has(changed, /login recheck after reload failed agent=a, expected acct-A, active acct-C, no message/));
  const consumed = make(), port3 = new Fake();
  port3.add("a");
  await limit(consumed, "a");
  await adopt(consumed);
  await consumed.recovery.run(port3);
  consumed.logs.length = 0;
  await adopt(consumed);
  await consumed.recovery.run(port3);
  assert.equal(consumed.logs.filter((l) => /continuation sent/.test(l)).length, 0);
  const send = make(), port4 = new Fake();
  port4.add("a");
  port4.send = async () => { throw new Error("boom"); };
  await limit(send, "a");
  await adopt(send);
  await send.recovery.run(port4);
  assert.ok(has(send, /send failed agent=a, attempt already consumed/));
  assertSafe(send);
});

test("LL-1: 'waiting' is logged once per pending agent, not on every run", async () => {
  const r = make(), port = new Fake();
  port.add("a", { status: "running", activeTurn: true });
  await limit(r, "a");
  await adopt(r, "txn:1");
  for (let i = 0; i < 4; i++) await r.recovery.run(port);
  const waiting = () => r.logs.filter((l) => /waiting agent=a/.test(l)).length;
  assert.equal(waiting(), 1, "four runs while the turn is still running log one line");
  port.agents.set("a", { id: "a", provider: "codex", status: "error", activeTurn: false });
  await r.recovery.run(port);
  assert.equal(r.logs.filter((l) => /continuation sent agent=a/.test(l)).length, 1);
  assert.equal(waiting(), 1);
  // a new candidate (new limit, new switch) that has to wait again is logged again
  port.agents.set("a", { id: "a", provider: "codex", status: "running", activeTurn: true });
  await r.recovery.turnBefore(codexAgent("a"), "t6"); // our continuation's turn ...
  await r.recovery.turnAfter(codexAgent("a"), "t6", { kind: "completed" }); // ... ends normally
  await limit(r, "a", "t7");
  await adopt(r, "txn:2");
  await r.recovery.run(port);
  await r.recovery.run(port);
  assert.equal(waiting(), 2);
  // superseded by a newer switch while still waiting: the new key waits and logs once more
  await adopt(r, "txn:3");
  await r.recovery.run(port);
  await r.recovery.run(port);
  assert.equal(waiting(), 3);
  assertSafe(r);
});

// ---- LL-2: a throwing logger changes nothing; realistic ids appear only in short form ----
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4222-8333-${String(n).padStart(12, "0")}`;
test("LL-2: a throwing logger changes neither the flow nor the persisted state", async () => {
  const run = async (throwing: boolean) => {
    const store = memoryStore();
    const logs: string[] = [];
    const clock = { t: 1000 };
    const recovery = new LimitedAgentRecovery(store, async () => true, async () => "acct-A", () => clock.t, 30_000, (line) => {
      logs.push(line);
      if (throwing) throw new Error("logger exploded with a secret sk-abc");
    });
    const port = new Fake();
    port.add("a");
    await recovery.turnBefore(codexAgent("a"), "t1");
    await recovery.turnAfter(codexAgent("a"), "t1", failed());
    clock.t += 10;
    await recovery.adopt("txn:1", "acct-A");
    await recovery.run(port);
    await recovery.run(port);
    return { calls: port.calls, saved: JSON.stringify(store.saved), logs };
  };
  const quiet = await run(false);
  const loud = await run(true);
  assert.deepEqual(loud.calls, quiet.calls);
  assert.equal(loud.saved, quiet.saved);
  assert.equal(loud.calls.filter((c) => c.startsWith("send:")).length, 1);
  assert.ok(loud.logs.length > 0, "the logger was still called");
});

test("LL-2: realistic UUID agent ids appear in the log only as the 8-character short form", async () => {
  const r = make(), port = new Fake();
  const ids = [uuid(1), uuid(2), uuid(3)];
  for (const id of ids) port.add(id);
  for (const id of ids) await limit(r, id, `turn-${id.slice(0, 4)}-${uuid(9)}`);
  await r.recovery.turnBefore(codexAgent(ids[2]!), "t-new");
  await adopt(r, `txn:${uuid(7)}`);
  await r.recovery.run(port);
  await r.recovery.archived(ids[1]!);
  assert.ok(r.logs.length > 6);
  for (const line of r.logs) {
    for (const id of ids) {
      assert.ok(!line.includes(id), `full agent id leaked: ${line}`);
      assert.ok(!line.includes(id.slice(0, 13)), `agent id beyond the short form leaked: ${line}`);
    }
    assert.ok(!line.includes(uuid(9)), `full turn id leaked: ${line}`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(line.replace(/account=acct-A/g, "")) || /account=|key=/.test(line), `unexpected UUID: ${line}`);
  }
  assert.ok(r.logs.some((l) => l.includes("agent=00000001")), "the short form is used");
  assertSafe(r);
});

// Switch target usability (the core's eligibility rule: all windows fresh and one at 100 = exhausted; paid fallback must be fresh and funded).
const win = (usedPercent: number | null, patch: Record<string, unknown> = {}, id = "five_hour") => ({ id, label: id, usedPercent, resetsAt: 5000, stale: false, inferred: false, fetchedAt: 990, ...patch });
const pair = (five: number | null, seven: number | null = 10, patch: Record<string, unknown> = {}) => [win(five, patch), win(seven, patch, "seven_day")];
const credits = (patch: Record<string, unknown> = {}) => ({ kind: "credits", fetchedAt: 990, stale: false, hasCredits: true, balance: "12.5", ...patch });
const target = (windows: unknown[], paidUsage?: unknown) => ({ id: "acct-A", windows, paidUsage });
async function exhaustedRun(usage: Usage) {
  const r = make({ usage }), port = new Fake();
  port.add("a");
  await limit(r, "a");
  await adopt(r, "txn:1");
  await r.recovery.run(port);
  await r.recovery.run(port);
  return { r, port };
}
test("target exhausted with no usable paid fallback: the candidate waits until headroom or the next switch, logged once", async () => {
  for (const paid of [undefined, credits({ hasCredits: false }), credits({ balance: "0" }), credits({ balance: "-5", unlimited: true }), credits({ stale: true }), credits({ fetchedAt: 700 })]) {
    const usage = { v: target(pair(100), paid) };
    const { r, port } = await exhaustedRun(usage);
    assert.deepEqual(port.calls, [], JSON.stringify(paid));
    assert.equal(r.logs.filter((l) => /waiting until the target has headroom or the next switch agent=a reason=target exhausted/.test(l)).length, 1);
    usage.v = target(pair(10));
    await adopt(r, "txn:2");
    await r.recovery.run(port);
    assert.equal(port.sends().length, 1);
  }
});
test("target exhausted but with usable credits (unlimited or a positive balance): continues as normal", async () => {
  for (const paid of [credits(), credits({ hasCredits: undefined, unlimited: true, balance: undefined }), credits({ balance: "1e-7" })]) {
    const { port } = await exhaustedRun({ v: target(pair(100), paid) });
    assert.deepEqual(port.sends(), [`send:a:${continuationText}`]);
  }
});
test("an exhausted target that regains headroom continues in the same switch", async () => {
  const usage = { v: target(pair(100)) };
  const { r, port } = await exhaustedRun(usage);
  assert.deepEqual(port.calls, []);
  usage.v = target(pair(20));
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
});
test("target status unreadable, stale or unknown: continues as today and logs the uncertainty once", async () => {
  const vectors = [
    null, target([]), target(pair(100, 10, { stale: true })), target(pair(null)),
    target([win(100), win(30, { stale: true }, "seven_day")]),
    target([win(100, {}, "seven_day")]), // 5h row missing: the core says unknown, not exhausted
    target(pair(100, 100, { inferred: true })),
    target(pair(100, 100, { resetsAt: 900 })),
  ];
  for (const v of vectors) {
    const { r, port } = await exhaustedRun({ v });
    assert.equal(port.sends().length, 1, JSON.stringify(v));
    assert.equal(r.logs.filter((l) => /target usage unreadable, stale or unknown/.test(l)).length, 1);
    assertSafe(r);
  }
});
test("target with headroom continues without any uncertainty line", async () => {
  const { r, port } = await exhaustedRun({ v: target(pair(40, 99)) });
  assert.equal(port.sends().length, 1);
  assert.ok(!has(r, /unreadable|exhausted/));
});

test("paidEligible mirrors the core (PaidUsage.swift) on signed balances, exponents and freshness", () => {
  const now = 1000;
  const vectors: [Record<string, unknown>, boolean][] = [
    [credits(), true],
    [credits({ balance: "-5" }), false],
    [credits({ balance: "-5", unlimited: true }), false],
    [credits({ balance: "1e-7" }), true],
    [credits({ balance: "0" }), false],
    [credits({ hasCredits: false, unlimited: true }), false],
    [credits({ hasCredits: true, balance: undefined }), false],
    [credits({ hasCredits: undefined, unlimited: true, balance: undefined }), true],
    [credits({ stale: true }), false],
    [credits({ fetchedAt: 820 }), false],
    [credits({ fetchedAt: 821 }), true],
    [credits({ fetchedAt: 1001 }), false],
    [{ kind: "extraUsage", fetchedAt: 990, stale: false, enabled: true }, true],
    [{ kind: "extraUsage", fetchedAt: 990, stale: false, enabled: false }, false],
    [{ kind: "extraUsage", fetchedAt: 990, stale: false, enabled: true, utilization: 100 }, false],
    [{ kind: "extraUsage", fetchedAt: 990, stale: false, enabled: true, monthlyLimit: 0 }, false],
    [{ kind: "extraUsage", fetchedAt: 990, stale: false, enabled: true, monthlyLimit: 50, usedCredits: 50 }, false],
  ];
  for (const [paid, expected] of vectors) assert.equal(paidEligible(paid as never, now), expected, JSON.stringify(paid));
  assert.equal(paidEligible(undefined, now), false);
});

// A limit that ended after the switch: the limit may have hit either login. Only a fresh target reading fetched after it counts as proof.
async function afterSwitch(usage: Usage) {
  const r = make({ usage }), port = new Fake();
  port.add("a");
  await adopt(r, "txn:1");
  r.clock.t += 5; // 1006
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed()); // ended at 1006
  r.clock.t += 5; // now 1011
  await r.recovery.run(port);
  return { r, port };
}
test("M1: a limit after the switch continues when the target has a fresh usable reading fetched after it", async () => {
  const usage = { v: target(pair(30, 10, { fetchedAt: 1005 })) };
  const { r, port } = await afterSwitch(usage);
  assert.deepEqual(port.calls, [], "a reading from before the limit proves nothing");
  assert.equal(r.logs.filter((l) => /waiting for the next switch agent=a/.test(l)).length, 1);
  usage.v = target(pair(30, 10, { fetchedAt: 1007 }));
  await r.recovery.run(port);
  assert.equal(port.sends().length, 1);
});
test("M1: a limit after the switch keeps waiting when the target is exhausted, unknown or has no status", async () => {
  for (const v of [target(pair(100, 10, { fetchedAt: 1007 })), target(pair(30, 10, { fetchedAt: 1007, stale: true })), null]) {
    const { port } = await afterSwitch({ v });
    assert.deepEqual(port.calls, [], JSON.stringify(v));
  }
  const { port } = await afterSwitch({ v: target(pair(100, 10, { fetchedAt: 1007 }), credits({ fetchedAt: 1007 })) });
  assert.equal(port.sends().length, 1, "credits fetched after the limit cover an exhausted target");
});

test("L4: waiting candidates expire after 7 days; log entries are cleared with the candidate", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await adopt(r, "txn:1");
  await limit(r, "a");
  await r.recovery.run(port);
  assert.ok(has(r, /waiting for the next switch agent=a/));
  r.clock.t += 7 * 86400 + 100;
  await r.recovery.run(port);
  assert.ok(has(r, /skipped agent=a reason=waited longer than 7 days/));
  r.account.v = "acct-B";
  await adopt(r, "txn:2");
  await r.recovery.run(port);
  assert.deepEqual(port.calls, []);
  // a new limit after the same agent was dropped logs its wait line again
  await r.recovery.turnBefore(codexAgent("a"), "t9");
  await r.recovery.turnAfter(codexAgent("a"), "t9", failed());
  await r.recovery.run(port);
  assert.equal(r.logs.filter((l) => /waiting for the next switch agent=a/.test(l)).length, 2);
});

test("M2: agents recovery handles are skipped by the handoff reopen; one reload per agent per switch", async () => {
  const r = make(), port = new Fake();
  port.add("a"); port.add("b");
  await limit(r, "a");
  await adopt(r, "txn:1");
  assert.equal(r.recovery.handles("a"), true);
  assert.equal(r.recovery.handles("b"), false);
  // interleaving: the handoff reopens every agent unless recovery handles it, while recovery runs
  const reopened: string[] = [];
  const reopen = async () => {
    for (const id of ["a", "b"]) {
      if (r.recovery.handles(id)) continue;
      await port.reload(id);
      reopened.push(id);
    }
  };
  await Promise.all([r.recovery.run(port), reopen()]);
  await reopen(); // a later tick, after recovery sent: "a" is still not reloaded again
  assert.equal(port.calls.filter((c) => c === "reload:a").length, 1);
  assert.equal(port.calls.filter((c) => c === "reload:b").length, 2 /* the fake handoff reloads b on each of its two passes */);
  assert.equal(port.sends().length, 1);
});
