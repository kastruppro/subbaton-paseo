import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScenarioCtx } from "./plugin-client";
import { ControlScreen } from "../../client/control";

const theme = { colors: new Proxy({}, { get: () => "#808080" }) };
/** Renders the whole settings page to static markup with seeded data (no network, no host). */
export function renderPage(doc: unknown, extra: { status?: unknown } = {}): string {
  const now = 1_800_000_000;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["subbaton-settings", "h"], { ok: true, data: doc, error: null });
  client.setQueryData(["subbaton-poller", "h"], { ok: true, data: { installed: true, loaded: true, lastTickAt: now, stale: false, pinnedEnvironment: {}, providers: {} }, error: null });
  client.setQueryData(["subbaton-events", "h"], { ok: true, data: { events: [{ id: "e1", at: now, provider: "claude", kind: "automaticSwitch" }] }, error: null });
  client.setQueryData(["subbaton-status", "h"], { ok: true, data: extra.status ?? { cacheOnly: true, generatedAt: now, providers: [] }, error: null });
  client.setQueryData(["subbaton-handoff", "h"], { handoffs: { codex: null, agy: null }, agentApi: true, notice: null });
  const ctx = {
    settings: {
      display: { items: [{ provider: "claude", windowId: "five_hour" }], warning: 80, danger: 100 },
      host: { binaryPath: "/x/subbaton", allowPathLookup: false },
      handoff: { reloadCodexAfterAutomaticSwitch: true, restartCodexDaemon: false, closeAgyForAutomaticSwitch: true, idleWaitMinutes: 30, resumeLimitedCodexAgents: true },
    },
    rpc: async () => ({}),
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ScenarioCtx.Provider value={ctx}>
        <ControlScreen host={{ id: "h", label: "Host" } as never} theme={theme as never} layout={{ compact: false } as never} />
      </ScenarioCtx.Provider>
    </QueryClientProvider>,
  );
}
