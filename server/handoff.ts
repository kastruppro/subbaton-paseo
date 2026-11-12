import { z } from "zod";
import type { ActionResult } from "../shared/contracts.js";
import {
  activePhases,
  handoffProviders,
  handoffStateSchema,
  paseoProviderId,
  type Handoff,
  type HandoffProvider,
  type HandoffSettings,
  type HandoffState,
} from "../shared/handoff.js";

// Idle-aware coordinated handoff (phase 6b part 2). It waits until every affected Paseo agent of the
// provider is idle, lets the CLI switch (agy: --stop-agy stops the idle agy runtimes), then reopens
// the affected agents with agent.reload(). It never interrupts a running turn on purpose, never
// reopens with agent.refresh(), never touches Claude agents or terminal sessions, and persists every
// phase so a Paseo restart resumes or reports safely.

export interface AgentSnapshot {
  id: string;
  provider: string;
  status: string;
  activeTurn: boolean;
}
/** The only agent operations the coordinator uses. There is deliberately no refresh() here. */
export interface AgentPort {
  list(): Promise<AgentSnapshot[]>;
  reload(id: string): Promise<void>;
}
export type SwitchKind = "switched" | "unchanged" | "refused" | "stoppedFailed" | "uncertain" | "busy";
export interface SwitchOutcome {
  kind: SwitchKind;
  code: string;
  message: string;
  daemonOutcome?: string | null;
}
export interface HandoffCli {
  agyProcesses(): Promise<{ ok: true; processes: { kind: string }[] } | { ok: false }>;
  switchAccount(provider: HandoffProvider, target: string, flags: string[]): Promise<SwitchOutcome>;
  events(since: number | null): Promise<{ ok: true; events: { at: number; provider: string; kind: string }[] } | { ok: false }>;
  knownAccount(provider: HandoffProvider, target: string): { alias: string } | null;
}
export interface HandoffStore {
  load(): Promise<unknown | null>;
  save(state: HandoffState): Promise<void>;
}

const busyStatus = (a: AgentSnapshot) => a.activeTurn || a.status === "running" || a.status === "initializing";
const terminal = (h: Handoff | null) => !h || !(activePhases as readonly string[]).includes(h.phase);
const ok = (code: string, message: string): ActionResult => ({ outcome: "success", code, message });
const refuse = (code: string, message: string): ActionResult => ({ outcome: "error", code, message });

export class HandoffCoordinator {
  private state: HandoffState = { schemaVersion: 1, handoffs: { codex: null, agy: null }, eventWatermark: null };
  private ready: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastEventPoll = -Infinity;
  agentApiSeen = false;

