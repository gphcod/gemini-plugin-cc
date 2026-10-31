#!/usr/bin/env node

// Companion CLI for the Gemini plugin. Every model turn is one agy process
// (see lib/agy.mjs); there is no broker, daemon, or self-detaching worker.
// Long runs are backgrounded by the caller (Claude's run_in_background Bash),
// and status/result/wait/cancel operate on the per-workspace job store.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, parseProseCommand, splitRawArgumentString } from "./lib/args.mjs";
import { DEFAULT_TIMEOUT_SECONDS, isDeniedFailure, runAgy } from "./lib/agy.mjs";
import { readStdinIfPiped, STDIN_INACTIVITY_MS, StdinTimeoutError } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, runCommand, stopProcessGroup, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { parseStructuredOutput } from "./lib/review-output.mjs";
import {
  claimRequestId,
  generateJobHandle,
  generateJobId,
  getConfig,
  listJobs,
  markJobCancelled,
  patchJobRecord,
  removeJobRecord,
  setConfig,
  writeAnswerFile,
  writeJobRecord
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  isActiveJobStatus,
  isJobStalled,
  matchJobReference,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  resolveWaitTargetJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  startJobHeartbeat,
  watchForCancel
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  capAnswer,
  renderCancelReport,
  renderFooter,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 10;
export const EXIT_DENIED = 20;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

class UsageError extends Error {}

// Aborts the in-flight agy run (killing its whole process tree) when the
// companion itself is signalled, e.g. by /gemini:cancel or a Bash timeout.
const turnAbort = new AbortController();
let signalled = false;
for (const signalName of ["SIGTERM", "SIGINT"]) {
  process.on(signalName, () => {
    signalled = true;
    turnAbort.abort();
    setTimeout(() => process.exit(EXIT_FAILURE), 5000).unref();
  });
}

// Set while a tracked job runs; aborts the turn when the job's cancel marker
// exists. Called right before agy is launched.
let consumeCancel = () => false;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gemini-companion.mjs setup [--verify] [--enable-review-gate|--disable-review-gate] [--json]",
      "  gemini-companion.mjs task [--plan] [--no-sandbox] [--model <m>] [--effort <low|medium|high|xhigh|max>] [--conversation <id>] [--timeout <s>] [--request-id <id>] [--json] [prompt]",
      "  gemini-companion.mjs reply [--job <handle>] [same flags as task] [prompt]",
      "  gemini-companion.mjs review|adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <m>] [--timeout <s>] [--request-id <id>] [--json] [focus]",
      "  gemini-companion.mjs status [job] [--all] [--wait] [--json]",
      "  gemini-companion.mjs result [job] [--json]",
      "  gemini-companion.mjs wait [job] [--timeout-ms <ms>] [--json]",
      "  gemini-companion.mjs cancel [job] [--json]",
      "",
      "Exit codes: 0 ok, 10 review findings, 20 action denied, 1 failure, 2 usage."
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeModel(model) {
  const normalized = String(model ?? "").trim();
  return normalized || null;
}

function normalizeEffort(effort) {
  if (effort == null) return null;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return null;
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new UsageError(`Unsupported reasoning effort "${effort}". Use one of: low, medium, high, xhigh, max.`);
  }
  return normalized;
}

function normalizeTimeoutSeconds(value) {
  if (value == null) return DEFAULT_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
    throw new UsageError(`--timeout must be positive seconds. Received: ${value}`);
  }
  return seconds;
}

function normalizeArgvForFlags(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseFlagCommand(argv, config = {}) {
  return parseArgs(normalizeArgvForFlags(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) }
  });
}

const PROSE_RUNTIME_FLAGS = {
  valueOptions: ["model", "effort", "cwd", "timeout", "conversation", "request-id", "prompt-file", "base", "scope", "job"],
  booleanOptions: ["json", "plan", "no-sandbox", "sandbox", "stop-gate", "wait", "background", "resume", "fresh"],
  aliasMap: { m: "model", C: "cwd" }
};

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// --- setup ---------------------------------------------------------------

