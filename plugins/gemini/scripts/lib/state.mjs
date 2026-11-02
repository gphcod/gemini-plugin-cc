// Per-workspace job store. No file here is read-modify-written by more than
// one process, so no cross-process lock is needed:
//
//   jobs/<id>.json         job record; written only by the companion running it
//   jobs/<id>.result.json  final payload; written once by that companion
//   jobs/<id>.cancel       cancel marker; created exclusively by /gemini:cancel
//   jobs/<id>.txt|.log     full answer text and progress log
//   requests/<hash>.json   --request-id claim; created exclusively, first wins
//   config.json            settings; written by /gemini:setup
//
// A job's status is derived when it is read: a cancel marker wins over the
// record, and a record whose processes are all gone reads as failed.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isPidAlive, isProcessGroupAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gemini-companion");
const MAX_FINISHED_JOBS = 50;
// A live companion refreshes heartbeatAt every 5 s.
const STALL_QUIET_MS = 30_000;
const DEBRIS_QUIET_MS = 60_000;

export { isPidAlive };

export function nowIso() {
  return new Date().toISOString();
}

// Every record, marker and heartbeat access resolves the state directory, so
// it is computed once per (directory, plugin data root) pair.
const stateDirs = new Map();
const ensuredStateDirs = new Set();

export function resolveStateDir(cwd) {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV] ?? "";
  const key = `${path.resolve(cwd)}\0${pluginDataDir}`;
  const cached = stateDirs.get(key);
  if (cached) {
    return cached;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  const stateDir = path.join(stateRoot, `${slug}-${hash}`);
  stateDirs.set(key, stateDir);
  return stateDir;
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

function resolveRequestsDir(cwd) {
  return path.join(resolveStateDir(cwd), "requests");
}

export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  if (ensuredStateDirs.has(stateDir)) {
    return;
  }
  for (const dir of [resolveJobsDir(cwd), resolveRequestsDir(cwd)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  try { fs.chmodSync(stateDir, 0o700); } catch {}
  ensuredStateDirs.add(stateDir);
}

// On Windows another process (a reader, often antivirus) can hold a file open for a moment. Elsewhere these errors are permanent.
const isBusy = (error) => process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Readers never see a torn file: content goes to a temp file, then rename.
function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, data, { encoding: "utf8", mode: 0o600 });
  for (const deadline = Date.now() + 5000; ;) {
    try {
      fs.renameSync(tempPath, filePath);
      break;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) {
        try { fs.unlinkSync(tempPath); } catch {}
        throw error;
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

// Publishes a fully written file under `filePath` only if that name is free.
// Returns false when another process created it first.
function createFileExclusive(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, data, { encoding: "utf8", mode: 0o600 });
  try {
    fs.linkSync(tempPath, filePath);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function readJsonOrNull(filePath) {
  for (const deadline = Date.now() + 5000; ;) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      // A short Windows lock is not a missing record: it waits as long as a write would.
      if (!isBusy(error) || Date.now() >= deadline) return null;
      sleepSync(20);
    }
  }
}

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

// --- config ---------------------------------------------------------------

const DEFAULT_CONFIG = { stopReviewGate: false };

export function getConfig(cwd) {
  const stateDir = resolveStateDir(cwd);
  const config = readJsonOrNull(path.join(stateDir, "config.json"))
    ?? readJsonOrNull(path.join(stateDir, "state.json"))?.config
    ?? {};
  return { ...DEFAULT_CONFIG, ...config };
}

export function setConfig(cwd, key, value) {
  ensureStateDir(cwd);
  const next = { ...getConfig(cwd), [key]: value };
  writeFileAtomic(path.join(resolveStateDir(cwd), "config.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// The repository fingerprint at the last stop the gate allowed; written only
// by the Stop hook.
export function readGateBaseline(cwd) {
  return readJsonOrNull(path.join(resolveStateDir(cwd), "gate-baseline.json"));
}

export function writeGateBaseline(cwd, baseline) {
  ensureStateDir(cwd);
  writeFileAtomic(path.join(resolveStateDir(cwd), "gate-baseline.json"), `${JSON.stringify(baseline)}\n`);
}

// A stop-gate diff too large to inline, attached as a file for Gemini to read.
export function gateChangesPath(cwd) {
  return path.join(resolveStateDir(cwd), "gate-changes.diff");
}

export function writeGateChanges(cwd, text) {
  ensureStateDir(cwd);
  const file = gateChangesPath(cwd);
  writeFileAtomic(file, String(text ?? ""));
  return file;
}

// --- job records ------------------------------------------------------------

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

// Short handle shown to users and the model: 4 base36 characters.
export function generateJobHandle(existingJobs = []) {
  const taken = new Set(existingJobs.map((job) => job.handle).filter(Boolean));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const handle = randomBytes(4).readUInt32BE(0).toString(36).padStart(4, "0").slice(-4);
    if (!taken.has(handle)) {
      return handle;
    }
  }
  return randomBytes(6).toString("hex").slice(0, 6);
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function resolveJobResultFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.result.json`);
}

function resolveCancelMarker(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.cancel`);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveAnswerFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.txt`);
}

export function writeAnswerFile(cwd, jobId, text) {
  const answerFile = resolveAnswerFile(cwd, jobId);
  writeFileAtomic(answerFile, String(text ?? ""));
  return answerFile;
}

// A review diff too large to inline, handed to Gemini as a file to read.
export function writeJobDiff(cwd, jobId, text) {
  ensureStateDir(cwd);
  const diffFile = path.join(resolveJobsDir(cwd), `${jobId}.diff`);
  writeFileAtomic(diffFile, String(text ?? ""));
  return diffFile;
}

// Owner only: the companion running the job is the record's sole writer.
export function writeJobRecord(cwd, record) {
  ensureStateDir(cwd);
  const timestamp = nowIso();
  const next = { createdAt: timestamp, ...record, updatedAt: timestamp };
  writeFileAtomic(resolveJobFile(cwd, record.id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Owner only.
export function patchJobRecord(cwd, jobId, patch) {
  const current = readJsonOrNull(resolveJobFile(cwd, jobId));
  if (!current) {
    return null;
  }
  return writeJobRecord(cwd, { ...current, ...patch, id: jobId });
}

// Owner only, once, when the run ends.
export function writeJobResult(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveJobResultFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`);
}

export function readJobResult(cwd, jobId) {
  return readJsonOrNull(resolveJobResultFile(cwd, jobId));
}

export function removeJobRecord(cwd, jobId) {
  removeFile(resolveJobFile(cwd, jobId));
}

// Any process. Returns true when this call created the marker.
export function markJobCancelled(cwd, jobId) {
  ensureStateDir(cwd);
  return createFileExclusive(resolveCancelMarker(cwd, jobId), `${JSON.stringify({ cancelledAt: nowIso(), by: process.pid })}\n`);
}

export function readCancelMarker(cwd, jobId) {
  return readJsonOrNull(resolveCancelMarker(cwd, jobId));
}

export function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function lastSignOfLife(record) {
  return Date.parse(record.heartbeatAt ?? record.startedAt ?? record.updatedAt ?? record.createdAt ?? "");
}

// An active record is stalled when its companion is gone (or silent long
// enough to rule out PID reuse). A stalled record whose agy process group is
// also gone and that stayed quiet past DEBRIS_QUIET_MS can never finish, so it
// reads as failed. A live agy group keeps it active: /gemini:cancel needs its
// handle and agyPid to stop that process tree.
export function deriveJobState(record, cancel, now = Date.now()) {
  if (cancel) {
    return {
      ...record,
      status: "cancelled",
      phase: "cancelled",
      completedAt: record.completedAt && !isActiveJobStatus(record.status) ? record.completedAt : cancel.cancelledAt,
      errorMessage: record.errorMessage ?? "Cancelled by user.",
      stalled: false
    };
  }
  if (!isActiveJobStatus(record.status)) {
    return { ...record, stalled: false };
  }
  const quietFor = now - lastSignOfLife(record);
  const companionGone =
    (record.pid != null && !isPidAlive(record.pid)) || (Number.isFinite(quietFor) && quietFor > STALL_QUIET_MS * 4);
  const stalled = companionGone && (!Number.isFinite(quietFor) || quietFor > STALL_QUIET_MS);
  if (!stalled) {
    return { ...record, stalled: false };
  }
  const agyAlive = record.agyPid != null && isProcessGroupAlive(record.agyPid);
  if (!agyAlive && Number.isFinite(quietFor) && quietFor > DEBRIS_QUIET_MS) {
    return {
      ...record,
      status: "failed",
      phase: "failed",
      stalled: false,
      errorMessage: record.errorMessage ?? "The companion process ended without recording a result."
    };
  }
  return { ...record, stalled: true };
}

export function listJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  let names;
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }
  const now = Date.now();
  const present = new Set(names);
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
    const record = readJsonOrNull(path.join(jobsDir, name));
    if (!record?.id) continue;
    const cancel = present.has(`${record.id}.cancel`) ? readJsonOrNull(path.join(jobsDir, `${record.id}.cancel`)) : null;
    jobs.push(deriveJobState(record, cancel, now));
  }
  return jobs.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

