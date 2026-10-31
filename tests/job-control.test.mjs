import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { isJobStalled, matchJobReference } from "../plugins/gemini/scripts/lib/job-control.mjs";
import { generateJobHandle } from "../plugins/gemini/scripts/lib/state.mjs";

const JOBS = [
  { id: "task-abc-111", handle: "k3f9", status: "completed" },
  { id: "task-abd-222", handle: "z0z0", status: "completed" }
];

test("references match the handle, then the full id, then a unique prefix", () => {
  assert.equal(matchJobReference(JOBS, "z0z0").id, "task-abd-222");
  assert.equal(matchJobReference(JOBS, "task-abc-111").handle, "k3f9");
  assert.equal(matchJobReference(JOBS, "task-abd").handle, "z0z0");
  assert.throws(() => matchJobReference(JOBS, "task-ab"), /ambiguous/);
  assert.throws(() => matchJobReference(JOBS, "nope"), /No job found/);
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
});
