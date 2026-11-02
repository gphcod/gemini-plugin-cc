import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");
export const COMPANION = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
export const FAKE_AGY = path.join(ROOT, "tests", "fixtures", "fake-agy.mjs");

// A read-only agy launch: deny-all settings plus the sandbox.
export function isReadOnlyLaunch(args) {
  const index = args.indexOf("--settings");
  if (index === -1 || !args.includes("--sandbox")) return false;
  const deny = JSON.parse(args[index + 1]).permissions?.deny ?? [];
  return ["write_file(*)", "edit_file(*)", "command(*)", "mcp(*)"].every((rule) => deny.includes(rule));
}

export function makeTempDir(prefix = "gemini-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: false,
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Gemini Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// A repository with one commit and one uncommitted change, plus a bin dir
// whose `agy` runs the fake Antigravity CLI.
export function makeFakeAgyWorkspace({ withAgy = true, slowGitSeconds = 0 } = {}) {
  const root = makeTempDir();
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const data = path.join(root, "data");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.mkdirSync(data);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");
  if (withAgy) {
    writeExecutable(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  }
  if (slowGitSeconds > 0) {
    // Slows the diff collection a review does before it launches agy.
    const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeExecutable(
      path.join(bin, "git"),
      `#!/bin/sh\ncase " $* " in *" --binary "*) sleep ${slowGitSeconds};; esac\nexec "${realGit}" "$@"\n`
    );
  }
  const argvLog = path.join(root, "agy-argv.log");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${withAgy ? process.env.PATH : "/usr/bin:/bin"}`,
    CLAUDE_PLUGIN_DATA: data,
    AGY_TEST_ARGV_LOG: argvLog
  };
  delete env.AGY_TEST_SCENARIO;
  // Windows cannot run the sh stand-in, and PATH would find the real agy.exe.
  if (process.platform === "win32") env.GEMINI_AGY_BIN = withAgy ? FAKE_AGY : path.join(bin, "no-agy.exe");
  return { root, repo, bin, data, env, argvLog };
}

export function readArgvLog(argvLog) {
  if (!fs.existsSync(argvLog)) return [];
  return fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function runCompanion(args, { cwd, env, input, scenario } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    env: scenario ? { ...env, AGY_TEST_SCENARIO: scenario } : env,
    encoding: "utf8",
    input: input ?? "",
    timeout: 30000
  });
}

export function spawnCompanion(args, { cwd, env, scenario } = {}) {
  return spawn(process.execPath, [COMPANION, ...args], {
    cwd,
    env: scenario ? { ...env, AGY_TEST_SCENARIO: scenario } : env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms.`);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
