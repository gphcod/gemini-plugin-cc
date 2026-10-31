import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

// The repository root cannot change while one companion process runs, and
// every state-file access needs it, so it is resolved once per directory.
const roots = new Map();

export function resolveWorkspaceRoot(cwd) {
  const key = path.resolve(cwd);
  let root = roots.get(key);
  if (root === undefined) {
    try {
      root = ensureGitRepository(key);
    } catch {
      root = key;
    }
    roots.set(key, root);
  }
  return root;
}
