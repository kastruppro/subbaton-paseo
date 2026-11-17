import { z } from "zod";
import type { AgentPort, AgentSnapshot } from "./handoff.js";
import type { Account, PaidUsage } from "../shared/contracts.js";
import { ReloadLedger } from "./reload-ledger.js";

// Limited Codex agent continuation (0.9.0). After a verified Codex account switch (the plugin's own
// reload of an agent makes it adopt the new login; no daemon restart is needed), each Codex agent whose latest turn positively ended
// in a provider usage limit is reloaded and sent ONE continuation message. Everything here fails
// closed: ambiguous history, a missing turn ID, a failed store or any doubt means no message.
// Evidence and open points: docs/limited-agents.md.

export const continuationText = "Continue the previous task from where it stopped because of the usage limit.";
/** Structured code from the hook's failed outcome (unverified against live output; see docs). */
const limitCodes = new Set(["usage_limit_reached"]);
/** Terminal provider error as Codex words it. Anchored at the start so quotes and prompts never match. */
const limitMessage = /^\s*you(?:'|’)ve hit your usage limit\b/i;

export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
/** How a failed turn was recognised as a usage limit: by the structured code, by the anchored text, or not at all. */
export function limitMatch(outcome: TurnOutcome): "code" | "text" | null {
  if (outcome.kind !== "failed") return null;
  const { message, code } = outcome.error;
  if (code !== undefined && limitCodes.has(code)) return "code";
  return typeof message === "string" && limitMessage.test(message) ? "text" : null;
}
export const isLimitFailure = (outcome: TurnOutcome): boolean => limitMatch(outcome) !== null;

/** Log lines carry this prefix, short agent IDs and saved account IDs only (never tokens, prompts or agent output). */
export const logPrefix = "[subbaton] limited-agents:";
const short = (id: string) => id.slice(0, 8);
const shortKey = (key: string) => (key.length > 40 ? key.slice(0, 40) + "…" : key);

/** Paid fallback usable now. Mirrors the core's PaidUsage.eligible (Sources/SubBatonCore/PaidUsage.swift). */
export function paidEligible(paid: PaidUsage | undefined, now: number): boolean {
  if (!paid || paid.stale || !Number.isFinite(paid.fetchedAt) || now < paid.fetchedAt || now - paid.fetchedAt >= 180) return false;
  if (paid.kind === "credits") {
    // Signed, optionally with an exponent (a number balance reaches us as String(n)); <= 0 is never eligible.
    const amount = paid.balance !== undefined && /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(paid.balance.trim()) ? Number(paid.balance) : undefined;
    if (paid.hasCredits === false || (amount !== undefined && amount <= 0)) return false;
    return paid.unlimited === true || (paid.hasCredits === true && amount !== undefined && amount > 0);
  }
  if (paid.enabled !== true) return false;
  if (paid.utilization !== undefined && paid.utilization >= 100) return false;
  if (paid.monthlyLimit !== undefined && paid.monthlyLimit <= 0) return false;
  if (paid.monthlyLimit !== undefined && paid.usedCredits !== undefined && paid.usedCredits >= paid.monthlyLimit) return false;
  return true;
}
/**
 * Windows the core always requires on a Codex account (PolicyEngine adds the missing ones as unknown). Real Codex
 * status rows are `bucket:window` (Status.swift), the main bucket being `codex`: 5h and 7d.
 */
const requiredWindows = ["codex:primary_window", "codex:secondary_window"];
export interface TargetUsage {
  verdict: "exhausted" | "usable" | "unknown";
  /** Oldest reading behind the verdict (windows, and the paid fallback when it was needed); null when unknown. */
  readAt: number | null;
}
/**
 * Core rule (PolicyEngine): every window fresh (not stale, not inferred, not past its reset, both required
 * windows present) and one at 100 or more = exhausted, unless the paid fallback is usable. All fresh and none
 * at 100 = usable (headroom). Anything else is unknown.
 */
export function targetUsage(account: Account, now: number): TargetUsage {
  const unknown: TargetUsage = { verdict: "unknown", readAt: null };
  const fresh = (w: Account["windows"][number]) => !w.stale && !w.inferred && w.usedPercent !== null && w.fetchedAt !== null && !(w.resetsAt !== null && w.resetsAt <= now);
  if (!requiredWindows.every((id) => account.windows.some((w) => w.id === id)) || !account.windows.every(fresh)) return unknown;
  const readAt = Math.min(...account.windows.map((w) => w.fetchedAt as number));
  if (!account.windows.some((w) => (w.usedPercent ?? 0) >= 100)) return { verdict: "usable", readAt };
  return paidEligible(account.paidUsage, now)
    ? { verdict: "usable", readAt: Math.min(readAt, account.paidUsage!.fetchedAt) }
    : { verdict: "exhausted", readAt };
}

/** A waiting candidate older than this is dropped (a "Continue" message after days would surprise the owner). */
export const waitingMaxAgeSeconds = 7 * 86400;

/** A recheck that follows a Codex limit: one `codex auto run-once --limit-observed <active account>` call. */
export interface LimitRecheck {
  /**
   * Runs the normal automatic evaluation. With an account it also reports that the official client just refused
   * that login (`--limit-observed`); null runs it plain. `invalidInput` as the outcome means the CLI does not
   * know the flag.
   */
  runOnceObserved(accountId: string | null): Promise<{ outcome: string; reason?: string; limitObserved?: string; limitObservedReason?: string }>;
  /** A switch was made: let the handoff poll the event now instead of at its next minute. */
  onSwitched?(): void;
}
/** At most one recheck per provider in this window. */
export const recheckWindowSeconds = 60;

export interface HookAgent {
  id: string;
  provider: string;
  workspaceId?: string | null;
}
export interface RecoveryStore {
  load(): Promise<unknown>;
  save(state: RecoveryState): Promise<void>;
}
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  /** `<switch key>|<agent>|<turn>` of every attempt already made. */
  consumed: z.array(z.string().max(700)).max(500).default([]),
  /** Agents whose latest automatic continuation hit a limit; cleared by new user activity. */
  suppressed: z.array(z.string().max(256)).max(500).default([]),
  /** Continuations we sent: "sent" until their turn starts, then "turn" with that turn's ID. */
  lineage: z
    .array(z.object({ agentId: z.string().max(256), state: z.enum(["sent", "turn"]), turnId: z.string().max(256).nullable() }))
    .max(500)
    .default([]),
  /** When each agent's session last opened (agent.open.before: create, resume, reload); persisted, pruned with the agent. */
  opened: z.record(z.string().max(256), z.number().finite()).default({}),
});
export type RecoveryState = z.infer<typeof stateSchema>;
const emptyState = (): RecoveryState => ({ schemaVersion: 1, consumed: [], suppressed: [], lineage: [], opened: {} });

