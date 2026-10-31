// One-shot runner for the Antigravity CLI (agy). One process per turn: the
// task goes in over stdin as a single NDJSON message, stream-json events come
// back on stdout, and the terminal `result` event carries the response, the
// conversation id for resume, and (with --json-schema) a validated
// `structured_output` object. Ported from the dual-hosts gemini-bridge design.
//
// tests/agy-contract.live.test.mjs (`npm run test:live`) pins every agy
// behaviour relied on here; re-run it after each agy upgrade and keep
// tests/fixtures/fake-agy.mjs in step with it.
//
// Verified against agy 1.4.12: read-only runs are enforced by --settings
// deny rules, which make agy refuse every write, edit, shell command and MCP
// call; a refused call fails as a tool step and the run still answers, with
// result.denied_actions left empty. `--mode plan` is not used: it is only a
// prompt, it is ignored when --disable-slash-commands is set, and dropping it
// changed a trivial turn's input by 23 tokens. When its own --print-timeout fires, agy still
// exits 0 with status SUCCESS and marks the result
// `finished_reason: "print_timeout"`; that is treated as incomplete.

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { shorten } from "./render.mjs";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
const DIAGNOSTIC_TAIL_LENGTH = 8192;

// Under Claude Code's 10-minute foreground Bash limit, leaving time to record
// the job before the tool call is killed.
export const DEFAULT_TIMEOUT_SECONDS = 540;
export const AGY_INSTALL_HINT =
  "Antigravity CLI is not installed or not on PATH. Install it from https://antigravity.google/docs/cli/install/ and authenticate by running `agy` once in a terminal.";

export function agyCommand(platform = process.platform) {
  return platform === "win32" ? "agy.exe" : "agy";
}

export const READ_ONLY_SETTINGS = JSON.stringify({
  permissions: { deny: ["write_file(*)", "edit_file(*)", "command(*)", "mcp(*)"] }
});