function getAgyAuthStatus(cwd) {
  const probe = runCommand("agy", ["models"], { cwd, timeout: 30000 });
  if (probe.error && probe.error.code === "ENOENT") {
    return { loggedIn: false, detail: "agy is not installed" };
  }
  if (probe.error) {
    return { loggedIn: false, detail: probe.error.message };
  }
  if (probe.status !== 0) {
    const detail = probe.stderr.trim() || probe.stdout.trim() || `agy models exited ${probe.status}`;
    return { loggedIn: false, detail: shorten(detail, 200) };
  }
  const modelCount = probe.stdout.split(/\r?\n/).filter((line) => /\S\t/.test(line)).length;
  return { loggedIn: true, detail: `signed in (agy models lists ${modelCount} model${modelCount === 1 ? "" : "s"})` };
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const agyStatus = binaryAvailable("agy", ["--version"], { cwd });
  const authStatus = agyStatus.available ? getAgyAuthStatus(cwd) : { loggedIn: false, detail: "agy is not installed" };
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!agyStatus.available) {
    nextSteps.push("Install the Antigravity CLI from https://antigravity.google/docs/cli/install/ and rerun /gemini:setup.");
  }
  if (agyStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate by running `agy` once in a terminal outside Claude Code, then rerun /gemini:setup.");
  }

  return {
    ready: nodeStatus.available && agyStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    agy: agyStatus,
    auth: authStatus,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseFlagCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "verify", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new UsageError("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const report = await buildSetupReport(cwd, actionsTaken);

  if (options.verify && report.agy.available) {
    const verify = await runAgy(
      { task: "Respond with exactly: ok", cwd: workspaceRoot, mode: "plan", timeoutSeconds: 120 },
      { signal: turnAbort.signal }
    );
    report.auth.verified = verify.ok;
    if (!verify.ok) {
      report.ready = false;
      report.auth.detail = `live check failed: ${shorten(verify.error ?? "unknown", 200)}`;
      report.nextSteps.push("The live verification call failed; check the auth detail above.");
    } else {
      report.auth.detail += ", live check passed";
    }
  }

  outputResult(options.json ? report : renderSetupReport(report), options.json);
  if (!report.ready) {
    process.exitCode = EXIT_FAILURE;
  }
}

// --- shared job helpers ---------------------------------------------------

function createCompanionJob({ prefix, kind, kindLabel, title, workspaceRoot, jobClass, summary, stopGate = false, requestId = null }) {
  return createJobRecord({
    id: generateJobId(prefix),
    handle: generateJobHandle(listJobs(workspaceRoot)),
    kind,
    kindLabel,
    title,
    workspaceRoot,
    jobClass,
    summary,
    stopGate,
    requestId
  });
}

// Registers the job, then claims its --request-id by creating the claim file
// exclusively. Of concurrent calls sharing an id exactly one claim succeeds;
// the others drop their record and replay the winner's job.
function reserveJob(workspaceRoot, requestId, jobSpec) {
  const job = createCompanionJob({ ...jobSpec, workspaceRoot, requestId });
  writeJobRecord(workspaceRoot, { ...job, status: "queued", phase: "queued", pid: process.pid, heartbeatAt: nowIso() });
  if (requestId) {
    const claim = claimRequestId(workspaceRoot, requestId, job.id);
    if (!claim.claimed) {
      removeJobRecord(workspaceRoot, job.id);
      const twin = listJobs(workspaceRoot).find((entry) => entry.id === claim.jobId);
      if (!twin) {
        throw new Error(`Request ${requestId} belongs to a job that is no longer recorded. Retry with a new --request-id.`);
      }
      return { twin };
    }
  }
  return { job };
}

function createTrackedProgress(job) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function agyEventToProgress(event, progress) {
  if (!progress) return;
  if (event.event === "init") {
    progress({ message: `conversation ${event.conversation_id ?? "started"}`, phase: "running", conversationId: event.conversation_id ?? null });
    return;
  }
  const step = event.step_update;
  if (event.event === "step_update" && step && typeof step === "object") {
    if (step.step_type === "agent_response" && step.state === "ACTIVE") {
      progress({ message: "", phase: "responding", conversationId: step.conversation_id ?? null });
    } else if (step.step_type === "tool" && step.state === "ACTIVE") {
      progress({ message: `tool: ${step.tool_name ?? step.tool_info?.name ?? "unknown"}`, phase: "working" });
    } else if (step.state === "ERROR") {
      progress({ message: `step error: ${String(step.error ?? step.step_type ?? "unknown").slice(0, 200)}` });
    }
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job);
  if (!options.json) {
    process.stderr.write(`[gemini] job ${job.handle} ${job.kindLabel} started\n`);
  }
  const stopHeartbeat = startJobHeartbeat(job.workspaceRoot, job.id);
  const cancelWatch = watchForCancel(job.workspaceRoot, job.id, () => turnAbort.abort());
  consumeCancel = cancelWatch.check;
  let execution;
  try {
    execution = await runTrackedJob(job, () => runner(progress, logFile), { logFile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = {
      status: "error",
      message: signalled ? `Cancelled: ${message}` : message,
      jobId: job?.id ?? null,
      handle: job?.handle ?? null,
      stderr: error instanceof Error && error.stack ? error.stack : null
    };
    if (options.json) {
      outputResult(envelope, true);
    } else {
      process.stderr.write(`Gemini companion failed: ${envelope.message}\n`);
      outputResult(`${renderFooter({ status: "failed", handle: job.handle, hint: `log: ${logFile}` })}\n`, false);
    }
    process.exitCode = EXIT_FAILURE;
    return { exitStatus: EXIT_FAILURE, payload: envelope, rendered: envelope.message };
  } finally {
    stopHeartbeat();
    cancelWatch.stop();
    consumeCancel = () => false;
  }
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

// Safe retries: a rerun with the same --request-id replays the stored result
// instead of starting a second agy. A twin that is still running is awaited.
async function replayTwin(workspaceRoot, twin, requestId, options) {
  let current = twin;
  const deadline = Date.now() + (Number(options.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS) * 1000 + 30_000;
  while (isActiveJobStatus(current.status) && !isJobStalled(current) && Date.now() < deadline) {
    await sleep(DEFAULT_STATUS_POLL_INTERVAL_MS / 4);
    current = matchJobReference(listJobs(workspaceRoot), current.id);
  }

  if (isActiveJobStatus(current.status)) {
    throw new Error(
      isJobStalled(current)
        ? `Request ${requestId} (job ${current.handle ?? current.id}) stopped without a result. Cancel it, then retry with a new --request-id.`
        : `Request ${requestId} is still running as job ${current.handle ?? current.id}. Check /gemini:status.`
    );
  }

  const storedJob = readStoredJob(workspaceRoot, current.id);
  outputCommandResult({ replayed: true, job: current, storedJob }, renderStoredJobResult(current, storedJob), options.json);
  const exitStatus = Number.isInteger(storedJob?.exitStatus) ? storedJob.exitStatus : current.status === "completed" ? EXIT_OK : EXIT_FAILURE;
  if (exitStatus !== 0) {
    process.exitCode = exitStatus;
  }
}

// --- task / reply ---------------------------------------------------------

async function readTaskPrompt(cwd, options, text) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  if (text) {
    return text;
  }
  const inactivityMs = Number(process.env.GEMINI_COMPANION_STDIN_TIMEOUT_MS) || STDIN_INACTIVITY_MS;
  try {
    return await readStdinIfPiped({ inactivityMs });
  } catch (error) {
    throw error instanceof StdinTimeoutError ? new UsageError(error.message) : error;
  }
}

function findLatestResumableJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.conversationId &&
        !job.stopGate &&
        !isActiveJobStatus(job.status)
    ) ?? null
  );
}

async function executeTaskRun(request, progress) {
  const startedAt = Date.now();
  consumeCancel();
  const outcome = await runAgy(
    {
      task: request.prompt,
      model: request.model,
      effort: request.effort,
      conversation: request.conversation,
      cwd: request.workspaceRoot,
      timeoutSeconds: request.timeoutSeconds,
      sandbox: request.sandbox,
      mode: request.plan ? "plan" : "accept-edits"
    },
    {
      signal: turnAbort.signal,
      onEvent: (event) => agyEventToProgress(event, progress),
      onSpawn: (pid) => {
        if (pid) patchJobRecord(request.workspaceRoot, request.jobId, { agyPid: pid });
      },
      onStderr: (chunk) => progress?.(String(chunk).trim())
    }
  );

  const durationSeconds = Number(outcome.result?.duration_seconds) || (Date.now() - startedAt) / 1000;
  const answer = typeof outcome.result?.response === "string" && outcome.result.response.trim()
    ? outcome.result.response
    : outcome.partial;
  const answerFile = writeAnswerFile(request.workspaceRoot, request.jobId, answer || outcome.error || "");

  const denied = isDeniedFailure(outcome.result);
  const exitStatus = outcome.ok ? EXIT_OK : denied ? EXIT_DENIED : EXIT_FAILURE;

  let body;
  let truncated = false;
  if (outcome.ok) {
    const capped = capAnswer(answer);
    truncated = capped.truncated;
    body = capped.text.endsWith("\n") ? capped.text : `${capped.text}\n`;
  } else {
    const detail = outcome.error ?? "agy failed without detail.";
    body = `${detail.trim()}\n`;
    if (answer.trim()) {
      const capped = capAnswer(answer);
      truncated = capped.truncated;
      body += `\nPartial response:\n${capped.text.endsWith("\n") ? capped.text : `${capped.text}\n`}`;
    }
  }
  const footer = renderFooter({
    status: outcome.ok ? "ok" : denied ? "denied" : "failed",
    handle: request.handle,
    duration: formatDuration(durationSeconds),
    answerFile: truncated ? answerFile : null
  });

  return {
    exitStatus,
    jobStatus: outcome.ok ? "completed" : "failed",
    conversationId: outcome.conversationId,
    answerFile,
    payload: {
      ok: outcome.ok,
      exitStatus,
      jobId: request.jobId,
      handle: request.handle,
      conversationId: outcome.conversationId,
      rawOutput: answer,
      error: outcome.error,
      deniedActions: outcome.result?.denied_actions ?? [],
      usage: outcome.result?.usage ?? null,
      answerFile
    },
    rendered: `${body}${footer}\n`,
    summary: shorten(answer || outcome.error || request.prompt)
  };
}

async function handleTaskLike(argv, { reply: replyCommand = false } = {}) {
  const { options, text } = parseProseCommand(argv, PROSE_RUNTIME_FLAGS);
  if (options.resume && options.fresh) {
    throw new UsageError("Choose either --resume or --fresh.");
  }
  const reply = replyCommand || Boolean(options.resume);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = normalizeModel(options.model);
  const effort = normalizeEffort(options.effort);
  const timeoutSeconds = normalizeTimeoutSeconds(options.timeout);
  const plan = Boolean(options.plan);
  const sandbox = plan ? false : options["no-sandbox"] ? false : true;
  const stopGate = Boolean(options["stop-gate"]);
  const requestId = options["request-id"] ?? null;
  const prompt = (await readTaskPrompt(cwd, options, text)).trim();

  let conversation = options.conversation ?? null;
  if (reply && !conversation) {
    const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
    const source = options.job ? matchJobReference(jobs, options.job) : findLatestResumableJob(jobs);
    if (!source?.conversationId) {
      throw new Error(
        options.job
          ? `Job ${options.job} has no stored conversation to resume.`
          : "No previous Gemini conversation was found for this repository. Run a task first."
      );
    }
    conversation = source.conversationId;
  }

  if (!prompt) {
    throw new UsageError("Provide a prompt (argument, --prompt-file, or piped stdin).");
  }

  const title = stopGate ? "Gemini Stop Gate Review" : reply ? "Gemini Reply" : "Gemini Task";
  const reservation = reserveJob(workspaceRoot, requestId, {
    prefix: stopGate ? "gate" : "task",
    kind: "task",
    kindLabel: reply ? "reply" : "task",
    title,
    jobClass: "task",
    summary: shorten(prompt),
    stopGate
  });
  if (reservation.twin) {
    await replayTwin(workspaceRoot, reservation.twin, requestId, { json: options.json, timeoutSeconds });
    return;
  }
  const { job } = reservation;

  await runForegroundCommand(
    job,
    (progress, logFile) =>
      executeTaskRun(
        {
          prompt,
          model,
          effort,
          conversation,
          workspaceRoot,
          timeoutSeconds,
          sandbox,
          plan,
          jobId: job.id,
          handle: job.handle,
          logFile
        },
        progress
      ),
    { json: options.json }
  );
}

// --- review ---------------------------------------------------------------

function buildReviewPrompt(context, focusText, reviewName) {
  const templateName = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

async function executeReviewRun(request, progress) {
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, request.focusText?.trim() ?? "", reviewName);

  const startedAt = Date.now();
  consumeCancel();
  const outcome = await runAgy(
    {
      task: prompt,
      model: request.model,
      effort: request.effort,
      cwd: context.repoRoot,
      timeoutSeconds: request.timeoutSeconds,
      mode: "plan",
      jsonSchemaPath: REVIEW_SCHEMA
    },
    {
      signal: turnAbort.signal,
      onEvent: (event) => agyEventToProgress(event, progress),
      onSpawn: (pid) => {
        if (pid) patchJobRecord(request.workspaceRoot, request.jobId, { agyPid: pid });
      },
      onStderr: (chunk) => progress?.(String(chunk).trim())
    }
  );

  const durationSeconds = Number(outcome.result?.duration_seconds) || (Date.now() - startedAt) / 1000;
  const parsed = parseStructuredOutput(outcome.result, {
    partial: outcome.partial,
    failureMessage: outcome.error ?? ""
  });
  const reviewBody = renderReviewResult(parsed, {
    reviewLabel: reviewName,
    targetLabel: context.target.label
  });
  const answerFile = writeAnswerFile(request.workspaceRoot, request.jobId, reviewBody);

  const denied = isDeniedFailure(outcome.result);
  const structuredOk = Boolean(parsed.parsed) && outcome.ok;
  const hasFindings = structuredOk && Array.isArray(parsed.parsed.findings) && parsed.parsed.findings.length > 0;
  const needsAttention = structuredOk && (parsed.parsed.verdict === "needs-attention" || hasFindings);
  const exitStatus = !outcome.ok
    ? denied ? EXIT_DENIED : EXIT_FAILURE
    : !parsed.parsed
      ? EXIT_FAILURE
      : needsAttention
        ? EXIT_FINDINGS
        : EXIT_OK;

  const capped = capAnswer(reviewBody);
  const footer = renderFooter({
    status: exitStatus === EXIT_FAILURE ? "failed" : exitStatus === EXIT_DENIED ? "denied" : "ok",
    handle: request.handle,
    duration: formatDuration(durationSeconds),
    answerFile: capped.truncated ? answerFile : null
  });

  let body = capped.text;
  if (!outcome.ok && outcome.error) {
    body = `${body.trimEnd()}\n\nagy error: ${outcome.error.trim()}\n`;
  }

  return {
    exitStatus,
    jobStatus: structuredOk ? "completed" : "failed",
    conversationId: outcome.conversationId,
    answerFile,
    payload: {
      ok: structuredOk,
      exitStatus,
      review: reviewName,
      target,
      jobId: request.jobId,
      handle: request.handle,
      conversationId: outcome.conversationId,
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      error: outcome.error,
      usage: outcome.result?.usage ?? null,
      answerFile
    },
    rendered: `${body.trimEnd()}\n${footer}\n`,
    summary: parsed.parsed?.summary ?? parsed.parseError ?? `${reviewName} finished.`
  };
}

async function handleReviewCommand(argv, config) {
  const { options, text } = parseProseCommand(argv, PROSE_RUNTIME_FLAGS);

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const timeoutSeconds = normalizeTimeoutSeconds(options.timeout);
  const requestId = options["request-id"] ?? null;
  const focusText = text.trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const kind = config.reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const reservation = reserveJob(workspaceRoot, requestId, {
    prefix: "review",
    kind,
    kindLabel: kind,
    title: `Gemini ${config.reviewName}`,
    jobClass: "review",
    summary: `${config.reviewName} ${target.label}`
  });
  if (reservation.twin) {
    await replayTwin(workspaceRoot, reservation.twin, requestId, { json: options.json, timeoutSeconds });
    return;
  }
  const { job } = reservation;

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun(
        {
          cwd,
          workspaceRoot,
          base: options.base,
          scope: options.scope,
          model: normalizeModel(options.model),
          effort: normalizeEffort(options.effort),
          timeoutSeconds,
          focusText,
          reviewName: config.reviewName,
          jobId: job.id,
          handle: job.handle
        },
        progress
      ),
    { json: options.json }
  );
}

