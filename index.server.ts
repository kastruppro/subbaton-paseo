import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  hostSettings,
  displaySettings,
  statusRpc,
  switchRpc,
  strategyRpc,
  refreshRpc,
} from "./shared/contracts.js";
import { SubBatonService } from "./server/service.js";
import { nativeCLI, resolveBinary } from "./server/exec.js";
export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(hostSettings);
  server.registerSettings(displaySettings);
  const service = new SubBatonService(nativeCLI, async () => {
    const current = await settings.read();
    if (current.status !== "ready") throw new Error("Settings unavailable");
    return resolveBinary(current.values.binaryPath);
  });
  server.handle(statusRpc, () => service.status());
  server.handle(switchRpc, (input) => service.switch(input));
  server.handle(strategyRpc, (input) => service.strategy(input));
  server.handle(refreshRpc, () => service.refresh());
  return () => {};
}
