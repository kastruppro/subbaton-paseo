import test from "node:test";
import assert from "node:assert/strict";
import {
  HandoffCoordinator,
  paseoAgentPort,
  type AgentSnapshot,
  type HandoffCli,
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
class FakeCli implements HandoffCli {
  switches: { provider: string; target: string; flags: string[] }[] = [];
  processes: { kind: string }[] | null = [];
  outcome: SwitchOutcome = { kind: "switched", code: "switched", message: "Switched.", daemonOutcome: "not-requested" };
  events_: { at: number; provider: string; kind: string }[] = [];
  eventReads: (number | null)[] = [];
  gate: Promise<void> | null = null;
  async agyProcesses() {
    return this.processes ? { ok: true as const, processes: this.processes } : { ok: false as const };
  }
  async switchAccount(provider: "codex" | "agy", t: string, flags: string[]) {
    this.switches.push({ provider, target: t, flags });
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
  constructor(public initial: unknown = null) {}
  async load() {
    return this.initial;
  }
  async save(state: HandoffState) {
    this.saved = structuredClone(state);
  }
}
const setup = (settings: Partial<HandoffSettings> = {}, initial: unknown = null) => {
  const cli = new FakeCli();
  const agents = new FakeAgents();
  const store = new MemoryStore(initial);
  let now = 1000;
  const coordinator = new HandoffCoordinator(
    cli,
    store,
    async () => ({ reloadCodexAfterAutomaticSwitch: true, restartCodexDaemon: false, idleWaitMinutes: 30, ...settings }),
    () => now,
    (() => {
      let n = 0;
      return () => `h${++n}`;
    })(),
  );
  return { cli, agents, store, coordinator, advance: (s: number) => (now += s) };
};

test("agy: waits for idle, stops only via the CLI, switches, then reloads only the affected agy agents", async () => {
  const { cli, agents, coordinator } = setup();
  agents.agents = [agent("a1", "antigravity"), agent("a2", "antigravity", "running", true), agent("c1", "codex"), agent("k1", "claude", "running", true)];
  cli.processes = [{ kind: "cli" }, { kind: "cli" }];
  assert.equal((await coordinator.request("agy", target)).result.outcome, "success");
  await coordinator.tick(agents);
  assert.equal(coordinator.status().handoffs.agy?.phase, "waiting");
  assert.equal(coordinator.status().handoffs.agy?.waitingFor, 1);
  assert.equal(cli.switches.length, 0);
  assert.deepEqual(agents.reloads, []);
  agents.agents[1] = agent("a2", "antigravity");
  await coordinator.tick(agents);
  assert.deepEqual(cli.switches, [{ provider: "agy", target, flags: ["--stop-agy"] }]);
  assert.deepEqual(agents.reloads, ["a1", "a2"]);
  const h = coordinator.status().handoffs.agy!;
  assert.equal(h.phase, "done");
  assert.deepEqual(h.affected, ["a1", "a2"]);
});

test("agy: sessions outside Paseo block the handoff instead of being stopped", async () => {
  for (const processes of [[{ kind: "cli" }, { kind: "cli" }], [{ kind: "desktop" }], null]) {
    const { cli, agents, coordinator } = setup();
    agents.agents = [agent("a1", "antigravity")];
    cli.processes = processes;
    await coordinator.request("agy", target);
    await coordinator.tick(agents);
    const h = coordinator.status().handoffs.agy!;
    assert.equal(h.phase, "waiting");
    assert.equal(h.code, processes ? "agyOutsidePaseo" : "processUnknown");
    assert.equal(cli.switches.length, 0);
  }
});

test("agy without running processes switches without --stop-agy", async () => {
  const { cli, agents, coordinator } = setup();
  cli.processes = [];
  await coordinator.request("agy", target);
  await coordinator.tick(agents);
  assert.deepEqual(cli.switches[0]?.flags, []);
  assert.equal(coordinator.status().handoffs.agy?.phase, "done");
});

test("uncertain, refused and stopped-but-failed switches never reopen; an explicit reopen does", async () => {
  for (const kind of ["uncertain", "refused", "stoppedFailed"] as const) {
    const { cli, agents, coordinator } = setup();
    agents.agents = [agent("a1", "antigravity")];
    cli.processes = [{ kind: "cli" }];
    cli.outcome = { kind, code: kind === "refused" ? "needsLogin" : kind, message: "CLI said no." };
    await coordinator.request("agy", target);
    await coordinator.tick(agents);
    const h = coordinator.status().handoffs.agy!;
    assert.equal(h.phase, kind === "uncertain" ? "uncertain" : "failed", kind);
    assert.deepEqual(agents.reloads, []);
    if (kind === "refused") {
      assert.match(h.message, /No agents were closed/);
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
    assert.deepEqual(cli.switches[0]?.flags, restart ? ["--restart-daemon"] : []);
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
  const original = agents.list.bind(agents);
  let calls = 0;
  agents.list = async () => (++calls === 2 ? (await original()).filter((a) => a.id !== "c2") : original());
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

test("waiting expires after the idle window without changing anything; cancel works only while waiting", async () => {
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
  assert.equal((await coordinator.control("agy", "cancel")).result.code, "notWaiting");
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
  const { cli, agents, coordinator } = setup({ reloadCodexAfterAutomaticSwitch: false });
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