// --- status / result / wait / cancel ---------------------------------------

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && !snapshot.job.stalled && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status) && !snapshot.job.stalled,
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseFlagCommand(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    const { job } = resolveWaitTargetJob(cwd);
    const snapshot = await waitForSingleJobSnapshot(cwd, job.id, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    });
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseFlagCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);

  // A replay always exits 0 (the footer carries the job's own status) so the
  // inline `!` command in /gemini:result never fails on a review with findings.
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

async function handleWait(argv) {
  const { options, positionals } = parseFlagCommand(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] || resolveWaitTargetJob(cwd).job.id;
  const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
    timeoutMs: options["timeout-ms"],
    pollIntervalMs: options["poll-interval-ms"]
  });

  if (snapshot.waitTimedOut) {
    outputCommandResult(snapshot, `Job ${snapshot.job.handle ?? snapshot.job.id} is still ${snapshot.job.status} after ${Math.round(snapshot.timeoutMs / 1000)}s. Check /gemini:status.\n`, options.json);
    process.exitCode = EXIT_FAILURE;
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readStoredJob(workspaceRoot, snapshot.job.id);
  outputCommandResult({ job: snapshot.job, storedJob }, renderStoredJobResult(snapshot.job, storedJob), options.json);
  const exitStatus = Number.isInteger(storedJob?.exitStatus) ? storedJob.exitStatus : 0;
  if (exitStatus !== 0) {
    process.exitCode = exitStatus;
  }
}

