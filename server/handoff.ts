import { z } from "zod";
import { createHash } from "node:crypto";
import { ReloadLedger } from "./reload-ledger.js";
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
  /** Only the limited-agent continuation sends a message (one explicit continuation, never a replay). */
  send?(id: string, text: string): Promise<void>;
}
/** notAllowed: an agy process outside the --only-pids list ran, nothing changed. notRun: auto run-once did nothing. */
export type SwitchKind = "switched" | "unchanged" | "refused" | "notAllowed" | "notRun" | "stoppedFailed" | "stoppedNoSwitch" | "uncertain" | "busy";
export interface SwitchOutcome {
  kind: SwitchKind;
  code: string;
  message: string;
  transaction?: string;
  daemonOutcome?: string | null;
  /** agy auto run-once: the CLI's 15-minute hold after a failed stop (Unix seconds). */
  retryAt?: number;
  /** stoppedNoSwitch: a stopped session had no saved conversation ID, so its agent may restart without its thread. */
  manualResumeRequired?: boolean;
}
/** One agy process as the CLI reports it; ancestors is null when the CLI gives no ancestry. */
export interface AgyProcessInfo {
  pid: number;
  kind: string;
  /** Parent first, up to launchd; executable is the CLI-reported basename (null when unreadable). */
  ancestors: { pid: number; executable: string | null }[] | null;
  /** True only when the chain reached PID 1, so a missing Paseo PID really means "not Paseo's". */
  complete: boolean;
}
export interface SwitchOptions {
  /** agy: stop exactly these PIDs (all of them Paseo's); the CLI refuses if any other agy runs. */
  onlyPids?: number[];
  /** Codex: pass --restart-daemon. */
  restartDaemon?: boolean;
}
export interface HandoffCli {
  agyProcesses(): Promise<{ ok: true; processes: AgyProcessInfo[] } | { ok: false }>;
  switchAccount(provider: HandoffProvider, target: string, options: SwitchOptions): Promise<SwitchOutcome>;
  events(since: number | null): Promise<{ ok: true; events: { id?: string; transaction?: string; target?: string; at: number; provider: string; kind: string }[] } | { ok: false }>;
  knownAccount(provider: HandoffProvider, target: string): { alias: string } | null;
  /** agy auto plan: whether running agy processes are the only blocker of an automatic switch. */
  agyAutoPlan(): Promise<{ ok: true; blockedOnlyByProcesses: boolean; target: string | null } | { ok: false }>;
  /** agy auto run-once --stop-agy --only-pids. */
  agyAutoRunOnce(onlyPids: number[]): Promise<SwitchOutcome>;
  /** codex processes daemonRestartPending; null when unknown. */
  codexDaemonPending(): Promise<boolean | null>;
  /** codex daemon restart: restarted, failed, pending, unknown or busy. */
  codexDaemonRestart(): Promise<string>;
}
export interface HandoffStore {
  load(): Promise<unknown | null>;
  save(state: HandoffState): Promise<void>;
  /** Moves an unreadable or unsupported state file aside; returns its new name. */
  setAside?(): Promise<string | null>;
}
export interface CoordinatorOptions {
  /** PID of the Paseo daemon, the process that spawns agents (see paseoAnchorPid); null: none known. */
  paseoAnchor?: number | null;
  listTimeoutMs?: number;
  reloadTimeoutMs?: number;
  /** How long request/control wait for a running step before answering busy. */
  fastWaitMs?: number;
}
const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * Review RH1: the process that spawns Paseo's agents. Paseo forks each plugin server from the daemon
 * with an IPC channel (server/plugins/runtime.js in Paseo 0.15), so a forked plugin's parent is the
 * daemon. Without that channel the plugin would run inside the daemon itself. A parent of PID 1
 * means the daemon is gone. The anchor is still verified by its executable name before it is used.
 */
export function paseoAnchorPid(own: { pid: number; ppid: number; forked: boolean } = { pid: process.pid, ppid: process.ppid, forked: typeof process.send === "function" }): number | null {
  const pid = own.forked ? own.ppid : own.pid;
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}
/**
 * Executable basenames of the Paseo daemon as the CLI reports them (proc_pidpath). The desktop app's
 * daemon runs as "Paseo Helper" (its title "Paseo Daemon" is not the executable). Shells, tmux,
 * terminal apps, launchd and a generic "node" are never accepted; a daemon run another way fails closed.
 */
