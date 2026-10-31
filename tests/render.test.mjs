import test from "node:test";
import assert from "node:assert/strict";

import {
  capAnswer,
  formatDuration,
  renderCancelReport,
  renderFooter,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  shorten,
  validateReviewResultShape
} from "../plugins/gemini/scripts/lib/render.mjs";
import { extractFirstJsonObject, parseStructuredOutput } from "../plugins/gemini/scripts/lib/review-output.mjs";

const META = { reviewLabel: "Review", targetLabel: "working tree diff" };

test("renderReviewResult orders findings by severity", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Two issues.",
        findings: [
          { severity: "low", title: "Minor", body: "b", file: "a.js", line_start: 1, line_end: 1, recommendation: "" },
          { severity: "critical", title: "Major", body: "b", file: "b.js", line_start: 3, line_end: 5, recommendation: "Fix." }
        ],
        next_steps: ["Fix major."]
      },
      rawOutput: "",
      parseError: null
    },
    META
  );
  assert.ok(output.indexOf("[critical] Major (b.js:3-5)") < output.indexOf("[low] Minor (a.js:1)"));
  assert.match(output, /^Review \(working tree diff\)\nVerdict: needs-attention/);
  assert.match(output, /Recommendation: Fix\./);
  assert.match(output, /Next steps:\n- Fix major\./);
});

test("missing finding fields get readable defaults", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "needs-attention", summary: "s", findings: [{}, null], next_steps: ["", "  "] }, rawOutput: "", parseError: null },
    META
  );
  assert.match(output, /- \[low\] Finding 1 \(unknown\)\n  No details provided\./);
  assert.match(output, /- \[low\] Finding 2 \(unknown\)/);
  assert.doesNotMatch(output, /Next steps/);
});

test("a clean review says so", () => {
  const output = renderReviewResult({ parsed: { verdict: "approve", summary: "Fine.", findings: [], next_steps: [] }, rawOutput: "", parseError: null }, META);
  assert.match(output, /No material findings\./);
});

test("renderReviewResult degrades gracefully on a wrong shape or missing JSON", () => {
  const wrongShape = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Looks fine." }, rawOutput: '{"verdict":"approve"}', parseError: null },
    META
  );
  assert.match(wrongShape, /unexpected review shape/);
  assert.match(wrongShape, /Missing array `findings`/);
  assert.match(wrongShape, /Raw final message:/);
  const noJson = renderReviewResult({ parsed: null, rawOutput: "prose only", parseError: "No structured review JSON found in the output." }, META);
  assert.match(noJson, /did not return valid structured JSON/);
  assert.match(noJson, /prose only/);
});

test("the shape check names the first missing field", () => {
  assert.equal(validateReviewResultShape(null), "Expected a top-level JSON object.");
  assert.equal(validateReviewResultShape({ summary: "s", findings: [], next_steps: [] }), "Missing string `verdict`.");
  assert.equal(validateReviewResultShape({ verdict: "approve", findings: [], next_steps: [] }), "Missing string `summary`.");
  assert.equal(validateReviewResultShape({ verdict: "approve", summary: "s", findings: [] }), "Missing array `next_steps`.");
  assert.equal(validateReviewResultShape({ verdict: "approve", summary: "s", findings: [], next_steps: [] }), null);
});

test("parseStructuredOutput prefers agy's validated structured_output", () => {
  const parsed = parseStructuredOutput({ response: "prose {\"verdict\":\"wrong\"}", structured_output: { verdict: "approve" } });
  assert.deepEqual(parsed.parsed, { verdict: "approve" });
  const scanned = parseStructuredOutput({ response: 'text {"verdict":"approve"} more' });
  assert.deepEqual(scanned.parsed, { verdict: "approve" });
  const partial = parseStructuredOutput({ response: "" }, { partial: '{"verdict":"x"}' });
  assert.deepEqual(partial.parsed, { verdict: "x" });
  const failed = parseStructuredOutput(null, { failureMessage: "agy timed out" });
  assert.equal(failed.parsed, null);
  assert.match(failed.parseError, /agy timed out/);
});

test("the JSON scanner skips braces inside strings and code fences inside values", () => {
  const text = 'Preamble {not json} then {"summary":"uses ``` and } inside","findings":[]} trailing';
  assert.deepEqual(extractFirstJsonObject(text), { summary: "uses ``` and } inside", findings: [] });
  assert.deepEqual(extractFirstJsonObject('{"a":"quote \\" inside"}'), { a: 'quote " inside' });
  assert.equal(extractFirstJsonObject("no json here"), null);
  assert.equal(extractFirstJsonObject(undefined), null);
});

test("capAnswer keeps short text and cuts at 24 KiB on a character boundary", () => {
  assert.deepEqual(capAnswer("short"), { text: "short", truncated: false });
  const capped = capAnswer("z".repeat(30 * 1024));
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text) < 25 * 1024);
  assert.match(capped.text, /truncated; full text in the answer file/);
});

