---
description: Show active and recent Gemini jobs for this repository
argument-hint: '[job] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status "$ARGUMENTS"`

Show the status above to the user unchanged.