export const paseoDaemonExecutables = ["Paseo Helper", "Paseo"];
/**
 * Review RH3: shells, multiplexers and terminal apps. One of these between an agy process and the
 * daemon means a person started it (for example in a Paseo terminal pane), so it is not an agent's.
 * Compared case-insensitively; a login shell's leading "-" is ignored.
 */
const interactiveExecutables = new Set(
  [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish", "pwsh", "powershell",
    "tmux", "screen", "zellij", "abduco", "dtach", "mosh-server", "sshd", "login", "su", "sudo", "script",
    "terminal", "iterm2", "ghostty", "kitty", "alacritty", "wezterm", "wezterm-gui", "hyper", "warp", "stable", "tabby", "rio",
  ],
);
const interactive = (name: string) => interactiveExecutables.has(name.replace(/^-/, "").toLowerCase());
/** Not running a turn and safe to reload: idle, and for Codex also an agent that stopped in an error (for example a usage limit). */
const reloadable = (provider: HandoffProvider, a: AgentSnapshot) => a.status === "idle" || (provider === "codex" && a.status === "error" && !a.activeTurn);
const MANUAL_RESUME_NOTE = " A stopped session had no saved conversation ID (no saved conversation), so that agent may start without its thread.";
/** A Codex handoff that already switched and only waits to reload running agents one by one may be taken over by a newer switch. */
const supersedable = (h: Handoff | null) => !!h && h.provider === "codex" && h.phase === "reopening";
const busyStatus = (a: AgentSnapshot) => a.activeTurn || a.status === "running" || a.status === "initializing";
const terminal = (h: Handoff | null) => !h || !(activePhases as readonly string[]).includes(h.phase);
const ok = (code: string, message: string): ActionResult => ({ outcome: "success", code, message });
const refuse = (code: string, message: string): ActionResult => ({ outcome: "error", code, message });

export class HandoffCoordinator {
  private state: HandoffState = { schemaVersion: 1, handoffs: { codex: null, agy: null }, eventWatermark: null, handledSwitches: [], notice: null };
  private ready: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Handoffs whose agy sessions were stopped for renewal without a switch (only the final message differs). */
  private noSwitch = new Map<string, boolean>();
  private lastEventPoll = -Infinity;
  private lastAgyPlan = -Infinity;
  private agyRetryAt = -Infinity;
  private lastDaemonAttempt = -Infinity;
  private queuedTick: Promise<void> | null = null;
  private tickPort: AgentPort | null = null;
  private running = false;
  agentApiSeen = false;
  /** Called once per verified Codex switch with a known identity (account = switch target, when known). */
  /** Shared with the limited-agent recovery: one reload per Codex agent per adopted switch. */
  ledger = new ReloadLedger();
  onCodexAdopted: ((switchKey: string, account: string, switchedAt: number | null) => void) | null = null;
  private paseoAnchor: number | null;
  private listTimeoutMs: number;
  private reloadTimeoutMs: number;
  private fastWaitMs: number;

  constructor(
    private cli: HandoffCli,
    private store: HandoffStore,
    private settings: () => Promise<HandoffSettings>,
    private now: () => number = () => Date.now() / 1000,
    private newId: () => string = () => crypto.randomUUID(),
    options: CoordinatorOptions = {},
  ) {
    const anchor = options.paseoAnchor === undefined ? paseoAnchorPid() : options.paseoAnchor;
    this.paseoAnchor = anchor !== null && Number.isInteger(anchor) && anchor > 1 ? anchor : null;
    this.listTimeoutMs = options.listTimeoutMs ?? 10_000;
    this.reloadTimeoutMs = options.reloadTimeoutMs ?? 60_000;
    this.fastWaitMs = options.fastWaitMs ?? 2_000;
  }

