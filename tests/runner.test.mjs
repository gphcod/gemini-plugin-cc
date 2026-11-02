import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { isReadOnlyLaunch, makeFakeAgyWorkspace, PLUGIN_ROOT, readArgvLog } from "./helpers.mjs";
import { resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import {
  createTurn,
  executeReviewRun,
  executeTaskRun,
  EXIT_DENIED,
  EXIT_FAILURE,
  EXIT_FINDINGS,
  EXIT_OK,
  measureAgyBaseline,
  replayTwin,
  reserveJob
} from "../plugins/gemini/scripts/lib/runner.mjs";
import { listJobs, writeJobRecord, writeJobResult } from "../plugins/gemini/scripts/lib/state.mjs";

// Runs `fn` with the fake agy first on PATH and the workspace's plugin data,
// as the companion would see them.
async function withFakeAgy(ws, scenario, fn) {
  const saved = { PATH: process.env.PATH, GEMINI_AGY_BIN: process.env.GEMINI_AGY_BIN, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA, AGY_TEST_SCENARIO: process.env.AGY_TEST_SCENARIO, AGY_TEST_ARGV_LOG: process.env.AGY_TEST_ARGV_LOG };
  Object.assign(process.env, { PATH: ws.env.PATH, CLAUDE_PLUGIN_DATA: ws.data, AGY_TEST_ARGV_LOG: ws.argvLog });
  if (ws.env.GEMINI_AGY_BIN) process.env.GEMINI_AGY_BIN = ws.env.GEMINI_AGY_BIN;
  if (scenario) process.env.AGY_TEST_SCENARIO = scenario;
  else delete process.env.AGY_TEST_SCENARIO;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function taskRequest(ws, overrides = {}) {
  return { prompt: "explain", workspaceRoot: ws.repo, timeoutSeconds: 30, sandbox: true, readOnly: false, jobId: "task-r1", handle: "r1r1", ...overrides };
}

test("reserveJob registers a queued job, and a reused request id finds the first one", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, null, async () => {
    const spec = { prefix: "task", kind: "task", kindLabel: "task", title: "Gemini Task", jobClass: "task", summary: "s" };
    const first = reserveJob(ws.repo, "req-1", spec);
    assert.ok(first.job);
    const queued = listJobs(ws.repo).find((job) => job.id === first.job.id);
    assert.deepEqual([queued.status, queued.pid, queued.requestId], ["queued", process.pid, "req-1"]);
    const second = reserveJob(ws.repo, "req-1", spec);
    assert.equal(second.twin.id, first.job.id);
    assert.equal(listJobs(ws.repo).length, 1, "the loser's record is removed");
    assert.ok(reserveJob(ws.repo, null, spec).job, "no request id never collides");
  });
});

test("replayTwin prints a finished twin's stored output and exit code", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, null, async () => {
    writeJobRecord(ws.repo, { id: "twin", handle: "twin", status: "completed" });
    writeJobResult(ws.repo, "twin", { rendered: "Stored answer.\n", exitStatus: EXIT_FINDINGS });
    const writes = [];
    const originalWrite = process.stdout.write;
    const originalExit = process.exitCode;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      await replayTwin(ws.repo, listJobs(ws.repo)[0], "req", { json: false });
      assert.equal(process.exitCode, EXIT_FINDINGS);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExit;
    }
    assert.deepEqual(writes, ["Stored answer.\n"]);
  });
});

test("replayTwin refuses a twin that stopped without a result", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, null, async () => {
    writeJobRecord(ws.repo, { id: "gone", handle: "gone", status: "running", pid: 2147483646, heartbeatAt: new Date(Date.now() - 45_000).toISOString() });
    await assert.rejects(replayTwin(ws.repo, listJobs(ws.repo)[0], "req-x", {}), /stopped without a result[\s\S]*new --request-id/);
  });
});

test("a task turn returns the answer, footer, conversation and exit code", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, "recovered-tool-error", async () => {
    writeJobRecord(ws.repo, { id: "task-r1", status: "running", pid: process.pid });
    const progress = [];
    const execution = await executeTaskRun(taskRequest(ws), (event) => progress.push(event), createTurn());
    assert.equal(execution.exitStatus, EXIT_OK);
    assert.equal(execution.conversationId, "conversation-opaque");
    assert.match(execution.rendered, /^The analysis\.\ngemini ok · job r1r1 · \d+s\n$/);
    assert.ok(progress.some((event) => /failed: read_file/.test(event.message ?? "")));
    assert.equal(listJobs(ws.repo)[0].agyPid > 0, true, "the agy pid is recorded for cancel");
  });
});

test("read-only task turns launch agy with the deny-all settings", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, "echo", async () => {
    await executeTaskRun(taskRequest(ws, { readOnly: true }), null, createTurn());
    assert.ok(isReadOnlyLaunch(readArgvLog(ws.argvLog)[0]));
  });
});

test("denied actions and failures map to their exit codes", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, "denied", async () => {
    const denied = await executeTaskRun(taskRequest(ws), null, createTurn());
    assert.equal(denied.exitStatus, EXIT_DENIED);
    assert.match(denied.rendered, /gemini denied/);
  });
  await withFakeAgy(ws, "print-timeout", async () => {
    const failed = await executeTaskRun(taskRequest(ws, { jobId: "task-r2" }), null, createTurn());
    assert.equal(failed.exitStatus, EXIT_FAILURE);
    assert.match(failed.rendered, /print timeout/);
  });
});

test("a cancel consumed before launch starts no agy process", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, "echo", async () => {
    const turn = createTurn();
    turn.consumeCancel = () => { turn.abort(); return true; };
    const execution = await executeTaskRun(taskRequest(ws), null, turn);
    assert.equal(execution.exitStatus, EXIT_FAILURE);
    assert.match(execution.rendered, /cancelled before launch/);
    assert.equal(readArgvLog(ws.argvLog).length, 0);
  });
});

test("a large review writes the full diff to a file and points Gemini at it", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, "echo", async () => {
    for (let index = 0; index < 30; index += 1) {
      fs.writeFileSync(path.join(ws.repo, `file-${index}.js`), `export const n = ${index};\n`);
    }
    const target = resolveReviewTarget(ws.repo, {});
    const execution = await executeReviewRun(
      { cwd: ws.repo, workspaceRoot: ws.repo, rootDir: PLUGIN_ROOT, target, timeoutSeconds: 30, reviewName: "Review", jobId: "review-big", handle: "rbig" },
      null,
      createTurn()
    );
    assert.equal(execution.payload.inputMode, "self-collect");
    const diffFile = execution.payload.diffFile;
    assert.match(fs.readFileSync(diffFile, "utf8"), /export const value = 2;/);
    const launch = readArgvLog(ws.argvLog)[0];
    assert.ok(isReadOnlyLaunch(launch));
    const prompt = JSON.parse(JSON.parse(execution.payload.rawOutput).input).message.content;
    assert.ok(prompt.includes(diffFile));
    assert.match(prompt, /read it with read_file/);
    assert.match(prompt, /file-29\.js \(\d+ bytes\)/);
  });
});

test("the baseline measurement reports agy's input tokens and tool count", async () => {
  const ws = makeFakeAgyWorkspace();
  await withFakeAgy(ws, "recovered-tool-error", async () => {
    const baseline = await measureAgyBaseline(ws.repo, createTurn());
    assert.deepEqual(baseline, { ok: true, error: null, inputTokens: 3, toolCount: 1 });
  });
});
