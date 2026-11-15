import { createContext, useContext } from "react";
/** Test stand-in for @getpaseo/plugin/client: settings values come from the scenario context. */
export const ScenarioCtx = createContext<{ settings: Record<string, unknown>; rpc: (name: string, input: unknown) => Promise<unknown> } | null>(null);
export function useRpc(rpc: { name: string }) {
  const s = useContext(ScenarioCtx)!;
  return async (input: unknown) => s.rpc(rpc.name, input);
}
export function useSettings(def: { id: string }) {
  const s = useContext(ScenarioCtx)!;
  return { status: "ready", values: s.settings[def.id], revision: 1, saving: false, saveError: false, save: async () => true, reload: async () => {}, reset: async () => {} };
}
