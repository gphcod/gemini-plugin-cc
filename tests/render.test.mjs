import test from "node:test";
import assert from "node:assert/strict";

import {
  capAnswer,
  renderFooter,
  renderReviewResult,
  renderStoredJobResult
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
});

test("renderReviewResult degrades gracefully on a wrong shape", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Looks fine." }, rawOutput: '{"verdict":"approve"}', parseError: null },
    META
  );
  assert.match(output, /unexpected review shape/);
  assert.match(output, /Missing array `findings`/);
  assert.match(output, /Raw final message:/);
});

test("parseStructuredOutput prefers agy's validated structured_output", () => {
  const parsed = parseStructuredOutput({ response: "prose {\"verdict\":\"wrong\"}", structured_output: { verdict: "approve" } });
  assert.deepEqual(parsed.parsed, { verdict: "approve" });
});

test("the JSON scanner skips braces inside strings and code fences inside values", () => {
  const text = 'Preamble {not json} then {"summary":"uses ``` and } inside","findings":[]} trailing';
  assert.deepEqual(extractFirstJsonObject(text), { summary: "uses ``` and } inside", findings: [] });
  assert.equal(extractFirstJsonObject("no json here"), null);
});

test("capAnswer keeps short text and cuts at 24 KiB", () => {
  assert.deepEqual(capAnswer("short"), { text: "short", truncated: false });
  const capped = capAnswer("z".repeat(30 * 1024));
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text) < 25 * 1024);
});

test("the footer stays compact and names the file only when given", () => {
  assert.equal(renderFooter({ status: "ok", handle: "k3f9", duration: "41s" }), "gemini ok · job k3f9 · 41s");
  assert.equal(renderFooter({ status: "ok", handle: "k3f9", answerFile: "/f.txt" }), "gemini ok · job k3f9 · full: /f.txt");
});

test("renderStoredJobResult replays the stored rendering once", () => {
  const rendered = "Answer.\ngemini ok · job k3f9 · 2s\n";
  assert.equal(renderStoredJobResult({ id: "task-1", status: "completed" }, { rendered }), rendered);
  const fallback = renderStoredJobResult({ id: "task-1", handle: "k3f9", status: "failed", errorMessage: "boom" }, null);
  assert.match(fallback, /^Job k3f9: failed/);
  assert.match(fallback, /boom/);
});
