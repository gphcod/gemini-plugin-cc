import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { isReadOnlyLaunch, makeFakeAgyWorkspace, PLUGIN_ROOT, readArgvLog, ROOT } from "./helpers.mjs";
import { COMMANDS, renderCommand } from "../scripts/generate-commands.mjs";

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

// The shell lines Claude is told to run, exactly as written in the files.
function bashBlocks(source) {
  return [...source.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1].trim());
}

function inlineCommand(source) {
  return source.match(/^!`(.+)`$/m)?.[1] ?? null;
}

// Git for Windows puts only git.exe on PATH outside Git Bash; its sh.exe sits at a fixed place below that.
function posixShell() {
  if (process.platform !== "win32") return "/bin/sh";
  const execPath = (spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout ?? "").trim();
  const bundled = path.resolve(execPath, "..", "..", "..", "bin", "sh.exe");
  return fs.existsSync(bundled) ? bundled : "sh.exe";
}

function runClaudeForm(line, ws, { args = "", scenario } = {}) {
  const command = line.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT).replaceAll("$ARGUMENTS", args);
  return spawnSync(posixShell(), ["-c", command], {
    cwd: ws.repo,
    env: { ...ws.env, ...(scenario ? { AGY_TEST_SCENARIO: scenario } : {}) },
    encoding: "utf8",
    timeout: 30000
  });
}

test("committed command files match the generator", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "generate-commands.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const command of COMMANDS) {
    assert.equal(read(`commands/${command.name}.md`), renderCommand(command));
  }
});

test("only reviews are model-invocable; the rest are user-only", () => {
  const files = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(files, ["adversarial-review.md", "cancel.md", "rescue.md", "result.md", "review.md", "setup.md", "status.md"]);
  for (const file of files) {
    const userOnly = /^disable-model-invocation: true$/m.test(read(`commands/${file}`));
    assert.equal(userOnly, !["review.md", "adversarial-review.md"].includes(file), file);
  }
});

test("model-visible surface stays within the token budget", () => {
  const skill = read("skills/gemini/SKILL.md");
  assert.ok(Buffer.byteLength(skill) <= 3000, `SKILL.md is ${Buffer.byteLength(skill)} B`);
  const description = skill.match(/^description: (.+)$/m)[1];
  assert.ok(Buffer.byteLength(description) <= 200, `description is ${Buffer.byteLength(description)} B`);
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, "commands"))) {
    assert.ok(Buffer.byteLength(read(`commands/${file}`)) <= 1200, `${file} exceeds 1200 B`);
  }
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN_ROOT, "skills")), ["gemini"]);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "agents")), false);
});

test("the version is the same in package.json, plugin.json and the marketplace", () => {
  const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
  const version = readJson("package.json").version;
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(readJson("plugins/gemini/.claude-plugin/plugin.json").version, version);
  assert.equal(marketplace.metadata.version, version);
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "gemini").version, version);
});

test("the only hook is the optional Stop review gate", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["Stop"]);
  assert.match(hooks.Stop[0].hooks[0].command, /stop-review-gate-hook\.mjs/);
});

test("review prompts name every field of the review schema", () => {
  const schema = JSON.parse(read("schemas/review-output.schema.json"));
  const fields = [...schema.required, ...schema.properties.findings.items.required];
  for (const prompt of ["prompts/review.md", "prompts/adversarial-review.md"]) {
    const source = read(prompt);
    for (const field of fields) {
      assert.match(source, new RegExp(`\`${field}\``), `${prompt} does not name ${field}`);
    }
    for (const severity of schema.properties.findings.items.properties.severity.enum) {
      assert.match(source, new RegExp(`\`${severity}\``), `${prompt} does not name severity ${severity}`);
    }
  }
});

test("no plugin file still refers to the retired Gemini CLI or ACP runtime", () => {
  const stale = /\bACP\b|acp-client|@google\/gemini-cli|codebase_investigator|--resume-last|gemini --resume|session\/prompt/;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of walk(PLUGIN_ROOT).filter((name) => /\.(md|mjs|json)$/.test(name))) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), stale, path.relative(PLUGIN_ROOT, file));
  }
});

// Claude -> companion contract: run each documented call form end to end.

