import fs from "node:fs";
import process from "node:process";

import {
  patchJobRecord,
  pruneFinishedJobs,
  readCancelMarker,
  resolveJobLogFile,
  writeJobRecord,
  writeJobResult
} from "./state.mjs";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      conversationId:
        typeof value.conversationId === "string" && value.conversationId.trim() ? value.conversationId.trim() : null,
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    conversationId: null,
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(logFile, 0o600); } catch {}
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base) {
  return {
    ...base,
    createdAt: nowIso()
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastConversationId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.conversationId && normalized.conversationId !== lastConversationId) {
      lastConversationId = normalized.conversationId;
      patch.conversationId = normalized.conversationId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    patchJobRecord(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ logFile = null, onEvent = null } = {}) {
  if (!logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

// The owner consumes /gemini:cancel itself: cancel may not be able to signal
// this process (its heartbeat can look stale while the event loop is busy,
// say during a large diff collection), so the marker is polled and also
// checked right before agy is launched. Returns a stop function.
export function watchForCancel(workspaceRoot, jobId, onCancel, intervalMs = 1000) {
  let fired = false;
  const check = () => {
    if (fired) return true;
    if (readCancelMarker(workspaceRoot, jobId)) {
      fired = true;
      onCancel();
    }
    return fired;
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}

// A running companion refreshes heartbeatAt so status can tell a working job
// from debris left by a killed process. Returns a stop function.
export function startJobHeartbeat(workspaceRoot, jobId, intervalMs = 5000) {
  const beat = () => {
    try {
      patchJobRecord(workspaceRoot, jobId, { heartbeatAt: nowIso() });
    } catch {
      // A failed heartbeat must not kill the job itself.
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// The companion is the only writer of its job record. /gemini:cancel never
// rewrites the record; it creates a cancel marker, which wins when the job is
// read, so a run that unwinds after a cancel cannot hide the cancellation.
export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  writeJobRecord(job.workspaceRoot, {
    ...job,
    status: "running",
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile
  });

  let execution;
  try {
    execution = await runner();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    patchJobRecord(job.workspaceRoot, job.id, { status: "failed", phase: "failed", errorMessage, pid: null, completedAt: nowIso() });
    pruneFinishedJobs(job.workspaceRoot);
    throw error;
  }

  const completionStatus = execution.jobStatus ?? (execution.exitStatus === 0 ? "completed" : "failed");
  writeJobResult(job.workspaceRoot, job.id, {
    exitStatus: execution.exitStatus ?? 0,
    answerFile: execution.answerFile ?? null,
    result: execution.payload,
    rendered: execution.rendered
  });
  patchJobRecord(job.workspaceRoot, job.id, {
    status: completionStatus,
    phase: completionStatus === "completed" ? "done" : "failed",
    conversationId: execution.conversationId ?? null,
    exitStatus: execution.exitStatus ?? 0,
    summary: execution.summary,
    answerFile: execution.answerFile ?? null,
    pid: null,
    completedAt: nowIso()
  });
  appendLogBlock(logFile, "Final output", execution.rendered);
  pruneFinishedJobs(job.workspaceRoot);

  if (readCancelMarker(job.workspaceRoot, job.id)) {
    return { ...execution, exitStatus: execution.exitStatus || 1, cancelled: true };
  }
  return execution;
}
