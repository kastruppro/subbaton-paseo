import test from "node:test";
import assert from "node:assert/strict";
import {
  HandoffCoordinator,
  paseoAgentPort,
  paseoAnchorPid,
  type AgentSnapshot,
  type AgyProcessInfo,
  type HandoffCli,
  type SwitchOptions,
  type SwitchOutcome,
} from "../server/handoff.js";
import type { HandoffSettings, HandoffState } from "../shared/handoff.js";

const target = "22222222-2222-4222-8222-222222222222";
const agent = (id: string, provider: string, status = "idle", activeTurn = false): AgentSnapshot => ({ id, provider, status, activeTurn });

class FakeAgents {
  agents: AgentSnapshot[] = [];
  reloads: string[] = [];
  failReload = new Set<string>();
  async list() {
    return this.agents.map((a) => ({ ...a }));
  }
  async reload(id: string) {
    if (this.failReload.has(id)) throw new Error("reload failed");
    this.reloads.push(id);
  }
}
// The process tree used in these tests: 500 is the Paseo daemon ("Paseo Helper"), whose parent 400
// is a login shell; 900 is a terminal shell; 700 a shell the daemon started.
const paseoPid = 500;
const names: Record<number, string> = { 500: "Paseo Helper", 400: "zsh", 900: "zsh", 700: "sh", 600: "node", 1: "launchd" };
const proc = (pid: number, ancestors: number[] | null = [paseoPid, 400, 1], kind = "cli", complete = ancestors !== null): AgyProcessInfo => ({
  pid,
  kind,
  ancestors: ancestors?.map((a) => ({ pid: a, executable: names[a] ?? null })) ?? null,
  complete,
});
class FakeCli implements HandoffCli {
  switches: { provider: string; target: string; options: SwitchOptions }[] = [];
  processes: AgyProcessInfo[] | null = [];
  outcome: SwitchOutcome = { kind: "switched", code: "switched", message: "Switched.", daemonOutcome: "not-requested" };
  events_: { id?: string; transaction?: string; at: number; provider: string; kind: string }[] = [];
  eventReads: (number | null)[] = [];
  gate: Promise<void> | null = null;
  plan: { ok: true; blockedOnlyByProcesses: boolean; target: string | null } | { ok: false } = { ok: true, blockedOnlyByProcesses: false, target: null };
  planReads = 0;
  autoRuns: number[][] = [];
  autoOutcome: SwitchOutcome = { kind: "switched", code: "switched", message: "Automatic switch verified." };
  daemonPending: boolean | null = false;
  daemonRestarts = 0;
  daemonOutcome = "restarted";
  pendingReads = 0;
  async agyAutoPlan() {
    this.planReads++;
    return this.plan;
  }
  async agyAutoRunOnce(pids: number[]) {
    this.autoRuns.push(pids);
    return this.autoOutcome;
  }
  async codexDaemonPending() {
    this.pendingReads++;
    return this.daemonPending;
  }
  async codexDaemonRestart() {
    this.daemonRestarts++;
    if (this.daemonOutcome === "restarted") this.daemonPending = false;
    return this.daemonOutcome;
  }
  async agyProcesses() {
    return this.processes ? { ok: true as const, processes: this.processes } : { ok: false as const };
  }
  async switchAccount(provider: "codex" | "agy", t: string, options: SwitchOptions) {
    this.switches.push({ provider, target: t, options });
    if (this.gate) await this.gate;
    return this.outcome;
  }
  async events(since: number | null) {
    this.eventReads.push(since);
    return { ok: true as const, events: this.events_ };
  }
  knownAccount(_p: string, t: string) {
    return t === target ? { alias: "home" } : null;
  }
}
class MemoryStore {
  saved: HandoffState | null = null;
  setAsideCalls = 0;
  constructor(public initial: unknown = null, public failLoad = false) {}
  async load() {
    if (this.failLoad) throw new Error("unreadable");
    return this.initial;
  }
  async setAside() {
    this.setAsideCalls++;
    return "handoff-v1.json.unreadable-1";
  }
  async save(state: HandoffState) {
    this.saved = structuredClone(state);
  }
}
const setup = (settings: Partial<HandoffSettings> = {}, initial: unknown = null, failLoad = false, options = {}) => {
  const cli = new FakeCli();
  const agents = new FakeAgents();
  const store = new MemoryStore(initial, failLoad);
  let now = 1000;
  const coordinator = new HandoffCoordinator(
    cli,
    store,
    async () => ({ reloadCodexAfterAutomaticSwitch: true, restartCodexDaemon: false, closeAgyForAutomaticSwitch: true, idleWaitMinutes: 30, resumeLimitedCodexAgents: true, ...settings }),
    () => now,
    (() => {
      let n = 0;
      return () => `h${++n}`;
    })(),
    { paseoAnchor: paseoPid, ...options },
  );
  return { cli, agents, store, coordinator, advance: (s: number) => (now += s) };
};

