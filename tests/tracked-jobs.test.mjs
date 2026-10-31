import fs from "node:fs";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { listJobs, markJobCancelled, readJobResult, resolveJobFile, writeJobRecord } from "../plugins/gemini/scripts/lib/state.mjs";
import {
  appendLogBlock,
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob,
  startJobHeartbeat,
  watchForCancel
} from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";

function job(workspace, id = "task-t1") {
  return { id, handle: "t1t1", title: "Gemini Task", kind: "task", jobClass: "task", workspaceRoot: workspace };
}

function record(workspace, id) {
  return listJobs(workspace).find((entry) => entry.id === id);
}

test("log helpers append timestamped lines and blocks, and skip empty input", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "task-log", "Gemini Task");
  appendLogLine(logFile, "  tool: read_file a.js  ");
  appendLogLine(logFile, "   ");
  appendLogLine(null, "ignored");
  appendLogBlock(logFile, "Final output", "answer\n\n");
  appendLogBlock(logFile, "Empty", "");
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  assert.match(lines[0], /^\[\d{4}-\d\d-\d\dT[^\]]+\] Starting Gemini Task\.$/);
  assert.match(lines[1], /\] tool: read_file a\.js$/);
  assert.match(lines[2], /\] Final output$/);
  assert.equal(lines[3], "answer");
  assert.equal(lines.length, 4);
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test("createJobRecord stamps a creation time without dropping fields", () => {
  const created = createJobRecord({ id: "x", handle: "abcd" });
  assert.equal(created.handle, "abcd");
  assert.ok(Date.parse(created.createdAt));
});

test("the progress updater writes only phase and conversation changes", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "task-p", status: "running", pid: process.pid, heartbeatAt: new Date().toISOString() });
  const update = createJobProgressUpdater(workspace, "task-p");
  update({ message: "x", phase: "working", conversationId: "conv-1" });
  const first = fs.readFileSync(resolveJobFile(workspace, "task-p"), "utf8");
  update({ message: "y", phase: "working", conversationId: "conv-1" });
  assert.equal(fs.readFileSync(resolveJobFile(workspace, "task-p"), "utf8"), first, "a repeat is not rewritten");
  update("plain string message");
  update({ phase: "responding" });
  const stored = record(workspace, "task-p");
  assert.equal(stored.phase, "responding");
  assert.equal(stored.conversationId, "conv-1");
});

test("the progress reporter logs messages and blocks and forwards normalized events", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "task-r", null);
  const seen = [];
  const report = createProgressReporter({ logFile, onEvent: (event) => seen.push(event) });
  report({ message: " step ", phase: " working ", logTitle: "Output", logBody: "body\n" });
  report("bare message");
  assert.deepEqual(seen[0], { message: "step", phase: "working", conversationId: null, logTitle: "Output", logBody: "body" });
  assert.equal(seen[1].message, "bare message");
  assert.match(fs.readFileSync(logFile, "utf8"), /step[\s\S]*Output\nbody[\s\S]*bare message/);
  assert.equal(createProgressReporter({}), null);
});

test("runTrackedJob records running, then the final status, result and log block", async () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "task-ok", null);
  let seenWhileRunning;
  const execution = await runTrackedJob(job(workspace, "task-ok"), async () => {
    seenWhileRunning = record(workspace, "task-ok");
    return { exitStatus: 0, conversationId: "conv-9", rendered: "Answer.\n", payload: { ok: true }, summary: "Answer." };
  }, { logFile });
  assert.equal(seenWhileRunning.status, "running");
  assert.equal(seenWhileRunning.pid, process.pid);
  const done = record(workspace, "task-ok");
  assert.deepEqual([done.status, done.phase, done.conversationId, done.pid], ["completed", "done", "conv-9", null]);
  assert.equal(readJobResult(workspace, "task-ok").rendered, "Answer.\n");
  assert.equal(execution.exitStatus, 0);
  assert.match(fs.readFileSync(logFile, "utf8"), /Final output\nAnswer\./);
});

test("runTrackedJob honours an explicit job status and a non-zero exit", async () => {
  const workspace = makeTempDir();
  await runTrackedJob(job(workspace, "task-fail"), async () => ({ exitStatus: 20, jobStatus: "failed", rendered: "denied\n", payload: {} }));
  const failed = record(workspace, "task-fail");
  assert.deepEqual([failed.status, failed.phase, failed.exitStatus], ["failed", "failed", 20]);
});

test("runTrackedJob records a thrown error as failed and rethrows it", async () => {
  const workspace = makeTempDir();
  await assert.rejects(
    runTrackedJob(job(workspace, "task-throw"), async () => { throw new Error("collection broke"); }),
    /collection broke/
  );
  const failed = record(workspace, "task-throw");
  assert.deepEqual([failed.status, failed.errorMessage, failed.pid], ["failed", "collection broke", null]);
});

test("a run that ends after a cancel reads as cancelled and reports a non-zero exit", async () => {
  const workspace = makeTempDir();
  const execution = await runTrackedJob(job(workspace, "task-c"), async () => {
    markJobCancelled(workspace, "task-c");
    return { exitStatus: 0, rendered: "late answer\n", payload: {} };
  });
  assert.equal(execution.cancelled, true);
  assert.equal(execution.exitStatus, 1);
  assert.equal(record(workspace, "task-c").status, "cancelled");
  assert.equal(readJobResult(workspace, "task-c").rendered, "late answer\n", "the late result is still kept");
});

test("the heartbeat writes immediately and tolerates a missing record", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "task-h", status: "running", heartbeatAt: "2020-01-01T00:00:00.000Z" });
  const stop = startJobHeartbeat(workspace, "task-h", 60_000);
  stop();
  assert.ok(Date.parse(record(workspace, "task-h").heartbeatAt) > Date.parse("2025-01-01"));
  const stopMissing = startJobHeartbeat(workspace, "no-such-job", 60_000);
  stopMissing();
});

test("the cancel watcher fires once when the marker appears", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "task-w", status: "running" });
  let fired = 0;
  const watch = watchForCancel(workspace, "task-w", () => { fired += 1; }, 60_000);
  try {
    assert.equal(watch.check(), false);
    markJobCancelled(workspace, "task-w");
    assert.equal(watch.check(), true);
    assert.equal(watch.check(), true);
    assert.equal(fired, 1);
  } finally {
    watch.stop();
  }
});
