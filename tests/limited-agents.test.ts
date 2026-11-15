import test from "node:test";
import assert from "node:assert/strict";
import {
  LimitedAgentRecovery,
  continuationText,
  isLimitFailure,
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
function make(opts: { store?: RecoveryStore; resume?: { v: boolean }; account?: { v: string | null }; clock?: { t: number } } = {}) {
  const store = opts.store ?? memoryStore();
  const resume = opts.resume ?? { v: true };
  const account = opts.account ?? { v: "acct-A" };
  const clock = opts.clock ?? { t: 1000 };
  const recovery = new LimitedAgentRecovery(store, async () => resume.v, async () => account.v, () => clock.t);
  return { recovery, store, resume, account, clock };
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

test("a limit that ended after the switch was adopted is not recovered (second limited account)", async () => {
  const r = make(), port = new Fake();
  port.add("a");
  await adopt(r);
  await r.recovery.turnBefore(codexAgent("a"), "t1");
  await r.recovery.turnAfter(codexAgent("a"), "t1", failed());
  await r.recovery.run(port);
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