  /** Loads persisted state once. A handoff interrupted while the CLI switch ran becomes uncertain. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      let raw: unknown = null;
      let unreadable = false;
      try {
        raw = await this.store.load();
      } catch {
        unreadable = true;
      }
      const parsed = handoffStateSchema.safeParse(raw);
      if (parsed.success) this.state = parsed.data;
      let changed = !parsed.success && raw !== null;
      if (unreadable || (!parsed.success && raw !== null)) {
        // Review L3: never interpret it, but keep it and tell the owner a handoff may have been cut off.
        let kept: string | null = null;
        try {
          kept = (await this.store.setAside?.()) ?? null;
        } catch {
          kept = null;
        }
        this.state.notice = {
          code: "stateUnreadable",
          message: `The saved handoff state could not be read${kept ? ` and was kept as ${kept}` : ""}. A handoff may have been interrupted: check the active Codex/agy account with the SubBaton CLI on the Mac and reopen closed agents from Paseo if needed.`,
        };
        changed = true;
      }
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
    const run = this.chain
      .then(() => this.init())
      .then(async () => {
        this.running = true;
        try {
          return await work();
        } finally {
          this.running = false;
        }
      });
    this.chain = run.catch(() => undefined);
    return run;
  }
  /** Owner actions answer busy instead of hanging behind a long or stuck step (review L2). */
  private async fast<T>(work: () => Promise<T>, busy: T): Promise<T> {
    let abandoned = false;
    let started = false;
    const run = this.serial(async () => {
      if (abandoned) return busy;
      started = true;
      return work();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.fastWaitMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const first = await Promise.race([run, wait]);
    clearTimeout(timer);
    if (first === "timeout" && !started) {
      abandoned = true;
      return busy;
    }
    return run;
  }

  status() {
    return { handoffs: { ...this.state.handoffs }, agentApi: this.agentApiSeen, notice: this.state.notice };
  }
  hasActive() {
    return handoffProviders.some((p) => !terminal(this.state.handoffs[p]));
  }

  request(provider: HandoffProvider, target: string): Promise<{ result: ActionResult; handoff: Handoff | null }> {
    const busy = { result: refuse("busy", "The handoff coordinator is busy (a switch or reopen is running). Retry shortly."), handoff: this.state.handoffs[provider] };
    return this.fast(async () => {
      const current = this.state.handoffs[provider];
      // A Codex handoff that is only reloading running agents one by one does not block a new request: the new one
      // takes over (its own ledger key reloads every agent onto the new login).
      if (!terminal(current) && !supersedable(current))
        return { result: refuse("busy", "A handoff for this provider is already in progress."), handoff: current };
      const account = this.cli.knownAccount(provider, target);
      if (!account)
        return { result: refuse("unknownAccount", "Reload status and choose a known saved account."), handoff: current };
      if (current && !terminal(current)) this.supersede(current, true);
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
        switchKey: null,
        switchedAt: null,
        switchTarget: null,
      };
      this.state.handoffs[provider] = handoff;
      await this.persist();
      return { result: ok("queued", "The switch runs as soon as every affected Paseo agent is idle."), handoff };
    }, busy);
  }

  control(provider: HandoffProvider, action: "cancel" | "reopen" | "dismiss") {
    const busy = { result: refuse("busy", "The handoff coordinator is busy (a switch or reopen is running). Retry shortly."), handoff: this.state.handoffs[provider] };
    return this.fast(async () => {
      const h = this.state.handoffs[provider];
      if (action === "dismiss" && this.state.notice) {
        // The notice is dismissed on its own; a finished handoff needs its own Dismiss.
        this.state.notice = null;
        await this.persist();
        return { result: ok("dismissed", "Cleared."), handoff: h };
      }
      if (!h) return { result: refuse("noHandoff", "There is no handoff for this provider."), handoff: null };
      if (action === "cancel") {
        if (h.phase === "waiting") this.update(h, { phase: "cancelled", code: "cancelled", message: "Cancelled before anything changed." });
        else if (h.phase === "reopening") {
          const closed = h.provider === "agy" && h.affected.some((id) => !h.reopened.includes(id));
          this.update(h, {
            phase: closed ? "failed" : "cancelled",
            code: "reopenCancelled",
            message: closed ? `Reopening cancelled; ${h.affected.length - h.reopened.length} agy agents stay closed. Use Reopen agents when ready.` : "Reopening cancelled; the remaining agents keep their current session.",
          });
        } else return { result: refuse("notCancellable", "Only a waiting or reopening handoff can be cancelled."), handoff: h };
      } else if (action === "reopen") {
        const pending = h.affected.filter((id) => !h.reopened.includes(id));
        if (!["uncertain", "failed"].includes(h.phase) || pending.length === 0)
          return { result: refuse("nothingToReopen", "No closed agents are waiting to be reopened."), handoff: h };
        // Explicit owner decision after inspecting the login on the Mac.
        this.update(h, { phase: "reopening", failedReopen: [], deadline: this.now() + (await this.settings()).idleWaitMinutes * 60, code: "reopenRequested", message: "Reopening the closed agents as requested." });
      } else {
        if (!terminal(h)) return { result: refuse("active", "A running handoff cannot be dismissed; cancel it while it waits."), handoff: h };
        this.state.handoffs[provider] = null;
        await this.persist();
        return { result: ok("dismissed", "Cleared."), handoff: null };
      }
      await this.persist();
      return { result: ok(action, h.message), handoff: h };
    }, busy);
  }

  /** One coordination step for every provider. Without an agent API nothing is switched or reopened. */
  tick(port: AgentPort | null): Promise<void> {
    // Review L2: at most one queued tick; it uses the newest agent API offered meanwhile.
    if (port) this.tickPort = port;
    if (this.queuedTick) return this.queuedTick;
    const queued = this.serial(async () => {
      this.queuedTick = null;
      const agents = this.guard(this.tickPort ?? port);
      if (agents) this.agentApiSeen = true;
      await this.pollEvents();
      if (agents) await this.pollAgyAuto();
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
    this.queuedTick = queued;
    queued.catch(() => undefined).finally(() => {
      if (this.queuedTick === queued) this.queuedTick = null;
    });
    return queued;
  }
  isRunning() {
    return this.running;
  }
  /** Bounds every SDK call so a stale PaseoApi cannot stall the coordinator. */
  private guard(port: AgentPort | null): AgentPort | null {
    if (!port) return null;
    return {
      list: () => withTimeout(port.list(), this.listTimeoutMs),
      reload: (id) => withTimeout(port.reload(id), this.reloadTimeoutMs),
    };
  }

  /** A reload-only Codex handoff after a verified switch; optionally restarts the shared daemon. */
  private automaticCodex(settings: HandoffSettings, code: string, message: string, switchKey: string | null = null, switchedAt: number | null = null, switchTarget: string | null = null): Handoff {
    const now = this.now();
    return {
      id: this.newId(),
      provider: "codex",
      target: null,
      targetAlias: null,
      trigger: "automaticSwitch",
      restartDaemon: settings.restartCodexDaemon,
      phase: "waiting",
      requestedAt: now,
      deadline: now + settings.idleWaitMinutes * 60,
      updatedAt: now,
      waitingFor: 0,
      code,
      message,
      affected: [],
      reopened: [],
      failedReopen: [],
      daemonOutcome: null,
      switchKey,
      switchedAt,
      switchTarget,
    };
  }
  private switchKey(key: string) {
    return key.length <= 512 ? key : "sha256:" + createHash("sha256").update(key).digest("hex");
  }
  private rememberSwitch(key: string) {
    key = this.switchKey(key);
    this.state.handledSwitches = [...this.state.handledSwitches.filter((value) => value !== key), key].slice(-200);
  }
  /** Ends an open handoff that a newer one takes over. Only claims coverage when the newer handoff will reload. */
  private supersede(old: Handoff, newerReloads: boolean) {
    const open = old.affected.filter((id) => !old.reopened.includes(id) && !old.failedReopen.includes(id)).length;
    this.update(old, {
      phase: "done",
      code: "superseded",
      message: newerReloads
        ? "A newer switch took over; its reload covers the remaining agents."
        : `A newer switch took over; reloading after automatic switches is off, so ${open} ${open === 1 ? "agent was" : "agents were"} not reloaded.`,
    });
  }
  private async pollEvents() {
    const open = this.state.handoffs.codex;
    if (this.now() - this.lastEventPoll < 60 || (!terminal(open) && !supersedable(open))) return;
    const settings = await this.settings();
    if (!settings.reloadCodexAfterAutomaticSwitch && !settings.restartCodexDaemon && !settings.resumeLimitedCodexAgents) return;
    this.lastEventPoll = this.now();
    const read = await this.cli.events(this.state.eventWatermark);
    if (read.ok) {
      const startedAt = this.state.eventWatermark ?? 0;
      const fresh = read.events.filter((e) => e.at > startedAt);
      if (fresh.length > 0) {
        // Keep the first-start boundary: the bounded event log can receive late writes.
        const switches = fresh.filter((e) => e.provider === "codex" && ["automaticSwitch","switched"].includes(e.kind));
        const unseen = switches.filter((e) => !this.state.handledSwitches.includes(this.switchKey(e.transaction ? "txn:" + e.transaction : "event:" + (e.id ?? `${e.at}:${e.kind}`))));
        for (const event of switches) this.rememberSwitch(event.transaction ? "txn:" + event.transaction : "event:" + (event.id ?? `${event.at}:${event.kind}`));
        if (unseen.length > 0) {
          const old = this.state.handoffs.codex;
          if (old && !terminal(old)) this.supersede(old, settings.reloadCodexAfterAutomaticSwitch);
          this.state.handoffs.codex = this.automaticCodex(
            settings,
            "queued",
            "Codex switched. Waiting until Paseo Codex agents are idle to pick up the new login.",
            (() => {
              const last = unseen[unseen.length - 1]!;
              return this.switchKey(last.transaction ? "txn:" + last.transaction : "event:" + (last.id ?? `${last.at}:${last.kind}`));
            })(),
            unseen[unseen.length - 1]!.at,
            unseen[unseen.length - 1]!.target ?? null,
          );
        }
        await this.persist();
        if (this.state.handoffs.codex && !terminal(this.state.handoffs.codex)) return;
      }
    }
    // A restart the CLI still marks as pending (for example one missed while Paseo was closed).
    // A failed attempt is not retried for 15 minutes, so a broken daemon is not restarted every minute.
    if (!settings.restartCodexDaemon || this.now() - this.lastDaemonAttempt < 900) return;
    if ((await this.cli.codexDaemonPending()) !== true) return;
    const overwritten = this.state.handoffs.codex;
    if (overwritten && !terminal(overwritten)) this.supersede(overwritten, settings.reloadCodexAfterAutomaticSwitch);
    this.state.handoffs.codex = { ...this.automaticCodex(settings, "daemonPending", "A Codex daemon restart is pending after a switch. Waiting until Paseo Codex agents are idle."), restartDaemon: true };
    await this.persist();
  }
  /**
   * Automatic agy: when running agy sessions are the only thing blocking the poller's automatic
   * switch, run it with --stop-agy limited to Paseo's own idle sessions, then reopen them.
   */
  private async pollAgyAuto() {
    if (this.now() - this.lastAgyPlan < 60 || this.now() < this.agyRetryAt || !terminal(this.state.handoffs.agy)) return;
    const settings = await this.settings();
    if (!settings.closeAgyForAutomaticSwitch) return;
    this.lastAgyPlan = this.now();
    const plan = await this.cli.agyAutoPlan();
    // A renewal-only trigger has no known target yet (the final plan decides after the renewal).
    if (!plan.ok || !plan.blockedOnlyByProcesses) return;
    const now = this.now();
    this.state.handoffs.agy = {
      id: this.newId(),
      provider: "agy",
      target: plan.target,
      targetAlias: plan.target ? (this.cli.knownAccount("agy", plan.target)?.alias ?? null) : null,
      trigger: "automaticSwitch",
      restartDaemon: false,
      phase: "waiting",
      requestedAt: now,
      deadline: now + settings.idleWaitMinutes * 60,
      updatedAt: now,
      waitingFor: 0,
      code: "queued",
      message: "An automatic agy switch is waiting only for running agy sessions. Waiting until Paseo agy agents are idle.",
      affected: [],
      reopened: [],
      failedReopen: [],
      daemonOutcome: null,
      switchKey: null,
      switchedAt: null,
      switchTarget: null,
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
    if (h.phase === "reopening") await this.reopen(h, agents, await this.settings());
  }

  private async waitAndSwitch(h: Handoff, agents: AgentPort) {
    const mine = (await agents.list()).filter((a) => a.provider === paseoProviderId[h.provider]);
    // Each Paseo Codex agent has its own app-server, so a reload of one never affects another: Codex needs no
    // all-idle gate, running agents are reloaded one by one once they are idle (see reopen). Only the shared
    // daemon restart interrupts every attached session, and agy stops processes: those keep the gate.
    const perAgent = h.provider === "codex" && !h.restartDaemon;
    const busy = perAgent ? [] : mine.filter(busyStatus);
    if (busy.length > 0) {
      this.update(h, {
        waitingFor: busy.length,
        code: "turnRunning",
        message: `Waiting for ${busy.length} running ${busy.length === 1 ? "turn" : "turns"} to finish. Nothing is interrupted.`,
      });
      return;
    }
    let affected = mine.filter((a) => (perAgent ? reloadable(h.provider, a) || busyStatus(a) : reloadable(h.provider, a))).map((a) => a.id);
    if (h.target === null && h.provider === "codex") {
      const settings = await this.settings();
      if (!settings.reloadCodexAfterAutomaticSwitch) affected = [];
      let daemonOutcome = h.daemonOutcome;
      if (h.restartDaemon) {
        // Every Paseo Codex agent is idle: the idle boundary for the shared daemon.
        const pending = await this.cli.codexDaemonPending();
        // The CLI does not check for running turns, so re-check right before the restart (it interrupts them).
        const again = (await agents.list()).filter((a) => a.provider === paseoProviderId.codex);
        if (pending === true && again.some(busyStatus)) {
          this.update(h, { waitingFor: again.filter(busyStatus).length, code: "turnRunning", message: "A Codex turn started; the daemon restart waits for it." });
          return;
        }
        if (pending === true) {
          this.lastDaemonAttempt = this.now();
          daemonOutcome = await this.cli.codexDaemonRestart();
          if (daemonOutcome === "busy") {
            this.update(h, { code: "busy", message: "Another SubBaton action is running; retrying the daemon restart." });
            return;
          }
        } else daemonOutcome = pending === false ? "notPending" : "unknown";
      }
      const daemonNote =
        daemonOutcome === "restarted" ? " The shared Codex daemon was restarted." :
        daemonOutcome && !["notPending", "restarted"].includes(daemonOutcome) ? ` The Codex daemon restart did not complete (${daemonOutcome}); restart it with the SubBaton CLI when no turn runs.` : "";
      this.update(h, {
        phase: affected.length ? "reopening" : "done",
        affected,
        waitingFor: 0,
        daemonOutcome,
        deadline: this.now() + settings.idleWaitMinutes * 60,
        code: affected.length ? "reloading" : daemonOutcome === "restarted" ? "daemonRestarted" : "nothingToReload",
        message: (affected.length ? "Reloading idle Codex agents with the new login." : "No Paseo Codex agents needed a reload.") + daemonNote,
      });
      // Adoption: a verified switch. The plugin's own reload of a limited agent adopts the new login;
      // a successful daemon restart is not required (and is never enabled for this).
      if (h.switchKey && h.switchTarget) this.onCodexAdopted?.(h.switchKey, h.switchTarget, h.switchedAt);
      return;
    }
    const options: SwitchOptions = {};
    if (h.provider === "agy") {
      const inventory = await this.cli.agyProcesses();
      if (!inventory.ok) {
        this.update(h, { waitingFor: 1, code: "processUnknown", message: "The agy process list is unavailable; waiting rather than guessing." });
        return;
      }
      // Review H1: only processes whose ancestry runs through the Paseo daemon are Paseo's.
      // Review RH1: only the daemon itself anchors attribution, and only if the CLI names it as Paseo.
      const anchor = this.paseoAnchor;
      const seen = inventory.processes.flatMap((p) => p.ancestors ?? []).filter((a) => a.pid === anchor);
      if (inventory.processes.length > 0 && (anchor === null || seen.some((a) => !a.executable || !paseoDaemonExecutables.includes(a.executable)))) {
        this.update(h, {
          waitingFor: inventory.processes.length,
          code: "anchorUnverified",
          message: `SubBaton could not confirm which process is the Paseo daemon${seen[0]?.executable ? ` (found ${seen[0].executable.slice(0, 64)})` : ""}, so it cannot tell Paseo's agy sessions from terminal ones. Waiting; nothing is stopped.`,
        });
        return;
      }
      // Paseo's only if the anchor is an ancestor and nothing between them is a shell or terminal (RH3).
      const between = (p: AgyProcessInfo) => {
        const index = p.ancestors?.findIndex((a) => a.pid === anchor) ?? -1;
        return index < 0 ? null : p.ancestors!.slice(0, index);
      };
      const ours = (p: AgyProcessInfo) => {
        const path = between(p);
        return !!path && path.every((a) => a.executable !== null && !interactive(a.executable));
      };
      const paseo = inventory.processes.filter(ours);
      // A chain that stopped early (unreadable parent, cycle, 32-entry bound) or an unreadable name
      // between the process and the daemon proves nothing.
      const unknown = inventory.processes.filter((p) => {
        if (ours(p)) return false;
        const path = between(p);
        if (path) return !path.some((a) => a.executable !== null && interactive(a.executable));
        return p.ancestors === null || !p.complete;
      });
      const outside = inventory.processes.length - paseo.length - unknown.length;
      if (unknown.length > 0) {
        this.update(h, { waitingFor: unknown.length, code: "attributionUnknown", message: "The CLI did not report which process started each running agy session, so SubBaton cannot tell Paseo's from terminal sessions. Waiting; nothing is stopped." });
        return;
      }
      if (outside > 0) {
        this.update(h, {
          waitingFor: outside,
          code: "agyOutsidePaseo",
          message: `${outside} agy ${outside === 1 ? "session runs" : "sessions run"} outside Paseo (terminal or desktop). Finish ${outside === 1 ? "it" : "them"}; SubBaton never stops them for Paseo.`,
        });
        return;
      }
      if (paseo.length > 0 && paseo.length < affected.length) {
        // Fail closed until live tests show idle Paseo agy agents may run without a process.
        this.update(h, { waitingFor: affected.length - paseo.length, code: "attributionIncomplete", message: "Some idle Paseo agy agents have no matching agy process. Waiting rather than guessing." });
        return;
      }
      if (paseo.length > affected.length) {
        // Review RH2: an extra Paseo process (an errored or orphaned runtime) would be stopped and never
        // reopened. Fail closed until live tests show where extra processes come from.
        this.update(h, {
          waitingFor: paseo.length - affected.length,
          code: "extraPaseoProcesses",
          message: `${paseo.length} Paseo agy processes run for ${affected.length} idle Paseo agy ${affected.length === 1 ? "agent" : "agents"}. SubBaton would stop the extra ones without reopening anything, so it waits. Close agy agents in an error state or restart Paseo.`,
        });
        return;
      }
      if (paseo.length > 0) options.onlyPids = paseo.map((p) => p.pid).sort((a, b) => a - b);
      if (h.trigger === "automaticSwitch" && !options.onlyPids) {
        this.update(h, { phase: "done", affected: [], waitingFor: 0, code: "notNeeded", message: "No agy sessions are running any more; the poller switches on its own next tick. Nothing was closed." });
        return;
      }
    } else if (h.restartDaemon) options.restartDaemon = true;
    // Persist the affected set before the CLI runs so a crash can be reported precisely.
    this.update(h, { phase: "switching", affected, waitingFor: 0, code: "switching", message: h.provider === "agy" && h.trigger === "automaticSwitch" ? `Closing ${affected.length} idle agy ${affected.length === 1 ? "agent" : "agents"}, renewing candidate accounts (up to 10 minutes) and switching.` : h.provider === "agy" && affected.length ? `Closing ${affected.length} idle agy ${affected.length === 1 ? "agent" : "agents"} and switching.` : "Switching." });
    await this.persist();
    // Review L1: re-check right before the CLI runs; anything busy or a changed idle set goes back to waiting.
    const again = (await agents.list()).filter((a) => a.provider === paseoProviderId[h.provider]);
    const idleNow = again.filter((a) => reloadable(h.provider, a)).map((a) => a.id).sort();
    if (!perAgent && (again.some(busyStatus) || idleNow.join() !== [...affected].sort().join())) {
      this.update(h, { phase: "waiting", affected: [], code: "becameBusy", message: "An agent started a turn or the set of agents changed; waiting again." });
      return;
    }
    const out =
      h.provider === "agy" && h.trigger === "automaticSwitch"
        ? await this.cli.agyAutoRunOnce(options.onlyPids ?? [])
        : await this.cli.switchAccount(h.provider, h.target!, options);
    if (h.provider === "codex" && out.kind === "switched" && out.transaction) {
      this.rememberSwitch("txn:" + out.transaction);
      await this.persist();
    }
    const daemonOutcome = out.daemonOutcome ?? null;
    if (out.retryAt !== undefined) this.agyRetryAt = out.retryAt;
    switch (out.kind) {
      case "busy":
        this.update(h, { phase: "waiting", affected: [], code: "busy", message: "Another SubBaton action is running; retrying." });
        return;
      case "notAllowed":
        // An agy session outside Paseo appeared after the check; the CLI stopped and switched nothing.
        this.update(h, { phase: "waiting", affected: [], waitingFor: 1, code: "agyOutsidePaseo", message: "An agy session outside Paseo started. Nothing was stopped or switched; waiting until it ends." });
        return;
      case "notRun":
        this.update(h, { phase: "done", affected: [], code: out.code, message: `${out.message} No agents were closed.` });
        return;
      case "switched":
      case "unchanged": {
        const reload = h.provider === "agy" ? affected.length > 0 : out.kind === "switched" && affected.length > 0;
        this.update(h, {
          phase: reload ? "reopening" : "done",
          deadline: this.now() + (await this.settings()).idleWaitMinutes * 60,
          daemonOutcome,
          code: out.kind === "switched" ? "switched" : "alreadyActive",
          ...(h.provider === "codex" && out.kind === "switched" && out.transaction ? { switchKey: "txn:" + out.transaction } : {}),
          message: reload ? "Switch verified. Reopening agents with their saved conversations." : out.kind === "switched" ? "Switch verified. No Paseo agents needed reopening." : "That account was already active.",
        });
        if (h.provider === "codex" && out.kind === "switched" && out.transaction)
          this.onCodexAdopted?.("txn:" + out.transaction, h.target!, this.now());
        return;
      }
      case "stoppedNoSwitch": {
        // agy renewal before a switch stopped the sessions, then the final policy chose not to switch: nothing was
        // switched, but the stopped sessions are resumed exactly as after a switch (agent.reload() reopens them).
        this.noSwitch.set(h.id, out.manualResumeRequired === true);
        this.update(h, {
          phase: affected.length > 0 ? "reopening" : "done",
          deadline: this.now() + (await this.settings()).idleWaitMinutes * 60,
          daemonOutcome,
          code: "stoppedNoSwitch",
          message: (affected.length > 0 ? "agy sessions were stopped to renew candidate accounts; no switch was needed. Reopening agents with their saved conversations." : "agy sessions were stopped to renew candidate accounts; no switch was needed. No Paseo agents needed reopening.") + (out.manualResumeRequired ? MANUAL_RESUME_NOTE : ""),
        });
        return;
      }
      case "refused":
        // Review L4: nothing was closed, so there is nothing to reopen.
        this.update(h, { phase: "failed", affected: [], daemonOutcome, code: out.code, message: `${out.message} No agents were closed.` });
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

  private async reopen(h: Handoff, agents: AgentPort, _settings: HandoffSettings) {
    let waiting = 0;
    for (const id of h.affected) {
      if (h.reopened.includes(id) || h.failedReopen.includes(id)) continue;
      // Review M1: read this agent's state immediately before its reload; earlier reloads take time.
      const snap = (await agents.list()).find((a) => a.id === id);
      if (!snap) {
        h.failedReopen.push(id);
        continue;
      }
      if (busyStatus(snap)) {
        // reload() interrupts a running turn, so a busy agent waits for a later tick.
        waiting++;
        continue;
      }
      // One reload per Codex agent per adopted switch, shared with the limited-agent recovery.
      const key = h.provider === "codex" ? (h.switchKey ?? h.id) : null;
      if (key !== null && !this.ledger.claim(key, id)) {
        h.reopened.push(id);
        continue;
      }
      try {
        await agents.reload(id);
        if (key !== null) this.ledger.finish(key, id, true);
        h.reopened.push(id);
      } catch {
        if (key !== null) this.ledger.finish(key, id, false);
        h.failedReopen.push(id);
      }
    }
    if (waiting > 0) {
      // Per-agent Codex reloads have no deadline: a running agent is reloaded whenever it becomes idle, for as long as
      // this switch is the current one (a newer switch supersedes it). Only the daemon-restart and agy handoffs time out.
      const perAgent = h.provider === "codex" && !h.restartDaemon;
      if (!perAgent && this.now() > h.deadline) {
        const closed = h.provider === "agy";
        this.update(h, {
          phase: closed ? "failed" : "done",
          waitingFor: 0,
          code: "reopenTimeout",
          message: closed
            ? `Reopened ${h.reopened.length}; ${waiting} stayed busy until the wait ended. Use Reopen agents when they are idle.`
            : `Reopened ${h.reopened.length}; ${waiting} stayed busy until the wait ended and keep their current session. Reload them from Paseo when idle.`,
        });
        return;
      }
      this.update(h, { waitingFor: waiting, code: "reopenWaiting", message: `Reopened ${h.reopened.length}; ${waiting} still in a turn.` });
      return;
    }
    const failed = h.failedReopen.length;
    this.update(h, {
      phase: failed ? "failed" : "done",
      waitingFor: 0,
      code: failed ? "reopenFailed" : "completed",
      message: failed
        ? `Reopened ${h.reopened.length}; ${failed} could not be reopened (archived, timed out or reload failed). Reopen them from Paseo.`
        : this.noSwitch.has(h.id)
          ? `Done. Reopened ${h.reopened.length} ${h.reopened.length === 1 ? "agent" : "agents"}; no switch was needed.${this.noSwitch.get(h.id) ? MANUAL_RESUME_NOTE : ""}`
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
    ref(id: string): { reload(options?: { requestId?: string }): Promise<unknown>; send(text: string): Promise<unknown> };
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
    async send(id, text) {
      await paseo.agents.ref(id).send(text);
    },
  };
}
