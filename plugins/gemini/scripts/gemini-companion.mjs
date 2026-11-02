#!/usr/bin/env node

// Companion CLI for the Gemini plugin. Every model turn is one agy process
// (lib/agy.mjs) driven by the turn engine in lib/runner.mjs; there is no
// broker, daemon, or self-detaching worker. Long runs are backgrounded by the
// caller (Claude's run_in_background Bash), whose completion notification
// replaces polling.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { agyInvocation, DEFAULT_TIMEOUT_SECONDS } from "./lib/agy.mjs";
import { parseArgs, parseProseCommand, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped, STDIN_INACTIVITY_MS, StdinTimeoutError } from "./lib/fs.mjs";
import { resolveReviewTarget } from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  matchJobReference,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { binaryAvailable, runCommand, stopProcessGroup, terminateProcessTree } from "./lib/process.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  shorten
} from "./lib/render.mjs";
import {
  createTurn,
  executeReviewRun,
  executeTaskRun,
  EXIT_FAILURE,
  EXIT_USAGE,
  measureAgyBaseline,
  outputCommandResult,
  outputResult,
  replayTwin,
  reserveJob,
  runForegroundCommand,
  UsageError
} from "./lib/runner.mjs";
import { getConfig, isActiveJobStatus, listJobs, markJobCancelled, setConfig } from "./lib/state.mjs";
import { appendLogLine } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Aborts the in-flight agy run (killing its whole process tree) when the
// companion itself is signalled, e.g. by /gemini:cancel or a Bash timeout.
const turn = createTurn();
for (const signalName of ["SIGTERM", "SIGINT"]) {
  process.on(signalName, () => {
    turn.signalled = true;
    turn.abort();
    setTimeout(() => process.exit(EXIT_FAILURE), 5000).unref();
  });
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gemini-companion.mjs setup [--verify] [--enable-review-gate|--disable-review-gate] [--json]",
      "  gemini-companion.mjs task [--plan] [--no-sandbox] [--model <m>] [--effort <low|medium|high|xhigh|max>] [--conversation <id>] [--timeout <s>] [--request-id <id>] [--json] [prompt]",
      "  gemini-companion.mjs reply [--job <handle>] [same flags as task] [prompt]",
      "  gemini-companion.mjs review|adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <m>] [--timeout <s>] [--request-id <id>] [--json] [focus]",
      "  gemini-companion.mjs status [job] [--all] [--json]",
      "  gemini-companion.mjs result [job] [--json]",
      "  gemini-companion.mjs cancel [job] [--json]",
      "",
      "Exit codes: 0 ok, 10 review findings, 20 action denied, 1 failure, 2 usage."
    ].join("\n")
  );
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

function parseFlagCommand(argv, config = {}) {
  const tokens = argv.length === 1 ? (argv[0]?.trim() ? splitRawArgumentString(argv[0]) : []) : argv;
  return parseArgs(tokens, { ...config, aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) } });
}

// `--wait` and `--background` are Claude-side run modes; the commands pass
// them through and the companion accepts and ignores them.
const PROSE_RUNTIME_FLAGS = {
  valueOptions: ["model", "effort", "cwd", "timeout", "conversation", "request-id", "prompt-file", "base", "scope", "job"],
  booleanOptions: ["json", "plan", "no-sandbox", "sandbox", "stop-gate", "wait", "background", "resume", "fresh"],
  aliasMap: { m: "model", C: "cwd" }
};

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

// --- setup ------------------------------------------------------------------

