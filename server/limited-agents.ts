import { z } from "zod";
import type { AgentPort, AgentSnapshot } from "./handoff.js";

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
});
export type RecoveryState = z.infer<typeof stateSchema>;
const emptyState = (): RecoveryState => ({ schemaVersion: 1, consumed: [], suppressed: [], lineage: [] });

interface Candidate {
  turnId: string;
  at: number;
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

  constructor(
    private store: RecoveryStore,
    private resumeEnabled: () => Promise<boolean>,
    /** The active saved Codex account (fresh, cache-only status); null when unknown. */
    private currentAccount: () => Promise<string | null>,
    private now: () => number = () => Date.now() / 1000,
    private timeoutMs = 30_000,
    /** One line per decision; the plugin's stdout shows in `paseo plugin logs subbaton`. */
    private log: (line: string) => void = (line) => console.log(line),
  ) {}

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

  private forget(agentId: string, reason?: string) {
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
      this.pending = { key, accountId: current, since: Math.min(this.now(), switchedAt ?? Infinity) };
      this.say(`switch adopted key=${shortKey(key)} account=${current} candidates=${this.candidates.size}`);
    });
  }

  hasPending() {
    return this.pending !== null && this.candidates.size > 0;
  }

  /** Continue every eligible candidate; busy agents wait for a later run. */
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
      if (this.candidates.get(agentId) === candidate) this.candidates.delete(agentId);
      if (reason) this.say(`skipped agent=${who} reason=${reason}`);
    };
    if (candidate.at >= pending.since) return drop("limit ended after the switch");
    const id = `${pending.key}|${agentId}|${candidate.turnId}`;
    if (this.state.consumed.includes(id)) return drop("already consumed for this switch");
    const first = await this.eligible(port, pending, agentId, candidate, false);
    if (first.state === "wait") return void this.say(`waiting agent=${who} reason=turn running`);
    if (first.state === "drop") return drop(first.reason);
    this.say(`login recheck before reload ok account=${pending.accountId} agent=${who}`);
    // Every side effect is preceded by a fresh eligibility check made after the previous persistence
    // step finished, and by a synchronous identity check with no await in between.
    if (!(await this.consume(id))) return drop("could not persist the attempt");
    this.say(`attempt persisted agent=${who} turn=${short(candidate.turnId)} key=${shortKey(pending.key)}`);
    const beforeReload = await this.eligible(port, pending, agentId, candidate, false).catch(() => ({ state: "drop" as const, reason: "check failed" }));
    if (beforeReload.state !== "ok" || !this.same(pending, agentId, candidate)) return drop(beforeReload.state === "drop" ? `${beforeReload.reason} (after persisting)` : "changed after persisting");
    this.say(`reload started agent=${who}`);
    try {
      await withTimeout(port.reload(agentId), this.timeoutMs);
    } catch {
      this.candidates.get(agentId) === candidate && this.candidates.delete(agentId);
      return void this.say(`reload failed agent=${who}, attempt consumed, no message`);
    }
    this.say(`reload finished agent=${who}`);
    const second = await this.eligible(port, pending, agentId, candidate, true).catch(() => ({ state: "drop" as const, reason: "check failed" }));
    if (second.state !== "ok") {
      this.candidates.get(agentId) === candidate && this.candidates.delete(agentId);
      return void this.say(
        second.state === "drop" && second.reason.startsWith("login changed")
          ? `login recheck after reload failed agent=${who}, ${second.reason.replace("login changed, ", "")}, no message`
          : `skipped agent=${who} reason=${second.state === "drop" ? second.reason : "not idle"} (after reload)`,
      );
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
