import test from "node:test";
import assert from "node:assert/strict";

import process from "node:process";
import { spawn } from "node:child_process";

import { runCommand, stopProcessGroup, terminateProcessTree } from "../plugins/gemini/scripts/lib/process.mjs";

test("runCommand enforces its timeout", () => {
  const started = Date.now();
  const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 200 });
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.ok(Date.now() - started < 5000);
});

test("stopProcessGroup escalates to SIGKILL for a member that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const leader = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const outcome = await stopProcessGroup(leader.pid, { graceMs: 300 });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.escalated, true);
  await new Promise((resolve) => leader.once("close", resolve));
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree falls back to the pid when it does not lead a process group", () => {
  const calls = [];
  const outcome = terminateProcessTree(4321, {
    platform: "darwin",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no such process group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });
  assert.deepEqual(calls, [[-4321, "SIGTERM"], [4321, "SIGTERM"]]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
