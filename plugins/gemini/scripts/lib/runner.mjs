// The turn engine behind gemini-companion.mjs: reserves a job, runs one agy
// turn for a task, reply or review, records progress, and prints the answer
// with its one-line footer. The CLI entry point only parses arguments.

import path from "node:path";
import process from "node:process";

import { DEFAULT_TIMEOUT_SECONDS, describeStepError, describeToolStep, isDeniedFailure, runAgy } from "./agy.mjs";
import { buildCollectionGuidance, collectReviewContext } from "./git.mjs";
import { isJobStalled, matchJobReference, readStoredJob } from "./job-control.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";
import { capAnswer, formatDuration, renderFooter, renderReviewResult, renderStoredJobResult, shorten } from "./render.mjs";
import { parseStructuredOutput } from "./review-output.mjs";
import {
  claimRequestId,
  generateJobHandle,
  generateJobId,
  isActiveJobStatus,
  listJobs,
  nowIso,
  patchJobRecord,
  removeJobRecord,
  writeAnswerFile,
  writeJobDiff,
  writeJobRecord
} from "./state.mjs";
import {
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob,
  startJobHeartbeat,
  watchForCancel
} from "./tracked-jobs.mjs";

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 10;
export const EXIT_DENIED = 20;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const REPLAY_POLL_MS = 500;

export class UsageError extends Error {}

export function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

export function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

// One per process: the signal that aborts the running agy turn, and the
// check that turns a cancel marker into that abort.
export function createTurn() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    signalled: false,
    abort() {
      controller.abort();
    },
    consumeCancel: () => false
  };
}

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
export function reserveJob(workspaceRoot, requestId, jobSpec) {
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

// Safe retries: a rerun with the same --request-id replays the stored result
// instead of starting a second agy. A twin that is still running is awaited.
export async function replayTwin(workspaceRoot, twin, requestId, options) {
  let current = twin;
  const deadline = Date.now() + (Number(options.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS) * 1000 + 30_000;
  while (isActiveJobStatus(current.status) && !isJobStalled(current) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_MS));
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
      progress({ message: `tool: ${describeToolStep(step)}`, phase: "working" });
    } else if (step.state === "ERROR") {
      progress({ message: describeStepError(step) });
    }
  }
}

function turnCallbacks(request, progress, turn) {
  return {
    signal: turn.signal,
    onEvent: (event) => agyEventToProgress(event, progress),
    onSpawn: (pid) => {
      if (pid) patchJobRecord(request.workspaceRoot, request.jobId, { agyPid: pid });
    },
    onStderr: (chunk) => progress?.(String(chunk).trim())
  };
}

export async function runForegroundCommand(job, runner, { json = false, turn }) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const progress = createProgressReporter({ logFile, onEvent: createJobProgressUpdater(job.workspaceRoot, job.id) });
  if (!json) {
    process.stderr.write(`[gemini] job ${job.handle} ${job.kindLabel} started\n`);
  }
  const stopHeartbeat = startJobHeartbeat(job.workspaceRoot, job.id);
  const cancelWatch = watchForCancel(job.workspaceRoot, job.id, () => turn.abort());
  turn.consumeCancel = cancelWatch.check;
  let execution;
  try {
    execution = await runTrackedJob(job, () => runner(progress), { logFile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = {
      status: "error",
      message: turn.signalled ? `Cancelled: ${message}` : message,
      jobId: job?.id ?? null,
      handle: job?.handle ?? null,
      stderr: error instanceof Error && error.stack ? error.stack : null
    };
    if (json) {
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
    turn.consumeCancel = () => false;
  }
  outputResult(json ? execution.payload : execution.rendered, json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

export async function executeTaskRun(request, progress, turn) {
  const startedAt = Date.now();
  turn.consumeCancel();
  const outcome = await runAgy(
    {
      task: request.prompt,
      model: request.model,
      effort: request.effort,
      conversation: request.conversation,
      cwd: request.workspaceRoot,
      timeoutSeconds: request.timeoutSeconds,
      sandbox: request.sandbox,
      readOnly: request.readOnly
    },
    turnCallbacks(request, progress, turn)
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
    body = `${(outcome.error ?? "agy failed without detail.").trim()}\n`;
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

function buildReviewPrompt(rootDir, context, focusText, reviewName, guidance) {
  const templateName = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  return interpolateTemplate(loadPromptTemplate(rootDir, templateName), {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: guidance,
    REVIEW_INPUT: context.content
  });
}

export async function executeReviewRun(request, progress, turn) {
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, request.target);
  const diffFile = context.fullDiff ? writeJobDiff(request.workspaceRoot, request.jobId, context.fullDiff) : null;
  const prompt = buildReviewPrompt(request.rootDir, context, request.focusText?.trim() ?? "", reviewName, buildCollectionGuidance(context, diffFile));

  const startedAt = Date.now();
  turn.consumeCancel();
  const outcome = await runAgy(
    {
      task: prompt,
      model: request.model,
      effort: request.effort,
      cwd: context.repoRoot,
      timeoutSeconds: request.timeoutSeconds,
      readOnly: true,
      jsonSchemaPath: path.join(request.rootDir, "schemas", "review-output.schema.json")
    },
    turnCallbacks(request, progress, turn)
  );

  const durationSeconds = Number(outcome.result?.duration_seconds) || (Date.now() - startedAt) / 1000;
  const parsed = parseStructuredOutput(outcome.result, { partial: outcome.partial, failureMessage: outcome.error ?? "" });
  const reviewBody = renderReviewResult(parsed, { reviewLabel: reviewName, targetLabel: context.target.label });
  const answerFile = writeAnswerFile(request.workspaceRoot, request.jobId, reviewBody);

  const denied = isDeniedFailure(outcome.result);
  const structuredOk = Boolean(parsed.parsed) && outcome.ok;
  const hasFindings = structuredOk && Array.isArray(parsed.parsed.findings) && parsed.parsed.findings.length > 0;
  const needsAttention = structuredOk && (parsed.parsed.verdict === "needs-attention" || hasFindings);
  const exitStatus = !outcome.ok
    ? denied ? EXIT_DENIED : EXIT_FAILURE
    : !parsed.parsed
      ? EXIT_FAILURE
      : needsAttention ? EXIT_FINDINGS : EXIT_OK;

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
      target: request.target,
      inputMode: context.inputMode,
      diffFile,
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

// A minimal read-only turn whose cost shows what agy loads into every call:
// its input tokens and the tools it offers the model.
export async function measureAgyBaseline(cwd, turn) {
  let toolCount = null;
  const outcome = await runAgy(
    { task: "Respond with exactly: ok", cwd, readOnly: true, timeoutSeconds: 120 },
    {
      signal: turn.signal,
      onEvent: (event) => {
        if (event.event === "init" && Array.isArray(event.init?.tools)) toolCount = event.init.tools.length;
      }
    }
  );
  return {
    ok: outcome.ok,
    error: outcome.error,
    inputTokens: outcome.result?.usage?.input_tokens ?? null,
    toolCount
  };
}
