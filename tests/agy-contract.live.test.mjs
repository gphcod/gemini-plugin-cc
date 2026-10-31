// Live contract between the companion and the real Antigravity CLI. Skipped
// unless AGY_E2E=1; each case makes a small paid model call. Run before every
// release and after every agy upgrade: `AGY_E2E=1 npm run test:live`.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { COMPANION, initGitRepo, isAlive, makeTempDir, run, waitFor } from "./helpers.mjs";
import { runAgy } from "../plugins/gemini/scripts/lib/agy.mjs";

const LIVE = process.env.AGY_E2E === "1";
const options = { skip: LIVE ? false : "set AGY_E2E=1 to run against the real agy", timeout: 240000 };

function workspace() {
  const dir = makeTempDir("agy-contract-");
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, "app.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  run("git", ["add", "app.js"], { cwd: dir });
  run("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("setup probes: agy --version and agy models exit 0", options, () => {
  const version = spawnSync("agy", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  const models = spawnSync("agy", ["models"], { encoding: "utf8", timeout: 60000 });
  assert.equal(models.status, 0, models.stderr);
  assert.ok(models.stdout.split("\n").some((line) => /\S\t\S/.test(line)), "models are tab-separated id/name lines");
});

test("an unknown flag makes agy exit non-zero", options, () => {
  const result = spawnSync("agy", ["--input-format", "stream-json", "--output-format", "stream-json", "--no-such-flag"], {
    input: "",
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
});

test("a plan turn: init first, terminal result with matching conversation id, resumable", options, async () => {
  const cwd = workspace();
  const events = [];
  const first = await runAgy(
    { task: "Remember the code word PLUM-7731. Reply with exactly: noted", cwd, mode: "plan", timeoutSeconds: 120 },
    { onEvent: (event) => events.push(event) }
  );
  assert.equal(first.ok, true, `${first.error} / response: ${JSON.stringify(first.result?.response)}`);
  assert.equal(first.exitCode, 0);
  assert.equal(events[0].event, "init", `events: ${events.map((event) => event.event).join(",")}`);
  assert.equal(typeof events[0].conversation_id, "string");
  assert.equal(events.at(-1).event, "result");
  assert.equal(first.result.status, "SUCCESS");
  assert.equal(first.result.conversation_id, events[0].conversation_id);
  assert.equal(first.conversationId, events[0].conversation_id);
  assert.ok(events.some((event) => event.event === "step_update" && event.step_update.step_type === "agent_response"));

  const second = await runAgy(
    { task: "What was the code word? Reply with only the word.", cwd, mode: "plan", conversation: first.conversationId, timeoutSeconds: 120 },
    {}
  );
  assert.equal(second.ok, true, second.error);
  assert.equal(second.conversationId, first.conversationId);
  assert.match(second.result.response, /PLUM-7731/, `resumed turn answered: ${JSON.stringify(second.result.response)}`);
});

test("plan mode is read-only; write mode with the sandbox can edit", options, async () => {
  const cwd = workspace();
  await runAgy({ task: "Create a file named plan-probe.txt containing hello.", cwd, mode: "plan", timeoutSeconds: 120 }, {});
  assert.equal(fs.existsSync(path.join(cwd, "plan-probe.txt")), false, "plan mode must not write to the workspace");

  const write = await runAgy(
    { task: "Create a file named write-probe.txt containing the single word hello, then reply with exactly: done", cwd, sandbox: true, timeoutSeconds: 180 },
    {}
  );
  assert.equal(write.ok, true, write.error);
  assert.equal(fs.readFileSync(path.join(cwd, "write-probe.txt"), "utf8").trim(), "hello");
});

test("review through the companion returns schema-validated JSON from --json-schema", options, () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, "app.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  const result = spawnSync(process.execPath, [COMPANION, "review", "--json", "--timeout", "200"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir("agy-contract-data-") },
    encoding: "utf8",
    timeout: 230000
  });
  assert.ok([0, 10].includes(result.status), `exit ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true, payload.error ?? payload.parseError);
  assert.ok(["approve", "needs-attention"].includes(payload.result.verdict));
  assert.ok(Array.isArray(payload.result.findings) && Array.isArray(payload.result.next_steps));
  assert.equal(result.status, payload.result.findings.length > 0 || payload.result.verdict === "needs-attention" ? 10 : 0);
  assert.equal(fs.readFileSync(path.join(cwd, "app.js"), "utf8").includes("a - b"), true, "review must not edit");
});

test("a turn cut by the timeout is reported as incomplete", options, async () => {
  const cwd = workspace();
  const outcome = await runAgy(
    { task: "Write a 4000-word essay on the history of compilers.", cwd, mode: "plan", timeoutSeconds: 3 },
    {}
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /time/i);
});

test("aborting a running turn ends agy's whole process group", { ...options, skip: options.skip || process.platform === "win32" }, async () => {
  const cwd = workspace();
  const controller = new AbortController();
  let pid = null;
  const run = runAgy(
    { task: "Write a 4000-word essay on the history of compilers.", cwd, mode: "plan", timeoutSeconds: 120 },
    {
      signal: controller.signal,
      onSpawn: (spawned) => { pid = spawned; },
      onEvent: (event) => { if (event.event === "init") setTimeout(() => controller.abort(), 1000); }
    }
  );
  const outcome = await run;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /cancelled/);
  await waitFor(() => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return !isAlive(pid);
    }
  }, { timeoutMs: 5000 });
});
