#!/usr/bin/env node

// Optional Stop hook: when the review gate is enabled for this workspace,
// a read-only Gemini turn reviews Claude's last turn and can block the stop.
// Gate runs are tagged with --stop-gate so they never become resume targets.

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { binaryAvailable } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { isActiveJobStatus, isJobStalled, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// Inner budget stays well under the hook's 900 s timeout so the hook always
// gets to emit its decision.
const GATE_AGY_TIMEOUT_SECONDS = 600;
const GATE_PROCESS_TIMEOUT_MS = 720 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

export function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function shortenDetail(rawDetail) {
  const text = String(rawDetail ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s+at /.test(line))
    .join(" ")
    .trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "The stop-time Gemini review returned no output. Run /gemini:review --wait manually or disable the gate with /gemini:setup --disable-review-gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Gemini stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason: "The stop-time Gemini review returned an unexpected answer. Run /gemini:review --wait manually or disable the gate with /gemini:setup --disable-review-gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "gemini-companion.mjs");
  const result = spawnSync(
    process.execPath,
    [scriptPath, "task", "--plan", "--stop-gate", "--json", "--timeout", String(GATE_AGY_TIMEOUT_SECONDS)],
    {
      cwd,
      env: process.env,
      encoding: "utf8",
      input: buildStopReviewPrompt(input),
      timeout: GATE_PROCESS_TIMEOUT_MS
    }
  );

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason: "The stop-time Gemini review timed out. Run /gemini:review --wait manually or disable the gate with /gemini:setup --disable-review-gate."
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }

  if (result.status !== 0) {
    const detail = shortenDetail(payload?.error ?? payload?.message ?? result.stderr ?? result.stdout);
    return {
      ok: false,
      reason: `The stop-time Gemini review failed${detail ? `: ${detail}` : "."} Run /gemini:setup to check agy, or disable the gate with /gemini:setup --disable-review-gate.`
    };
  }

  if (!payload) {
    return {
      ok: false,
      reason: "The stop-time Gemini review returned invalid JSON. Run /gemini:review --wait manually or disable the gate with /gemini:setup --disable-review-gate."
    };
  }
  return parseStopReviewOutput(payload.rawOutput);
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const runningJob = sortJobsNewestFirst(listJobs(workspaceRoot)).find(
    (job) => isActiveJobStatus(job.status) && !isJobStalled(job) && !job.stopGate
  );
  const runningTaskNote = runningJob
    ? `Gemini job ${runningJob.handle ?? runningJob.id} is still running. Check /gemini:status, or /gemini:cancel ${runningJob.handle ?? runningJob.id} to stop it.`
    : null;

  // Claude is already continuing because of an earlier block from this hook:
  // review once per stop cycle so a persistent BLOCK cannot loop forever.
  if (!config.stopReviewGate || input.stop_hook_active) {
    logNote(runningTaskNote);
    return;
  }

  if (!binaryAvailable("agy", ["--version"], { cwd }).available) {
    emitDecision({
      decision: "block",
      reason: [
        "The Gemini review gate is enabled but agy is not installed. Run /gemini:setup, or disable the gate with /gemini:setup --disable-review-gate.",
        runningTaskNote
      ].filter(Boolean).join(" ")
    });
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: [runningTaskNote, review.reason].filter(Boolean).join(" ")
    });
    return;
  }

  logNote(runningTaskNote);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