test("agy: waits for idle, stops only via the CLI, switches, then reloads only the affected agy agents", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity"), agent("a2", "antigravity", "running", true), agent("c1", "codex"), agent("k1", "claude", "running", true)];
  cli.processes = [proc(12), proc(11, [600, paseoPid, 400, 1])];
  assert.equal((await coordinator.request("agy", target)).result.outcome, "success");
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.phase, "waiting");
  assert.equal(coordinator.status().handoffs.agy?.waitingFor, 1);
  assert.equal(cli.switches.length, 0);
  assert.deepEqual(agents.reloads, []);
  agents.agents[1] = agent("a2", "antigravity");
  await coordinator.tick(agents);
  assert.deepEqual(cli.switches, [{ provider: "agy", target, options: { onlyPids: [11, 12] } }]);
  assert.deepEqual(agents.reloads, ["a1", "a2"]);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "done");
  assert.deepEqual(h.affected, ["a1", "a2"]);
});

test("agy: only processes descended from the Paseo daemon count; anything else waits (fail closed)", async () => {
  const cases: [AgentSnapshot[], AgyProcessInfo[] | null, string][] = [
    [[agent("a1", "antigravity")], [proc(11), proc(12, [900, 1])], "agyOutsidePaseo"],
    [[agent("a1", "antigravity")], [proc(11, [900, 1], "desktop")], "agyOutsidePaseo"],
    [[agent("a1", "antigravity")], null, "processUnknown"],
    [[agent("a1", "antigravity")], [proc(11, null)], "attributionUnknown"],
    // Review H1: two idle agents, one Paseo process and one terminal session must not be stopped.
    [[agent("a1", "antigravity"), agent("a2", "antigravity")], [proc(11), proc(12, [900, 1])], "agyOutsidePaseo"],
    [[agent("a1", "antigravity"), agent("a2", "antigravity")], [proc(11)], "attributionIncomplete"],
  ];
  for (const [list, processes, code] of cases) {
    const { cli, agents, coordinator } = setup();
    agents.agents = list;
    cli.processes = processes;
    await coordinator.request("agy", target);
    await coordinator.tick(agents);
    const h = coordinator.status().handoffs.agy!;
    assert.equal(h.phase, "waiting", code);
    assert.equal(h.code, code);
    assert.equal(cli.switches.length, 0);
  }
});

test("agy without running processes switches without --stop-agy", async () => {
  const { cli, agents, coordinator } = setup();
  cli.processes = [];
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  assert.deepEqual(cli.switches[0]?.options, {});
  assert.equal(coordinator.status().handoffs.agy?.phase, "done");
});

test("uncertain, refused and stopped-but-failed switches never reopen; an explicit reopen does", async () => {
  for (const kind of ["uncertain", "refused", "stoppedFailed"] as const) {
    const { cli, agents, coordinator } = setup();
    agents.agents = [agent("a1", "antigravity")];
    cli.processes = [proc(11)];
    cli.outcome = { kind, code: kind === "refused" ? "needsLogin" : kind, message: "CLI said no." };
    await coordinator.request("agy", target);
    await coordinator.tick(agents);
    const h = coordinator.status().handoffs.agy!;
    assert.equal(h.phase, kind === "uncertain" ? "uncertain" : "failed", kind);
    assert.deepEqual(agents.reloads, []);
    if (kind === "refused") {
      assert.match(h.message, /No agents were closed/);
      assert.deepEqual(h.affected, []);
      assert.equal((await coordinator.control("agy", "reopen")).result.code, "nothingToReopen");
      continue;
    }
    assert.match(h.message, /Reopen agents/);
    assert.equal((await coordinator.control("agy", "reopen")).result.outcome, "success");
    await coordinator.tick(agents);
    assert.deepEqual(agents.reloads, ["a1"]);
    assert.equal(coordinator.status().handoffs.agy?.phase, "done");
  }
});

test("codex: reloads idle Codex agents after a verified switch; daemon restart only when enabled", async () => {
  for (const restart of [false, true]) {
    const { cli, agents, coordinator } = setup({ restartCodexDaemon: restart });
    agents.agents = [agent("c1", "codex"), agent("c2", "codex", "closed"), agent("a1", "antigravity")];
    cli.outcome = { kind: "switched", code: "switched", message: "ok", daemonOutcome: restart ? "restarted" : "not-requested" };
    await coordinator.request("codex", target);
    await coordinator.tick(agents);
    assert.deepEqual(cli.switches[0]?.options, restart ? { restartDaemon: true } : {});
    assert.deepEqual(agents.reloads, ["c1"]);
    assert.equal(coordinator.status().handoffs.codex?.daemonOutcome, restart ? "restarted" : "not-requested");
  }
});