  constructor(
    private cli: HandoffCli,
    private store: HandoffStore,
    private settings: () => Promise<HandoffSettings>,
    private now: () => number = () => Date.now() / 1000,
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Loads persisted state once. A handoff interrupted while the CLI switch ran becomes uncertain. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      let raw: unknown = null;
      try {
        raw = await this.store.load();
      } catch {
        raw = null;
      }
      const parsed = handoffStateSchema.safeParse(raw);
      if (parsed.success) this.state = parsed.data;
      let changed = !parsed.success && raw !== null;
      for (const provider of handoffProviders) {
        const h = this.state.handoffs[provider];
        if (h?.phase === "switching") {
          this.update(h, {
            phase: "uncertain",
            code: "interrupted",
            message:
              "Paseo restarted while the SubBaton switch was running. Check the active account and pending recovery with the SubBaton CLI on the Mac, then use Reopen agents.",
          });
          changed = true;
        }
      }
      if (this.state.eventWatermark === null) {
        this.state.eventWatermark = this.now();
        changed = true;
      }
      if (changed) await this.persist();
    })();
    return this.ready;
  }
  private update(h: Handoff, patch: Partial<Handoff>) {
    Object.assign(h, patch, { updatedAt: this.now() });
  }
  private async persist() {
    await this.store.save(this.state);
  }
  /** Serialises every state change: single flight per provider and across ticks/requests. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.init()).then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  status() {
    return { handoffs: { ...this.state.handoffs }, agentApi: this.agentApiSeen };
  }
  hasActive() {
    return handoffProviders.some((p) => !terminal(this.state.handoffs[p]));
  }

  request(provider: HandoffProvider, target: string): Promise<{ result: ActionResult; handoff: Handoff | null }> {
    return this.serial(async () => {
      const current = this.state.handoffs[provider];
      if (!terminal(current))
        return { result: refuse("busy", "A handoff for this provider is already in progress."), handoff: current };
      const account = this.cli.knownAccount(provider, target);
      if (!account)
        return { result: refuse("unknownAccount", "Reload status and choose a known saved account."), handoff: current };
      const settings = await this.settings();
      const now = this.now();
      const handoff: Handoff = {
        id: this.newId(),
        provider,
        target,
        targetAlias: account.alias,
        trigger: "manual",
        restartDaemon: provider === "codex" && settings.restartCodexDaemon,
        phase: "waiting",
        requestedAt: now,
        deadline: now + settings.idleWaitMinutes * 60,
        updatedAt: now,
        waitingFor: 0,
        code: "queued",
        message: "Waiting until every Paseo agent of this provider is idle.",
        affected: [],
        reopened: [],
        failedReopen: [],
        daemonOutcome: null,
      };
      this.state.handoffs[provider] = handoff;
      await this.persist();
      return { result: ok("queued", "The switch runs as soon as every affected Paseo agent is idle."), handoff };
    });
  }

  control(provider: HandoffProvider, action: "cancel" | "reopen" | "dismiss") {
    return this.serial(async () => {
      const h = this.state.handoffs[provider];
      if (!h) return { result: refuse("noHandoff", "There is no handoff for this provider."), handoff: null };
      if (action === "cancel") {
        if (h.phase !== "waiting")
          return { result: refuse("notWaiting", "Only a handoff that is still waiting can be cancelled."), handoff: h };
        this.update(h, { phase: "cancelled", code: "cancelled", message: "Cancelled before anything changed." });
      } else if (action === "reopen") {
        const pending = h.affected.filter((id) => !h.reopened.includes(id));
        if (!["uncertain", "failed"].includes(h.phase) || pending.length === 0)
          return { result: refuse("nothingToReopen", "No closed agents are waiting to be reopened."), handoff: h };
        // Explicit owner decision after inspecting the login on the Mac.
        this.update(h, { phase: "reopening", failedReopen: [], code: "reopenRequested", message: "Reopening the closed agents as requested." });
      } else {
        if (!terminal(h)) return { result: refuse("active", "A running handoff cannot be dismissed; cancel it while it waits."), handoff: h };
        this.state.handoffs[provider] = null;
        await this.persist();
        return { result: ok("dismissed", "Cleared."), handoff: null };
      }
      await this.persist();
      return { result: ok(action, h.message), handoff: h };
    });
  }

  /** One coordination step for every provider. Without an agent API nothing is switched or reopened. */
  tick(agents: AgentPort | null): Promise<void> {
    return this.serial(async () => {
      if (agents) this.agentApiSeen = true;
      await this.pollEvents();
      for (const provider of handoffProviders) {
        const h = this.state.handoffs[provider];
        if (!h || terminal(h)) continue;
        try {
          await this.step(h, agents);
        } catch {
          // An agent API failure leaves the phase as it is; the next tick retries.
          this.update(h, { code: "agentApiUnavailable", message: "Paseo's agent API did not answer; retrying." });
        }
        await this.persist();
      }
    });
  }

  private async pollEvents() {
    if (this.now() - this.lastEventPoll < 60 || !terminal(this.state.handoffs.codex)) return;
    const settings = await this.settings();
    if (!settings.reloadCodexAfterAutomaticSwitch) return;
    this.lastEventPoll = this.now();
    const read = await this.cli.events(this.state.eventWatermark);
    if (!read.ok) return;
    const watermark = this.state.eventWatermark ?? 0;
    const fresh = read.events.filter((e) => e.at > watermark);
    if (fresh.length === 0) return;
    this.state.eventWatermark = Math.max(...fresh.map((e) => e.at));
    if (!fresh.some((e) => e.provider === "codex" && e.kind === "automaticSwitch")) {
      await this.persist();
      return;
    }
    const now = this.now();
    this.state.handoffs.codex = {
      id: this.newId(),
      provider: "codex",
      target: null,
      targetAlias: null,
      trigger: "automaticSwitch",
      restartDaemon: false,
      phase: "waiting",
      requestedAt: now,
      deadline: now + settings.idleWaitMinutes * 60,
      updatedAt: now,
      waitingFor: 0,
      code: "queued",
      message: "Codex switched automatically. Waiting until Paseo Codex agents are idle to reload them with the new login.",
      affected: [],
      reopened: [],
      failedReopen: [],
      daemonOutcome: null,
    };
    await this.persist();
  }

  private async step(h: Handoff, agents: AgentPort | null) {
    if (h.phase === "waiting" && this.now() > h.deadline) {
      this.update(h, {
        phase: "expired",
        code: "idleTimeout",
        message: "Agents stayed busy until the wait ended. Nothing was switched or reopened.",
      });
      return;
    }
    if (!agents) {
      this.update(h, { code: "agentApiUnavailable", message: "Waiting for Paseo's agent API (open a Paseo client or finish a turn)." });
      return;
    }
    if (h.phase === "waiting") await this.waitAndSwitch(h, agents);
    if (h.phase === "reopening") await this.reopen(h, agents);
  }

  private async waitAndSwitch(h: Handoff, agents: AgentPort) {
    const mine = (await agents.list()).filter((a) => a.provider === paseoProviderId[h.provider]);
    const busy = mine.filter(busyStatus);
    if (busy.length > 0) {
      this.update(h, {
        waitingFor: busy.length,
        code: "turnRunning",
        message: `Waiting for ${busy.length} running ${busy.length === 1 ? "turn" : "turns"} to finish. Nothing is interrupted.`,
      });
      return;
    }
    const affected = mine.filter((a) => a.status === "idle").map((a) => a.id);
    if (h.target === null) {
      this.update(h, { phase: affected.length ? "reopening" : "done", affected, waitingFor: 0, code: affected.length ? "reloading" : "nothingToReload", message: affected.length ? "Reloading idle Codex agents with the new login." : "No Paseo Codex agents needed a reload." });
      return;
    }
    const flags: string[] = [];
    if (h.provider === "agy") {
      const inventory = await this.cli.agyProcesses();
      if (!inventory.ok) {
        this.update(h, { waitingFor: 1, code: "processUnknown", message: "The agy process list is unavailable; waiting rather than guessing." });
        return;
      }
      const outside = inventory.processes.filter((p) => p.kind !== "cli").length + Math.max(0, inventory.processes.filter((p) => p.kind === "cli").length - affected.length);
      if (outside > 0) {
        this.update(h, {
          waitingFor: outside,
          code: "agyOutsidePaseo",
          message: `${outside} agy ${outside === 1 ? "session runs" : "sessions run"} outside Paseo (terminal or desktop). Finish ${outside === 1 ? "it" : "them"}; SubBaton never stops them for Paseo.`,
        });
        return;
      }
      if (inventory.processes.length > 0) flags.push("--stop-agy");
    } else if (h.restartDaemon) flags.push("--restart-daemon");
    // Persist the affected set before the CLI runs so a crash can be reported precisely.
    this.update(h, { phase: "switching", affected, waitingFor: 0, code: "switching", message: h.provider === "agy" && affected.length ? `Closing ${affected.length} idle agy ${affected.length === 1 ? "agent" : "agents"} and switching.` : "Switching." });
    await this.persist();
    const out = await this.cli.switchAccount(h.provider, h.target, flags);
    const daemonOutcome = out.daemonOutcome ?? null;
    switch (out.kind) {
      case "busy":
        this.update(h, { phase: "waiting", code: "busy", message: "Another SubBaton action is running; retrying." });
        return;
      case "switched":
      case "unchanged": {
        const reload = h.provider === "agy" ? affected.length > 0 : out.kind === "switched" && affected.length > 0;
        this.update(h, {
          phase: reload ? "reopening" : "done",
          daemonOutcome,
          code: out.kind === "switched" ? "switched" : "alreadyActive",
          message: reload ? "Switch verified. Reopening agents with their saved conversations." : out.kind === "switched" ? "Switch verified. No Paseo agents needed reopening." : "That account was already active.",
        });
        return;
      }
      case "refused":
        this.update(h, { phase: "failed", daemonOutcome, code: out.code, message: `${out.message} No agents were closed.` });
        return;
      case "stoppedFailed":
        this.update(h, {
          phase: "failed",
          daemonOutcome,
          code: out.code,
          message: `${out.message} The agy agents were stopped and stay closed. Inspect the login and recovery with the SubBaton CLI on the Mac, then use Reopen agents.`,
        });
        return;
      default:
        this.update(h, {
          phase: "uncertain",
          daemonOutcome,
          code: "uncertain",
          message: `${out.message} Affected agents stay closed until you check the login on the Mac and choose Reopen agents.`,
        });
    }
  }

  private async reopen(h: Handoff, agents: AgentPort) {
    const snapshots = await agents.list();
    let waiting = 0;
    for (const id of h.affected) {
      if (h.reopened.includes(id) || h.failedReopen.includes(id)) continue;
      const snap = snapshots.find((a) => a.id === id);
      if (!snap) {
        h.failedReopen.push(id);
        continue;
      }
      if (busyStatus(snap)) {
        // reload() interrupts a running turn, so a reopened-and-busy agent waits.
        waiting++;
        continue;
      }
      try {
        await agents.reload(id);
        h.reopened.push(id);
      } catch {
        h.failedReopen.push(id);
      }
    }
    if (waiting > 0) {
      this.update(h, { waitingFor: waiting, code: "reopenWaiting", message: `Reopened ${h.reopened.length}; ${waiting} still in a turn.` });
      return;
    }
    const failed = h.failedReopen.length;
    this.update(h, {
      phase: failed ? "failed" : "done",
      waitingFor: 0,
      code: failed ? "reopenFailed" : "completed",
      message: failed
        ? `Reopened ${h.reopened.length}; ${failed} could not be reopened (archived or reload failed). Reopen them from Paseo.`
        : `Done. Reopened ${h.reopened.length} ${h.reopened.length === 1 ? "agent" : "agents"} with the new login.`,
    });
  }
}

