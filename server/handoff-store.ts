import { lstat, mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HandoffState } from "../shared/handoff.js";
import type { HandoffStore } from "./handoff.js";

/** Default location: plugin-owned, outside the CLI's ~/.subbaton state. Holds no secrets. */
export const defaultHandoffPath = () => join(homedir(), "Library", "Application Support", "SubBaton Paseo", "handoff-v1.json");

/** Owner-only JSON file replaced atomically (write temp, rename). Symlinks and oversize files are refused. */
export function fileHandoffStore(path = defaultHandoffPath()): HandoffStore {
  return {
    async load() {
      let info;
      try {
        info = await lstat(path);
      } catch {
        return null;
      }
      if (!info.isFile() || info.size > 256 * 1024) throw new Error("Unsafe handoff state file.");
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    },
    async setAside() {
      const aside = `${path}.unreadable-${Date.now()}`;
      try {
        await rename(path, aside);
        return basename(aside);
      } catch {
        return null;
      }
    },
    async save(state: HandoffState) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
  };
}
