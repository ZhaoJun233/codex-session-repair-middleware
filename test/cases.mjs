import { pathToFileURL } from "node:url";

export const id = prefix => `${prefix}_0123456789abcdef0123456789abcdef`;
export const user = () => ({ role: "user", content: "Keep every visible word." });
export const assistant = () => ({
  type: "message", id: id("msg"), role: "assistant", status: "completed", phase: "commentary",
  content: [{ type: "output_text", text: "Checking the result.", annotations: [], logprobs: [] }],
});
export const history = () => ({
  model: "synthetic-model", stream: true, store: true, previous_response_id: id("resp"),
  input: [user(), assistant(),
    { type: "reasoning", id: id("rs"), summary: [], encrypted_content: "synthetic-sealed" },
    { type: "compaction", id: id("cmp"), encrypted_content: "synthetic-compacted" },
    { type: "item_reference", id: id("msg") },
    { type: "function_call", id: id("fc"), call_id: id("call"), name: "lookup",
      arguments: '{"id":"business-id","encrypted_content":"literal-tool-data"}',
      encrypted_function_args: "synthetic-sealed-args" },
    { type: "function_call_output", id: id("fco"), call_id: id("call"),
      output: [{ type: "input_text", text: "Keep the tool result." }] },
  ],
  tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {
    id: { type: "string" }, encrypted_content: { type: "string" },
  } } }],
  metadata: { id: id("meta"), previous_response_id: "business-reference" },
});
export const cleanedHistory = () => ({
  model: "synthetic-model", stream: true, store: false,
  input: [user(), {
    type: "message", role: "assistant", phase: "commentary",
    content: [{ type: "output_text", text: "Checking the result.", annotations: [], logprobs: [] }],
  }, {
    type: "function_call", call_id: id("call"), name: "lookup",
    arguments: '{"id":"business-id","encrypted_content":"literal-tool-data"}',
  }, {
    type: "function_call_output", call_id: id("call"),
    output: [{ type: "input_text", text: "Keep the tool result." }],
  }],
  tools: history().tools,
  metadata: { id: id("meta"), previous_response_id: "business-reference" },
});
export const context = (options = { enabled: true }, protocol = "responses", path = "/v1/responses") => ({
  options, protocol, path, model: "synthetic-model", stream: true, state: {},
});