test("codex: a running Codex turn defers both the switch and any daemon restart", async () => {
  const { cli, agents, coordinator } = setup({ restartCodexDaemon: true });
  agents.agents = [agent("c1", "codex", "running", true)];
  await coordinator.request("codex", target);
  await coordinator.tick(agents);
  assert.equal(cli.switches.length, 0);
  assert.equal(coordinator.status().handoffs.codex?.code, "turnRunning");
});

test("an agent that starts a turn before its reopen is reloaded only once it is idle again", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("c1", "codex"), agent("c2", "codex")];
  const original = cli.switchAccount.bind(cli);
  cli.switchAccount = async (provider, t, flags) => {
    agents.agents[1] = agent("c2", "codex", "running", true);
    return original(provider, t, flags);
  };
  await coordinator.request("codex", target);
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads, ["c1"]);
  assert.equal(coordinator.status().handoffs.codex?.phase, "reopening");
  agents.agents[1] = agent("c2", "codex");
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads, ["c1", "c2"]);
  assert.equal(coordinator.status().handoffs.codex?.phase, "done");
});

test("reload failures and vanished agents are reported, not retried forever", async () => {
  const { agents, coordinator } = setup();
  agents.agents = [agent("c1", "codex"), agent("c2", "codex")];
  agents.failReload.add("c1");
  await coordinator.request("codex", target);
  const reload = agents.reload.bind(agents);
  agents.reload = async (id) => {
    agents.agents = agents.agents.filter((a) => a.id !== "c2");
    return reload(id);
  };
  await coordinator.tick(agents);
  const h = coordinator.status().handoffs.codex!;
  assert.equal(h.phase, "failed");
  assert.deepEqual(h.failedReopen.sort(), ["c1", "c2"]);
});

test("single flight: one handoff per provider and concurrent ticks never switch twice", async () => {
  const { cli, agents, coordinator } = setup();
  await coordinator.request("codex", target);
  assert.equal((await coordinator.request("codex", target)).result.code, "busy");
  assert.equal((await coordinator.request("agy", "33333333-3333-4333-8333-333333333333")).result.code, "unknownAccount");
  agents.agents = [agent("c1", "codex")];
  let release!: () => void;
  cli.gate = new Promise((r) => (release = r));
  const first = coordinator.tick(agents);
  const second = coordinator.tick(agents);
  await new Promise((r) => setTimeout(r, 5));
  release();
  await Promise.all([first, second]);
  assert.equal(cli.switches.length, 1);
  assert.deepEqual(agents.reloads, ["c1"]);
});

test("waiting expires after the idle window without changing anything; cancel works only while waiting or reopening", async () => {
  const { cli, agents, coordinator, advance } = setup({ idleWaitMinutes: 1 });
  agents.agents = [agent("a1", "antigravity", "running", true)];
  await coordinator.request("agy", target);
  advance(61);
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.phase, "expired");
  assert.equal(cli.switches.length, 0);
  await coordinator.control("agy", "dismiss");
  await coordinator.request("agy", target);
  assert.equal((await coordinator.control("agy", "cancel")).result.outcome, "success");
  assert.equal(coordinator.status().handoffs.agy?.phase, "cancelled");
  assert.equal((await coordinator.control("agy", "cancel")).result.code, "notCancellable");
});

test("without Paseo's agent API nothing is switched or reopened", async () => {
  const { cli, coordinator } = setup();
  await coordinator.request("codex", target);
  await coordinator.tick(null);
  assert.equal(cli.switches.length, 0);
  assert.equal(coordinator.status().handoffs.codex?.code, "agentApiUnavailable");
});

const persisted = (phase: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  eventWatermark: 500,
  handoffs: {
    codex: null,
    agy: {
      id: "old",
      provider: "agy",
      target,
      targetAlias: "home",
      trigger: "manual",
      restartDaemon: false,
      phase,
      requestedAt: 900,
      deadline: 99999,
      updatedAt: 950,
      waitingFor: 0,
      code: null,
      message: "x",
      affected: ["a1", "a2"],
      reopened: [],
      failedReopen: [],
      daemonOutcome: null,
      ...extra,
    },
  },
});

test("crash during the CLI switch resumes as uncertain and keeps agents closed", async () => {
  const { cli, agents, coordinator, store } = setup({}, persisted("switching"));
  agents.agents = [agent("a1", "antigravity"), agent("a2", "antigravity")];
  await coordinator.tick(agents);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "uncertain");
  assert.equal(h.code, "interrupted");
  assert.equal(cli.switches.length, 0);
  assert.deepEqual(agents.reloads, []);
  assert.equal(store.saved?.handoffs.agy?.phase, "uncertain");
});

test("crash during reopening continues with the agents not yet reopened", async () => {
  const { cli, agents, coordinator } = setup({}, persisted("reopening", { reopened: ["a1"] }));
  agents.agents = [agent("a1", "antigravity"), agent("a2", "antigravity", "closed")];
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads, ["a2"]);
  assert.equal(cli.switches.length, 0);
  assert.equal(coordinator.status().handoffs.agy?.phase, "done");
});

