import fs from "node:fs";

import { formatDuration } from "./render.mjs";
import { deriveJobState, getConfig, isActiveJobStatus, listJobs, readJobResult, resolveJobFile } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 10;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review" || job.kind === "review") {
    return "review";
  }
  if (job.jobClass === "task" || job.kind === "task") {
    return "task";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return ["Final output", "Assistant message", "Review output"].includes(line);
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return formatDuration((end - start) / 1000);
}

export { isActiveJobStatus };

// listJobs() derives `stalled`: the job claims to be active but its companion
// is gone, e.g. a foreground run whose Bash call hit its timeout.
export function isJobStalled(job, now = Date.now()) {
  if (!isActiveJobStatus(job.status)) {
    return false;
  }
  return typeof job.stalled === "boolean" ? job.stalled : Boolean(deriveJobState(job, null, now).stalled);
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const stalled = isJobStalled(job);
  return {
    ...job,
    kindLabel: getJobTypeLabel(job),
    stalled,
    displayStatus: stalled ? "stalled" : job.status,
    progressPreview: isActiveJobStatus(job.status) || job.status === "failed"
      ? readJobProgressPreview(job.logFile, maxProgressLines)
      : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null,
    phase: job.phase ?? (isActiveJobStatus(job.status) ? "running" : job.status)
  };
}

// The job record merged with its final payload (rendered output, result).
export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  const record = listJobs(workspaceRoot).find((job) => job.id === jobId) ?? JSON.parse(fs.readFileSync(jobFile, "utf8"));
  return { ...record, ...(readJobResult(workspaceRoot, jobId) ?? {}) };
}

// References match the 4-character handle first, then the full id, then a
// unique id prefix.
export function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const byHandle = filtered.filter((job) => job.handle === reference);
  if (byHandle.length === 1) {
    return byHandle[0];
  }
  if (byHandle.length > 1) {
    throw new Error(`Job handle "${reference}" is ambiguous. Use the full job id.`);
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /gemini:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = listJobs(workspaceRoot);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isActiveJobStatus(job.status))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJobStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJobStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /gemini:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);

  if (!reference) {
    const latestFinished = jobs.find(
      (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
    );
    if (latestFinished) {
      return { workspaceRoot, job: latestFinished };
    }
    throw new Error("No finished Gemini jobs found for this repository yet.");
  }

  const selected = matchJobReference(jobs, reference);
  if (isActiveJobStatus(selected.status) && !isJobStalled(selected)) {
    throw new Error(`Job ${selected.handle ?? selected.id} is still ${selected.status}. Check /gemini:status and try again once it finishes.`);
  }

  return { workspaceRoot, job: selected };
}

export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const activeJobs = jobs.filter((job) => isActiveJobStatus(job.status));

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  if (activeJobs.length === 1) {
    return { workspaceRoot, job: activeJobs[0] };
  }
  if (activeJobs.length > 1) {
    throw new Error("Multiple Gemini jobs are active. Pass a job handle to /gemini:cancel.");
  }

  throw new Error("No active Gemini jobs to cancel.");
}