test("--args-file holds the raw arguments, and any argument beside it is refused rather than lost", () => {
  const ws = makeFakeAgyWorkspace();
  const file = path.join(ws.root, "arguments.txt");
  fs.writeFileSync(file, "--plan look at app.js");
  const companion = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
  const call = (...args) => spawnSync(process.execPath, [companion, "task", ...args], { cwd: ws.repo, env: ws.env, encoding: "utf8", timeout: 30000, input: "" });
  assert.equal(call("--args-file", file).status, 0);
  assert.ok(isReadOnlyLaunch(readArgvLog(ws.argvLog).at(-1)));
  assert.equal(call(`--args-file=${file}`).status, 0);
  for (const args of [["--args-file", file, "--plan"], ["--plan", "--args-file", file], [`--args-file=${file}`, "extra"], ["--args-file"]]) {
    const before = readArgvLog(ws.argvLog).length;
    const result = call(...args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.equal(readArgvLog(ws.argvLog).length, before, "agy did not start");
  }
  assert.equal(call("--args-file", path.join(ws.root, "missing.txt")).status, 2);
  assert.equal(call("--plan", "--", "--args-file=not-a-file.txt").status, 0, "after -- it is text");
});

const POWERSHELLS = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"].filter((exe) => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0) : [];
for (const exe of POWERSHELLS) {
  test(`${exe}: the PowerShell form takes flags and text by file, keeps the exit code, and carries no text`, () => {
    const ws = makeFakeAgyWorkspace();
    const form = (name, file) => /```powershell\n(.*)\n```/.exec(read(`commands/${name}.md`))[1].replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT).replace("<file>", file);
    const runPs = (body, scenario) => spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", body], { cwd: ws.repo, env: { ...ws.env, ...(scenario ? { AGY_TEST_SCENARIO: scenario } : {}) }, encoding: "utf8", timeout: 30000, windowsHide: true });
    const file = path.join(ws.root, "arguments.txt");
    const text = 'He said "hi", $HOME and `tick\n\'@ not an end\n\u2019@ nor this\nna\u00efve \u6f22\u5b57';
    fs.writeFileSync(file, `--plan ${text}`);
    const task = runPs(form("rescue", file), "echo");
    assert.equal(task.status, 0, task.stderr);
    assert.ok(isReadOnlyLaunch(readArgvLog(ws.argvLog).at(-1)), "--plan in the file reaches the parser as a flag");
    const input = JSON.parse(JSON.parse(task.stdout.split("\n")[0]).input.trim()).message.content;
    for (const piece of ['"hi"', "\u2019@", "'@ not an end", "na\u00efve \u6f22\u5b57"]) assert.ok(input.includes(piece), piece);
    fs.writeFileSync(file, "");
    assert.equal(runPs(form("review", file), "review").status, 10, "exit $LASTEXITCODE keeps the companion's code");
    assert.equal(runPs(form("review", path.join(ws.root, "missing.txt"))).status, 2);
  });
}

test("setup's call form exits 0 when agy is ready", () => {
  const ws = makeFakeAgyWorkspace();
  const [line] = bashBlocks(read("commands/setup.md"));
  const result = runClaudeForm(line, ws, { args: "--verify" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gemini setup: ready/);
});

test("review call forms: findings exit 10, a clean review exits 0, --wait is accepted", () => {
  const ws = makeFakeAgyWorkspace();
  const [review] = bashBlocks(read("commands/review.md"));
  const findings = runClaudeForm(review, ws, { args: "--wait focus on value", scenario: "review" });
  assert.equal(findings.status, 10, findings.stderr);
  assert.match(findings.stdout, /Verdict: needs-attention/);
  const [adversarial] = bashBlocks(read("commands/adversarial-review.md"));
  const clean = runClaudeForm(adversarial, ws, { args: "--background", scenario: "review-clean" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^Adversarial Review/);
});

test("rescue's call form forwards flags and text, and --resume continues the conversation", () => {
  const ws = makeFakeAgyWorkspace();
  const [line] = bashBlocks(read("commands/rescue.md"));
  const first = runClaudeForm(line, ws, { args: "--wait --plan why is value 2?" });
  assert.equal(first.status, 0, first.stderr);
  const second = runClaudeForm(line, ws, { args: "--resume now check app.js", scenario: "echo" });
  assert.equal(second.status, 0, second.stderr);
  const [planArgs, resumeArgs] = readArgvLog(ws.argvLog);
  assert.ok(isReadOnlyLaunch(planArgs));
  assert.ok(resumeArgs.includes("--conversation"));
  assert.equal(JSON.parse(JSON.parse(second.stdout.split("\n")[0]).input).message.content, "now check app.js");
});

test("inline status, result and cancel forms run and exit as Claude expects", () => {
  const ws = makeFakeAgyWorkspace();
  const [rescue] = bashBlocks(read("commands/rescue.md"));
  runClaudeForm(rescue, ws, { args: "hello" });
  const status = runClaudeForm(inlineCommand(read("commands/status.md")), ws);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /\| completed \|/);
  const result = runClaudeForm(inlineCommand(read("commands/result.md")), ws);
  assert.equal(result.status, 0, result.stderr);
  const cancel = runClaudeForm(inlineCommand(read("commands/cancel.md")), ws);
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Gemini jobs to cancel/);
});

test("the skill's heredoc form delivers a multi-line brief intact without using stdin", () => {
  const ws = makeFakeAgyWorkspace();
  const [line] = bashBlocks(read("skills/gemini/SKILL.md"));
  const brief = `Goal: check "quotes", $HOME, \`ticks\` and --plan text.\nSecond line.`;
  const result = runClaudeForm(line.replace("<brief>", brief), ws, { scenario: "echo" });
  assert.equal(result.status, 0, result.stderr);
  const echoed = JSON.parse(result.stdout.split("\n")[0]);
  assert.equal(JSON.parse(echoed.input).message.content, brief);
  assert.ok(isReadOnlyLaunch(echoed.args));
});

test("the generator renders frontmatter in a fixed order and user-only flags only where set", () => {
  const rendered = renderCommand({ name: "x", description: "D", argumentHint: "[a]", userOnly: true, allowedTools: "Bash(node:*)", body: "Body\n\n" });
  assert.equal(rendered, "---\ndescription: D\nargument-hint: '[a]'\ndisable-model-invocation: true\nallowed-tools: Bash(node:*)\n---\n\nBody\n");
  assert.doesNotMatch(renderCommand({ name: "y", description: "D", argumentHint: "", userOnly: false, allowedTools: "Bash(node:*)", body: "B" }), /disable-model-invocation/);
});
