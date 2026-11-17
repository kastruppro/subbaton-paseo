import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  handoffControlInput,
  handoffControlRpc,
  handoffRequestInput,
  handoffRequestRpc,
  handoffSettings,
  handoffStatusRpc,
  type HandoffSettings,
} from "../shared/handoff.js";
import { HandoffCoordinator, paseoAgentPort, type AgentPort, type HandoffStore } from "./handoff.js";
import { LimitedAgentRecovery, type RecoveryStore, type TurnOutcome } from "./limited-agents.js";
import type { SubBatonService } from "./service.js";

const defaults: HandoffSettings = handoffSettings.schema.parse({});

type Host = Pick<PluginServerContext, "registerSettings" | "handle" | "addHook">;

/**
 * Wires the coordinator into the plugin server. The SDK hands a PaseoApi only to RPC handlers and
 * hooks, so the latest one seen is kept for the periodic tick; turn-end hooks nudge a tick at the
 * idle boundary. Returns the cleanup function.
 */
export function registerHandoff(
  server: Host,
  service: SubBatonService,
  store: HandoffStore,
  intervalMs = 5000,
  recoveryStore: RecoveryStore = { load: async () => null, save: async () => {} },
) {
  const settings = server.registerSettings(handoffSettings);
  const read = async (): Promise<HandoffSettings> => {
    const current = await settings.read();
    return current.status === "ready" ? current.values : defaults;
  };
  const coordinator = new HandoffCoordinator(service.handoffCli(), store, read);
  let latest: AgentPort | null = null;
  const capture = (context: unknown) => {
    const port = paseoAgentPort((context as { paseo?: unknown } | null)?.paseo);
    if (port) latest = port;
    return port;
  };
  const recovery = new LimitedAgentRecovery(
    recoveryStore,
    async () => (await read()).resumeLimitedCodexAgents,
    () => service.activeAccount("codex"),
    undefined,
    undefined,
    undefined,
    (id) => service.accountUsage("codex", id),
    coordinator.ledger,
    {
      runOnceObserved: (id) => service.codexAutoRunOnceObserved(id),
      onSwitched: () => {
        coordinator.pollEventsSoon();
        nudge();
      },
    },
  );
  coordinator.onCodexAdopted = (key, account, switchedAt) =>
    void recovery
      .adopt(key, account, switchedAt)
      .then(() => recovery.run(latest))
      .catch(() => undefined);
  const nudge = (port: AgentPort | null = latest) => void coordinator.tick(port).catch(() => undefined);

  server.handle(handoffStatusRpc, (_input, context) => {
    const port = capture(context);
    if (coordinator.hasActive()) nudge(port);
    return coordinator.init().then(() => coordinator.status());
  });
  server.handle(handoffRequestRpc, async (input, context) => {
    const parsed = handoffRequestInput.safeParse(input);
    if (!parsed.success)
      return { result: { outcome: "error" as const, code: "invalidInput", message: "Choose Codex or agy and a saved account." }, handoff: null };
    const port = capture(context);
    const response = await coordinator.request(parsed.data.provider, parsed.data.target);
    nudge(port);
    return response;
  });
  server.handle(handoffControlRpc, async (input, context) => {
    const parsed = handoffControlInput.safeParse(input);
    if (!parsed.success)
      return { result: { outcome: "error" as const, code: "invalidInput", message: "Unsupported handoff action." }, handoff: null };
    const port = capture(context);
    const response = await coordinator.control(parsed.data.provider, parsed.data.action);
    nudge(port);
    return response;
  });
  type HookEvent = { agent?: { id: string; provider: string; workspaceId?: string | null; createdAt?: string | null }; turnId?: string | null; outcome?: TurnOutcome };
  const removeBefore = server.addHook("agent.turn.before", async (event, context) => {
    capture(context);
    const e = event as HookEvent;
    if (e.agent) await recovery.turnBefore(e.agent, e.turnId ?? null).catch(() => undefined);
  });
  const removeArchive = server.addHook("agent.archive.after", async (event) => {
    const e = event as HookEvent;
    if (e.agent) await recovery.archived(e.agent.id).catch(() => undefined);
  });
  const removeHook = server.addHook("agent.turn.after", async (event, context) => {
    const port = capture(context);
    const e = event as HookEvent;
    if (e.agent && e.outcome) await recovery.turnAfter(e.agent, e.turnId ?? null, e.outcome).catch(() => undefined);
    if (recovery.hasPending()) void recovery.run(port ?? latest).catch(() => undefined);
    nudge(port);
  });
  const timer = setInterval(() => {
    // A parked candidate waits for a fresher target reading; no turn ends at the idle boundary to trigger a run.
    if (recovery.hasPending()) void recovery.run(latest).catch(() => undefined);
    nudge();
  }, intervalMs);
  timer.unref?.();
  return {
    coordinator,
    recovery,
    capture,
    cleanup: () => {
      clearInterval(timer);
      removeHook();
      removeBefore();
      removeArchive();
    },
  };
}