test("corrupt persisted state is replaced, never interpreted", async () => {
  const { cli, agents, coordinator } = setup({}, { schemaVersion: 9, handoffs: { agy: { phase: "switching" } } });
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy, null);
  assert.equal(cli.switches.length, 0);
});

test("a Codex automatic switch event queues a reload-only handoff; older events are ignored", async () => {
  const { cli, agents, coordinator, advance } = setup();
  cli.events_ = [{ at: 900, provider: "codex", kind: "automaticSwitch" }];
  agents.agents = [agent("c1", "codex"), agent("a1", "antigravity")];
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.codex, null);
  assert.deepEqual(cli.eventReads, [1000]);
  advance(61);
  cli.events_ = [{ at: 1050, provider: "agy", kind: "paused" }, { at: 1055, provider: "codex", kind: "automaticSwitch" }];
  await coordinator.tick(agents);
  const h = coordinator.status().handoffs.codex!;
  assert.equal(h.trigger, "automaticSwitch");
  assert.equal(h.target, null);
  assert.equal(cli.switches.length, 0);
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads, ["c1"]);
  assert.equal(coordinator.status().handoffs.codex?.phase, "done");
});

test("the automatic reload follow-up can be turned off", async () => {
  const { cli, agents, coordinator } = setup({ reloadCodexAfterAutomaticSwitch: false, resumeLimitedCodexAgents: false });
  cli.events_ = [{ at: 2000, provider: "codex", kind: "automaticSwitch" }];
  await coordinator.tick(agents);
  assert.deepEqual(cli.eventReads, []);
});

test("the Paseo adapter lists non-archived agents and reopens with reload(), never refresh()", async () => {
  const calls: string[] = [];
  const api = {
    agents: {
      async list(options: { page?: { cursor?: string } }) {
        calls.push(`list:${options.page?.cursor ?? ""}`);
        return options.page?.cursor
          ? { entries: [{ agent: { id: "a2", provider: "antigravity", status: "running", activeTurn: { turnId: "t" } } }], pageInfo: { hasMore: false, nextCursor: null } }
          : { entries: [{ agent: { id: "a1", provider: "antigravity", status: "idle", activeTurn: null } }, { agent: { id: "x", provider: "codex", status: "idle", archivedAt: "2026-01-01" } }, { bogus: true }], pageInfo: { hasMore: true, nextCursor: "c2" } };
      },
      ref(id: string) {
        return {
          async reload() {
            calls.push(`reload:${id}`);
          },
          async refresh() {
            throw new Error("refresh must not be used to reopen");
          },
        };
      },
    },
  };
  const port = paseoAgentPort(api)!;
  assert.deepEqual(await port.list(), [
    { id: "a1", provider: "antigravity", status: "idle", activeTurn: false },
    { id: "a2", provider: "antigravity", status: "running", activeTurn: true },
  ]);
  await port.reload("a1");
  assert.deepEqual(calls, ["list:", "list:c2", "reload:a1"]);
  assert.equal(paseoAgentPort(null), null);
  assert.equal(paseoAgentPort({}), null);
});

test("L1: an agent that turns busy after the process check sends the handoff back to waiting", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity")];
  cli.processes = [proc(11)];
  const original = agents.list.bind(agents);
  let calls = 0;
  agents.list = async () => (++calls === 2 ? [agent("a1", "antigravity", "running", true)] : original());
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  assert.equal(cli.switches.length, 0);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "waiting");
  assert.equal(h.code, "becameBusy");
  await coordinator.tick(agents);
  assert.equal(cli.switches.length, 1);
});

test("M1: each agent is re-read right before its reload; one that turned busy meanwhile waits", async () => {
  const { agents, coordinator } = setup();
  agents.agents = [agent("c1", "codex"), agent("c2", "codex")];
  const reload = agents.reload.bind(agents);
  agents.reload = async (id) => {
    await reload(id);
    if (id === "c1") agents.agents[1] = agent("c2", "codex", "running", true);
  };
  await coordinator.request("codex", target);
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads, ["c1"]);
  assert.equal(coordinator.status().handoffs.codex?.code, "reopenWaiting");
  agents.agents[1] = agent("c2", "codex");
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads, ["c1", "c2"]);
});

test("L2: ticks coalesce, stuck SDK calls time out and owner actions answer busy quickly", async () => {
  const { agents, coordinator } = setup({}, null, false, { listTimeoutMs: 30, fastWaitMs: 10 });
  await coordinator.request("codex", target);
  let lists = 0;
  agents.list = () => {
    lists++;
    return new Promise(() => {});
  };
  const ticks = Array.from({ length: 5 }, () => coordinator.tick(agents));
  const answer = await coordinator.control("codex", "cancel");
  assert.equal(answer.result.code, "busy");
  await Promise.all(ticks);
  assert.ok(lists <= 2, `lists ${lists}`);
  assert.equal(coordinator.status().handoffs.codex?.code, "agentApiUnavailable");
  assert.equal(coordinator.status().handoffs.codex?.phase, "waiting");
});

