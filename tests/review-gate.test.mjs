import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { isReadOnlyLaunch, makeFakeAgyWorkspace, PLUGIN_ROOT, readArgvLog, runCompanion } from "./helpers.mjs";

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
  assert.ok(isReadOnlyLaunch(args));
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
  const prompt = JSON.parse(JSON.parse(stored.result.rawOutput).input).message.content;
  assert.match(prompt, /UNIQUE_LAST_MESSAGE_MARKER/);
  assert.match(prompt, /export const value = 2;/, "the uncommitted change is inlined");
});

test("an unchanged repository since the last ALLOW skips Gemini entirely", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  assert.equal(runHook(ws, { scenario: "gate-allow" }).stdout, "");
  assert.equal(readArgvLog(ws.argvLog).length, 1);
  assert.equal(runHook(ws, { scenario: "gate-allow" }).stdout, "");
  assert.equal(readArgvLog(ws.argvLog).length, 1, "no second agy call for an unchanged repo");
  fs.writeFileSync(path.join(ws.repo, "app.js"), "export const value = 3;\n");
  runHook(ws, { scenario: "gate-allow" });
  assert.equal(readArgvLog(ws.argvLog).length, 2, "a new change is reviewed");
});

test("a BLOCK records no baseline, so the next stop is reviewed again", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  assert.equal(JSON.parse(runHook(ws, { scenario: "gate-block" }).stdout).decision, "block");
  assert.equal(JSON.parse(runHook(ws, { scenario: "gate-block" }).stdout).decision, "block");
  assert.equal(readArgvLog(ws.argvLog).length, 2);
});

test("after an ALLOW, the next review sees the changes since that stop, including commits", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  runHook(ws, { scenario: "gate-allow" });
  fs.writeFileSync(path.join(ws.repo, "app.js"), "export const value = 42;\n");
  spawnSync("git", ["commit", "-qam", "change value"], { cwd: ws.repo });
  runHook(ws, { scenario: "echo" });
  const stored = JSON.parse(runCompanion(["result", "--json"], { cwd: ws.repo, env: ws.env }).stdout).storedJob;
  const prompt = JSON.parse(JSON.parse(stored.result.rawOutput).input).message.content;
  assert.match(prompt, /Commits since the last allowed stop[\s\S]*\+export const value = 42;/);
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

test("a digest-less baseline never skips the review", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  const stateDir = path.join(ws.data, "state", fs.readdirSync(path.join(ws.data, "state"))[0]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ws.repo, encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(stateDir, "gate-baseline.json"), JSON.stringify({ head, digest: null }));
  runHook(ws, { scenario: "gate-allow" });
  assert.equal(readArgvLog(ws.argvLog).length, 1);
});

function stateDirOf(ws) {
  return path.join(ws.data, "state", fs.readdirSync(path.join(ws.data, "state"))[0]);
}

test("an unwritable attachment blocks the stop without calling Gemini or recording a baseline", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  fs.mkdirSync(path.join(stateDirOf(ws), "gate-changes.diff", "occupied"), { recursive: true });
  fs.writeFileSync(path.join(ws.repo, "app.js"), `${"line of text\n".repeat(20000)}`);
  const result = runHook(ws, { scenario: "gate-allow" });
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /cannot hand over these changes[\s\S]*Unstaged changes/);
  assert.equal(readArgvLog(ws.argvLog).length, 0);
  assert.equal(fs.existsSync(path.join(stateDirOf(ws), "gate-baseline.json")), false);
});

test("an unexpected failure inside the gate blocks instead of letting Claude stop", () => {
  const ws = makeFakeAgyWorkspace();
  enableGate(ws);
  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(ws.bin, "git"), `#!/bin/sh\ncase " $* " in *" --porcelain=v1 "*) echo "fatal: index corrupt" >&2; exit 128;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const result = runHook(ws, { scenario: "gate-allow" });
  assert.equal(result.status, 0, "the hook itself must not fail open");
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /review gate failed[\s\S]*index corrupt/);
  assert.equal(readArgvLog(ws.argvLog).length, 0);
});
