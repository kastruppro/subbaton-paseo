import { build } from "esbuild";
import { resolve } from "node:path";

/** Bundles the real settings page for node with the plugin SDK replaced by small stand-ins, and returns renderPage. */
export async function loadRenderer(): Promise<(doc: unknown, extra?: { status?: unknown }) => string> {
  const root = resolve(import.meta.dirname, "../..");
  const out = await build({
    entryPoints: [resolve(root, "tests/render/page.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    logLevel: "silent",
    define: { __DEV__: "false", "process.env.NODE_ENV": '"test"' },
    alias: {
      "react-native": "react-native-web",
      "@getpaseo/plugin/client/ui": resolve(root, "tests/render/plugin-ui.tsx"),
      "@getpaseo/plugin/client": resolve(root, "tests/render/plugin-client.tsx"),
    },
    nodePaths: [resolve(root, "node_modules")],
  });
  const module = { exports: {} as { renderPage: (doc: unknown, extra?: { status?: unknown }) => string } };
  new Function("module", "exports", "require", out.outputFiles[0]!.text)(module, module.exports, (await import("node:module")).createRequire(resolve(root, "package.json")));
  return module.exports.renderPage;
}
