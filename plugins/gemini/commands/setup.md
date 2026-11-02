---
description: Check that the Antigravity CLI (agy) is installed and signed in, and toggle the stop-time review gate
argument-hint: '[--verify] [--enable-review-gate|--disable-review-gate]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*), Write
---

Run once with Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "$ARGUMENTS"
```

No Bash tool: write the arguments verbatim to a new UTF-8 file outside the repo, never into the command, then in PowerShell:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "--args-file=<file>"; exit $LASTEXITCODE
```

Report the result. Exit 1 means not ready: give the next step it names. Sign-in is interactive, so the user runs `agy` once in their own terminal, not through `!`.
