import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { subbatonMark } from "../client/icons.js";

const root = new URL("../", import.meta.url);

test("the manifest icon is a package-relative PNG", () => {
  const manifest = JSON.parse(readFileSync(new URL("paseo-plugin.json", root), "utf8"));
  assert.equal(manifest.icon, "assets/icon.png");
  const png = readFileSync(new URL(manifest.icon, root));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("the inline mark follows Paseo's SVG rules and the theme colour", () => {
  assert.match(subbatonMark, /^<svg [^>]*viewBox="0 0 256 256"/);
  assert.equal(subbatonMark.match(/<svg/g)?.length, 1);
  assert.ok(subbatonMark.length < 64 * 1024);
  assert.doesNotMatch(subbatonMark, /<script|<style|<foreignObject|\son[a-z]+=|javascript:|href=/i);
  assert.equal(subbatonMark.match(/<path /g)?.length, 3);
  assert.doesNotMatch(subbatonMark, /fill="#/);
  assert.match(subbatonMark, /fill="currentColor"/);
});
