import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";

import { FAKE_AGY, isAlive, waitFor } from "./helpers.mjs";
import {
  AGY_INSTALL_HINT,
  buildLaunchDescription,
  DEFAULT_TIMEOUT_SECONDS,
  isDeniedFailure,
  resultFailure,
  runAgy
} from "../plugins/gemini/scripts/lib/agy.mjs";

function fakeSpawn(scenario, extraEnv = {}) {
  return (command, args, options) =>
    spawn(process.execPath, [FAKE_AGY, ...args], {
      ...options,
      env: { ...options.env, AGY_TEST_SCENARIO: scenario, ...extraEnv }
    });
}

test("write runs disable slash commands and use accept-edits with the default timeout", () => {
  const launch = buildLaunchDescription({ task: "fix it", cwd: "/tmp" });
  assert.equal(launch.command, process.platform === "win32" ? "agy.exe" : "agy");
  assert.deepEqual(launch.args, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--mode", "accept-edits",
    "--print-timeout", `${DEFAULT_TIMEOUT_SECONDS}s`
  ]);
  assert.equal(launch.cwd, "/tmp");
  assert.equal(launch.input, `${JSON.stringify({ event: "user", message: { content: "fix it" } })}\n`);
});

test("plan runs keep slash expansion so agy honours read-only mode", () => {
  const launch = buildLaunchDescription({ task: "look", mode: "plan" });
  assert.ok(launch.args.includes("plan"));
  assert.ok(!launch.args.includes("--disable-slash-commands"));
});

test("a plan task starting with a slash is prefixed so it is not run as a slash command", () => {
  const plan = buildLaunchDescription({ task: "/etc/hosts: what is this?", mode: "plan" });
  assert.equal(JSON.parse(plan.input).message.content, "Task: /etc/hosts: what is this?");
  const write = buildLaunchDescription({ task: "/etc/hosts: what is this?" });
  assert.equal(JSON.parse(write.input).message.content, "/etc/hosts: what is this?");
});

test("model, effort, conversation, schema and sandbox pass through unchanged", () => {
  const launch = buildLaunchDescription({
    task: "t",
    model: "future/model:experimental",
    effort: "xhigh",
    conversation: "opaque:session/value",
    jsonSchemaPath: "/schemas/review.json",
    sandbox: true,
    timeoutSeconds: 17
  });
  const args = launch.args;
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "future/model:experimental"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
  assert.deepEqual(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2), ["--conversation", "opaque:session/value"]);
  assert.deepEqual(args.slice(args.indexOf("--json-schema"), args.indexOf("--json-schema") + 2), ["--json-schema", "/schemas/review.json"]);
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("17s"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--continue"));
});

test("a large task with shell metacharacters arrives as one stdin message, never in argv", async () => {
  const task = `$(rm -rf /) && \`echo pwned\` "quotes" 'single' ; | > < 中文 ${"x".repeat(320 * 1024)}`;
  const outcome = await runAgy({ task, cwd: process.cwd() }, { spawnImpl: fakeSpawn("echo") });
  assert.equal(outcome.ok, true, outcome.error);
  const echoed = JSON.parse(outcome.result.response);
  assert.equal(echoed.eof, true);
  assert.equal(echoed.input, `${JSON.stringify({ event: "user", message: { content: task } })}\n`);
  assert.ok(!echoed.args.some((arg) => arg.includes("pwned")));
});

test("a successful run reports the conversation id from init and streams events", async () => {
  const events = [];
  let spawnedPid = null;
  const outcome = await runAgy(
    { task: "hi" },
    {
      spawnImpl: fakeSpawn("recovered-tool-error", { AGY_TEST_CONVERSATION_ID: "conv-42" }),
      onEvent: (event) => events.push(event.event),
      onSpawn: (pid) => { spawnedPid = pid; }
    }
  );
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.conversationId, "conv-42");
  assert.equal(outcome.partial, "The analysis.");
  assert.equal(events[0], "init");
  assert.equal(events.at(-1), "result");
  assert.ok(events.includes("future_progress"));
  assert.ok(Number.isInteger(spawnedPid));
});

const FAILURES = [
  ["denied", /denied 1 requested action/],
  ["empty", /empty response/],
  ["whitespace", /empty response/],
  ["failed-result", /status ERROR: model backend unavailable/],
  ["malformed-result", /malformed result/],
  ["nonzero", /exited with code 23[\s\S]*IneligibleTierError/],
  ["malformed", /malformed stream-json/],
  ["missing", /without a terminal result/],
  ["duplicate", /duplicate terminal results/],
  ["print-timeout", /print timeout before the turn finished/]
];

for (const [scenario, pattern] of FAILURES) {
  test(`scenario ${scenario} is reported as a failure`, async () => {
    const outcome = await runAgy({ task: "t" }, { spawnImpl: fakeSpawn(scenario) });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, pattern);
  });
}

test("denied actions are distinguishable for the exit-code contract", async () => {
  const outcome = await runAgy({ task: "t" }, { spawnImpl: fakeSpawn("denied") });
  assert.equal(isDeniedFailure(outcome.result), true);
  assert.equal(isDeniedFailure({ denied_actions: [] }), false);
});

test("resultFailure accepts a complete successful result", () => {
  assert.equal(resultFailure({ status: "SUCCESS", response: "ok\n", conversation_id: "c" }), null);
});

test("the watchdog stops a run that outlives its timeout", async () => {
  const started = Date.now();
  const outcome = await runAgy({ task: "t", timeoutSeconds: 0.3 }, { spawnImpl: fakeSpawn("hang") });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /timed out after 0.3 seconds/);
  assert.ok(Date.now() - started < 5000);
});

test("an abort signal cancels a running turn", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const outcome = await runAgy({ task: "t" }, { spawnImpl: fakeSpawn("hang"), signal: controller.signal });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /cancelled/);
});

test("cancellation kills a grandchild that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  let grandchild = null;
  const run = runAgy(
    { task: "t" },
    {
      spawnImpl: fakeSpawn("delegated-child"),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.event === "delegated_child") {
          grandchild = event.pid;
          controller.abort();
        }
      }
    }
  );
  const outcome = await run;
  assert.equal(outcome.ok, false);
  assert.ok(grandchild, "fake agy reported its child");
  await waitFor(() => !isAlive(grandchild), { timeoutMs: 5000 });
});

test("a missing executable gives the install hint", async () => {
  const outcome = await runAgy(
    { task: "t" },
    { spawnImpl: (command, args, options) => spawn("definitely-not-agy-binary-xyz", args, options) }
  );
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error.includes(AGY_INSTALL_HINT));
});