function getAgyAuthStatus(cwd) {
  const agyBin = agyInvocation();
  const probe = runCommand(agyBin.command, [...agyBin.args, "models"], { cwd, timeout: 30000 });
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

  const node = binaryAvailable(process.execPath, ["--version"], { cwd });
  const agyBin = agyInvocation();
  const agy = binaryAvailable(agyBin.command, [...agyBin.args, "--version"], { cwd });
  const auth = agy.available ? getAgyAuthStatus(cwd) : { loggedIn: false, detail: "agy is not installed" };
  const report = {
    ready: node.available && agy.available && auth.loggedIn,
    node,
    agy,
    auth,
    baseline: null,
    reviewGateEnabled: Boolean(getConfig(workspaceRoot).stopReviewGate),
    actionsTaken,
    nextSteps: []
  };
  if (!agy.available) {
    report.nextSteps.push("Install the Antigravity CLI from https://antigravity.google/docs/cli/install/ and rerun /gemini:setup.");
  } else if (!auth.loggedIn) {
    report.nextSteps.push("Authenticate by running `agy` once in a terminal outside Claude Code, then rerun /gemini:setup.");
  }

  if (options.verify && agy.available) {
    const baseline = await measureAgyBaseline(workspaceRoot, turn);
    report.auth.verified = baseline.ok;
    report.baseline = baseline;
    if (!baseline.ok) {
      report.ready = false;
      report.auth.detail = `live check failed: ${shorten(baseline.error ?? "unknown", 200)}`;
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

// --- task / reply -------------------------------------------------------------

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
  return jobs.find((job) => job.conversationId && !job.stopGate && !isActiveJobStatus(job.status)) ?? null;
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
  const readOnly = Boolean(options.plan);
  const stopGate = Boolean(options["stop-gate"]);
  const requestId = options["request-id"] ?? null;
  const prompt = (await readTaskPrompt(cwd, options, text)).trim();

  let conversation = options.conversation ?? null;
  if (reply && !conversation) {
    const jobs = listJobs(workspaceRoot);
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

  const reservation = reserveJob(workspaceRoot, requestId, {
    prefix: stopGate ? "gate" : "task",
    kind: "task",
    kindLabel: reply ? "reply" : "task",
    title: stopGate ? "Gemini Stop Gate Review" : reply ? "Gemini Reply" : "Gemini Task",
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
    (progress) =>
      executeTaskRun(
        {
          prompt,
          model,
          effort,
          conversation,
          workspaceRoot,
          timeoutSeconds,
          readOnly,
          sandbox: !options["no-sandbox"],
          jobId: job.id,
          handle: job.handle
        },
        progress,
        turn
      ),
    { json: options.json, turn }
  );
}

// --- review -------------------------------------------------------------------

async function handleReviewCommand(argv, reviewName) {
  const { options, text } = parseProseCommand(argv, PROSE_RUNTIME_FLAGS);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const timeoutSeconds = normalizeTimeoutSeconds(options.timeout);
  const requestId = options["request-id"] ?? null;
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  const kind = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const reservation = reserveJob(workspaceRoot, requestId, {
    prefix: "review",
    kind,
    kindLabel: kind,
    title: `Gemini ${reviewName}`,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`
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
          rootDir: ROOT_DIR,
          target,
          model: normalizeModel(options.model),
          effort: normalizeEffort(options.effort),
          timeoutSeconds,
          focusText: text.trim(),
          reviewName,
          jobId: job.id,
          handle: job.handle
        },
        progress,
        turn
      ),
    { json: options.json, turn }
  );
}

// --- status / result / cancel ---------------------------------------------------

function handleStatus(argv) {
  const { options, positionals } = parseFlagCommand(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "all"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }
  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseFlagCommand(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { workspaceRoot, job } = resolveResultJob(resolveCommandCwd(options), positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id);
  // A replay always exits 0 (the footer carries the job's own status) so the
  // inline `!` command in /gemini:result never fails on a review with findings.
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseFlagCommand(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const { workspaceRoot, job } = resolveCancelableJob(resolveCommandCwd(options), positionals[0] ?? "");

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
  let companionKill = { attempted: false, delivered: false };
  try {
    if (companionFresh) companionKill = terminateProcessTree(job.pid);
  } catch (error) {
    // The cancel marker is written and agy still has to be stopped below.
    companionKill = { attempted: true, delivered: false };
    try { appendLogLine(job.logFile, `Could not signal the companion: ${error.message}`); } catch {}
  }
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

const HANDLERS = {
  setup: handleSetup,
  review: (argv) => handleReviewCommand(argv, "Review"),
  "adversarial-review": (argv) => handleReviewCommand(argv, "Adversarial Review"),
  task: (argv) => handleTaskLike(argv),
  reply: (argv) => handleTaskLike(argv, { reply: true }),
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel
};

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  const handler = HANDLERS[subcommand];
  if (!handler) {
    throw new UsageError(`Unknown subcommand: ${subcommand}`);
  }
  await handler(argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
});
