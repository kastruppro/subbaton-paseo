// One reload per Codex agent per adopted switch. The idle-aware handoff and the limited-agent recovery
// share one ledger: whoever claims an agent first reloads it, the other never reloads it again.
// In memory only; a restart forgets it (a handoff resumed after a restart reloads at most once more).

export type ReloadState = "inflight" | "done" | "failed";

export class ReloadLedger {
  private switches = new Map<string, Map<string, ReloadState>>();

  /** True when the caller now owns the reload of this agent for this switch. Synchronous, so claims never interleave. */
  claim(switchKey: string, agentId: string): boolean {
    let agents = this.switches.get(switchKey);
    if (!agents) {
      agents = new Map();
      this.switches.set(switchKey, agents);
      // Keep only the newest switches.
      for (const old of [...this.switches.keys()].slice(0, Math.max(0, this.switches.size - 20))) this.switches.delete(old);
    }
    if (agents.has(agentId)) return false;
    agents.set(agentId, "inflight");
    return true;
  }
  finish(switchKey: string, agentId: string, ok: boolean) {
    this.switches.get(switchKey)?.set(agentId, ok ? "done" : "failed");
  }
  state(switchKey: string, agentId: string): ReloadState | null {
    return this.switches.get(switchKey)?.get(agentId) ?? null;
  }
}