test("L3: an unreadable state file is set aside and reported once", async () => {
  const { agents, coordinator, store } = setup({}, null, true);
  await coordinator.tick(agents);
  assert.equal(store.setAsideCalls, 1);
  assert.match(coordinator.status().notice?.message ?? "", /may have been interrupted/);
  await coordinator.request("codex", target);
  await coordinator.control("codex", "cancel");
  await coordinator.control("codex", "dismiss");
  assert.equal(coordinator.status().notice, null);
  assert.equal(coordinator.status().handoffs.codex?.phase, "cancelled", "the notice is dismissed on its own");
  const future = setup({}, { schemaVersion: 2, handoffs: {} });
  await future.coordinator.tick(future.agents);
  assert.equal(future.store.setAsideCalls, 1);
  assert.equal(future.coordinator.status().notice?.code, "stateUnreadable");
});

test("L5: reopening has a deadline and can be cancelled; closed agy agents stay reopenable", async () => {
  const { cli, agents, coordinator, advance } = setup({ idleWaitMinutes: 1 });
  agents.agents = [agent("a1", "antigravity")];
  cli.processes = [proc(11)];
  const original = cli.switchAccount.bind(cli);
  cli.switchAccount = async (p, t, o) => {
    agents.agents[0] = agent("a1", "antigravity", "running", true);
    return original(p, t, o);
  };
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.phase, "reopening");
  advance(61);
  await coordinator.tick(agents);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "failed");
  assert.equal(h.code, "reopenTimeout");
  assert.equal((await coordinator.control("agy", "reopen")).result.outcome, "success");
  assert.equal((await coordinator.control("agy", "cancel")).result.outcome, "success");
  assert.equal(coordinator.status().handoffs.agy?.code, "reopenCancelled");
  assert.equal(coordinator.status().handoffs.agy?.phase, "failed");
});

test("agy: an incomplete ancestor chain without the Paseo PID is unattributable; a refused allowlist waits", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity")];
  cli.processes = [proc(11), proc(12, [900], "cli", false)];
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.code, "attributionUnknown");
  agents.agents = [agent("a1", "antigravity"), agent("a2", "antigravity")];
  cli.processes = [proc(11), proc(12, [600, paseoPid, 1], "cli", false)];
  cli.outcome = { kind: "notAllowed", code: "processesNotAllowed", message: "x" };
  await coordinator.tick(agents);
  assert.deepEqual(cli.switches.at(-1)?.options, { onlyPids: [11, 12] });
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "waiting");
  assert.equal(h.code, "agyOutsidePaseo");
  assert.deepEqual(h.affected, []);
});

test("automatic agy: runs auto run-once with Paseo's PIDs only when processes are the only blocker", async () => {
  const { cli, agents, coordinator, advance } = setup();
  agents.agents = [agent("a1", "antigravity")];
  cli.processes = [proc(11)];
  await coordinator.tick(agents);
  assert.equal(cli.autoRuns.length, 0);
  assert.equal(coordinator.status().handoffs.agy, null);
  cli.plan = { ok: true, blockedOnlyByProcesses: true, target };
  advance(61);
  await coordinator.tick(agents);
  assert.deepEqual(cli.autoRuns, [[11]]);
  assert.equal(cli.switches.length, 0);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.trigger, "automaticSwitch");
  assert.equal(h.targetAlias, "home");
  assert.equal(h.phase, "done");
  assert.deepEqual(agents.reloads, ["a1"]);
});

test("automatic agy: off by setting, terminal sessions wait, refusals close nothing, a failed stop honours retryAt", async () => {
  const off = setup({ closeAgyForAutomaticSwitch: false });
  off.cli.plan = { ok: true, blockedOnlyByProcesses: true, target };
  await off.coordinator.tick(off.agents);
  assert.equal(off.cli.planReads, 0);

  const { cli, agents, coordinator, advance } = setup();
  agents.agents = [agent("a1", "antigravity")];
  cli.plan = { ok: true, blockedOnlyByProcesses: true, target };
  cli.processes = [proc(11), proc(12, [900, 1])];
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.code, "agyOutsidePaseo");
  assert.equal(cli.autoRuns.length, 0);
  await coordinator.control("agy", "cancel");

  cli.processes = [proc(11)];
  cli.autoOutcome = { kind: "notRun", code: "processStopRefused", message: "The automatic switch did not run. Nothing was stopped." };
  advance(61);
  await coordinator.tick(agents);
  let h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "done");
  assert.deepEqual(h.affected, []);
  assert.equal((await coordinator.control("agy", "reopen")).result.code, "nothingToReopen");

  cli.autoOutcome = { kind: "stoppedFailed", code: "stopFailed", message: "Some agy sessions did not stop.", retryAt: 1000 + 122 + 900 };
  advance(61);
  await coordinator.tick(agents);
  h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "failed");
  assert.deepEqual(h.affected, ["a1"]);
  await coordinator.control("agy", "dismiss");
  const reads = cli.planReads;
  advance(120);
  await coordinator.tick(agents);
  assert.equal(cli.planReads, reads, "no plan read before retryAt");
  advance(900);
  await coordinator.tick(agents);
  assert.equal(cli.planReads, reads + 1);
});