// --- request ids ------------------------------------------------------------

function resolveRequestClaim(cwd, requestId) {
  const digest = createHash("sha256").update(String(requestId)).digest("hex").slice(0, 32);
  return path.join(resolveRequestsDir(cwd), `${digest}.json`);
}

// First caller wins. Returns { claimed: true } or the winning job's id.
export function claimRequestId(cwd, requestId, jobId) {
  ensureStateDir(cwd);
  const claimFile = resolveRequestClaim(cwd, requestId);
  if (createFileExclusive(claimFile, `${JSON.stringify({ requestId, jobId })}\n`)) {
    return { claimed: true, jobId };
  }
  const existing = readJsonOrNull(claimFile);
  return { claimed: false, jobId: existing?.jobId ?? null };
}

// --- pruning ----------------------------------------------------------------

// Keeps the newest finished jobs. Active and stalled jobs are never removed,
// whatever their age, so a running process tree always stays cancellable.
// Request claims are never removed: a claim cannot be retired safely while
// another caller may be re-creating it, and each is under 100 bytes. A retry
// whose job was pruned is told to use a new id.
export function pruneFinishedJobs(cwd, maxFinished = MAX_FINISHED_JOBS) {
  const finished = listJobs(cwd).filter((job) => !isActiveJobStatus(job.status));
  for (const job of finished.slice(maxFinished)) {
    for (const suffix of [".json", ".result.json", ".cancel", ".txt", ".log", ".diff"]) {
      removeFile(path.join(resolveJobsDir(cwd), `${job.id}${suffix}`));
    }
  }
}
