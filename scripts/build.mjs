import { build } from "esbuild";
const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "build",
  metafile: true,
  external: [
    "@getpaseo/plugin",
    "@getpaseo/plugin/*",
    "react",
    "react/*",
    "react-native",
    "@tanstack/react-query",
    "zod",
  ],
};
const client = await build({
  ...shared,
  entryPoints: ["index.client.tsx"],
  platform: "browser",
});
if (
  Object.keys(client.metafile.inputs).some((path) => path.startsWith("server/"))
)
  throw new Error("Server code entered the client bundle");
await build({ ...shared, entryPoints: ["index.server.ts"], platform: "node" });