/** What is known about one limited agent when its turn ends. */
interface AgentFacts {
  opened?: number;
  turnStart?: number;
}
interface Candidate {
  turnId: string;
  at: number;
  /** Parked for a later switch or until the target has headroom. */
  waiting?: boolean;
}
interface Pending {
  key: string;
  accountId: string;
  since: number;
}
const busy = (a: AgentSnapshot) => a.activeTurn || a.status === "running" || a.status === "initializing";
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref?.())]);

export class LimitedAgentRecovery {
  private state: RecoveryState = emptyState();
  private ready: Promise<void> | null = null;
  /** False when the persisted state could not be read: nothing is recorded or sent. */
  private trusted = true;
  private candidates = new Map<string, Candidate>();
  private pending: Pending | null = null;
  /** run() and adopt() queue here. Hooks never wait for it: they must invalidate a candidate mid-run. */
  private chain: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  /** "Waiting" lines already logged, keyed `<agent>\0<tag>` (agent "" for per-switch lines). */
  private waitLogged = new Set<string>();

  constructor(
    private store: RecoveryStore,
    private resumeEnabled: () => Promise<boolean>,
    /** The active saved Codex account (fresh, cache-only status); null when unknown. */
    private currentAccount: () => Promise<string | null>,
    private now: () => number = () => Date.now() / 1000,
    private timeoutMs = 30_000,
    /** One line per decision; the plugin's stdout shows in `paseo plugin logs subbaton`. */
    private log: (line: string) => void = (line) => console.log(line),
    /** The saved account with its windows and paid usage (the CLI's status --json); null when unreadable. Omitted: no check. */
    private accountUsage?: (accountId: string) => Promise<Account | null>,
    /** Shared with the handoff: one reload per agent per switch. */
    private ledger: ReloadLedger = new ReloadLedger(),
    /** Optional: re-read the active account and evaluate automatic switching right after a Codex limit. */
    private recheck?: LimitRecheck,
    /** Bound of each recheck CLI step; the same as the CLI call itself (a Codex read can take a while). */
    private recheckTimeoutMs = 120_000,
    /** Limits that arrive within this window share one recheck (attribution is collected over the burst). */
    private recheckCollectMs = 250,
  ) {
    // A successful reload (by the handoff or by this recovery) restarts the agent's app-server: that is its open time too.
    this.ledger.onReloaded = (agentId) => this.sessionOpened(agentId, "reload");
  }

