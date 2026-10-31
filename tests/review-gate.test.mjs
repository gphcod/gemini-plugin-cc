import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { makeFakeAgyWorkspace, PLUGIN_ROOT, readArgvLog, runCompanion } from "./helpers.mjs";

const HOOK_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

function runHook(ws, { scenario, input = {} } = {}) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: ws.repo,
    input: JSON.stringify({ cwd: ws.repo, ...input }),
    env: { ...ws.env, ...(scenario ? { AGY_TEST_SCENARIO: scenario } : {}) },
    encoding: "utf8",
    timeout: 30000
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

function enableGate(ws) {
  const setup = runCompanion(["setup", "--enable-review-gate", "--json"], { cwd: ws.repo, env: ws.env });
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);
}

test("gate disabled: the hook passes silently without calling agy", () => {
  const ws = makeFakeAgyWorkspace();
  const { stdout, status } = runHook(ws, { scenario: "gate-block" });
  assert.equal(status, 0);
  assert.equal(stdout, "");
  assert.equal(readArgvLog(ws.argvLog).length, 0);
});

test("gate enabled without agy: the hook blocks with the setup step", () => {
  const ws = makeFakeAgyWorkspace({ withAgy: false });
  enableGate(ws);
  const decision = JSON.parse(runHook(ws).stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /agy is not installed/);
  assert.match(decision.reason, /--disable-review-gate/);
});

test("ALLOW lets Claude stop, and the gate run is read-only and never resumable", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  const { stdout, status } = runHook(ws, { scenario: "gate-allow", input: { last_assistant_message: "Edited parser.js" } });
  assert.equal(status, 0);
  assert.equal(stdout, "");
  const [args] = readArgvLog(ws.argvLog);
  assert.ok(args.includes("plan"));
  const reply = runCompanion(["reply", "continue"], { cwd: ws.repo, env: ws.env });
  assert.equal(reply.status, 1);
  assert.match(reply.stderr, /No previous Gemini conversation/);
});

test("the gate prompt carries Claude's last message", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  runHook(ws, { scenario: "echo", input: { last_assistant_message: "UNIQUE_LAST_MESSAGE_MARKER" } });
  const status = runCompanion(["result", "--json"], { cwd: ws.repo, env: ws.env });
  const stored = JSON.parse(status.stdout).storedJob;
  assert.equal(stored.stopGate, true);
  assert.match(JSON.parse(stored.result.rawOutput).input, /UNIQUE_LAST_MESSAGE_MARKER/);
});

test("BLOCK stops Claude with Gemini's reason", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  const decision = JSON.parse(runHook(ws, { scenario: "gate-block" }).stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /drops the last line/);
});

test("a failed gate run blocks with the failure detail", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  const decision = JSON.parse(runHook(ws, { scenario: "failed-result" }).stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /status ERROR/);
});

test("stop_hook_active skips the review so a persistent BLOCK cannot loop", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  const { stdout, status } = runHook(ws, { scenario: "gate-block", input: { stop_hook_active: true } });
  assert.equal(status, 0);
  assert.equal(stdout, "");
  assert.equal(readArgvLog(ws.argvLog).length, 0);
});