test("Codex daemon: restarted at the idle boundary after an automatic switch, never while a turn runs", async () => {
  const { cli, agents, coordinator, advance } = setup({ restartCodexDaemon: true });
  agents.agents = [agent("c1", "codex", "running", true)];
  cli.daemonPending = true;
  cli.events_ = [{ at: 2000, provider: "codex", kind: "automaticSwitch" }];
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.codex?.restartDaemon, true);
  assert.equal(cli.daemonRestarts, 0);
  agents.agents = [agent("c1", "codex")];
  // A turn starts between the idle check and the restart: no restart.
  const list = agents.list.bind(agents);
  let calls = 0;
  agents.list = async () => (++calls === 2 ? [agent("c1", "codex", "running", true)] : list());
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 0);
  assert.equal(coordinator.status().handoffs.codex?.code, "turnRunning");
  agents.list = list;
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 1);
  const h = coordinator.status().handoffs.codex!;
  assert.equal(h.daemonOutcome, "restarted");
  assert.deepEqual(agents.reloads, ["c1"]);
  assert.equal(h.phase, "done");
  advance(61);
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 1, "cleared flag: no second restart");
});

test("Codex daemon: a pending flag without an event is picked up; a failed restart is not retried for 15 minutes", async () => {
  const { cli, agents, coordinator, advance } = setup({ restartCodexDaemon: true, reloadCodexAfterAutomaticSwitch: false });
  agents.agents = [agent("c1", "codex")];
  cli.daemonPending = true;
  cli.daemonOutcome = "failed";
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 1);
  const h = coordinator.status().handoffs.codex!;
  assert.equal(h.daemonOutcome, "failed");
  assert.deepEqual(agents.reloads, []);
  assert.match(h.message, /did not complete/);
  advance(61);
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 1);
  advance(900);
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 2);
  const quiet = setup();
  quiet.cli.daemonPending = true;
  await quiet.coordinator.tick(quiet.agents);
  assert.equal(quiet.cli.pendingReads, 0, "setting off: never read or restarted");
});

test("RH1: a terminal agy that shares the daemon's parent is outside Paseo; nothing is stopped", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity")];
  // The owner started the daemon from shell 400 and also runs agy from that shell.
  cli.processes = [proc(11), proc(12, [400, 1])];
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "waiting");
  assert.equal(h.code, "agyOutsidePaseo");
  assert.equal(cli.switches.length, 0);
});

test("RH1: an anchor that is not the Paseo daemon (shell, tmux, terminal, launchd, unknown) is never trusted", async () => {
  for (const executable of ["zsh", "tmux", "Terminal", "iTerm2", "launchd", "login", "node", null]) {
    const { cli, agents, coordinator } = setup({}, null, false, { paseoAnchor: 400 });
    agents.agents = [agent("a1", "antigravity")];
    cli.processes = [{ pid: 11, kind: "cli", ancestors: [{ pid: 400, executable }, { pid: 1, executable: "launchd" }], complete: true }];
    await coordinator.request("agy", target);
    await coordinator.tick(agents);
    const h = coordinator.status().handoffs.agy!;
    assert.equal(h.phase, "waiting", String(executable));
    assert.equal(h.code, "anchorUnverified");
    assert.equal(cli.switches.length, 0);
  }
  const none = setup({}, null, false, { paseoAnchor: null });
  none.agents.agents = [agent("a1", "antigravity")];
  none.cli.processes = [proc(11)];
  await none.coordinator.request("agy", target);
  await none.coordinator.tick(none.agents);
  assert.equal(none.coordinator.status().handoffs.agy?.code, "anchorUnverified");
});

test("RH1: the anchor is the forking daemon (ppid) for a forked plugin, the process itself otherwise", () => {
  assert.equal(paseoAnchorPid({ pid: 50, ppid: 40, forked: true }), 40);
  assert.equal(paseoAnchorPid({ pid: 50, ppid: 40, forked: false }), 50);
  assert.equal(paseoAnchorPid({ pid: 50, ppid: 1, forked: true }), null, "reparented to launchd: the daemon is gone");
});

test("RH2: more Paseo agy processes than idle Paseo agy agents waits", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity")];
  cli.processes = [proc(11), proc(12)];
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "waiting");
  assert.equal(h.code, "extraPaseoProcesses");
  assert.match(h.message, /2 Paseo agy processes/);
  assert.equal(cli.switches.length, 0);
});

