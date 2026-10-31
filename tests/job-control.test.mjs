import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  enrichJob,
  isJobStalled,
  matchJobReference,
  readJobProgressPreview,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/gemini/scripts/lib/job-control.mjs";
import { generateJobHandle, markJobCancelled, setConfig, writeJobRecord, writeJobResult } from "../plugins/gemini/scripts/lib/state.mjs";

const JOBS = [
  { id: "task-abc-111", handle: "k3f9", status: "completed" },
  { id: "task-abd-222", handle: "z0z0", status: "completed" }
];

function live(extra = {}) {
  return { status: "running", pid: process.pid, heartbeatAt: new Date().toISOString(), ...extra };
}

test("references match the handle, then the full id, then a unique prefix", () => {
  assert.equal(matchJobReference(JOBS, "z0z0").id, "task-abd-222");
  assert.equal(matchJobReference(JOBS, "task-abc-111").handle, "k3f9");
  assert.equal(matchJobReference(JOBS, "task-abd").handle, "z0z0");
  assert.throws(() => matchJobReference(JOBS, "task-ab"), /ambiguous/);
  assert.throws(() => matchJobReference(JOBS, "nope"), /No job found/);
  assert.equal(matchJobReference(JOBS, ""), JOBS[0]);
  assert.equal(matchJobReference([], ""), null);
  assert.throws(() => matchJobReference([...JOBS, { id: "other", handle: "k3f9" }], "k3f9"), /handle "k3f9" is ambiguous/);
});

test("handles are 4 base36 characters and avoid ones in use", () => {
  const handle = generateJobHandle(JOBS);
  assert.match(handle, /^[0-9a-z]{4}$/);
  assert.ok(!JOBS.some((job) => job.handle === handle));
});

test("an active job is stalled only when its process is gone and it went quiet", () => {
  const now = Date.now();
  const quiet = new Date(now - 60_000).toISOString();
  const fresh = new Date(now - 1_000).toISOString();
  assert.equal(isJobStalled({ status: "running", pid: process.pid, heartbeatAt: quiet }, now), false);
  assert.equal(isJobStalled({ status: "running", pid: 2147483646, heartbeatAt: fresh }, now), false);
  assert.equal(isJobStalled({ status: "running", pid: 2147483646, heartbeatAt: quiet }, now), true);
  assert.equal(isJobStalled({ status: "completed", pid: 2147483646, heartbeatAt: quiet }, now), false);
  assert.equal(isJobStalled({ status: "running", stalled: true }, now), true, "a derived flag is trusted");
});

test("the progress preview keeps the last lines and drops block titles", () => {
  const logFile = path.join(makeTempDir(), "x.log");
  fs.writeFileSync(logFile, [
    "[t1] Starting Gemini Task.",
    "[t2] tool: read_file a.js",
    "",
    "[t3] Final output",
    "body line without a prefix",
    "[t4] failed: read_file b.js — file does not exist",
    "[t5] tool: read_file c.js"
  ].join("\n"));
  assert.deepEqual(readJobProgressPreview(logFile, 3), [
    "tool: read_file a.js",
    "failed: read_file b.js — file does not exist",
    "tool: read_file c.js"
  ]);
  assert.deepEqual(readJobProgressPreview(null), []);
  assert.deepEqual(readJobProgressPreview(path.join(makeTempDir(), "missing.log")), []);
});

test("enrichJob labels the kind, formats time and marks stalled jobs", () => {
  const finished = enrichJob({
    id: "r1", kind: "adversarial-review", status: "completed",
    startedAt: "2026-10-30T10:00:00.000Z", completedAt: "2026-10-30T10:01:05.000Z"
  });
  assert.deepEqual([finished.kindLabel, finished.duration, finished.phase, finished.displayStatus], ["adversarial-review", "1m 5s", "completed", "completed"]);
  assert.deepEqual(finished.progressPreview, []);
  const stalled = enrichJob({ id: "t1", jobClass: "task", status: "running", pid: 2147483646, heartbeatAt: new Date(Date.now() - 45_000).toISOString() });
  assert.deepEqual([stalled.kindLabel, stalled.displayStatus, stalled.phase], ["task", "stalled", "running"]);
  assert.equal(enrichJob({ id: "j", status: "completed" }).kindLabel, "job");
});

test("the status snapshot splits active, latest finished and recent jobs", () => {
  const workspace = makeTempDir();
  setConfig(workspace, "stopReviewGate", true);
  writeJobRecord(workspace, { id: "old", handle: "aaaa", status: "completed" });
  writeJobRecord(workspace, { id: "newer", handle: "bbbb", status: "failed" });
  writeJobRecord(workspace, live({ id: "active", handle: "cccc" }));
  const snapshot = buildStatusSnapshot(workspace);
  assert.deepEqual(snapshot.running.map((job) => job.handle), ["cccc"]);
  assert.equal(snapshot.latestFinished.handle, "bbbb");
  assert.deepEqual(snapshot.recent.map((job) => job.handle), ["aaaa"]);
  assert.equal(snapshot.needsReview, true);
  assert.equal(buildStatusSnapshot(workspace, { maxJobs: 1 }).recent.length, 0);
  assert.equal(buildSingleJobSnapshot(workspace, "aaaa").job.id, "old");
});

test("a result needs a finished job unless the running one has stalled", () => {
  const workspace = makeTempDir();
  assert.throws(() => resolveResultJob(workspace, ""), /No finished Gemini jobs/);
  writeJobRecord(workspace, live({ id: "busy", handle: "busy" }));
  assert.throws(() => resolveResultJob(workspace, "busy"), /still running/);
  writeJobRecord(workspace, { id: "done", handle: "done", status: "completed" });
  assert.equal(resolveResultJob(workspace, "").job.id, "done");
  writeJobRecord(workspace, { id: "dead", handle: "dead", status: "running", pid: 2147483646, heartbeatAt: new Date(Date.now() - 45_000).toISOString() });
  assert.equal(resolveResultJob(workspace, "dead").job.id, "dead");
});

test("cancel picks the only active job, and needs a handle when there are several", () => {
  const workspace = makeTempDir();
  assert.throws(() => resolveCancelableJob(workspace, ""), /No active Gemini jobs/);
  writeJobRecord(workspace, live({ id: "one", handle: "one1" }));
  assert.equal(resolveCancelableJob(workspace, "").job.id, "one");
  writeJobRecord(workspace, live({ id: "two", handle: "two2" }));
  assert.throws(() => resolveCancelableJob(workspace, ""), /Multiple Gemini jobs are active/);
  assert.equal(resolveCancelableJob(workspace, "two2").job.id, "two");
  markJobCancelled(workspace, "two");
  assert.equal(resolveCancelableJob(workspace, "").job.id, "one", "a cancelled job is no longer active");
});

test("a stored job merges the record with its result payload", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "j1", handle: "j1j1", status: "completed", stopGate: true });
  writeJobResult(workspace, "j1", { rendered: "Answer\n", exitStatus: 10 });
  const stored = readStoredJob(workspace, "j1");
  assert.deepEqual([stored.stopGate, stored.rendered, stored.exitStatus, stored.status], [true, "Answer\n", 10, "completed"]);
  assert.equal(readStoredJob(workspace, "missing"), null);
});
