import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  hostSettings,
  displaySettings,
  statusRpc,
  switchRpc,
  strategyRpc,
  strategyPreviewRpc,
  refreshRpc,
} from "./shared/contracts.js";
import {
  settingsGetRpc,
  settingsSetRpc,
  settingsActionRpc,
  pollerStatusRpc,
  pollerLifecycleRpc,
  eventsRpc,
  autoPlanRpc,
} from "./shared/settings.js";
import { SubBatonService } from "./server/service.js";
import { nativeCLI } from "./server/exec.js";
import { resolveBinary } from "./server/binary.js";
import { registerHandoff } from "./server/handoff-host.js";
import { fileHandoffStore, fileRecoveryStore } from "./server/handoff-store.js";
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(hostSettings);
  server.registerSettings(displaySettings);
  const service = new SubBatonService(nativeCLI, async () => {
    const current = await settings.read();
    if (current.status !== "ready") throw new Error("Settings unavailable");
    return resolveBinary(
      current.values.binaryPath,
      current.values.allowPathLookup,
    );
  });
  const unsubscribe = settings.subscribe(() => service.configurationChanged());
  const handoff = registerHandoff(server, service, fileHandoffStore(), 5000, fileRecoveryStore());
  server.handle(statusRpc, (_input, context) => {
    // Clients poll status; their PaseoApi keeps the handoff coordinator's agent view current.
    handoff.capture(context);
    return service.status();
  });
  server.handle(switchRpc, (input) => service.switch(input));
  server.handle(strategyRpc, (input) => service.strategy(input));
  server.handle(strategyPreviewRpc, (input) => service.strategyPreview(input));
  server.handle(refreshRpc, () => service.refresh());
  server.handle(settingsGetRpc, (input) => service.settings(input));
  server.handle(settingsSetRpc, (input) => service.settingsSet(input));
  server.handle(settingsActionRpc, (input) => service.settingsAction(input));
  server.handle(pollerStatusRpc, () => service.pollerStatus());
  server.handle(pollerLifecycleRpc, (input) => service.pollerLifecycle(input));
  server.handle(eventsRpc, (input) => service.events(input));
  server.handle(autoPlanRpc, (input) => service.autoPlan(input));
  return () => {
    handoff.cleanup();
    unsubscribe();
  };
}
