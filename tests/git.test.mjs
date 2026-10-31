import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCollectionGuidance, collectReviewContext, describeChangesSince, repoFingerprint, resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.equal(context.fullDiff, null);
  assert.match(buildCollectionGuidance(context, null), /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("a review over the file limit lists files and hands over the full diff for a diff file", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  assert.equal(collectReviewContext(cwd, target).inputMode, "inline-diff");
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 2 });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
  assert.match(context.fullDiff, /SELF_COLLECT_MARKER_A[\s\S]*SELF_COLLECT_MARKER_C/);
  const guidance = buildCollectionGuidance(context, "/state/jobs/review-1.diff");
  assert.match(guidance, /\/state\/jobs\/review-1\.diff/);
  assert.match(guidance, /read_file/);
  assert.doesNotMatch(guidance, /git commands/);
  assert.match(buildCollectionGuidance({ ...context, fullDiff: null }, null), /Read the changed and untracked files listed below/);
});

test("a single oversized diff is not inlined but still handed over in full", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
  assert.match(context.fullDiff, /x{512}/);
});

test("a large review lists untracked files by size instead of pasting their contents", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 2 });

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /new-risk\.js \(\d+ bytes\)/);
  assert.doesNotMatch(context.content, /UNTRACKED_RISK_MARKER/);
});

test("untracked file contents count toward the inline size limit", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(cwd, "big-new.js"), `export const blob = "${"y".repeat(4000)}";\n`);

  const target = resolveReviewTarget(cwd, {});
  assert.equal(collectReviewContext(cwd, target, { maxInlineDiffBytes: 1000 }).inputMode, "self-collect");
  assert.equal(collectReviewContext(cwd, target, { maxInlineDiffBytes: 64 * 1024 }).inputMode, "inline-diff");
});

function committedRepo() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

test("a branch review over the limits lists commits and files and hands over the full diff", () => {
  const cwd = committedRepo();
  run("git", ["checkout", "-b", "feature"], { cwd });
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const name = "${name}-BRANCH_MARKER";\n`);
  }
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "add files"], { cwd });
  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target, { maxInlineFiles: 2 });
  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /## Commit Log[\s\S]*add files/);
  assert.match(context.content, /## Changed Files\n\na\.js\nb\.js\nc\.js/);
  assert.doesNotMatch(context.content, /BRANCH_MARKER/);
  assert.match(context.fullDiff, /c\.js-BRANCH_MARKER/);
  const inline = collectReviewContext(cwd, target);
  assert.equal(inline.inputMode, "inline-diff");
  assert.match(inline.content, /## Branch Diff[\s\S]*BRANCH_MARKER/);
});

test("the fingerprint changes with tracked edits, new untracked files and commits, and only then", () => {
  const cwd = committedRepo();
  const clean = repoFingerprint(cwd);
  assert.equal(clean.head.length, 40);
  assert.deepEqual(repoFingerprint(cwd), clean, "stable when nothing changed");
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  const edited = repoFingerprint(cwd);
  assert.notEqual(edited.digest, clean.digest);
  fs.writeFileSync(path.join(cwd, "new.js"), "x\n");
  const untracked = repoFingerprint(cwd);
  assert.notEqual(untracked.digest, edited.digest);
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "next"], { cwd });
  assert.notEqual(repoFingerprint(cwd).head, clean.head);
  assert.equal(repoFingerprint(makeTempDir()), null, "outside Git there is no fingerprint");
});

test("the gate's change summary covers commits since the baseline and survives a vanished base", () => {
  const cwd = committedRepo();
  const base = repoFingerprint(cwd).head;
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 7;\n");
  run("git", ["commit", "-qam", "seven"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 8;\n");
  const since = describeChangesSince(cwd, base);
  assert.equal(since.complete, true);
  assert.match(since.text, /Commits since the last allowed stop[\s\S]*-export const value = 1;[\s\S]*\+export const value = 7;/);
  assert.match(since.text, /Unstaged changes \(git diff\)[\s\S]*\+export const value = 8;/);
  const fallback = describeChangesSince(cwd, "0".repeat(40)).text;
  assert.match(fallback, /Latest commit \(git show HEAD\)[\s\S]*\+export const value = 7;/);
  assert.match(fallback, /Unstaged changes \(git diff\)[\s\S]*\+export const value = 8;/);
  assert.match(describeChangesSince(cwd, "none").text, /Latest commit/);
});

test("an untracked file whose text mentions a skip marker is still capped and counted", () => {
  const cwd = committedRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(cwd, "notes.txt"), `(skipped: not really) ${"z".repeat(3000)}\n`);
  const target = resolveReviewTarget(cwd, {});
  assert.equal(collectReviewContext(cwd, target, { maxInlineDiffBytes: 1000 }).inputMode, "self-collect");
  const capped = collectReviewContext(cwd, target, { maxAggregateUntrackedBytes: 100 });
  assert.match(capped.content, /1 more untracked file not shown/);
  assert.doesNotMatch(capped.content, /z{100}/);
});

test("a large review of only untracked files attaches no empty diff file", () => {
  const cwd = committedRepo();
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(cwd, `new-${index}.js`), `export const n = ${index};\n`);
  }
  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { maxInlineFiles: 2 });
  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fullDiff, null);
  assert.ok(context.diffBytes > 0, "untracked sizes count toward the reported size");
  assert.match(buildCollectionGuidance(context, null), /about 1 KB[\s\S]*untracked files listed below/);
});

test("staged and unstaged versions of a file give different fingerprints, with or without HEAD", () => {
  for (const withHead of [false, true]) {
    const cwd = withHead ? committedRepo() : makeTempDir();
    if (!withHead) initGitRepo(cwd);
    fs.writeFileSync(path.join(cwd, "app.js"), "staged version\n");
    run("git", ["add", "app.js"], { cwd });
    const staged = repoFingerprint(cwd);
    fs.writeFileSync(path.join(cwd, "app.js"), "edited after staging\n");
    const edited = repoFingerprint(cwd);
    assert.notEqual(edited.digest, staged.digest, `withHead=${withHead}`);
    run("git", ["add", "app.js"], { cwd });
    fs.writeFileSync(path.join(cwd, "app.js"), "staged version\n");
    assert.notEqual(repoFingerprint(cwd).digest, staged.digest, `index differs, worktree same (withHead=${withHead})`);
  }
});

test("edits to untracked files with unusual names change the fingerprint", () => {
  const cwd = committedRepo();
  const name = "tab\there café.txt";
  fs.writeFileSync(path.join(cwd, name), "one\n");
  const first = repoFingerprint(cwd);
  fs.writeFileSync(path.join(cwd, name), "two\n");
  assert.notEqual(repoFingerprint(cwd).digest, first.digest);
});

test("a diff too large to hash gives no digest, so it can never match a baseline", () => {
  const cwd = committedRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = "${"q".repeat(4000)}";\n`);
  const fingerprint = repoFingerprint(cwd, { maxDiffBytes: 512 });
  assert.equal(fingerprint.digest, null);
  assert.equal(fingerprint.head.length, 40);
});

