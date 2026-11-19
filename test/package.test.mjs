import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { history, cleanedHistory, context } from "./cases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

test("declares a default-disabled middleware-only package", () => {
  assert.equal(pkg.type, "module");
  assert.equal(Object.hasOwn(pkg, "main"), false);
  assert.equal(Object.hasOwn(pkg, "exports"), false);
  assert.equal(Object.hasOwn(pkg, "dependencies"), false);
  assert.equal(pkg.magpie.middleware, "./codex-session-repair.middleware.js");
  assert.deepEqual(pkg.magpie.options, { enabled: false });
  assert.match(pkg.description, /[\u4e00-\u9fff]/);
});

test("uses generic public summaries and the official public registry", async () => {
  const names = /magpie|agentrouter|opencode|codex/i;
  assert.equal(names.test(pkg.description), false);
  assert.equal(pkg.keywords.some(keyword => names.test(keyword)), false);
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.equal(names.test(readme.split("\n\n").slice(0, 2).join("\n\n")), false);
  assert.equal(/agentrouter|opencode-agentrouter-auth/i.test(readme), false);
  assert.equal(names.test(await readFile(join(root, "CHANGELOG.md"), "utf8")), false);
});

test("uses an explicit public-file allowlist without test or private configuration", async () => {
  assert.deepEqual(pkg.files, [
    "codex-session-repair.middleware.js", "session-repair.mjs", "options.example.json",
    "README.md", "CHANGELOG.md", "LICENSE",
  ]);
  for (const file of pkg.files) {
    assert.equal(isAbsolute(file), false);
    assert.equal(relative(root, resolve(root, file)).startsWith(".."), false);
    assert.ok((await readFile(join(root, file))).length > 0);
    assert.equal(/\.local\.|\.npmrc|\.env|test\/|\.exe$/.test(file), false);
  }
  const example = JSON.parse(await readFile(join(root, "options.example.json"), "utf8"));
  assert.deepEqual(example, pkg.magpie.options);
});

test("includes all imports and needs no Node APIs in production modules", async () => {
  const entry = await readFile(join(root, "codex-session-repair.middleware.js"), "utf8");
  assert.match(entry, /from "\.\/session-repair\.mjs"/);
  for (const file of pkg.files.filter(file => /\.(?:js|mjs)$/.test(file))) {
    const source = await readFile(join(root, file), "utf8");
    assert.equal(/node:|\bfetch\s*\(|\bsetTimeout\s*\(|\bprocess\./.test(source), false);
  }
});

test("runs from an isolated installed directory using only packaged files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-repair-middleware-"));
  try {
    for (const file of ["package.json", ...pkg.files]) {
      await copyFile(join(root, file), join(directory, file));
    }
    const installed = await import(pathToFileURL(join(directory, "codex-session-repair.middleware.js")).href);
    assert.deepEqual(Object.keys(installed), ["onRequest"]);
    assert.equal(installed.onRequest(history(), context({})), undefined);
    assert.deepEqual(installed.onRequest(history(), context()), cleanedHistory());
    assert.equal(installed.onRequest(history(), context({ enabled: false })), undefined);
  } finally {
    const target = resolve(directory);
    const parent = resolve(tmpdir());
    const child = relative(parent, target);
    assert.ok(child !== "" && !child.startsWith("..") && !isAbsolute(child));
    await rm(target, { recursive: true, force: true });
  }
});
