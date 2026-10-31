import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  COMPANION,
  isAlive,
  makeFakeAgyWorkspace,
  readArgvLog,
  runCompanion,
  spawnCompanion,
  waitFor
} from "./helpers.mjs";
import { listJobs, markJobCancelled } from "../plugins/gemini/scripts/lib/state.mjs";

function jobsFor(ws) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = ws.data;
  try {
    return listJobs(ws.repo);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

// Kills the test's companion and every recorded agy process group when the
// test ends, pass or fail, so a regression cannot hold the runner open.
function cleanupAfter(t, ws, child) {
  t.after(() => {
    try { child.kill("SIGKILL"); } catch {}
    for (const job of jobsFor(ws)) {
      if (job.agyPid) {
        try { process.kill(-job.agyPid, "SIGKILL"); } catch {}
      }
    }
  });
}

function footer(stdout) {
  return stdout.trimEnd().split("\n").at(-1);
}

test("setup reports ready when agy is installed and signed in", () => {
  const ws = makeFakeAgyWorkspace();
  const result = runCompanion(["setup", "--json"], { cwd: ws.repo, env: ws.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.agy.detail, "1.4.12");
  assert.match(report.auth.detail, /signed in/);
});

test("setup exits 1 with a sign-in step when agy is signed out", () => {
  const ws = makeFakeAgyWorkspace();
  const result = runCompanion(["setup"], { cwd: ws.repo, env: ws.env, scenario: "signed-out" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /needs attention/);
  assert.match(result.stdout, /run(ning)? `agy` once in a terminal/i);
});

test("setup exits 1 with the install step when agy is missing", () => {
  const ws = makeFakeAgyWorkspace({ withAgy: false });
  const result = runCompanion(["setup"], { cwd: ws.repo, env: ws.env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /agy: not installed/);
  assert.match(result.stdout, /antigravity\.google/);
});

test("task prints the answer and one compact footer, with the start line on stderr", () => {
  const ws = makeFakeAgyWorkspace();
  const result = runCompanion(["task", "--", "explain app.js"], { cwd: ws.repo, env: ws.env, scenario: "recovered-tool-error" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^\[gemini\] job [0-9a-z]{4} task started$/m);
  assert.equal(result.stdout, `The analysis.\n${footer(result.stdout)}\n`);
  assert.match(footer(result.stdout), /^gemini ok · job [0-9a-z]{4} · \d+s$/);
});

test("task sends write mode with the sandbox by default and plan mode with --plan", () => {
  const ws = makeFakeAgyWorkspace();
  runCompanion(["task", "fix", "it"], { cwd: ws.repo, env: ws.env });
  runCompanion(["task", "--plan", "look", "only"], { cwd: ws.repo, env: ws.env });
  const [write, plan] = readArgvLog(ws.argvLog);
  assert.ok(write.includes("accept-edits") && write.includes("--sandbox") && write.includes("--disable-slash-commands"));
  assert.ok(plan.includes("plan") && !plan.includes("--sandbox") && !plan.includes("--disable-slash-commands"));
});

test("prompt text keeps quotes and embedded flags when passed as one raw argument", () => {
  const ws = makeFakeAgyWorkspace();
  const raw = `--plan explain why "--model" and 'it\\'s' --json appear here`;
  const result = runCompanion(["task", raw], { cwd: ws.repo, env: ws.env, scenario: "echo" });
  assert.equal(result.status, 0, result.stderr);
  const echoed = JSON.parse(result.stdout.split("\n")[0]);
  const content = JSON.parse(echoed.input).message.content;
  assert.equal(content, `explain why "--model" and 'it\\'s' --json appear here`);
  assert.ok(echoed.args.includes("plan"));
});

test("task reads the prompt from stdin when no text is given", () => {
  const ws = makeFakeAgyWorkspace();
  const result = runCompanion(["task", "--plan"], { cwd: ws.repo, env: ws.env, scenario: "echo", input: "from stdin\n" });
  assert.equal(result.status, 0, result.stderr);
  const echoed = JSON.parse(result.stdout.split("\n")[0]);
  assert.equal(JSON.parse(echoed.input).message.content, "from stdin");
});

test("a stdin that never closes fails with a usage error instead of hanging", async () => {
  const ws = makeFakeAgyWorkspace();
  const companion = spawn(process.execPath, [COMPANION, "task"], {
    cwd: ws.repo,
    env: { ...ws.env, GEMINI_COMPANION_STDIN_TIMEOUT_MS: "300" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  companion.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => companion.once("close", resolve));
  companion.stdin.destroy();
  assert.equal(code, 2);
  assert.match(stderr, /No end of input on stdin/);
});

test("reply resumes the last conversation and sends only the new text", () => {
  const ws = makeFakeAgyWorkspace();
  const env = { ...ws.env, AGY_TEST_CONVERSATION_ID: "conv-first" };
  assert.equal(runCompanion(["task", "start"], { cwd: ws.repo, env }).status, 0);
  const result = runCompanion(["reply", "go", "deeper"], { cwd: ws.repo, env: ws.env, scenario: "echo" });
  assert.equal(result.status, 0, result.stderr);
  const echoed = JSON.parse(result.stdout.split("\n")[0]);
  assert.deepEqual(echoed.args.slice(echoed.args.indexOf("--conversation"), echoed.args.indexOf("--conversation") + 2), ["--conversation", "conv-first"]);
  assert.equal(JSON.parse(echoed.input).message.content, "go deeper");
});

test("task --resume is the same as reply, and reply without history fails clearly", () => {
  const ws = makeFakeAgyWorkspace();
  const empty = runCompanion(["reply", "more"], { cwd: ws.repo, env: ws.env });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No previous Gemini conversation/);
  runCompanion(["task", "start"], { cwd: ws.repo, env: ws.env });
  runCompanion(["task", "--resume", "more"], { cwd: ws.repo, env: ws.env });
  const last = readArgvLog(ws.argvLog).at(-1);
  assert.ok(last.includes("--conversation"));
});

test("review with findings exits 10 and renders them by severity", () => {
  const ws = makeFakeAgyWorkspace();
  const result = runCompanion(["review"], { cwd: ws.repo, env: ws.env, scenario: "review" });
  assert.equal(result.status, 10, result.stderr);
  assert.match(result.stdout, /^Review \(working tree diff\)\nVerdict: needs-attention/);
  assert.match(result.stdout, /- \[high\] Example finding \(src\/example\.mjs:10-12\)/);
  assert.match(footer(result.stdout), /^gemini ok · job [0-9a-z]{4}/);
  const args = readArgvLog(ws.argvLog)[0];
  assert.ok(args.includes("plan"));
  assert.ok(args[args.indexOf("--json-schema") + 1].endsWith("review-output.schema.json"));
});

test("a clean review exits 0 and the diff reaches agy inline", () => {
  const ws = makeFakeAgyWorkspace();
  const clean = runCompanion(["adversarial-review", "focus", "on", "value"], { cwd: ws.repo, env: ws.env, scenario: "review-clean" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /No material findings\./);
  const echo = runCompanion(["review", "--json"], { cwd: ws.repo, env: ws.env, scenario: "echo" });
  const payload = JSON.parse(echo.stdout);
  const prompt = JSON.parse(JSON.parse(payload.rawOutput).input).message.content;
  assert.match(prompt, /export const value = 2;/);
  assert.match(prompt, /`verdict`/);
});

test("runtime failures exit 1 and denied actions exit 20", () => {
  const ws = makeFakeAgyWorkspace();
  const failed = runCompanion(["task", "x"], { cwd: ws.repo, env: ws.env, scenario: "failed-result" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /status ERROR/);
  assert.match(footer(failed.stdout), /^gemini failed/);
  const denied = runCompanion(["task", "x"], { cwd: ws.repo, env: ws.env, scenario: "denied" });
  assert.equal(denied.status, 20);
  assert.match(footer(denied.stdout), /^gemini denied/);
  const usage = runCompanion(["task", "--effort", "extreme", "x"], { cwd: ws.repo, env: ws.env });
  assert.equal(usage.status, 2);
});

test("a repeated --request-id replays the first result without a second agy run", () => {
  const ws = makeFakeAgyWorkspace();
  const first = runCompanion(["task", "--request-id", "r-1", "--", "one"], { cwd: ws.repo, env: ws.env, scenario: "recovered-tool-error" });
  const second = runCompanion(["task", "--request-id", "r-1", "--", "one"], { cwd: ws.repo, env: ws.env, scenario: "recovered-tool-error" });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, first.stdout);
  assert.equal(readArgvLog(ws.argvLog).length, 1);
});

test("answers over 24 KiB are cut on stdout and kept whole in the answer file", () => {
  const ws = makeFakeAgyWorkspace();
  const big = "y".repeat(40 * 1024);
  const result = runCompanion(["task", "--plan"], { cwd: ws.repo, env: ws.env, scenario: "echo", input: big });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) < 26 * 1024);
  const answerFile = footer(result.stdout).match(/full: (.+)$/)[1];
  assert.ok(fs.readFileSync(answerFile, "utf8").includes(big));
});

test("status and result replay finished jobs by handle", () => {
  const ws = makeFakeAgyWorkspace();
  const task = runCompanion(["task", "hello"], { cwd: ws.repo, env: ws.env, scenario: "recovered-tool-error" });
  const handle = footer(task.stdout).match(/job ([0-9a-z]{4})/)[1];
  const status = runCompanion(["status"], { cwd: ws.repo, env: ws.env });
  assert.match(status.stdout, new RegExp(`\\| ${handle} \\| task \\| completed \\|`));
  const result = runCompanion(["result", handle], { cwd: ws.repo, env: ws.env });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, task.stdout);
});

test("result exits 0 even for a review with findings", () => {
  const ws = makeFakeAgyWorkspace();
  runCompanion(["review"], { cwd: ws.repo, env: ws.env, scenario: "review" });
  const result = runCompanion(["result"], { cwd: ws.repo, env: ws.env });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Example finding/);
});

test("cancel stops a running task, kills agy, and the job stays cancelled", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const ws = makeFakeAgyWorkspace();
  const companion = spawnCompanion(["task", "long", "job"], { cwd: ws.repo, env: ws.env, scenario: "hang" });
  cleanupAfter(t, ws, companion);
  const exited = new Promise((resolve) => companion.once("close", resolve));
  const job = await waitFor(() => jobsFor(ws).find((entry) => entry.agyPid && entry.status === "running"));
  const cancel = runCompanion(["cancel", job.handle], { cwd: ws.repo, env: ws.env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, new RegExp(`^Cancelled ${job.handle}`));
  await exited;
  await waitFor(() => !isAlive(job.agyPid), { timeoutMs: 5000 });
  assert.equal(jobsFor(ws).find((entry) => entry.id === job.id).status, "cancelled");
});

test("concurrent calls sharing a --request-id start agy once and all get its result", async () => {
  const ws = makeFakeAgyWorkspace();
  const env = { ...ws.env, AGY_TEST_SLOW_MS: "600" };
  const runs = Array.from({ length: 4 }, () => {
    const child = spawnCompanion(["task", "--request-id", "same-id", "--", "do it once"], { cwd: ws.repo, env, scenario: "slow" });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout })));
  });
  const results = await Promise.all(runs);
  assert.equal(readArgvLog(ws.argvLog).length, 1);
  for (const result of results) {
    assert.equal(result.code, 0);
    assert.equal(result.stdout, results[0].stdout);
  }
});