async function handleCancel(argv) {
  const { options, positionals } = parseFlagCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  // The marker is written before any signal, so the run unwinding afterwards
  // reads as cancelled. A job that finishes at the same moment also reads as
  // cancelled; its stored result stays available to /gemini:result.
  markJobCancelled(workspaceRoot, job.id);

  // Signal the companion (its SIGTERM handler aborts the agy run), then stop
  // the recorded agy process group directly with escalation, because the
  // companion may already be dead and unable to escalate. A companion whose
  // heartbeat went quiet is not signalled: its pid may now belong to another
  // process.
  const companionFresh = job.pid != null && Date.now() - Date.parse(job.heartbeatAt ?? "") <= 30_000;
  const companionKill = companionFresh ? terminateProcessTree(job.pid) : { attempted: false, delivered: false };
  let agyKill = { attempted: false, delivered: false };
  if (job.agyPid != null && job.agyPid !== job.pid) {
    agyKill = await stopProcessGroup(job.agyPid);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const payload = {
    jobId: job.id,
    handle: job.handle ?? null,
    status: "cancelled",
    title: job.title,
    companionSignalled: companionKill.delivered,
    agySignalled: agyKill.delivered
  };

  outputCommandResult(payload, renderCancelReport(job, { interrupted: companionKill.delivered || agyKill.delivered }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTaskLike(argv);
      break;
    case "reply":
      await handleTaskLike(argv, { reply: true });
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "wait":
      await handleWait(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new UsageError(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
});
