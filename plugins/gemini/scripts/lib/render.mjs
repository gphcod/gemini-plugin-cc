const ANSWER_CAP_BYTES = 24 * 1024;

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

// Caps the text shown on stdout; the full text always lives in the answer file.
export function capAnswer(text) {
  const normalized = String(text ?? "");
  if (Buffer.byteLength(normalized, "utf8") <= ANSWER_CAP_BYTES) {
    return { text: normalized, truncated: false };
  }
  const buffer = Buffer.from(normalized, "utf8").subarray(0, ANSWER_CAP_BYTES);
  return { text: `${buffer.toString("utf8")}\n… (truncated; full text in the answer file)`, truncated: true };
}

// One compact footer per call: status, handle, duration, and the answer file
// only when stdout was truncated.
export function renderFooter({ status = "ok", handle, duration, answerFile, hint }) {
  const parts = [`gemini ${status}`];
  if (handle) parts.push(`job ${handle}`);
  if (duration) parts.push(duration);
  if (answerFile) parts.push(`full: ${answerFile}`);
  if (hint) parts.push(hint);
  return parts.join(" · ");
}

export function renderSetupReport(report) {
  const lines = [
    `Gemini setup: ${report.ready ? "ready" : "needs attention"}`,
    `- node: ${report.node.detail}`,
    `- agy: ${report.agy.available ? report.agy.detail : "not installed"}`,
    `- auth: ${report.auth.detail}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `${meta.reviewLabel} failed: Gemini did not return valid structured JSON.`,
      `- Parse error: ${parsedResult.parseError}`
    ];
    if (parsedResult.rawOutput) {
      const { text } = capAnswer(parsedResult.rawOutput);
      lines.push("", "Raw final message:", "", "```text", text, "```");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `${meta.reviewLabel} failed: Gemini returned JSON with an unexpected review shape.`,
      `- Validation error: ${validationError}`
    ];
    if (parsedResult.rawOutput) {
      const { text } = capAnswer(parsedResult.rawOutput);
      lines.push("", "Raw final message:", "", "```text", text, "```");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = parsedResult.parsed;
  const findings = data.findings
    .map((finding, index) => normalizeReviewFinding(finding, index))
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `${meta.reviewLabel} (${meta.targetLabel})`,
    `Verdict: ${data.verdict.trim()}`,
    "",
    data.summary.trim(),
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  const nextSteps = data.next_steps.filter((step) => typeof step === "string" && step.trim());
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of nextSteps) {
      lines.push(`- ${step.trim()}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatJobRow(job) {
  return `| ${job.handle ?? job.id} | ${job.kindLabel} | ${job.displayStatus ?? job.status} | ${job.elapsed ?? job.duration ?? ""} | ${escapeMarkdownCell(job.summary ?? "")} |`;
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function renderStatusReport(report) {
  const lines = [`Gemini status (review gate ${report.config.stopReviewGate ? "enabled" : "disabled"})`];

  const rows = [...report.running, ...(report.latestFinished ? [report.latestFinished] : []), ...report.recent];
  if (rows.length === 0) {
    lines.push("No jobs recorded yet.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("", "| Job | Kind | Status | Time | Summary |", "| --- | --- | --- | --- | --- |");
  for (const job of rows) {
    lines.push(formatJobRow(job));
  }

  const active = report.running.filter((job) => !job.stalled);
  if (active.length > 0) {
    lines.push("", `Active: ${active.map((job) => job.handle ?? job.id).join(", ")} — result replays with /gemini:result <job> once finished; cancel with /gemini:cancel <job>.`);
  }
  const stalled = report.running.filter((job) => job.stalled);
  if (stalled.length > 0) {
    lines.push("", `Stalled (process gone): ${stalled.map((job) => job.handle ?? job.id).join(", ")} — cancel to clear, then retry.`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [
    `Job ${job.handle ?? job.id}: ${job.displayStatus ?? job.status}${job.phase && job.phase !== job.status ? ` (${job.phase})` : ""}`
  ];
  if (job.title) lines.push(`- ${job.title}${job.summary ? ` — ${escapeMarkdownCell(job.summary)}` : ""}`);
  if (job.elapsed && (job.status === "queued" || job.status === "running")) lines.push(`- Elapsed: ${job.elapsed}`);
  if (job.duration && job.status !== "queued" && job.status !== "running") lines.push(`- Duration: ${job.duration}`);
  if (job.conversationId) lines.push(`- Conversation: ${job.conversationId}`);
  if (job.errorMessage) lines.push(`- Error: ${job.errorMessage}`);
  if (job.logFile && (job.status === "failed" || job.stalled)) lines.push(`- Log: ${job.logFile}`);
  if (job.status === "queued" || job.status === "running") {
    lines.push(`- Cancel: /gemini:cancel ${job.handle ?? job.id}`);
  } else {
    lines.push(`- Result: /gemini:result ${job.handle ?? job.id}`);
  }
  if (job.progressPreview?.length) {
    lines.push("- Recent progress:");
    for (const line of job.progressPreview) {
      lines.push(`  - ${line}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// The stored rendering already ends with the run's footer.
export function renderStoredJobResult(job, storedJob) {
  const rendered = storedJob?.rendered;
  if (typeof rendered === "string" && rendered.trim()) {
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }

  const lines = [
    `Job ${job.handle ?? job.id}: ${job.status}`
  ];
  if (job.summary) lines.push(`- ${escapeMarkdownCell(job.summary)}`);
  if (job.conversationId) lines.push(`- Conversation: ${job.conversationId}`);
  const errorMessage = job.errorMessage ?? storedJob?.errorMessage;
  if (errorMessage) {
    lines.push("", errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job, { interrupted = false } = {}) {
  const lines = [
    `Cancelled ${job.handle ?? job.id}${job.title ? ` (${job.title})` : ""}.`
  ];
  if (interrupted) {
    lines.push("The running agy process tree was signalled.");
  }
  return `${lines.join("\n")}\n`;
}
