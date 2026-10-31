// Stand-in for the Antigravity CLI used by the offline test suite.
// Event shapes mirror agy 1.4.12 stream-json output.
import process from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";

const scenario = process.env.AGY_TEST_SCENARIO ?? "echo";
const CONVERSATION_ID = process.env.AGY_TEST_CONVERSATION_ID ?? "conversation-opaque";

if (process.argv[2] === "--version") {
  process.stdout.write("1.4.12\n");
  process.exit(0);
}
if (process.argv[2] === "models") {
  if (scenario === "signed-out") {
    process.stderr.write("Not signed in. Run agy to sign in.\n");
    process.exit(1);
  }
  process.stdout.write("Fetching available models...\ngemini-test-model\tGemini Test Model\n");
  process.exit(0);
}
if (process.env.AGY_TEST_ARGV_LOG) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.AGY_TEST_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const usage = { input_tokens: 3, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 8 };
const result = {
  conversation_id: CONVERSATION_ID,
  status: "SUCCESS",
  response: "The analysis.\n",
  duration_seconds: 0.01,
  num_turns: 1,
  usage
};

emit({ event: "init", conversation_id: CONVERSATION_ID, init: { cwd: process.cwd(), tools: ["view_file"], permission_mode: "always-proceed" } });
emit({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "The analysis." } });
emit({ event: "future_progress", detail: "preserve me" });

if (scenario === "echo") {
  result.response = JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, eof: true });
} else if (scenario === "denied") {
  result.denied_actions = [{ tool: "run_command", command: "npm test", reason: "Permission denied" }];
} else if (scenario === "empty") {
  result.response = "";
} else if (scenario === "whitespace") {
  result.response = " \n\t";
} else if (scenario === "failed-result") {
  result.status = "ERROR";
  result.error = "model backend unavailable";
} else if (scenario === "malformed-result") {
  result.response = null;
} else if (scenario === "recovered-tool-error") {
  emit({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 2, state: "ERROR", step_type: "tool", error: "Transient read failure; retried" } });
} else if (scenario === "review") {
  result.structured_output = {
    verdict: "needs-attention",
    summary: "One material finding.",
    findings: [{
      severity: "high",
      title: "Example finding",
      body: "The code path can fail.",
      file: "src/example.mjs",
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      recommendation: "Guard the call."
    }],
    next_steps: ["Fix the guard."]
  };
  result.response = `${JSON.stringify(result.structured_output)}\n`;
} else if (scenario === "review-clean") {
  result.structured_output = { verdict: "approve", summary: "Safe to ship.", findings: [], next_steps: [] };
  result.response = `${JSON.stringify(result.structured_output)}\n`;
} else if (scenario === "gate-allow") {
  result.response = "ALLOW: the previous turn made no code changes.\n";
} else if (scenario === "gate-block") {
  result.response = "BLOCK: the new parser drops the last line.\nDetails follow.\n";
} else if (scenario === "print-timeout") {
  process.stderr.write("[agy] print timeout after 2s with turn in progress; returning partial output\n");
  result.response = "";
  result.finished_reason = "print_timeout";
} else if (scenario === "tool-step") {
  emit({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: { Path: "made.txt" } } } });
  emit({ event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_file", duration_seconds: 0.01, tool_info: { name: "write_file", parameters: { Path: "made.txt" } } } });
} else if (scenario === "nonzero") {
  process.stderr.write("IneligibleTierError: client no longer supported\n");
  process.exitCode = 23;
} else if (scenario === "hang") {
  await new Promise(() => setInterval(() => {}, 60_000));
} else if (scenario === "delegated-child") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 60000);"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  const [pid] = await once(child, "message");
  if (process.env.AGY_TEST_CHILD_PID_FILE) {
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.AGY_TEST_CHILD_PID_FILE, String(pid));
  }
  emit({ event: "delegated_child", pid });
  await new Promise(() => setInterval(() => {}, 60_000));
} else if (scenario === "malformed") {
  process.stdout.write("not JSON\n");
} else if (scenario === "slow") {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.AGY_TEST_SLOW_MS ?? 400)));
}

if (scenario !== "missing") {
  const record = `${JSON.stringify({ event: "result", result })}\n`;
  const splitAt = Math.floor(record.length / 2);
  process.stdout.write(record.slice(0, splitAt));
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stdout.write(record.slice(splitAt));
  if (scenario === "duplicate") emit({ event: "result", result });
}
