import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { CliExecutor } from "./service.js";
export const defaultBinary = "/Users/Shared/subbaton/subbaton";
export async function resolveBinary(path: string): Promise<string> {
  if (
    !path ||
    /[\u0000-\u001f]/.test(path) ||
    path.length > 4096 ||
    !(path.startsWith("/") || path === "subbaton")
  )
    throw new Error("Invalid binary path");
  if (path === defaultBinary) {
    try {
      await access(path, constants.X_OK);
    } catch {
      return "subbaton";
    }
  }
  return path;
}
export const nativeCLI: CliExecutor = {
  run(binary, argv, timeout) {
    return new Promise((resolve) => {
      execFile(
        binary,
        argv,
        {
          encoding: "utf8",
          shell: false,
          timeout,
          killSignal: "SIGTERM",
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          const code = error?.killed
            ? -2
            : error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? -1
                : 0;
          resolve({ code, stdout: stdout ?? "" });
        },
      );
    });
  },
};
