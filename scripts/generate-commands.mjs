#!/usr/bin/env node

// Generates plugins/gemini/commands/*.md from one template so the slash
// commands stay small and consistent. `--check` exits 1 when a committed
// command file differs from what this script would write.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS_DIR = path.join(ROOT, "plugins", "gemini", "commands");
const COMPANION = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs"';

function bashBlock(subcommand) {
  return [
    "```bash", `${COMPANION} ${subcommand} "$ARGUMENTS"`, "```", "",
    "No Bash tool: write the arguments verbatim to a new UTF-8 file outside the repo, never into the command, then in PowerShell:", "",
    "```powershell", `${COMPANION} ${subcommand} "--args-file=<file>"; exit $LASTEXITCODE`, "```"
  ].join("\n");
}

function inline(subcommand) {
  return `!\`${COMPANION} ${subcommand} "$ARGUMENTS"\``;
}

const RUN_MODE =
  "Use Bash with `run_in_background: true` and end the turn (the completion notification brings the output), unless `$ARGUMENTS` has `--wait`: then run in the foreground with `timeout: 600000`.";

function reviewBody(subcommand, framing) {
  return [
    framing,
    "Review only: do not edit files or start fixing anything.",
    "",
    RUN_MODE,
    "",
    bashBlock(subcommand),
    "",
    "When the output arrives: give the verdict, list every finding by severity with exact file:line, then ask which findings to fix. Exit 10 means findings, not failure. Do not repeat the output verbatim."
  ].join("\n");
}

export const COMMANDS = [
  {
    name: "setup",
    description: "Check that the Antigravity CLI (agy) is installed and signed in, and toggle the stop-time review gate",
    argumentHint: "[--verify] [--enable-review-gate|--disable-review-gate]",
    userOnly: true,
    allowedTools: "Bash(node:*), PowerShell(node:*), Write",
    body: [
      "Run once with Bash:",
      "",
      bashBlock("setup"),
      "",
      "Report the result. Exit 1 means not ready: give the next step it names. Sign-in is interactive, so the user runs `agy` once in their own terminal, not through `!`."
    ].join("\n")
  },
  {
    name: "review",
    description: "Run a Gemini code review of local git changes (working tree or branch diff)",
    argumentHint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]",
    userOnly: false,
    allowedTools: "Bash(node:*), PowerShell(node:*), Write",
    body: reviewBody("review", "Run a Gemini code review focused on correctness and regression risk.")
  },
  {
    name: "adversarial-review",
    description: "Run a Gemini review that challenges the implementation approach and design choices",
    argumentHint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]",
    userOnly: false,
    allowedTools: "Bash(node:*), PowerShell(node:*), Write",
    body: reviewBody(
      "adversarial-review",
      "Run an adversarial Gemini review that questions the design, its assumptions, and how it fails under real conditions."
    )
  },
  {
    name: "rescue",
    description: "Delegate an investigation, a question, or a fix to Gemini",
    argumentHint: "[--wait|--background] [--resume] [--plan] [--model <m>] [--effort <e>] <task>",
    userOnly: true,
    allowedTools: "Bash(node:*), PowerShell(node:*), Write",
    body: [
      "Forward the request to Gemini in one Bash call. If `$ARGUMENTS` has no task text, ask what Gemini should do instead.",
      "`--resume` continues the last Gemini conversation; `--plan` keeps the run read-only.",
      "",
      "Use Bash with `run_in_background: true` and end the turn, unless `$ARGUMENTS` has `--wait` or the task is a quick question: then run in the foreground with `timeout: 600000`.",
      "",
      bashBlock("task"),
      "",
      "Then summarize Gemini's answer (do not repeat it verbatim) and name any files it changed. On failure, report the error and stop."
    ].join("\n")
  },
  {
    name: "status",
    description: "Show active and recent Gemini jobs for this repository",
    argumentHint: "[job] [--all]",
    userOnly: true,
    allowedTools: "Bash(node:*), PowerShell(node:*)",
    body: [inline("status"), "", "Show the status above to the user unchanged."].join("\n")
  },
  {
    name: "result",
    description: "Show the stored output of a finished Gemini job",
    argumentHint: "[job]",
    userOnly: true,
    allowedTools: "Bash(node:*), PowerShell(node:*)",
    body: [
      inline("result"),
      "",
      "Present the result above. For a review, list every finding with exact file:line. For a long answer, summarize and point to the `full:` file."
    ].join("\n")
  },
  {
    name: "cancel",
    description: "Cancel an active Gemini job in this repository",
    argumentHint: "[job]",
    userOnly: true,
    allowedTools: "Bash(node:*), PowerShell(node:*)",
    body: [inline("cancel"), "", "Report the line above."].join("\n")
  }
];

export function renderCommand(command) {
  const frontmatter = [
    "---",
    `description: ${command.description}`,
    `argument-hint: '${command.argumentHint}'`,
    ...(command.userOnly ? ["disable-model-invocation: true"] : []),
    `allowed-tools: ${command.allowedTools}`,
    "---"
  ];
  return `${frontmatter.join("\n")}\n\n${command.body.trimEnd()}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const expected = new Map(COMMANDS.map((command) => [`${command.name}.md`, renderCommand(command)]));
  const drift = [];

  const existing = fs.existsSync(COMMANDS_DIR) ? fs.readdirSync(COMMANDS_DIR).filter((file) => file.endsWith(".md")) : [];
  for (const file of existing) {
    if (!expected.has(file)) {
      drift.push(`${file} is not generated by scripts/generate-commands.mjs`);
      if (!check) fs.unlinkSync(path.join(COMMANDS_DIR, file));
    }
  }

  for (const [file, content] of expected) {
    const target = path.join(COMMANDS_DIR, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === content) continue;
    drift.push(`${file} differs from its template`);
    if (!check) {
      fs.mkdirSync(COMMANDS_DIR, { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
  }

  if (check) {
    if (drift.length > 0) {
      process.stderr.write(`Command files are out of date (run npm run generate-commands):\n- ${drift.join("\n- ")}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stdout.write(drift.length ? `Updated:\n- ${drift.join("\n- ")}\n` : "Command files already up to date.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
