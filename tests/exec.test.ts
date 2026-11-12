import test from "node:test";
import assert from "node:assert/strict";
import { nativeCLI, maxInputBytes } from "../server/exec.js";

// Uses /bin/cat as a harmless stand-in child; never the SubBaton CLI.
test("native execution passes batch input on stdin without a shell", async () => {
  const result = await nativeCLI.run("/bin/cat", [], 5000, '{"changes":{"/claude/autoEnabled":true}}');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"changes":{"/claude/autoEnabled":true}}');
});
test("commands without input get a closed stdin instead of waiting", async () => {
  const result = await nativeCLI.run("/bin/cat", [], 5000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});
test("oversized input is refused before spawning", async () => {
  const result = await nativeCLI.run("/nonexistent/never-spawned", [], 5000, "x".repeat(maxInputBytes + 1));
  assert.equal(result.notStarted, true);
});
