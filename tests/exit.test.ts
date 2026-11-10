import test from "node:test";
import assert from "node:assert/strict";
import { classifyExit } from "../server/exec.js";
test("L6 native exit classification distinguishes pre-spawn errno from killed or incomplete execution", () => {
  assert.deepEqual(classifyExit(null), { code: 0, notStarted: false });
  assert.deepEqual(classifyExit({ code: 1 }), { code: 1, notStarted: false });
  for (const error of [
    { killed: true },
    { signal: "SIGKILL", code: null, killed: false },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { code: null },
  ])
    assert.deepEqual(classifyExit(error), { code: -2, notStarted: false });
  for (const code of ["ENOENT", "EACCES", "ENOEXEC"])
    assert.deepEqual(classifyExit({ code }), { code: -1, notStarted: true });
});