test("RH3: agy started in a Paseo terminal pane (a shell between it and the daemon) is never Paseo's", async () => {
  for (const shell of ["zsh", "-zsh", "bash", "sh", "fish", "tmux", "login", "screen", "zellij", "Terminal", "iTerm2", "ghostty"]) {
    const { cli, agents, coordinator } = setup();
    // One idle Paseo agent without a live process; the terminal session would fill its slot by count.
    agents.agents = [agent("a1", "antigravity")];
    cli.processes = [{ pid: 12, kind: "cli", ancestors: [{ pid: 700, executable: shell }, { pid: paseoPid, executable: "Paseo Helper" }, { pid: 1, executable: "launchd" }], complete: true }];
    await coordinator.request("agy", target);
    await coordinator.tick(agents);
    const h = coordinator.status().handoffs.agy!;
    assert.equal(h.phase, "waiting", shell);
    assert.equal(h.code, "agyOutsidePaseo", shell);
    assert.equal(cli.switches.length, 0);
  }
  // An unreadable name between the process and the daemon proves nothing either.
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity")];
  cli.processes = [{ pid: 12, kind: "cli", ancestors: [{ pid: 700, executable: null }, { pid: paseoPid, executable: "Paseo Helper" }, { pid: 1, executable: "launchd" }], complete: true }];
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.code, "attributionUnknown");
  assert.equal(cli.switches.length, 0);
});


test("manual Codex switch events reload only after idle and are not replayed", async () => {
  const { cli, agents, coordinator, advance } = setup();
  agents.agents = [agent("c1","codex","running",true)];
  cli.events_ = [{id:"manual-1",transaction:"txn-1",at:1050,provider:"codex",kind:"switched"}];
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,[]);
  agents.agents = [agent("c1","codex")];
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1"]);
  advance(61); await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1"]);
  assert.equal(cli.switches.length,0);
});

test("plugin-owned switch transaction is not reloaded twice by its event", async () => {
  const {cli,agents,coordinator,advance,store} = setup();
  agents.agents = [agent("c1","codex")];
  cli.outcome = {kind:"switched",code:"switched",message:"verified",transaction:"own-txn"};
  await coordinator.request("codex",target);
  await coordinator.tick(agents);
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1"]);
  assert.ok(store.saved?.handledSwitches.includes("txn:own-txn"));
  cli.events_ = [{id:"own-event",transaction:"own-txn",at:1055,provider:"codex",kind:"switched"}];
  advance(61); await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1"]);
});


test("manual switch replay and older events are ignored after persisted dedupe", async () => {
  const initial = {schemaVersion:1,handoffs:{codex:null,agy:null},eventWatermark:1000,handledSwitches:["txn:handled"],notice:null};
  const {cli,agents,coordinator} = setup({},initial);
  agents.agents = [agent("c1","codex")];
  cli.events_ = [{id:"old",transaction:"old",at:900,provider:"codex",kind:"switched"},{id:"repeat",transaction:"handled",at:1050,provider:"codex",kind:"switched"}];
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,[]);
});

test("late and same-time switch events are handled by identity rather than newest timestamp", async () => {
  const {cli,agents,coordinator,advance} = setup();
  agents.agents = [agent("c1","codex")];
  cli.events_ = [{id:"newer",at:1100,provider:"codex",kind:"switched"}];
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1"]);
  advance(61);
  cli.events_.push({id:"late",at:1050,provider:"codex",kind:"switched"},{id:"same-time",at:1100,provider:"codex",kind:"switched"});
  await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1","c1"]);
  advance(61); await coordinator.tick(agents);
  assert.deepEqual(agents.reloads,["c1","c1"]);
  assert.ok(cli.eventReads.every((since) => since === 1000));
});

test("maximum event identifiers never invalidate the persisted dedupe state", async () => {
  const {handoffStateSchema} = await import("../shared/handoff.js");
  for (const field of ["transaction","id"] as const) {
    const {cli,agents,coordinator,store,advance} = setup();
    agents.agents = [agent("c1","codex")];
    cli.events_ = [{id:"event",at:1050,provider:"codex",kind:"switched",[field]:"x".repeat(512)}];
    await coordinator.tick(agents);
    assert.equal(handoffStateSchema.safeParse(store.saved).success,true);
    assert.ok(store.saved!.handledSwitches.every((key) => key.length <= 512));
    advance(61); await coordinator.tick(agents);
    assert.deepEqual(agents.reloads,["c1"]);
    const restarted = setup({},store.saved);
    restarted.agents.agents = [agent("c1","codex")];
    restarted.cli.events_ = cli.events_;
    await restarted.coordinator.tick(restarted.agents);
    assert.equal(restarted.store.setAsideCalls,0);
    assert.deepEqual(restarted.agents.reloads,[]);
  }
});

