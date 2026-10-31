#!/usr/bin/env node

// Measures the bytes Claude reads per call besides the answer itself (start
// line, footer, labels), using the fake agy so only plugin overhead counts.
// `--check <bytes>` exits 1 when a task call exceeds the budget.

import process from "node:process";

import { makeFakeAgyWorkspace, runCompanion } from "../tests/helpers.mjs";

const ANSWER = "The analysis.\n";

export function measure() {
  const ws = makeFakeAgyWorkspace();
  const call = (args, scenario) => {
    const result = runCompanion(args, { cwd: ws.repo, env: ws.env, scenario });
    if (![0, 10].includes(result.status)) {
      throw new Error(`${args.join(" ")} exited ${result.status}: ${result.stderr}`);
    }
    return Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  };
  const task = call(["task", "--", "explain app.js"], "recovered-tool-error") - Buffer.byteLength(ANSWER);
  const reply = call(["reply", "--", "go on"], "recovered-tool-error") - Buffer.byteLength(ANSWER);
  return { task, reply };
}

function main() {
  const checkIndex = process.argv.indexOf("--check");
  const budget = checkIndex === -1 ? null : Number(process.argv[checkIndex + 1]);
  const bytes = measure();
  process.stdout.write(`Per-call overhead excluding the answer: task ${bytes.task} B, reply ${bytes.reply} B\n`);
  if (budget != null && (bytes.task > budget || bytes.reply > budget)) {
    process.stderr.write(`Over the ${budget} B budget.\n`);
    process.exitCode = 1;
  }
}

main();
