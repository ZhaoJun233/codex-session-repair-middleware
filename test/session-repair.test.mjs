import test from "node:test";
import assert from "node:assert/strict";
import { repairSessionResources, SessionRepairError } from "../session-repair.mjs";
import { id, user, assistant, history, cases } from "./cases.mjs";

test("uses copies while retaining untouched items, content and tool identities", () => {
  const item = Object.freeze(assistant());
  const untouched = Object.freeze(user());
  const tools = Object.freeze(history().tools);
  const body = Object.freeze({ store: true, input: Object.freeze([untouched, item]), tools });
  const result = repairSessionResources(body);
  assert.equal(result.changed, true);
  assert.notEqual(result.body, body);
  assert.notEqual(result.body.input, body.input);
  assert.equal(result.body.input[0], untouched);
  assert.notEqual(result.body.input[1], item);
  assert.equal(result.body.input[1].content, item.content);
  assert.equal(result.body.tools, tools);
  assert.equal(result.body.store, true);
  assert.equal(item.id, id("msg"));
  assert.equal(item.status, "completed");
});

for (const value of [undefined, null, true, 42, "plaintext", [], { input: null }, { input: [null] }]) {
  test("unknown representations return the original identity: " + JSON.stringify(value), () => {
    const result = repairSessionResources(value);
    assert.equal(result.body, value);
    assert.equal(result.changed, false);
  });
}

for (const value of [id("msg"), "MSG_0123456789ABCDEF", "msg_0123456789abcdef", "business-id", "msg_short", "msg_0123456789abcdef-not-an-id", "123_0123456789abcdef"]) {
  test("applies only the existing server ID rule: " + value, () => {
    const body = { input: [{ ...assistant(), id: value }] };
    const result = repairSessionResources(body);
    const serverId = [id("msg"), "MSG_0123456789ABCDEF", "msg_0123456789abcdef"].includes(value);
    assert.equal(result.changed, serverId);
    if (serverId) {
      assert.equal(Object.hasOwn(result.body.input[0], "id"), false);
      assert.equal(Object.hasOwn(result.body.input[0], "status"), false);
    } else {
      assert.equal(result.body, body);
      assert.equal(result.body.input[0].id, value);
      assert.equal(result.body.input[0].status, "completed");
    }
    assert.equal(body.input[0].id, value);
  });
}

for (const fixture of cases.filter(fixture => fixture.errorCode)) {
  test("core validation retains the original input: " + fixture.name, () => {
    const body = structuredClone(fixture.body);
    assert.throws(() => repairSessionResources(body), error => {
      assert.ok(error instanceof SessionRepairError);
      assert.equal(error.name, "SessionRepairError");
      assert.equal(error.code, fixture.errorCode);
      assert.equal(error.message.includes("synthetic-private-marker"), false);
      return true;
    });
    assert.deepEqual(body, fixture.body);
  });
}

test("does not trigger special-property setters when copying JSON business data", () => {
  const body = JSON.parse('{"input":"Visible","previous_response_id":"synthetic-response","__proto__":{"business":"keep"},"constructor":{"id":"business-id"}}');
  const result = repairSessionResources(body);
  assert.equal(result.changed, true);
  assert.equal(Object.hasOwn(result.body, "__proto__"), true);
  assert.deepEqual(result.body.__proto__, { business: "keep" });
  assert.deepEqual(result.body.constructor, { id: "business-id" });
  assert.equal(Object.getPrototypeOf(result.body), Object.prototype);
});