  private say(message: string) {
    try {
      this.log(`${logPrefix} ${message}`);
    } catch {
      // logging never changes a decision
    }
  }

  private init() {
    this.ready ??= (async () => {
      try {
        const raw = await this.store.load();
        if (raw !== null && raw !== undefined) {
          const parsed = stateSchema.safeParse(raw);
          if (parsed.success) this.state = parsed.data;
          else this.trusted = false;
        }
      } catch {
        this.trusted = false;
      }
      this.loaded = true;
      for (const [id, at] of this.earlyOpened) this.state.opened[id] = Math.max(this.state.opened[id] ?? 0, at);
      this.earlyOpened.clear();
      if (!this.trusted) this.say("state file unreadable, continuation disabled until it is fixed");
    })();
    return this.ready;
  }
  private persist(): Promise<boolean> {
    const snapshot: RecoveryState = {
      ...this.state,
      consumed: this.state.consumed.slice(-500),
      suppressed: this.state.suppressed.slice(-500),
      lineage: this.state.lineage.slice(-500).map((l) => ({ ...l })),
      opened: Object.fromEntries(Object.entries(this.state.opened).sort((a, b) => b[1] - a[1]).slice(0, 500)),
    };
    const write = this.writes.then(
      () => this.store.save(snapshot).then(() => true, () => false),
      () => false,
    );
    this.writes = write;
    return write;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private logOnce(agentId: string, tag: string, message: string) {
    const key = `${agentId}\0${tag}`;
    if (this.waitLogged.has(key)) return;
    this.waitLogged.add(key);
    this.say(message);
  }
  private clearLogged(agentId: string) {
    for (const key of [...this.waitLogged]) if (key.startsWith(`${agentId}\0`)) this.waitLogged.delete(key);
  }
  private loaded = false;
  /** Opens seen before the state file was read; merged in once it is. */
  private earlyOpened = new Map<string, number>();
  private rechecking: Promise<void> | null = null;
  private lastRecheckAt = -Infinity;
  /** What the plugin knows about the agents of a burst while a recheck collects them. */
  private burst: AgentFacts[] | null = null;
  /** When each agent's current turn started (memory only; unknown after a plugin restart). */
  private turnStarts = new Map<string, number>();
  /** Resolves when the running recheck (if any) is done. */
  recheckIdle(): Promise<void> {
    return this.rechecking ?? Promise.resolve();
  }
  /** agent.open.before: the agent's session (and so its Codex app-server, with the login it reads then) opens now. */
  sessionOpened(agentId: string, reason: string): void {
    // Recorded in memory at once; the state file is written in the background (errors are logged, never thrown).
    const at = this.now();
    if (this.loaded) this.state.opened[agentId] = Math.max(this.state.opened[agentId] ?? 0, at);
    else this.earlyOpened.set(agentId, at);
    this.say(`session opened agent=${short(agentId)} reason=${reason.slice(0, 20)}`);
    void this.init()
      .then(() => this.persist())
      .then((saved) => {
        if (!saved) this.say(`session open of agent=${short(agentId)} could not be saved`);
      })
      .catch(() => this.say(`session open of agent=${short(agentId)} could not be saved`));
  }
  /**
   * Which login does this limited turn belong to? Reference: when the active account was activated. An app-server keeps
   * the login it started with, so a session opened before the activation is on an old login. A session that opened after
   * the limited turn started cannot be the process that ran it (a reload in the gap before the hook), so it proves nothing.
   */
  private classify(facts: AgentFacts, activatedAt: number | undefined): "current" | "old" | "unknown" {
    if (facts.opened === undefined || activatedAt === undefined) return "unknown";
    if (facts.opened < activatedAt) return "old";
    if (facts.turnStart === undefined) return "unknown";
    return facts.opened <= facts.turnStart ? "current" : "old";
  }
  /** Single-flight and debounced: several agents hitting the limit together cause one recheck, at most once per minute. */
  private recheckSoon(facts: AgentFacts) {
    if (!this.recheck) return;
    // still collecting: this agent joins the burst
    this.burst?.push(facts);
    const key = `recheck|${Math.floor(this.lastRecheckAt)}`;
    if (this.rechecking) return this.logOnce("", `${key}|running`, `recheck skipped reason=already running`);
    if (this.now() - this.lastRecheckAt < recheckWindowSeconds)
      return this.logOnce("", `${key}|window`, `recheck skipped reason=within ${recheckWindowSeconds} s of the last recheck`);
    this.lastRecheckAt = this.now();
    this.burst = [facts];
    const work = this.runRecheck(this.recheck).finally(() => {
      if (this.rechecking === work) this.rechecking = null;
    });
    this.rechecking = work;
  }
  private async runRecheck(recheck: LimitRecheck) {
    try {
      await new Promise((resolve) => setTimeout(resolve, this.recheckCollectMs));
      const burst = this.burst ?? [];
      this.burst = null;
      const account = await this.currentAccount().catch(() => null);
      if (!account) return void this.say("recheck skipped reason=no active Codex account in the status");
      this.say(`recheck started provider=codex account=${short(account)}`);
      // Reference: the active account's activation time (status), else the adopted switch of this account.
      const info = await withTimeout(this.accountUsage?.(account) ?? Promise.resolve(null), this.timeoutMs).catch(() => null);
      const activatedAt = info?.activatedAt ?? (this.pending?.accountId === account ? this.pending.since : undefined);
      const kinds = burst.map((facts) => this.classify(facts, activatedAt));
      // One current or unknown agent is enough; agents known to run on an old login never count.
      const report = kinds.some((kind) => kind !== "old");
      if (report && !kinds.includes("current"))
        this.say("recheck attribution unknown, sent (core plausibility gate applies)");
      const render = (decision: Awaited<ReturnType<LimitRecheck["runOnceObserved"]>>, observed: string) =>
        `${observed}decision=${decision.outcome.slice(0, 40)} reason=${(decision.reason ?? "none").slice(0, 60)}`;
      let decision = await withTimeout(recheck.runOnceObserved(report ? account : null), this.recheckTimeoutMs);
      if (report && decision.outcome === "invalidInput") {
        // An older CLI does not know the flag: the immediate evaluation still runs, plain, once.
        decision = await withTimeout(recheck.runOnceObserved(null), this.recheckTimeoutMs);
        this.say(`recheck ${render(decision, "limitObserved=unsupported (invalidInput), fell back to plain run-once ")}`);
      } else if (!report) {
        this.say(`recheck run-once ${render(decision, "limitObserved=skipped reason=agent not on the current login ")}`);
      } else {
        this.say(
          `recheck run-once limitObserved=${(decision.limitObserved ?? "unknown").slice(0, 20)} reason=${(decision.limitObservedReason ?? "none").slice(0, 40)} decision=${decision.outcome.slice(0, 40)} reason=${(decision.reason ?? "none").slice(0, 60)}`,
        );
      }
      if (decision.outcome === "switched") recheck.onSwitched?.();
    } catch (error) {
      this.burst = null;
      this.say(`recheck skipped reason=${error instanceof Error && error.message === "timeout" ? "timeout" : "unexpected error"}`);
    }
  }

  private forget(agentId: string, reason?: string) {
    this.clearLogged(agentId);
    if (this.candidates.delete(agentId) && reason) this.say(`candidate dropped agent=${short(agentId)} reason=${reason}`);
  }
  private lineageOf(agentId: string) {
    return this.state.lineage.find((l) => l.agentId === agentId);
  }
  private dropLineage(agentId: string) {
    this.state.lineage = this.state.lineage.filter((l) => l.agentId !== agentId);
  }

  /** agent.turn.before: our continuation turn is tagged; anything else is user activity. */
  async turnBefore(agent: HookAgent, turnId: string | null): Promise<void> {
    await (async () => {
      if (agent.provider !== "codex") return;
      await this.init();
      this.turnStarts.set(agent.id, this.now());
      this.forget(agent.id, "turn started again");
      const entry = this.lineageOf(agent.id);
      if (entry?.state === "sent") entry.turnId = turnId, (entry.state = "turn");
      else {
        // New user activity establishes a new task.
        this.dropLineage(agent.id);
        this.state.suppressed = this.state.suppressed.filter((id) => id !== agent.id);
      }
      await this.persist();
    })();
  }

  /** agent.turn.after: record a candidate only from a positive terminal provider limit. */
  async turnAfter(agent: HookAgent, turnId: string | null, outcome: TurnOutcome): Promise<void> {
    await (async () => {
      if (agent.provider !== "codex") return;
      await this.init();
      const entry = this.lineageOf(agent.id);
      const continuation = !!entry && (entry.state === "sent" || entry.turnId === turnId);
      const who = short(agent.id);
      this.forget(agent.id, outcome.kind === "canceled" ? "canceled" : outcome.kind === "completed" ? "turn completed" : undefined);
      const via = limitMatch(outcome);
      if (via) {
        // The switch decision does not depend on whether we may message this agent: every positive limit rechecks.
        this.recheckSoon({ opened: this.state.opened[agent.id], turnStart: this.turnStarts.get(agent.id) });
        if (continuation) {
          // A limited continuation is never continued again until new user activity.
          if (!this.state.suppressed.includes(agent.id)) this.state.suppressed.push(agent.id);
          this.dropLineage(agent.id);
          this.say(`continuation hit a limit again agent=${who}, suppressed until new activity`);
        } else if (!this.trusted) this.say(`candidate not recorded agent=${who} reason=state untrusted`);
        else if (!turnId) this.say(`candidate not recorded agent=${who} reason=no turn id`);
        else if (this.state.suppressed.includes(agent.id)) this.say(`candidate not recorded agent=${who} reason=suppressed after a limited continuation`);
        else if (!(await this.resumeEnabled())) this.say(`candidate not recorded agent=${who} reason=setting off`);
        else {
          this.candidates.set(agent.id, { turnId, at: this.now() });
          this.say(`limit detected agent=${who} provider=codex via=${via} turn=${short(turnId)}`);
        }
      } else if (continuation) {
        this.dropLineage(agent.id);
        this.say(`continuation ended without a limit agent=${who}`);
      }
      await this.persist();
    })();
  }

  async archived(agentId: string): Promise<void> {
    await this.init();
    this.forget(agentId, "archived");
    this.dropLineage(agentId);
    delete this.state.opened[agentId];
    this.turnStarts.delete(agentId);
    await this.persist();
  }

  /**
   * A verified Codex switch. `expectedAccount` (the verified switch target, required) must be the account
   * that is active now; `switchedAt` is when the switch happened (default: now), so a limit that ended after
   * it, on the new login, is never recovered. A newer adoption supersedes a pending one.
   */
  adopt(key: string, expectedAccount: string, switchedAt: number | null = null): Promise<void> {
    return this.serial(async () => {
      await this.init();
      const current = await this.currentAccount().catch(() => null);
      // An unknown switch target fails closed: the attempt is never bound to whatever login is current later.
      const refuse = (reason: string) => {
        this.pending = null;
        this.say(`adoption refused key=${shortKey(key)} reason=${reason}`);
      };
      if (!this.trusted) return refuse("state untrusted");
      if (!expectedAccount || typeof expectedAccount !== "string") return refuse("switch target unknown");
      if (!current) return refuse("active login unknown");
      if (expectedAccount !== current) return refuse(`target ${expectedAccount} is not the active login ${current}`);
      // The same switch adopted again keeps its original time, so candidates waiting for the next switch stay waiting.
      if (this.pending?.key === key && this.pending.accountId === current) return;
      this.clearLogged("");
      this.pending = { key, accountId: current, since: Math.min(this.now(), switchedAt ?? Infinity) };
      this.say(`switch adopted key=${shortKey(key)} account=${current} candidates=${this.candidates.size}`);
    });
  }

  hasPending() {
    return this.pending !== null && this.candidates.size > 0;
  }

  /**
   * Continue every eligible candidate; busy agents wait for a later run. Candidates whose limit ended after
   * the pending switch stay in memory for the next adopted switch (lost on a plugin restart, by design).
   */
  run(port: AgentPort | null): Promise<void> {
    return this.serial(async () => {
      await this.init();
      if (!port?.send || !this.trusted || !this.pending) return;
      const pending = this.pending;
      for (const [agentId, candidate] of [...this.candidates]) {
        if (this.pending !== pending) return;
        await this.attempt(port, pending, agentId, candidate).catch(() => this.say(`attempt aborted agent=${short(agentId)} reason=unexpected error`));
      }
    });
  }

  private same(pending: Pending, agentId: string, candidate: Candidate) {
    return this.pending === pending && this.candidates.get(agentId) === candidate;
  }
  /** "ok", "wait" (busy, try later) or a drop reason. */
  private async eligible(port: AgentPort, pending: Pending, agentId: string, candidate: Candidate, afterReload: boolean): Promise<{ state: "ok" | "wait" } | { state: "drop"; reason: string }> {
    const drop = (reason: string) => ({ state: "drop" as const, reason });
    if (!this.same(pending, agentId, candidate)) return drop("candidate replaced or switch superseded");
    if (!(await this.resumeEnabled())) return drop("setting off");
    if (this.state.suppressed.includes(agentId)) return drop("suppressed after a limited continuation");
    const active = await this.currentAccount().catch(() => null);
    if (active !== pending.accountId) return { state: "drop", reason: `login changed, expected ${pending.accountId}, active ${active ?? "unknown"}` };
    const snapshot = (await withTimeout(port.list(), this.timeoutMs)).find((a) => a.id === agentId);
    if (!snapshot || snapshot.provider !== "codex") return drop("agent gone, archived or not Codex");
    if (!this.same(pending, agentId, candidate)) return drop("owner activity during the check");
    if (busy(snapshot)) return afterReload ? drop("turn started after the reload") : { state: "wait" };
    if (afterReload ? snapshot.status !== "idle" : !["idle", "error"].includes(snapshot.status)) return drop(`agent state ${snapshot.status}`);
    return { state: "ok" };
  }

  private async attempt(port: AgentPort, pending: Pending, agentId: string, candidate: Candidate) {
    const send = port.send!.bind(port);
    const who = short(agentId);
    const drop = (reason?: string) => {
      if (reason?.startsWith("login changed")) {
        // The active login moved on (a newer switch is not adopted yet): wait for that adoption, do not lose the agent.
        candidate.waiting = true;
        this.logOnce(agentId, `login|${pending.key}`, `waiting for the next switch agent=${who} reason=login changed`);
        return;
      }
      if (this.candidates.get(agentId) === candidate) this.candidates.delete(agentId);
      this.clearLogged(agentId);
      if (reason) this.say(`skipped agent=${who} reason=${reason}`);
    };
    const id = `${pending.key}|${agentId}|${candidate.turnId}`;
    if (candidate.waiting && this.now() - candidate.at > waitingMaxAgeSeconds) return drop("waited longer than 7 days");
    if (this.state.consumed.includes(id)) {
      // A candidate that is still here after its attempt was consumed was parked (the login changed meanwhile and came
      // back without a new adoption). It stays parked for the next adoption; the consumed key still prevents a second
      // message for this switch.
      if (!candidate.waiting) return drop("already consumed for this switch");
      return this.logOnce(agentId, `used|${id}`, `waiting for the next switch agent=${who} reason=attempt already used for this switch`);
    }
    const park = (message: string, tag: string) => {
      candidate.waiting = true;
      this.logOnce(agentId, tag, message);
    };
    // The target's cached status (windows and paid usage); no check configured means no evidence.
    let usage: TargetUsage | null = null;
    if (this.accountUsage) {
      const account = await withTimeout(this.accountUsage(pending.accountId), this.timeoutMs).catch(() => null);
      usage = account ? targetUsage(account, this.now()) : { verdict: "unknown", readAt: null };
    }
    if (candidate.at >= pending.since) {
      // The limit may have hit either login (an agent still on the old login hits the old limit after an automatic
      // switch). Continue only on a usable reading of the target fetched after the limit ended: it proves the
      // agent did not hit the target's subscription limit, or that credits now cover it.
      if (!(usage?.verdict === "usable" && usage.readAt !== null && usage.readAt > candidate.at))
        return park(`waiting for the next switch agent=${who}`, `next|${id}`);
    }
    if (usage?.verdict === "exhausted") {
      // The target would hit the limit again and suppress the agent.
      return park(`waiting until the target has headroom or the next switch agent=${who} reason=target exhausted`, `exhausted|${id}`);
    }
    if (usage?.verdict === "unknown")
      this.logOnce("", `unknown|${pending.key}`, `target usage unreadable, stale or unknown, continuing anyway account=${pending.accountId} key=${shortKey(pending.key)}`);
    candidate.waiting = false;
    this.waitLogged.delete(`${agentId}\0next|${id}`);
    this.waitLogged.delete(`${agentId}\0exhausted|${id}`);
    if (this.ledger.state(pending.key, agentId) === "inflight") return; // the handoff is reloading it; a later run continues
    const first = await this.eligible(port, pending, agentId, candidate, false);
    if (first.state === "wait") {
      // Runs fire on every finished turn host-wide; log the wait once, again only after it resolved.
      this.logOnce(agentId, `busy|${id}`, `waiting agent=${who} reason=turn running`);
      return;
    }
    this.clearLogged(agentId);
    if (first.state === "drop") return drop(first.reason);
    this.say(`login recheck before reload ok account=${pending.accountId} agent=${who}`);
    // Every side effect is preceded by a fresh eligibility check made after the previous persistence
    // step finished, and by a synchronous identity check with no await in between.
    if (!(await this.consume(id))) return drop("could not persist the attempt");
    this.say(`attempt persisted agent=${who} turn=${short(candidate.turnId)} key=${shortKey(pending.key)}`);
    const beforeReload = await this.eligible(port, pending, agentId, candidate, false).catch(() => ({ state: "drop" as const, reason: "check failed" }));
    if (beforeReload.state !== "ok" || !this.same(pending, agentId, candidate)) return drop(beforeReload.state === "drop" ? `${beforeReload.reason} (after persisting)` : "changed after persisting");
    // One reload per agent per switch: the handoff may have reloaded this agent already.
    const prior = this.ledger.state(pending.key, agentId);
    if (prior === "inflight") {
      // The handoff claimed it while the attempt was being saved: give the attempt back, the next run continues.
      this.state.consumed = this.state.consumed.filter((v) => v !== id);
      await this.persist();
      return;
    }
    if (prior === "failed") {
      this.candidates.get(agentId) === candidate && this.candidates.delete(agentId);
      return void this.say(`reload by the handoff failed agent=${who}, attempt consumed, no message`);
    }
    if (prior === "done") this.say(`reload already done by the handoff agent=${who}`);
    else {
      if (!this.ledger.claim(pending.key, agentId)) return;
      this.say(`reload started agent=${who}`);
      try {
        await withTimeout(port.reload(agentId), this.timeoutMs);
        this.ledger.finish(pending.key, agentId, true);
      } catch {
        this.ledger.finish(pending.key, agentId, false);
        this.candidates.get(agentId) === candidate && this.candidates.delete(agentId);
        return void this.say(`reload failed agent=${who}, attempt consumed, no message`);
      }
      this.say(`reload finished agent=${who}`);
    }
    const second = await this.eligible(port, pending, agentId, candidate, true).catch(() => ({ state: "drop" as const, reason: "check failed" }));
    if (second.state !== "ok") {
      if (second.state === "drop" && second.reason.startsWith("login changed")) {
        // Nothing was sent; the candidate waits for the adoption of the newer switch (a new key, a new attempt).
        candidate.waiting = true;
        return void this.say(`login recheck after reload failed agent=${who}, ${second.reason.replace("login changed, ", "")}, no message, waiting for the next switch`);
      }
      this.candidates.get(agentId) === candidate && this.candidates.delete(agentId);
      return void this.say(`skipped agent=${who} reason=${second.state === "drop" ? second.reason : "not idle"} (after reload)`);
    }
    this.say(`login recheck after reload ok account=${pending.accountId} agent=${who}`);
    // Mark the continuation before sending so a restart between the two cannot treat it as user activity.
    this.dropLineage(agentId);
    const mark = { agentId, state: "sent" as const, turnId: null };
    this.state.lineage.push(mark);
    const saved = await this.persist();
    const beforeSend = saved ? await this.eligible(port, pending, agentId, candidate, true).catch(() => ({ state: "drop" as const, reason: "check failed" })) : ({ state: "drop" as const, reason: "could not persist the marker" });
    if (beforeSend.state !== "ok" || !this.same(pending, agentId, candidate) || this.lineageOf(agentId) !== mark) {
      // Nothing was sent: remove the marker so a later turn is not mistaken for a continuation.
      if (this.lineageOf(agentId) === mark) this.dropLineage(agentId);
      await this.persist();
      return drop(beforeSend.state === "drop" ? `${beforeSend.reason} (before sending)` : "changed before sending");
    }
    this.candidates.delete(agentId);
    try {
      await withTimeout(send(agentId, continuationText), this.timeoutMs);
      this.say(`continuation sent agent=${who} turn=${short(candidate.turnId)} key=${shortKey(pending.key)}`);
    } catch {
      this.say(`send failed agent=${who}, attempt already consumed, not retried`);
    }
  }

  private async consume(id: string): Promise<boolean> {
    this.state.consumed = [...this.state.consumed.filter((v) => v !== id), id];
    return this.persist();
  }
}