// 0.9.0: limited-agent continuation may start after a verified Codex switch (the plugin's own reload
// of the agent adopts the new login; a successful daemon restart is not required).
test("adoption is reported for every verified manual Codex switch, whatever the daemon restart did", async () => {
  for (const [kind, daemonOutcome, expectAdopted] of [
    ["switched", "restarted", true],
    ["switched", "pending", true],
    ["switched", "failed", true],
    ["switched", "busy", true],
    ["switched", "not-requested", true],
    ["unchanged", "restarted", false],
  ] as const) {
    const { cli, agents, coordinator } = setup({ restartCodexDaemon: true });
    const adopted: [string, string | null][] = [];
    coordinator.onCodexAdopted = (key, account) => void adopted.push([key, account]);
    agents.agents = [agent("c1", "codex")];
    cli.outcome = { kind, code: kind, message: "ok", daemonOutcome, transaction: "T1" };
    await coordinator.request("codex", target);
    await coordinator.tick(agents);
    assert.deepEqual(adopted, expectAdopted ? [["txn:T1", target]] : [], `${kind}/${daemonOutcome}`);
  }
});
test("manual switch with the daemon restart opt-in off is still adopted", async () => {
  const { cli, agents, coordinator } = setup({ restartCodexDaemon: false });
  const adopted: string[] = [];
  coordinator.onCodexAdopted = (key) => void adopted.push(key);
  agents.agents = [agent("c1", "codex")];
  cli.outcome = { kind: "switched", code: "switched", message: "ok", daemonOutcome: "not-requested", transaction: "T2" };
  await coordinator.request("codex", target);
  await coordinator.tick(agents);
  assert.deepEqual(adopted, ["txn:T2"]);
  assert.equal(cli.daemonRestarts, 0, "continuation never enables the restart");
});
test("a manual switch without a transaction identity is never adopted", async () => {
  const { cli, agents, coordinator } = setup({ restartCodexDaemon: true });
  const adopted: string[] = [];
  coordinator.onCodexAdopted = (key) => void adopted.push(key);
  agents.agents = [agent("c1", "codex")];
  cli.outcome = { kind: "switched", code: "switched", message: "ok", daemonOutcome: "restarted" };
  await coordinator.request("codex", target);
  await coordinator.tick(agents);
  assert.deepEqual(adopted, []);
});
test("an automatic switch is adopted at the idle boundary, keyed by its switch event and time", async () => {
  for (const [restartCodexDaemon, outcome, expected] of [
    [true, "restarted", ["txn:T9"]],
    [true, "failed", ["txn:T9"]],
    [true, "busy", []],
    [false, "restarted", ["txn:T9"]],
  ] as const) {
    const { cli, agents, coordinator } = setup({ restartCodexDaemon });
    const adopted: [string, number | null][] = [];
    coordinator.onCodexAdopted = (key, _account, switchedAt) => void adopted.push([key, switchedAt]);
    agents.agents = [agent("c1", "codex")];
    cli.daemonPending = true;
    cli.daemonOutcome = outcome;
    cli.events_ = [{ id: "e1", transaction: "T9", at: 2000, provider: "codex", kind: "automaticSwitch" }];
    await coordinator.tick(agents);
    await coordinator.tick(agents);
    assert.deepEqual(adopted, expected.map((k) => [k, 2000]), `${restartCodexDaemon}/${outcome}`);
  }
});
test("automatic switch events are watched for continuation even when reload and restart are both off", async () => {
  const { cli, agents, coordinator } = setup({ restartCodexDaemon: false, reloadCodexAfterAutomaticSwitch: false });
  const adopted: string[] = [];
  coordinator.onCodexAdopted = (key) => void adopted.push(key);
  agents.agents = [agent("c1", "codex")];
  cli.events_ = [{ id: "e1", transaction: "T9", at: 2000, provider: "codex", kind: "automaticSwitch" }];
  await coordinator.tick(agents);
  await coordinator.tick(agents);
  assert.deepEqual(adopted, ["txn:T9"]);
  assert.deepEqual(agents.reloads, [], "the handoff itself reloads nothing");
});
test("with continuation off, switch events are not watched when reload and restart are off", async () => {
  const { cli, agents, coordinator } = setup({ restartCodexDaemon: false, reloadCodexAfterAutomaticSwitch: false, resumeLimitedCodexAgents: false });
  cli.events_ = [{ id: "e1", transaction: "T9", at: 2000, provider: "codex", kind: "automaticSwitch" }];
  await coordinator.tick(agents);
  assert.deepEqual(cli.eventReads, []);
});
test("a daemon restart that is merely pending from an unknown switch is not adopted", async () => {
  const { cli, agents, coordinator } = setup({ restartCodexDaemon: true });
  const adopted: string[] = [];
  coordinator.onCodexAdopted = (key) => void adopted.push(key);
  agents.agents = [agent("c1", "codex")];
  cli.daemonPending = true;
  await coordinator.tick(agents);
  await coordinator.tick(agents);
  assert.equal(cli.daemonRestarts, 1);
  assert.deepEqual(adopted, []);
});
