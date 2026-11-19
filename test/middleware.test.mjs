import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../codex-session-repair.middleware.js";
import { cases, context, history, cleanedHistory } from "./cases.mjs";

for (const fixture of cases) {
  test(fixture.name, () => {
    const body = structuredClone(fixture.body);
    const ctx = structuredClone(fixture.ctx);
    const rejections = [];
    ctx.reject = (status, message) => rejections.push({ status, message });
    const before = JSON.stringify(body, null, 2);
    const replacement = onRequest(body, ctx);
    assert.deepEqual(body, fixture.body);
    assert.equal(JSON.stringify(body, null, 2), before);

    let dispatches = 0;
    if (rejections.length === 0) dispatches++;
    if (fixture.errorCode) {
      assert.equal(replacement, undefined);
      assert.equal(dispatches, 0);
      assert.equal(rejections.length, 1);
      assert.equal(rejections[0].status, 400);
      assert.ok(rejections[0].message.startsWith(fixture.errorCode + ": "));
      assert.match(rejections[0].message, /[\u4e00-\u9fff]/);
      assert.equal(rejections[0].message.includes("synthetic-private-marker"), false);
      assert.equal(rejections[0].message.includes("synthetic-sealed"), false);
    } else {
      assert.equal(rejections.length, 0);
      assert.equal(dispatches, 1);
      if (Object.hasOwn(fixture, "expected")) {
        assert.deepEqual(replacement, fixture.expected);
        assert.notEqual(replacement, body);
        assert.equal(replacement.store, false);
      } else {
        assert.equal(replacement, undefined);
      }
    }
  });
}

test("handles an absent context without enabling cleanup", () => {
  assert.equal(onRequest(history()), undefined);
  assert.equal(onRequest(history(), null), undefined);
});

test("can toggle repeatedly without state or re-login", () => {
  const body = history();
  const ctx = context({ enabled: false });
  assert.equal(onRequest(body, ctx), undefined);
  ctx.options.enabled = true;
  assert.deepEqual(onRequest(body, ctx), cleanedHistory());
  ctx.options.enabled = false;
  assert.equal(onRequest(body, ctx), undefined);
  ctx.options.enabled = true;
  assert.deepEqual(onRequest(body, ctx), cleanedHistory());
  assert.deepEqual(ctx.state, {});
});

test("a replacement is idempotent and does not change unrelated body fields", () => {
  const body = history();
  const repaired = onRequest(body, context());
  assert.equal(onRequest(repaired, context()), undefined);
  assert.equal(repaired.tools, body.tools);
  assert.equal(repaired.metadata, body.metadata);
  assert.equal(repaired.input[0], body.input[0]);
});

test("unexpected exceptions remain host failures instead of cleanup rejections", () => {
  const failure = new Error("synthetic-programming-failure");
  const body = { get input() { throw failure; } };
  const ctx = context();
  ctx.reject = () => assert.fail("not a cleanup validation error");
  assert.throws(() => onRequest(body, ctx), error => error === failure);
});

test("does not recurse into deeply nested business data", () => {
  const body = history();
  let nested = { id: "business-id", encrypted_content: "literal-business-data" };
  for (let depth = 0; depth < 10000; depth++) nested = { child: nested };
  body.metadata = nested;
  const repaired = onRequest(body, context());
  assert.equal(repaired.metadata, nested);
});

test("handles large parsed plaintext without claiming an original wire-size cap", () => {
  const input = "\u4e2d".repeat(1_500_000);
  const body = { input, previous_response_id: "synthetic-response", store: true };
  const repaired = onRequest(body, context());
  assert.deepEqual(repaired, { input, store: false });
  assert.equal(body.previous_response_id, "synthetic-response");
});
