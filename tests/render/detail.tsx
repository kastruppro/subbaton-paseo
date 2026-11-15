import { renderToStaticMarkup } from "react-dom/server";
import { AccountDetail, PaletteContext } from "../../client/views";
import { themePalette } from "../../client/display";
import type { Account, Provider } from "../../shared/contracts";

const theme = { colors: new Proxy({}, { get: () => "#808080" }) };
/** Renders the shared account detail block (the one the active account and every expanded other account use). */
export function renderDetail(provider: Provider, account: Account, opts: { warning?: number; danger?: number; offline?: boolean; legend?: boolean } = {}): string {
  return renderToStaticMarkup(
    <PaletteContext.Provider value={themePalette(theme as never)}>
      <AccountDetail provider={provider} account={account} warning={opts.warning ?? 80} danger={opts.danger ?? 100} offline={opts.offline ?? false} legend={opts.legend ?? true} />
    </PaletteContext.Provider>,
  );
}