export const cases = [
  { name: "disabled by absent saved option", body: history(), ctx: context({}) },
  { name: "disabled by absent options", body: history(), ctx: { protocol: "responses", path: "/v1/responses" } },
  ...[false, null, "true", 1, [], {}].map(enabled => ({
    name: "requires explicit boolean true: " + JSON.stringify(enabled),
    body: history(), ctx: context({ enabled }),
  })),
  { name: "disabled by null options", body: history(), ctx: context(null) },
  { name: "cleans known history and leaves tool data intact", body: history(), ctx: context(), expected: cleanedHistory() },
  { name: "supports the root Responses endpoint", body: history(), ctx: context({ enabled: true }, "responses", "/responses"), expected: cleanedHistory() },
  { name: "supports a gateway prefix", body: history(), ctx: context({ enabled: true }, "responses", "/agent/v1/responses"), expected: cleanedHistory() },
  ...["chat", "anthropic", "gemini", "unknown"].map(protocol => ({
    name: "bypasses protocol " + protocol, body: history(), ctx: context({ enabled: true }, protocol),
  })),
  ...["/v1/responses/compact", "/v1/chat/completions", "/v1/models", "/notresponses", "/v1/responses/", "/v1/responses?debug=1", "", null].map(path => ({
    name: "bypasses path " + String(path), body: history(), ctx: context({ enabled: true }, "responses", path),
  })),
  { name: "bypasses a missing path", body: history(), ctx: { options: { enabled: true }, protocol: "responses" } },
  { name: "keeps a clean request and store value", body: { input: [user()], store: true }, ctx: context() },
  { name: "keeps an already repaired request", body: cleanedHistory(), ctx: context() },
  { name: "keeps a server conversation string", body: { ...history(), conversation: id("conv") }, ctx: context() },
  { name: "keeps a server conversation object", body: { ...history(), conversation: { id: id("conv") } }, ctx: context() },
  { name: "detaches string input without changing literal IDs", body: { input: `Keep ${id("msg")} in literal text.`, previous_response_id: id("resp"), store: true }, ctx: context(), expected: { input: `Keep ${id("msg")} in literal text.`, store: false } },
  { name: "preserves Unicode and assistant output types", body: { input: [user(), { ...assistant(), content: [{ type: "output_text", text: "\u4fdd\u7559\u4e2d\u6587 \ud83d\ude00" }] }] }, ctx: context(), expected: { input: [user(), { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "\u4fdd\u7559\u4e2d\u6587 \ud83d\ude00" }] }], store: false } },
  ...[null, [], "", { input: [null], previous_response_id: id("resp") }, { input: ["unknown"], previous_response_id: id("resp") }, { input: { future: true }, previous_response_id: id("resp") }, { previous_response_id: id("resp") }].map((body, index) => ({
    name: "bypasses unknown input shape " + index, body, ctx: context(),
  })),
  { name: "keeps clean empty input unchanged", body: { input: [], store: true }, ctx: context() },
  { name: "removes even a null previous response binding", body: { input: "Visible text", previous_response_id: null }, ctx: context(), expected: { input: "Visible text", store: false } },
  { name: "preserves business IDs and nested attachments", body: { input: [assistant(), { type: "message", id: "business-id", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Business text", annotations: [{ id: id("citation") }] }] }, { role: "user", content: [{ type: "input_file", file_id: id("file") }] }] }, ctx: context(), expected: { input: [cleanedHistory().input[1], { type: "message", id: "business-id", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Business text", annotations: [{ id: id("citation") }] }] }, { role: "user", content: [{ type: "input_file", file_id: id("file") }] }], store: false } },
  { name: "cleans encrypted fragments but keeps refusal and phase", body: { input: [user(), { ...assistant(), encrypted_content: "synthetic-sealed", previous_response_id: id("resp"), content: [{ type: "encrypted_content", encrypted_content: "synthetic-fragment" }, { type: "output_text", text: "Visible", annotations: [{ type: "url_citation", url: "https://example.test" }], logprobs: [] }, { type: "refusal", refusal: "Keep the refusal." }] }, { type: "message", role: "assistant", content: [{ type: "encrypted_content", encrypted_content: "synthetic-opaque" }] }] }, ctx: context(), expected: { input: [user(), { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Visible", annotations: [{ type: "url_citation", url: "https://example.test" }], logprobs: [] }, { type: "refusal", refusal: "Keep the refusal." }] }], store: false } },
  { name: "preserves custom tool free-form input, namespace and results", body: { input: [user(), { type: "custom_tool_call", id: id("ctc"), call_id: id("call"), name: "exec", namespace: "functions", input: 'text({ id: "business-id", encrypted_content: "literal data" });', encrypted_function_args: "synthetic-sealed" }, { type: "custom_tool_call_output", id: id("ctco"), call_id: id("call"), output: "Keep the complete result.", encrypted_content: "synthetic-sealed" }] }, ctx: context(), expected: { input: [user(), { type: "custom_tool_call", call_id: id("call"), name: "exec", namespace: "functions", input: 'text({ id: "business-id", encrypted_content: "literal data" });' }, { type: "custom_tool_call_output", call_id: id("call"), output: "Keep the complete result." }], store: false } },
  { name: "drops bound reasoning without inventing an ID-less item", body: { input: [user(), { type: "reasoning", id: id("rs"), summary: [{ type: "summary_text", text: "Synthetic summary" }] }, { type: "reasoning", id: "local-reasoning", summary: [], future_state: { id: id("rs") } }] }, ctx: context(), expected: { input: [user(), { type: "reasoning", id: "local-reasoning", summary: [], future_state: { id: id("rs") } }], store: false } },
  { name: "leaves unknown kinds and opaque fields alone", body: { input: [assistant(), { type: "future_item", id: id("future"), encrypted_content: "synthetic-future", nested: { previous_response_id: id("resp") } }] }, ctx: context(), expected: { input: [cleanedHistory().input[1], { type: "future_item", id: id("future"), encrypted_content: "synthetic-future", nested: { previous_response_id: id("resp") } }], store: false } },
  { name: "leaves an unbound incomplete tool alone", body: { input: [user(), { type: "function_call", name: "lookup" }], store: true }, ctx: context() },
  { name: "keeps empty but replayable tool text", body: { input: [user(), { type: "function_call", id: id("fc"), call_id: "keep", name: "lookup", arguments: "" }, { type: "function_call_output", id: id("fco"), call_id: "keep", output: "" }] }, ctx: context(), expected: { input: [user(), { type: "function_call", call_id: "keep", name: "lookup", arguments: "" }, { type: "function_call_output", call_id: "keep", output: "" }], store: false } },
  { name: "cleans a message with implicit type", body: { input: [{ role: "assistant", id: id("msg"), status: "completed", content: "Visible" }] }, ctx: context(), expected: { input: [{ role: "assistant", content: "Visible" }], store: false } },
  { name: "cleans an agent message", body: { input: [{ type: "agent_message", role: "assistant", id: id("msg"), status: "completed", content: "Visible" }] }, ctx: context(), expected: { input: [{ type: "agent_message", role: "assistant", content: "Visible" }], store: false } },
  { name: "removes binding fields without erasing a business message ID", body: { input: [{ type: "message", role: "assistant", id: "business-id", status: "completed", content: "Visible", encrypted_content: null, encrypted_function_args: "synthetic-sealed", previous_response_id: "synthetic-response" }] }, ctx: context(), expected: { input: [{ type: "message", role: "assistant", id: "business-id", status: "completed", content: "Visible" }], store: false } },
  ...[
    { type: "compaction", encrypted_content: "synthetic-private-marker" },
    { type: "item_reference", id: id("msg") },
    { type: "reasoning", id: id("rs"), encrypted_content: "synthetic-private-marker" },
    { type: "message", role: "assistant", encrypted_content: "synthetic-private-marker", content: [] },
    { type: "message", id: id("msg"), role: "assistant", content: [] },
    { type: "message", id: id("msg"), role: "assistant" },
  ].map((item, index) => ({ name: "rejects empty cleaned input " + index, body: { input: [item] }, ctx: context(), errorCode: "agent_router_session_repair_empty_input" })),
  { name: "rejects empty detached array", body: { input: [], previous_response_id: id("resp") }, ctx: context(), errorCode: "agent_router_session_repair_empty_input" },
  { name: "rejects whitespace-only detached string", body: { input: " \n\t ", previous_response_id: id("resp") }, ctx: context(), errorCode: "agent_router_session_repair_empty_input" },
  ...[
    { type: "function_call", id: id("fc"), call_id: "keep", name: "lookup", encrypted_function_args: "synthetic-private-marker" },
    { type: "function_call_output", id: id("fco"), call_id: "keep", encrypted_content: "synthetic-private-marker" },
    { type: "function_call", id: id("fc"), call_id: "keep", name: "lookup" },
    { type: "function_call_output", id: id("fco"), call_id: "keep" },
    { type: "function_call", id: id("fc"), name: "lookup", arguments: "{}" },
    { type: "function_call_output", id: id("fco"), output: "Keep" },
    { type: "custom_tool_call", id: id("ctc"), call_id: "keep", name: "exec", encrypted_function_args: "synthetic-private-marker" },
    { type: "custom_tool_call_output", id: id("ctco"), call_id: "keep", encrypted_content: "synthetic-private-marker" },
    { type: "function_call", id: id("fc"), call_id: "", name: "lookup", arguments: "{}" },
    { type: "function_call", id: id("fc"), call_id: "keep", name: "", arguments: "{}" },
    { type: "function_call_output", id: id("fco"), call_id: "keep", output: { unknown: true } },
  ].map((item, index) => ({ name: "rejects incomplete bound tool " + index, body: { input: [user(), item] }, ctx: context(), errorCode: "agent_router_session_repair_opaque_tool" })),
  { name: "can switch back off on a reused runtime", body: history(), ctx: context({ enabled: false }) },
  { name: "can switch back on on a reused runtime", body: history(), ctx: context(), expected: cleanedHistory() },
];

// The real-engine harness reads these same synthetic fixtures through Node.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(cases));
}
