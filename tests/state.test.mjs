import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  claimRequestId,
  deriveJobState,
  getConfig,
  listJobs,
  markJobCancelled,
  patchJobRecord,
  pruneFinishedJobs,
  resolveJobsDir,
  resolveStateDir,
  setConfig,
  writeJobRecord,
  writeJobResult
} from "../plugins/gemini/scripts/lib/state.mjs";

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("close", resolve));
  return child.pid;
}

function withPluginData(dir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  if (dir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const stateDir = withPluginData(undefined, () => resolveStateDir(makeTempDir()));
  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const pluginDataDir = makeTempDir();
  const stateDir = withPluginData(pluginDataDir, () => resolveStateDir(makeTempDir()));
  assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
});

test("config round-trips and falls back to a 1.0.0 state.json", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }));
  assert.equal(getConfig(workspace).stopReviewGate, true);
  setConfig(workspace, "stopReviewGate", false);
  assert.equal(getConfig(workspace).stopReviewGate, false);
});

test("a cancel marker wins over whatever the job's owner writes afterwards", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "job-a", handle: "aaaa", status: "running", pid: process.pid, heartbeatAt: new Date().toISOString() });
  assert.equal(markJobCancelled(workspace, "job-a"), true);
  assert.equal(markJobCancelled(workspace, "job-a"), false);
  patchJobRecord(workspace, "job-a", { status: "completed", phase: "done" });
  const [job] = listJobs(workspace);
  assert.equal(job.status, "cancelled");
});

test("exactly one of many concurrent processes claims a request id", async () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const stateModule = new URL("../plugins/gemini/scripts/lib/state.mjs", import.meta.url).href;
  const claimer = `
    const { claimRequestId } = await import(${JSON.stringify(stateModule)});
    process.stdout.write(JSON.stringify(claimRequestId(process.argv[1], "same-request", "job-" + process.argv[2])));
  `;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", claimer, workspace, String(index)], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))));
    })
  ));
  const winners = results.filter((result) => result.claimed);
  assert.equal(winners.length, 1);
  for (const result of results) {
    assert.equal(result.jobId, winners[0].jobId);
  }
});

test("pruning never retires request claims, so a pruned id cannot be reserved twice", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "job-claimed", status: "completed", requestId: "r-old" });
  assert.equal(claimRequestId(workspace, "r-old", "job-claimed").claimed, true);
  pruneFinishedJobs(workspace, 0);
  assert.equal(listJobs(workspace).length, 0);
  assert.deepEqual(claimRequestId(workspace, "r-old", "job-new"), { claimed: false, jobId: "job-claimed" });
});

test("pruning keeps the newest finished jobs and removes their files", () => {
  const workspace = makeTempDir();
  for (let index = 0; index < 55; index += 1) {
    writeJobRecord(workspace, { id: `job-${String(index).padStart(2, "0")}`, status: "completed" });
    writeJobResult(workspace, `job-${String(index).padStart(2, "0")}`, { rendered: "x" });
  }
  pruneFinishedJobs(workspace, 50);
  const remaining = listJobs(workspace).map((job) => job.id);
  assert.equal(remaining.length, 50);
  assert.ok(!remaining.includes("job-00"));
  assert.equal(fs.existsSync(path.join(resolveJobsDir(workspace), "job-00.result.json")), false);
});

test("pruning never removes an active job, however many newer jobs finished", { skip: process.platform === "win32" }, async () => {
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  try {
    const workspace = makeTempDir();
    const quiet = new Date(Date.now() - 5 * 60_000).toISOString();
    writeJobRecord(workspace, { id: "orphaned", handle: "orph", status: "running", pid: await deadPid(), agyPid: orphan.pid, heartbeatAt: quiet });
    for (let index = 0; index < 60; index += 1) {
      writeJobRecord(workspace, { id: `newer-${index}`, status: "completed" });
    }
    pruneFinishedJobs(workspace, 50);
    const orphanJob = listJobs(workspace).find((job) => job.id === "orphaned");
    assert.ok(orphanJob, "the orphan's record survives pruning");
    assert.equal(orphanJob.status, "running");
    assert.equal(orphanJob.stalled, true);
    assert.equal(orphanJob.agyPid, orphan.pid);
  } finally {
    process.kill(-orphan.pid, "SIGKILL");
  }
});

test("a quiet job whose companion and agy are both gone reads as failed", async () => {
  const quiet = new Date(Date.now() - 5 * 60_000).toISOString();
  const pid = await deadPid();
  const debris = deriveJobState({ id: "d", status: "running", pid, agyPid: pid, heartbeatAt: quiet }, null);
  assert.equal(debris.status, "failed");
  assert.match(debris.errorMessage, /without recording a result/);
  const live = deriveJobState({ id: "l", status: "running", pid: process.pid, heartbeatAt: new Date().toISOString() }, null);
  assert.deepEqual([live.status, live.stalled], ["running", false]);
});

test("records are written atomically with no temp files left behind", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "job-x", status: "queued" });
  patchJobRecord(workspace, "job-x", { status: "running" });
  assert.deepEqual(fs.readdirSync(resolveJobsDir(workspace)).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(listJobs(workspace)[0].status, "running");
});

test("review diff files are written privately and pruned with their job", async () => {
  const { writeJobDiff } = await import("../plugins/gemini/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  writeJobRecord(workspace, { id: "review-old", status: "completed" });
  const diffFile = writeJobDiff(workspace, "review-old", "diff --git a b\n");
  assert.equal(fs.statSync(diffFile).mode & 0o777, 0o600);
  pruneFinishedJobs(workspace, 0);
  assert.equal(fs.existsSync(diffFile), false);
});

test("the gate baseline round-trips and is absent at first", async () => {
  const { readGateBaseline, writeGateBaseline } = await import("../plugins/gemini/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  assert.equal(readGateBaseline(workspace), null);
  writeGateBaseline(workspace, { head: "abc", digest: "d1" });
  assert.deepEqual(readGateBaseline(workspace), { head: "abc", digest: "d1" });
});

test("state directories are resolved once per directory and plugin data root", () => {
  const workspace = makeTempDir();
  const first = withPluginData(makeTempDir(), () => resolveStateDir(workspace));
  const second = withPluginData(makeTempDir(), () => resolveStateDir(workspace));
  assert.notEqual(first, second, "a different plugin data root gets its own directory");
});