test("cancel kills agy's process group even after the companion died", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const ws = makeFakeAgyWorkspace();
  const childPidFile = path.join(ws.root, "grandchild.pid");
  const companion = spawnCompanion(["task", "orphan", "me"], {
    cwd: ws.repo,
    env: { ...ws.env, AGY_TEST_CHILD_PID_FILE: childPidFile },
    scenario: "delegated-child"
  });
  cleanupAfter(t, ws, companion);
  const exited = new Promise((resolve) => companion.once("close", resolve));
  const job = await waitFor(() => jobsFor(ws).find((entry) => entry.agyPid && entry.status === "running"));
  const grandchild = Number(await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, "utf8")));
  companion.kill("SIGKILL");
  await exited;
  assert.ok(isAlive(grandchild), "the orphaned agy tree survives its companion");

  const cancel = runCompanion(["cancel", job.handle], { cwd: ws.repo, env: ws.env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => !isAlive(grandchild) && !isAlive(job.agyPid), { timeoutMs: 5000 });
  assert.equal(jobsFor(ws).find((entry) => entry.id === job.id).status, "cancelled");
});

function markCancelledDirectly(ws, jobId) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = ws.data;
  try {
    return markJobCancelled(ws.repo, jobId);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test("the companion consumes a cancel marker mid-run even when nothing signals it", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const ws = makeFakeAgyWorkspace();
  const companion = spawnCompanion(["task", "long"], { cwd: ws.repo, env: ws.env, scenario: "hang" });
  cleanupAfter(t, ws, companion);
  const exited = new Promise((resolve) => companion.once("close", resolve));
  const job = await waitFor(() => jobsFor(ws).find((entry) => entry.agyPid && entry.status === "running"));
  assert.equal(markCancelledDirectly(ws, job.id), true);
  const code = await exited;
  assert.notEqual(code, 0);
  await waitFor(() => !isAlive(job.agyPid), { timeoutMs: 5000 });
  assert.equal(jobsFor(ws).find((entry) => entry.id === job.id).status, "cancelled");
});

