#!/usr/bin/env node
// Runs the live agy contract tests. npm runs scripts through cmd.exe on Windows, which has no `NAME=value command` form.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", path.join("tests", "agy-contract.live.test.mjs")], {
  cwd: root, stdio: "inherit", env: { ...process.env, AGY_E2E: "1" }
});
process.exitCode = result.status ?? 1;