test("shorten and formatDuration produce compact labels", () => {
  assert.equal(shorten("  a \n  b  "), "a b");
  assert.equal(shorten("x".repeat(20), 10), "xxxxxxx...");
  assert.equal(shorten(null), "");
  assert.deepEqual([formatDuration(0), formatDuration(59.4), formatDuration(65), formatDuration(3725)], ["0s", "59s", "1m 5s", "1h 2m"]);
  assert.equal(formatDuration(-1), null);
  assert.equal(formatDuration(Number.NaN), null);
});

test("the footer stays compact and names the file only when given", () => {
  assert.equal(renderFooter({ status: "ok", handle: "k3f9", duration: "41s" }), "gemini ok · job k3f9 · 41s");
  assert.equal(renderFooter({ status: "ok", handle: "k3f9", answerFile: "/f.txt" }), "gemini ok · job k3f9 · full: /f.txt");
  assert.equal(renderFooter({ status: "failed", handle: "k3f9", hint: "log: /x.log" }), "gemini failed · job k3f9 · log: /x.log");
});

test("the setup report lists checks, actions, next steps and the measured agy context", () => {
  const report = {
    ready: true,
    node: { detail: "v22.19.0" },
    agy: { available: true, detail: "1.4.12" },
    auth: { detail: "signed in" },
    reviewGateEnabled: false,
    baseline: { ok: true, inputTokens: 7676, toolCount: 61 },
    actionsTaken: ["Enabled the stop-time review gate."],
    nextSteps: ["Run it."]
  };
  const output = renderSetupReport(report);
  assert.match(output, /^Gemini setup: ready\n- node: v22\.19\.0\n- agy: 1\.4\.12/);
  assert.match(output, /agy context per call: 7676 input tokens and 61 tools offered/);
  assert.match(output, /Actions taken:\n- Enabled/);
  assert.match(output, /Next steps:\n- Run it\./);
  const notInstalled = renderSetupReport({ ...report, ready: false, agy: { available: false }, baseline: null, actionsTaken: [], nextSteps: [] });
  assert.match(notInstalled, /needs attention[\s\S]*- agy: not installed/);
  assert.doesNotMatch(notInstalled, /agy context/);
});

test("the status table escapes cells and flags stalled jobs", () => {
  const output = renderStatusReport({
    config: { stopReviewGate: true },
    running: [
      { handle: "aaaa", kindLabel: "task", status: "running", displayStatus: "running", elapsed: "5s", summary: "a | b\nc", stalled: false },
      { handle: "bbbb", kindLabel: "review", status: "running", displayStatus: "stalled", elapsed: "2m 0s", summary: "x", stalled: true }
    ],
    latestFinished: { handle: "cccc", kindLabel: "review", status: "completed", duration: "41s", summary: "done" },
    recent: []
  });
  assert.match(output, /^Gemini status \(review gate enabled\)/);
  assert.match(output, /\| aaaa \| task \| running \| 5s \| a \\\| b c \|/);
  assert.match(output, /Active: aaaa/);
  assert.match(output, /Stalled \(process gone\): bbbb/);
  assert.equal(renderStatusReport({ config: {}, running: [], latestFinished: null, recent: [] }), "Gemini status (review gate disabled)\nNo jobs recorded yet.\n");
});

test("a single job report shows next actions for running and finished jobs", () => {
  const running = renderJobStatusReport({ handle: "aaaa", title: "Gemini Task", summary: "s", status: "running", displayStatus: "running", phase: "working", elapsed: "3s", progressPreview: ["tool: read_file a.js"] });
  assert.match(running, /^Job aaaa: running \(working\)/);
  assert.match(running, /Cancel: \/gemini:cancel aaaa/);
  assert.match(running, /Recent progress:\n  - tool: read_file a\.js/);
  const failed = renderJobStatusReport({ handle: "bbbb", status: "failed", displayStatus: "failed", phase: "failed", duration: "1s", errorMessage: "boom", logFile: "/x.log", conversationId: "c-1" });
  assert.match(failed, /Error: boom/);
  assert.match(failed, /Log: \/x\.log/);
  assert.match(failed, /Conversation: c-1/);
  assert.match(failed, /Result: \/gemini:result bbbb/);
});

test("renderStoredJobResult replays the stored rendering once", () => {
  const rendered = "Answer.\ngemini ok · job k3f9 · 2s\n";
  assert.equal(renderStoredJobResult({ id: "task-1", status: "completed" }, { rendered }), rendered);
  assert.equal(renderStoredJobResult({ id: "task-1", status: "completed" }, { rendered: "no newline" }), "no newline\n");
  const fallback = renderStoredJobResult({ id: "task-1", handle: "k3f9", status: "failed", errorMessage: "boom" }, null);
  assert.match(fallback, /^Job k3f9: failed/);
  assert.match(fallback, /boom/);
  assert.match(renderStoredJobResult({ id: "t", status: "cancelled" }, {}), /No captured result payload/);
});

test("the cancel report says whether a process was signalled", () => {
  assert.equal(renderCancelReport({ handle: "aaaa", title: "Gemini Task" }), "Cancelled aaaa (Gemini Task).\n");
  assert.match(renderCancelReport({ id: "x" }, { interrupted: true }), /process tree was signalled/);
});
