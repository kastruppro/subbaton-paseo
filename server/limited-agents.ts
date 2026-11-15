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
export function isLimitFailure(outcome: TurnOutcome): boolean {
  if (outcome.kind !== "failed") return false;
  const { message, code } = outcome.error;
  return (code !== undefined && limitCodes.has(code)) || (typeof message === "string" && limitMessage.test(message));
}

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
  ) {}

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

  private forget(agentId: string) {
    this.candidates.delete(agentId);
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
      this.forget(agent.id);
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
      this.forget(agent.id);
      if (isLimitFailure(outcome)) {
        if (continuation) {
          // A limited continuation is never continued again until new user activity.
          if (!this.state.suppressed.includes(agent.id)) this.state.suppressed.push(agent.id);
          this.dropLineage(agent.id);
        } else if (
          this.trusted &&
          turnId &&
          !this.state.suppressed.includes(agent.id) &&
          (await this.resumeEnabled())
        )
          this.candidates.set(agent.id, { turnId, at: this.now() });
      } else if (continuation) this.dropLineage(agent.id);
      await this.persist();
    })();
  }

  async archived(agentId: string): Promise<void> {
    await this.init();
    this.forget(agentId);
    this.dropLineage(agentId);
    await this.persist();
  }

  /**
   * A verified Codex switch. `expectedAccount` (the switch target, when known) must be the account that
   * is active now; `switchedAt` is when the switch happened (default: now), so a limit that ended after
   * it, on the new login, is never recovered. A newer adoption supersedes a pending one.
   */
  adopt(key: string, expectedAccount: string | null, switchedAt: number | null = null): Promise<void> {
    return this.serial(async () => {
      await this.init();
      const current = await this.currentAccount().catch(() => null);
      if (!this.trusted || !current || (expectedAccount !== null && expectedAccount !== current)) {
        this.pending = null;
        return;
      }
      this.pending = { key, accountId: current, since: Math.min(this.now(), switchedAt ?? Infinity) };
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
        await this.attempt(port, pending, agentId, candidate).catch(() => undefined);
      }
    });
  }

  private same(pending: Pending, agentId: string, candidate: Candidate) {
    return this.pending === pending && this.candidates.get(agentId) === candidate;
  }
  private async eligible(port: AgentPort, pending: Pending, agentId: string, candidate: Candidate, afterReload: boolean) {
    if (!this.same(pending, agentId, candidate) || !(await this.resumeEnabled())) return "drop" as const;
    if (this.state.suppressed.includes(agentId)) return "drop" as const;
    if ((await this.currentAccount().catch(() => null)) !== pending.accountId) return "drop" as const;
    const snapshot = (await withTimeout(port.list(), this.timeoutMs)).find((a) => a.id === agentId);
    if (!snapshot || snapshot.provider !== "codex") return "drop" as const;
    if (!this.same(pending, agentId, candidate)) return "drop" as const;
    if (busy(snapshot)) return afterReload ? ("drop" as const) : ("wait" as const);
    if (afterReload ? snapshot.status !== "idle" : !["idle", "error"].includes(snapshot.status)) return "drop" as const;
    return "ok" as const;
  }

  private async attempt(port: AgentPort, pending: Pending, agentId: string, candidate: Candidate) {
    const send = port.send!.bind(port);
    if (candidate.at >= pending.since) return void this.candidates.delete(agentId);
    const id = `${pending.key}|${agentId}|${candidate.turnId}`;
    if (this.state.consumed.includes(id)) return void this.candidates.delete(agentId);
    const first = await this.eligible(port, pending, agentId, candidate, false);
    if (first === "wait") return;
    if (first === "drop") return void (this.candidates.get(agentId) === candidate && this.candidates.delete(agentId));
    // Reload, then recheck; a failed reload or send consumes the attempt.
    if (!(await this.consume(id))) return void this.candidates.delete(agentId);
    try {
      await withTimeout(port.reload(agentId), this.timeoutMs);
    } catch {
      return void this.candidates.delete(agentId);
    }
    const second = await this.eligible(port, pending, agentId, candidate, true).catch(() => "drop" as const);
    if (second !== "ok") return void (this.candidates.get(agentId) === candidate && this.candidates.delete(agentId));
    this.candidates.delete(agentId);
    this.dropLineage(agentId);
    this.state.lineage.push({ agentId, state: "sent", turnId: null });
    if (!(await this.persist())) return;
    try {
      await withTimeout(send(agentId, continuationText), this.timeoutMs);
    } catch {
      // consumed already; never retried
    }
  }

  private async consume(id: string): Promise<boolean> {
    this.state.consumed = [...this.state.consumed.filter((v) => v !== id), id];
    return this.persist();
  }
}