const agentEntry = z.object({
  agent: z.object({
    id: z.string().max(256),
    provider: z.string().max(128),
    status: z.string().max(32),
    activeTurn: z.object({}).passthrough().nullable().optional(),
    archivedAt: z.string().nullable().optional(),
  }),
});
interface PaseoAgentsLike {
  agents: {
    list(options: unknown): Promise<{ entries: unknown[]; pageInfo?: { hasMore?: boolean; nextCursor?: string | null } }>;
    ref(id: string): { reload(options?: { requestId?: string }): Promise<unknown> };
  };
}
/** Adapts the SDK's PaseoApi (from an RPC or hook context) to the coordinator's agent port. */
export function paseoAgentPort(api: unknown): AgentPort | null {
  const paseo = api as PaseoAgentsLike | null;
  if (!paseo?.agents || typeof paseo.agents.list !== "function" || typeof paseo.agents.ref !== "function") return null;
  return {
    async list() {
      const result: AgentSnapshot[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const response = await paseo.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const entry of response.entries) {
          const parsed = agentEntry.safeParse(entry);
          if (!parsed.success || parsed.data.agent.archivedAt) continue;
          const a = parsed.data.agent;
          result.push({ id: a.id, provider: a.provider, status: a.status, activeTurn: !!a.activeTurn });
        }
        if (!response.pageInfo?.hasMore || !response.pageInfo.nextCursor) return result;
        cursor = response.pageInfo.nextCursor;
      }
      throw new Error("Too many agents to list safely.");
    },
    async reload(id) {
      await paseo.agents.ref(id).reload({ requestId: `subbaton-handoff-${id}` });
    },
  };
}