test("without a baseline the gate also sees the latest commit, for a turn that committed", () => {
  const cwd = committedRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 99;\n");
  run("git", ["commit", "-qam", "turn commit"], { cwd });
  const summary = describeChangesSince(cwd, null).text;
  assert.match(summary, /Files in the latest commit[\s\S]*M\tapp\.js/);
  assert.match(summary, /Latest commit \(git show HEAD\)[\s\S]*\+export const value = 99;/);
});

test("an oversized gate diff keeps the file list and attaches the full diff", () => {
  const cwd = committedRepo();
  const base = repoFingerprint(cwd).head;
  fs.writeFileSync(path.join(cwd, "big.txt"), `${"line of text\n".repeat(20000)}`);
  run("git", ["add", "big.txt"], { cwd });
  run("git", ["commit", "-qm", "big"], { cwd });
  let attached = null;
  const result = describeChangesSince(cwd, base, { attach: (text) => { attached = text; return "/state/gate-changes.diff"; } });
  assert.equal(result.complete, true);
  assert.match(result.text, /Files changed by commits since the last allowed stop[\s\S]*A\tbig\.txt/);
  assert.match(result.text, /are in \/state\/gate-changes\.diff[\s\S]*- Commits since the last allowed stop/);
  assert.doesNotMatch(result.text, /line of text\nline of text\nline of text/);
  assert.match(attached, /# Commits since the last allowed stop[\s\S]*\+line of text/);
  const noAttach = describeChangesSince(cwd, base);
  assert.equal(noAttach.complete, false, "unattachable evidence is incomplete");
  assert.match(noAttach.text, /could not be attached/);
});

test("a staged version that differs from the working file is shown to the gate", () => {
  const cwd = committedRepo();
  const base = repoFingerprint(cwd).head;
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = STAGED_DEFECT;\n");
  run("git", ["add", "app.js"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  const summary = describeChangesSince(cwd, base).text;
  assert.match(summary, /Staged changes \(git diff --cached\)[\s\S]*\+export const value = STAGED_DEFECT;/);
  assert.match(summary, /Unstaged changes \(git diff\)[\s\S]*-export const value = STAGED_DEFECT;/);
});

test("evidence too large to hand over makes the summary incomplete and names the part", () => {
  const cwd = committedRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = "${"w".repeat(4000)}";\n`);
  const result = describeChangesSince(cwd, null, { maxDiffBytes: 1024, attach: () => "/state/x.diff" });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ["Unstaged changes (git diff)"]);
  assert.match(result.text, /## Unstaged changes \(git diff\)\n\n\(larger than 1 KB or not attachable: not provided\)/);
});

test("a failing attachment write marks the oversized parts as not provided", () => {
  const cwd = committedRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), `${"line of text\n".repeat(20000)}`);
  const result = describeChangesSince(cwd, null, { attach: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } });
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes("Unstaged changes (git diff)"));
  assert.match(result.text, /could not be attached/);
});