export function buildLaunchDescription(options) {
  const timeoutSeconds = Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS;
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--mode", "accept-edits",
    "--print-timeout", `${timeoutSeconds.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 })}s`
  ];
  for (const key of ["model", "effort", "conversation"]) {
    if (options[key] != null && options[key] !== "") {
      args.push(`--${key}`, String(options[key]));
    }
  }
  if (options.jsonSchemaPath) {
    args.push("--json-schema", options.jsonSchemaPath);
  }
  if (options.readOnly) {
    args.push("--settings", READ_ONLY_SETTINGS);
  }
  if (options.readOnly || options.sandbox) {
    args.push("--sandbox");
  }
  return {
    command: agyCommand(),
    args,
    cwd: options.cwd ?? process.cwd(),
    timeoutSeconds,
    input: `${JSON.stringify({ event: "user", message: { content: String(options.task ?? "") } })}\n`
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resultFailure(result) {
  if (!isObject(result) || typeof result.status !== "string" || typeof result.response !== "string") {
    return "agy returned a malformed result: expected status and response strings.";
  }
  if (result.denied_actions !== undefined && !Array.isArray(result.denied_actions)) {
    return "agy returned malformed denied_actions; expected an array.";
  }
  if (result.denied_actions?.length) {
    return `agy denied ${result.denied_actions.length} requested action(s). The task is incomplete; review denied_actions and configured permissions.`;
  }
  if (result.status !== "SUCCESS") {
    return `agy finished with status ${result.status}${result.error ? `: ${String(result.error)}` : "."}`;
  }
  if (result.finished_reason === "print_timeout") {
    return "agy hit its print timeout before the turn finished; any response is partial. Retry with a larger --timeout or a narrower task.";
  }
  if (!result.response.trim()) {
    return "agy returned an empty response. No usable task result was produced.";
  }
  return null;
}

export function launchFailure(error, command) {
  return error.code === "ENOENT"
    ? `Cannot launch ${command}: ${AGY_INSTALL_HINT}`
    : `Cannot launch ${command}: ${error.message}`;
}

export function isDeniedFailure(result) {
  return Boolean(Array.isArray(result?.denied_actions) && result.denied_actions.length);
}

// The tool name plus its main argument (a path, command, query or URL), so
// the job log says what Gemini touched, e.g. "read_file /repo/tests/x.mjs".
export function describeToolStep(step) {
  const name = step.tool_name ?? step.tool_info?.name ?? "unknown tool";
  const parameters = step.tool_info?.parameters;
  let target = "";
  if (parameters && typeof parameters === "object") {
    const entries = Object.entries(parameters).filter(([, value]) => typeof value === "string" && value.trim());
    const preferred = entries.find(([key]) => /path|file|command|query|url|pattern|dir/i.test(key)) ?? entries[0];
    target = preferred ? shorten(preferred[1], 160) : "";
  }
  return target ? `${name} ${target}` : name;
}

// agy streams a failed tool step as state ERROR with the reason in
// tool_info.error.message, not in a top-level error field.
export function describeStepError(step) {
  const reason = step.tool_info?.error?.message ?? step.error?.message ?? step.error ?? "no reason given";
  const subject = step.step_type === "tool" || step.tool_name || step.tool_info ? describeToolStep(step) : step.step_type ?? "step";
  return `failed: ${subject} — ${shorten(reason, 200)}`;
}

// Runs one agy turn. Returns { ok, result, error, partial, conversationId,
// exitCode, exitSignal }. `onEvent` fires for every parsed stream event
// (including the terminal result) so callers can log progress and record the
// conversation id as soon as `init` arrives. `onStderr` receives raw agy
// diagnostics chunks.
export async function runAgy(options, { spawnImpl = spawn, signal, onEvent, onStderr, onSpawn } = {}) {
  const launch = buildLaunchDescription(options);
  if (signal?.aborted) {
    return { ok: false, result: null, error: "agy cancelled before launch.", partial: "", conversationId: null };
  }

  let child;
  try {
    child = spawnImpl(launch.command, launch.args, {
      cwd: launch.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    return { ok: false, result: null, error: launchFailure(error, launch.command), partial: "", conversationId: null };
  }
  try {
    onSpawn?.(child.pid ?? null);
  } catch {
    // Progress reporting must never break the run.
  }

  let failure = null;
  let result = null;
  let seenResult = false;
  let partial = "";
  let partialBytes = 0;
  let diagnosticTail = "";
  let conversationId = null;
  let closed = false;
  let stopping = false;
  let forceTimer;
  let timeoutTimer;
  const cleanupAttempts = [];
  const fail = (message) => { failure ??= message; };
  const cleanupError = (error) => {
    if (error.code !== "ESRCH") {
      failure = `${failure ? `${failure}\n` : ""}Unable to terminate the agy process tree: ${error.message}`;
    }
  };

  function killTree(force) {
    if (process.platform === "win32" && child.pid) {
      // Kill the tree in one operation: once its parent exits, taskkill cannot
      // discover orphaned commands. Windows has no POSIX process-group signal.
      cleanupAttempts.push(new Promise((resolve) => {
        const killer = spawn(
          path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" }
        );
        killer.once("error", (error) => { cleanupError(error); child.kill("SIGKILL"); resolve(); });
        killer.once("close", (code) => {
          if (code !== 0 && !closed) {
            cleanupError(new Error(`taskkill exited with code ${code}; delegated commands may still be running.`));
            child.kill("SIGKILL");
          }
          resolve();
        });
      }));
    } else {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        else child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (error.code === "ESRCH") return;
        try {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch (innerError) {
          cleanupError(innerError);
        }
      }
    }
  }

  function stop(message) {
    fail(message);
    if (closed || stopping) return;
    stopping = true;
    killTree(false);
    forceTimer = setTimeout(() => killTree(true), 1000);
  }

  const cancelled = () => stop("agy cancelled. Partial edits may exist; inspect the workspace before retrying.");
  if (signal) signal.addEventListener("abort", cancelled, { once: true });

  // Node timers have a 32-bit delay limit; long requested deadlines are rearmed.
  const deadline = Date.now() + launch.timeoutSeconds * 1000;
  function armTimeout() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) stop(`agy timed out after ${launch.timeoutSeconds} seconds. Partial edits may exist; inspect the workspace before retrying.`);
    else timeoutTimer = setTimeout(armTimeout, Math.min(remaining, 2_147_483_647));
  }
  armTimeout();

  const completion = new Promise((resolve) => {
    child.once("error", (error) => fail(launchFailure(error, launch.command)));
    child.once("close", (code, exitSignal) => {
      closed = true;
      resolve({ code, exitSignal });
    });
  });
  child.stdin.once("error", (error) => stop(`Cannot send task to agy: ${error.message}`));

  async function consumeLine(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      throw new Error("agy output event exceeds the 32 MiB framing limit; output was not truncated.");
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("agy emitted malformed stream-json output; expected one JSON event per line.");
    }
    if (!isObject(event) || typeof event.event !== "string") {
      throw new Error("agy emitted a malformed stream event: missing event name.");
    }
    if (typeof event.conversation_id === "string" && event.conversation_id) {
      conversationId = event.conversation_id;
    }
    if (event.event === "result") {
      if (seenResult) throw new Error("agy emitted duplicate terminal results for one task.");
      seenResult = true;
      if (!isObject(event.result)) throw new Error("agy emitted a malformed terminal result; expected a result object.");
      result = event.result;
      if (typeof result.conversation_id === "string" && result.conversation_id) {
        conversationId = result.conversation_id;
      }
    } else {
      const step = event.step_update;
      if (event.event === "step_update" && isObject(step)) {
        if (typeof step.conversation_id === "string" && step.conversation_id) {
          conversationId = step.conversation_id;
        }
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          partialBytes += Buffer.byteLength(step.text_delta);
          if (partialBytes > MAX_PARTIAL_BYTES) {
            throw new Error("agy partial response exceeds the 32 MiB limit; the run was stopped instead of silently truncating output.");
          }
          partial += step.text_delta;
        }
      }
    }
    try {
      onEvent?.(event, { conversationId });
    } catch {
      // Progress reporting must never break the run.
    }
  }

  async function consumeStdout() {
    child.stdout.setEncoding("utf8");
    let pending = "";
    try {
      for await (const chunk of child.stdout) {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          await consumeLine(line);
        }
        if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
          throw new Error("agy output event exceeds the 32 MiB framing limit; output was not truncated.");
        }
      }
      await consumeLine(pending);
    } catch (error) {
      stop(error.message);
    }
  }

  async function consumeStderr() {
    child.stderr.setEncoding("utf8");
    try {
      for await (const chunk of child.stderr) {
        diagnosticTail = (diagnosticTail + chunk).slice(-DIAGNOSTIC_TAIL_LENGTH);
        try {
          onStderr?.(chunk);
        } catch {
          // Diagnostics reporting must never break the run.
        }
      }
    } catch (error) {
      stop(`Cannot read agy diagnostics: ${error.message}`);
    }
  }

  const readers = [consumeStdout(), consumeStderr()];
  try {
    if (signal?.aborted) {
      cancelled();
    } else {
      try {
        child.stdin.end(launch.input);
      } catch (error) {
        stop(`Cannot send task to agy: ${error.message}`);
      }
    }
    const outcome = await completion;
    await Promise.all(readers);
    // Descendants can close their pipes before the process-group leader exits.
    // Escalate any survivors even if close arrived before the grace timer.
    if (stopping && process.platform !== "win32") killTree(true);
    clearTimeout(forceTimer);
    await Promise.all(cleanupAttempts);
    if (outcome.code !== 0) {
      fail(`agy exited ${outcome.exitSignal ? `on signal ${outcome.exitSignal}` : `with code ${outcome.code ?? "unknown"}`}.`);
    }
    if (!failure) {
      failure = seenResult ? resultFailure(result) : "agy exited without a terminal result. No completed response was produced.";
    }
    if (failure && diagnosticTail.trim()) {
      failure += `\nagy diagnostics (last ${DIAGNOSTIC_TAIL_LENGTH} characters):\n${diagnosticTail.trim()}`;
    }
    return {
      ok: failure === null,
      result,
      error: failure,
      partial,
      conversationId,
      exitCode: outcome.code,
      exitSignal: outcome.exitSignal
    };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(forceTimer);
    if (signal) signal.removeEventListener("abort", cancelled);
  }
}
