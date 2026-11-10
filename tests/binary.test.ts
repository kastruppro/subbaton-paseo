import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBinary,
  verifySignature,
  codeRequirement,
  type BinarySystem,
} from "../server/binary.js";
const root = {
  uid: 0,
  mode: 0o755,
  kind: "directory" as const,
  executable: false,
};
function fixture() {
  const values = new Map<
    string,
    {
      uid: number;
      mode: number;
      kind: "directory" | "file";
      executable: boolean;
    }
  >([
    ["/", { ...root }],
    ["/Users", { ...root }],
    ["/Users/Shared", { ...root, mode: 0o1777 }],
    ["/Users/Shared/subbaton", { ...root, uid: 501 }],
    [
      "/Users/Shared/subbaton/subbaton",
      { uid: 501, mode: 0o755, kind: "file", executable: true },
    ],
    ["/safe", { ...root }],
    ["/safe/subbaton", { uid: 0, mode: 0o755, kind: "file", executable: true }],
  ]);
  let signature = true;
  const signed: string[] = [];
  const system: BinarySystem = {
    uid: 501,
    path: "/safe",
    async realpath(p) {
      if (!values.has(p))
        throw Object.assign(new Error("secret path"), { code: "ENOENT" });
      return p;
    },
    async stat(p) {
      const value = values.get(p);
      if (!value) throw new Error("missing");
      return value;
    },
    async verify(p) {
      signed.push(p);
      return signature;
    },
  };
  return {
    system,
    values,
    signed,
    badSignature() {
      signature = false;
    },
  };
}
test("M2 permits only trusted ownership permissions and Developer ID signature", async () => {
  const f = fixture();
  assert.equal(
    await resolveBinary("/Users/Shared/subbaton/subbaton", false, f.system),
    "/Users/Shared/subbaton/subbaton",
  );
  assert.equal(f.signed.length, 1);
  for (const path of [
    "/Users/Shared/subbaton/subbaton",
    "/Users/Shared/subbaton",
    "/Users",
    "/",
  ])
    for (const change of [{ uid: 502 }, { mode: 0o777 }]) {
      const f = fixture();
      Object.assign(f.values.get(path)!, change);
      await assert.rejects(
        resolveBinary("/Users/Shared/subbaton/subbaton", false, f.system),
      );
      assert.equal(f.signed.length, 0);
    }
  const bad = fixture();
  bad.badSignature();
  await assert.rejects(resolveBinary("/safe/subbaton", false, bad.system));
});
test("M2 never falls back to PATH without opt-in; PATH entries receive the same checks", async () => {
  const f = fixture();
  f.values.delete("/Users/Shared/subbaton/subbaton");
  await assert.rejects(
    resolveBinary("/Users/Shared/subbaton/subbaton", false, f.system),
  );
  assert.equal(
    await resolveBinary("/Users/Shared/subbaton/subbaton", true, f.system),
    "/safe/subbaton",
  );
  await assert.rejects(resolveBinary("subbaton", false, f.system));
  assert.equal(
    await resolveBinary("subbaton", true, f.system),
    "/safe/subbaton",
  );
  for (const path of ["./subbaton", "bin/subbaton", "bad\npath"])
    await assert.rejects(resolveBinary(path, true, f.system));
  f.values.get("/safe")!.mode = 0o777;
  await assert.rejects(resolveBinary("subbaton", true, f.system));
});
test("M2 shared sticky exception is root-owned and never a direct binary parent", async () => {
  const f = fixture();
  f.values.set("/Users/Shared/binary", {
    uid: 501,
    mode: 0o755,
    kind: "file",
    executable: true,
  });
  await assert.rejects(resolveBinary("/Users/Shared/binary", false, f.system));
  f.values.get("/Users/Shared")!.uid = 502;
  await assert.rejects(
    resolveBinary("/Users/Shared/subbaton/subbaton", false, f.system),
  );
});
test("M2 verifies the canonical target, Developer ID chain, team and identifier via argv", async () => {
  const f = fixture();
  f.system.realpath = async () => "/safe/subbaton";
  assert.equal(await resolveBinary("/link", false, f.system), "/safe/subbaton");
  assert.deepEqual(f.signed, ["/safe/subbaton"]);
  const calls: unknown[] = [];
  assert.equal(
    await verifySignature("/safe/subbaton", {
      async run(binary, argv, timeout) {
        calls.push({ binary, argv, timeout });
        return { code: 0, stdout: "" };
      },
    }),
    true,
  );
  assert.deepEqual(calls, [
    {
      binary: "/usr/bin/codesign",
      argv: ["--verify", "--strict", "-R", codeRequirement, "/safe/subbaton"],
      timeout: 5000,
    },
  ]);
  assert.match(codeRequirement, /5W98EXLE44/);
  assert.match(codeRequirement, /dk\.kastruppro\.subbaton/);
  assert.match(codeRequirement, /1\.2\.840\.113635\.100\.6\.1\.13/);
});
test("M2 custom missing path never falls back and non-executable files refuse", async () => {
  const f = fixture();
  await assert.rejects(resolveBinary("/missing/custom", true, f.system));
  assert.equal(f.signed.length, 0);
  f.values.get("/safe/subbaton")!.executable = false;
  await assert.rejects(resolveBinary("/safe/subbaton", false, f.system));
  assert.equal(f.signed.length, 0);
});
