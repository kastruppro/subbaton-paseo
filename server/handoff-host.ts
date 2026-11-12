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
import type { SubBatonService } from "./service.js";

const defaults: HandoffSettings = { reloadCodexAfterAutomaticSwitch: true, restartCodexDaemon: false, idleWaitMinutes: 30 };

type Host = Pick<PluginServerContext, "registerSettings" | "handle" | "addHook">;

/**
 * Wires the coordinator into the plugin server. The SDK hands a PaseoApi only to RPC handlers and
 * hooks, so the latest one seen is kept for the periodic tick; turn-end hooks nudge a tick at the
 * idle boundary. Returns the cleanup function.
 */
export function registerHandoff(server: Host, service: SubBatonService, store: HandoffStore, intervalMs = 5000) {
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
  const removeHook = server.addHook("agent.turn.after", async (_event, context) => {
    nudge(capture(context));
  });
  const timer = setInterval(() => nudge(), intervalMs);
  timer.unref?.();
  return {
    coordinator,
    capture,
    cleanup: () => {
      clearInterval(timer);
      removeHook();
    },
  };
}
