import test from "node:test";
import assert from "node:assert/strict";
import { controlFor, groupFor, parseOwnerNames } from "../client/settings-model.js";
import { validValue, normalizeSection, validateChanges } from "../server/settings.js";
import { settingsFieldSchema } from "../shared/settings.js";
import { settingsMessages } from "../shared/settings-messages.js";
import { claudeSection } from "./settings-fixtures.js";

test("trusted owners uses a Codex string-list editor and validates without resolving users on the client", () => {
  const field = settingsFieldSchema.parse({path:"trustedExecutableOwners",type:"array",title:"Owners",runtime:"active"});
  const section = normalizeSection("codex",claudeSection());
  assert.equal(controlFor(section,field,[]).kind,"stringList");
  assert.equal(groupFor(field.path),"Codex");
  assert.deepEqual(parseOwnerNames(" _brewau, builder "),["_brewau","builder"]);
  assert.deepEqual(parseOwnerNames(""),[]);
  assert.equal(validValue(section,field,["_brewau"]),true);
  for (const value of [["x","x"],["bad/name"],Array(9).fill("x"),[1]]) assert.equal(validValue(section,field,value as never),false);
  section.fields.push(field);
  assert.deepEqual(validateChanges(section,[{path:["trustedExecutableOwners"],value:["bad/name"]}]),{ok:false,code:"invalidTrustedExecutableOwners"});
  assert.match(settingsMessages.invalidTrustedExecutableOwners,/existing local account/);
});