test("a job cancelled before agy launches never launches it", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const ws = makeFakeAgyWorkspace({ slowGitSeconds: 1 });
  const companion = spawnCompanion(["review"], { cwd: ws.repo, env: ws.env, scenario: "hang" });
  cleanupAfter(t, ws, companion);
  const exited = new Promise((resolve) => companion.once("close", resolve));
  const job = await waitFor(() => jobsFor(ws).find((entry) => entry.jobClass === "review"), { timeoutMs: 15000 });
  assert.equal(job.agyPid, undefined);
  assert.equal(markCancelledDirectly(ws, job.id), true);
  const code = await exited;
  assert.notEqual(code, 0);
  assert.equal(readArgvLog(ws.argvLog).length, 0, "agy must not start after the cancel");
  assert.equal(jobsFor(ws).find((entry) => entry.id === job.id).status, "cancelled");
});

test("a job whose process died shows as stalled instead of running forever", () => {
  const ws = makeFakeAgyWorkspace();
  const task = runCompanion(["task", "hello"], { cwd: ws.repo, env: ws.env });
  assert.equal(task.status, 0);
  const jobsDir = path.join(ws.data, "state", fs.readdirSync(path.join(ws.data, "state"))[0], "jobs");
  const recordFile = path.join(jobsDir, fs.readdirSync(jobsDir).find((name) => /^task-.*(?<!\.result)\.json$/.test(name)));
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const write = (heartbeatAgoMs) =>
    fs.writeFileSync(recordFile, JSON.stringify({
      ...record,
      status: "running",
      pid: 2147483646,
      heartbeatAt: new Date(Date.now() - heartbeatAgoMs).toISOString()
    }));

  write(45_000);
  const stalled = runCompanion(["status"], { cwd: ws.repo, env: ws.env });
  assert.match(stalled.stdout, /\| stalled \|/);
  assert.match(stalled.stdout, /Stalled \(process gone\)/);

  write(5 * 60_000);
  const settled = runCompanion(["status"], { cwd: ws.repo, env: ws.env });
  assert.match(settled.stdout, /\| failed \|/);
});
