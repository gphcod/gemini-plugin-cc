import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_AGGREGATE_UNTRACKED_BYTES = 128 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 25;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const DIFF_ARGS = ["--binary", "--no-ext-diff", "--submodule=diff"];
const FULL_DIFF_MAX_BYTES = 64 * 1024 * 1024;
const GATE_INLINE_MAX_BYTES = 128 * 1024;
const FINGERPRINT_CONTENT_MAX_BYTES = 1024 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

// NUL-separated output keeps paths with spaces, tabs, backslashes or
// non-ASCII characters exactly as they are on disk (git quotes them otherwise).
function gitPaths(cwd, args) {
  return gitChecked(cwd, [...args, "-z"]).stdout.split("\0").filter(Boolean);
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

// Runs git once and keeps the output, or returns null when it is larger than
// maxBytes.
function gitOutputWithin(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return null;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout;
}

function byteLength(text) {
  return Buffer.byteLength(text ?? "", "utf8");
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

// The repository root cannot change while one process runs, and reviews, the
// stop gate and every state access ask for it.
const repoRoots = new Map();

export function ensureGitRepository(cwd) {
  const key = path.resolve(cwd);
  const cached = repoRoots.get(key);
  if (cached) {
    return cached;
  }
  const result = git(key, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  const root = result.stdout.trim();
  repoRoots.set(key, root);
  return root;
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitPaths(cwd, ["diff", "--cached", "--name-only"]);
  const unstaged = gitPaths(cwd, ["diff", "--name-only"]);
  const untracked = gitPaths(cwd, ["ls-files", "--others", "--exclude-standard"]);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  const repoRoot = ensureGitRepository(cwd);
  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: true, repoRoot };
  }
  if (requestedScope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", explicit: true, repoRoot };
  }
  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }
  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(repoRoot);
    return { mode: "branch", label: `branch diff against ${detectedBase}`, baseRef: detectedBase, explicit: true, repoRoot };
  }

  const dirty = gitChecked(repoRoot, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim() !== "";
  if (dirty) {
    return { mode: "working-tree", label: "working tree diff", explicit: false, repoRoot };
  }
  const detectedBase = detectDefaultBranch(repoRoot);
  return { mode: "branch", label: `branch diff against ${detectedBase}`, baseRef: detectedBase, explicit: false, repoRoot };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function untrackedEntry(cwd, relativePath) {
  try {
    const stat = fs.statSync(path.join(cwd, relativePath));
    return { relativePath, stat };
  } catch {
    return { relativePath, stat: null };
  }
}

// Untracked files for an inline review: bodies of small text files until the
// aggregate cap, then a count of what was left out. Sizes are checked before
// any file is read, so nothing past the cap is read at all.
function formatUntrackedFiles(cwd, untrackedPaths, options = {}) {
  const aggregateMax = options.maxAggregateUntrackedBytes ?? MAX_AGGREGATE_UNTRACKED_BYTES;
  const parts = [];
  let totalBytes = 0;
  let truncatedCount = 0;
  let truncatedRawBytes = 0;

  for (const { relativePath, stat } of untrackedPaths.map((entry) => untrackedEntry(cwd, entry))) {
    if (!stat) {
      parts.push(`### ${relativePath}\n(skipped: broken symlink or unreadable file)`);
      continue;
    }
    if (stat.isDirectory()) {
      parts.push(`### ${relativePath}\n(skipped: directory)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      parts.push(`### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`);
      continue;
    }
    if (totalBytes + stat.size > aggregateMax) {
      truncatedCount += 1;
      truncatedRawBytes += stat.size;
      continue;
    }

    let buffer;
    try {
      buffer = fs.readFileSync(path.join(cwd, relativePath));
    } catch {
      parts.push(`### ${relativePath}\n(skipped: broken symlink or unreadable file)`);
      continue;
    }
    if (!isProbablyText(buffer)) {
      parts.push(`### ${relativePath}\n(skipped: binary file)`);
      continue;
    }
    parts.push([`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n"));
    totalBytes += buffer.length;
  }

  if (truncatedCount > 0) {
    parts.push(
      `### ... ${truncatedCount} more untracked file${truncatedCount === 1 ? "" : "s"} not shown\n` +
      `(total ~${Math.ceil(truncatedRawBytes / 1024)} KB; use \`git add\` to stage specific files for full diff)`
    );
  }

  return { body: parts.join("\n\n"), bytes: totalBytes + truncatedRawBytes };
}

// Large reviews list untracked files by path and size; Gemini reads the ones
// it needs instead of every body being pasted into the prompt.
function listUntrackedFiles(cwd, untrackedPaths) {
  return untrackedPaths
    .map((relativePath) => {
      const { stat } = untrackedEntry(cwd, relativePath);
      if (!stat) return `${relativePath} (unreadable)`;
      return stat.isDirectory() ? `${relativePath}/ (directory)` : `${relativePath} (${stat.size} bytes)`;
    })
    .join("\n");
}

function untrackedBytes(cwd, untrackedPaths) {
  return untrackedPaths.reduce((total, relativePath) => {
    const { stat } = untrackedEntry(cwd, relativePath);
    return total + (stat && !stat.isDirectory() ? stat.size : 0);
  }, 0);
}

function joinDiffSections(sections) {
  const present = sections.filter(([, body]) => body);
  return present.length ? present.map(([title, body]) => `# ${title}\n${body}`).join("\n") : null;
}

function collectWorkingTreeContext(repoRoot, limits, options) {
  const state = getWorkingTreeState(repoRoot);
  const status = gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const staged = gitOutputWithin(repoRoot, ["diff", "--cached", ...DIFF_ARGS], FULL_DIFF_MAX_BYTES);
  const unstaged = gitOutputWithin(repoRoot, ["diff", ...DIFF_ARGS], FULL_DIFF_MAX_BYTES);
  const overflow = staged === null || unstaged === null;
  const trackedBytes = overflow ? FULL_DIFF_MAX_BYTES + 1 : byteLength(staged) + byteLength(unstaged);
  const summary = `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`;

  const inlinePossible = !overflow && changedFiles.length <= limits.maxFiles && trackedBytes <= limits.maxBytes;
  const untracked = inlinePossible && options.includeDiff !== false
    ? formatUntrackedFiles(repoRoot, state.untracked, { maxAggregateUntrackedBytes: options.maxAggregateUntrackedBytes })
    : null;
  const includeDiff = options.includeDiff ?? (inlinePossible && trackedBytes + untracked.bytes <= limits.maxBytes);

  if (includeDiff) {
    const inlineUntracked = untracked ?? formatUntrackedFiles(repoRoot, state.untracked, { maxAggregateUntrackedBytes: options.maxAggregateUntrackedBytes });
    return {
      summary,
      changedFiles,
      diffBytes: trackedBytes + inlineUntracked.bytes,
      fullDiff: null,
      inputMode: "inline-diff",
      content: [
        formatSection("Git Status", status),
        formatSection("Staged Diff", staged ?? ""),
        formatSection("Unstaged Diff", unstaged ?? ""),
        formatSection("Untracked Files", inlineUntracked.body)
      ].join("\n")
    };
  }

  const fullDiff = overflow ? null : joinDiffSections([["Staged changes", staged], ["Unstaged changes", unstaged]]);
  return {
    summary,
    changedFiles,
    diffBytes: trackedBytes + untrackedBytes(repoRoot, state.untracked),
    fullDiff,
    inputMode: "self-collect",
    content: [
      formatSection("Git Status", status),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", listUntrackedFiles(repoRoot, state.untracked))
    ].join("\n")
  };
}

function collectBranchContext(repoRoot, baseRef, limits, options) {
  const comparison = buildBranchComparison(repoRoot, baseRef);
  const currentBranch = getCurrentBranch(repoRoot);
  const changedFiles = gitPaths(repoRoot, ["diff", "--name-only", comparison.commitRange]);
  const logOutput = gitChecked(repoRoot, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(repoRoot, ["diff", "--stat", comparison.commitRange]).stdout.trim();
  const diff = gitOutputWithin(repoRoot, ["diff", ...DIFF_ARGS, comparison.commitRange], FULL_DIFF_MAX_BYTES);
  const diffBytes = diff === null ? FULL_DIFF_MAX_BYTES + 1 : byteLength(diff);
  const includeDiff = options.includeDiff ?? (diff !== null && changedFiles.length <= limits.maxFiles && diffBytes <= limits.maxBytes);
  const summary = `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`;

  if (includeDiff) {
    return {
      summary,
      changedFiles,
      diffBytes,
      fullDiff: null,
      inputMode: "inline-diff",
      content: [
        formatSection("Commit Log", logOutput),
        formatSection("Diff Stat", diffStat),
        formatSection("Branch Diff", diff ?? "")
      ].join("\n")
    };
  }
  return {
    summary,
    changedFiles,
    diffBytes,
    fullDiff: diff || null,
    inputMode: "self-collect",
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Changed Files", changedFiles.join("\n"))
    ].join("\n")
  };
}

// Reviews run with every shell command denied, so a diff too large to inline
// is handed over as a file that Gemini reads with its read_file tool.
export function buildCollectionGuidance(context, diffFile) {
  if (context.inputMode === "inline-diff") {
    return "Use the repository context below as primary evidence.";
  }
  const size = context.diffBytes > FULL_DIFF_MAX_BYTES
    ? `${context.fileCount} files, over ${FULL_DIFF_MAX_BYTES / (1024 * 1024)} MB`
    : `${context.fileCount} files, about ${Math.max(1, Math.ceil(context.diffBytes / 1024))} KB`;
  if (diffFile) {
    return `The changes are too large to include here (${size}). The complete diff of tracked files is in ${diffFile}: read it with read_file, page by page, before finalizing findings. Read untracked or changed files directly by path when you need more context.`;
  }
  return `The changes are too large to include here (${size}). Read the changed and untracked files listed below directly by path before finalizing findings.`;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = target.repoRoot ?? ensureGitRepository(cwd);
  const limits = {
    maxFiles: normalizeMaxInlineFiles(options.maxInlineFiles),
    maxBytes: normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes)
  };
  const details = target.mode === "working-tree"
    ? collectWorkingTreeContext(repoRoot, limits, options)
    : collectBranchContext(repoRoot, target.baseRef, limits, options);
  return {
    cwd: repoRoot,
    repoRoot,
    target,
    mode: target.mode,
    fileCount: details.changedFiles.length,
    ...details
  };
}

// --- stop gate ----------------------------------------------------------------

function resolveHead(repoRoot) {
  const result = git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

// Identifies everything a stop-gate review could see: HEAD, the index (staged
// changes), the working tree relative to the index, and untracked files'
// contents (size and time for files over 1 MiB). `digest` is null when a diff
// is too large to hash, so such a state never matches a recorded baseline.
// Returns null outside a Git repository.
export function repoFingerprint(cwd, options = {}) {
  let repoRoot;
  try {
    repoRoot = ensureGitRepository(cwd);
  } catch {
    return null;
  }
  const maxDiffBytes = options.maxDiffBytes ?? FULL_DIFF_MAX_BYTES;
  const head = resolveHead(repoRoot) ?? "none";
  const status = gitChecked(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const indexDiff = gitOutputWithin(repoRoot, ["diff", "--cached", ...DIFF_ARGS], maxDiffBytes);
  const worktreeDiff = gitOutputWithin(repoRoot, ["diff", ...DIFF_ARGS], maxDiffBytes);
  if (indexDiff === null || worktreeDiff === null) {
    return { repoRoot, head, digest: null };
  }

  const hash = createHash("sha256");
  for (const part of [head, status, indexDiff, worktreeDiff]) {
    hash.update(part).update("\0");
  }
  for (const relativePath of gitPaths(repoRoot, ["ls-files", "--others", "--exclude-standard"])) {
    hash.update(relativePath).update("\0");
    const { stat } = untrackedEntry(repoRoot, relativePath);
    if (!stat) {
      hash.update("missing\0");
    } else if (stat.isFile() && stat.size <= FINGERPRINT_CONTENT_MAX_BYTES) {
      try {
        hash.update(fs.readFileSync(path.join(repoRoot, relativePath))).update("\0");
      } catch {
        hash.update("unreadable\0");
      }
    } else {
      hash.update(`${stat.size}\0${stat.mtimeMs}\0`);
    }
  }
  return { repoRoot, head, digest: hash.digest("hex") };
}

// The evidence a read-only stop-gate review judges, with no shell to explore,
// as separately labelled parts: commits since the last allowed stop (or, with
// no baseline, the latest commit, which the turn may have made), staged
// changes, and unstaged changes. Staged and unstaged stay separate so a staged
// version that differs from the working file is never hidden. Parts over the
// inline limit go to a file from `attach`; `complete` is false when a part is
// too large to hand over at all, and the gate must not allow on partial
// evidence.
export function describeChangesSince(repoRoot, baseHead, { attach, maxDiffBytes = FULL_DIFF_MAX_BYTES } = {}) {
  const status = gitChecked(repoRoot, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const head = resolveHead(repoRoot);
  let base = baseHead && baseHead !== "none" ? baseHead : null;
  if (base && git(repoRoot, ["cat-file", "-e", `${base}^{commit}`]).status !== 0) {
    base = null;
  }

  const sections = [formatSection("Git Status", status)];
  const parts = [];
  if (base && head && base !== head) {
    const short = base.slice(0, 12);
    sections.push(formatSection(`Files changed by commits since the last allowed stop (git diff --name-status ${short} HEAD)`,
      gitChecked(repoRoot, ["diff", "--name-status", base, "HEAD"]).stdout));
    parts.push([`Commits since the last allowed stop (git diff ${short} HEAD)`,
      gitOutputWithin(repoRoot, ["diff", base, "HEAD", ...DIFF_ARGS], maxDiffBytes)]);
  } else if (!base && head) {
    sections.push(formatSection("Files in the latest commit (no earlier allowed stop to compare with)",
      gitChecked(repoRoot, ["show", "--name-status", "--format=%H %s", "HEAD"]).stdout));
    parts.push(["Latest commit (git show HEAD)",
      gitOutputWithin(repoRoot, ["show", "--format=commit %H%n%s%n", ...DIFF_ARGS, "HEAD"], maxDiffBytes)]);
  }
  parts.push(["Staged changes (git diff --cached)", gitOutputWithin(repoRoot, ["diff", "--cached", ...DIFF_ARGS], maxDiffBytes)]);
  parts.push(["Unstaged changes (git diff)", gitOutputWithin(repoRoot, ["diff", ...DIFF_ARGS], maxDiffBytes)]);

  const missing = parts.filter(([, diff]) => diff === null).map(([title]) => title);
  const available = parts.filter(([, diff]) => diff !== null);
  const availableBytes = available.reduce((total, [, diff]) => total + byteLength(diff), 0);

  if (availableBytes <= GATE_INLINE_MAX_BYTES) {
    sections.push(...available.map(([title, diff]) => formatSection(title, diff)));
  } else {
    let file = null;
    try {
      file = attach ? attach(available.map(([title, diff]) => `# ${title}\n${diff}`).join("\n")) : null;
    } catch {
      file = null;
    }
    const listed = available.map(([title]) => `- ${title}`).join("\n");
    sections.push(file
      ? `These parts are over the ${GATE_INLINE_MAX_BYTES / 1024} KB inline limit and are in ${file}; read it with read_file before deciding:\n${listed}\n`
      : `These parts are over the ${GATE_INLINE_MAX_BYTES / 1024} KB inline limit and could not be attached:\n${listed}\n`);
    if (!file) {
      missing.push(...available.map(([title]) => title));
    }
  }
  for (const title of missing) {
    sections.push(formatSection(title, `(larger than ${Math.round(maxDiffBytes / 1024)} KB or not attachable: not provided)`));
  }

  return { text: sections.join("\n"), complete: missing.length === 0, missing };
}
