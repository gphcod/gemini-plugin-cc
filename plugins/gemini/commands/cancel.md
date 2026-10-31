---
description: Cancel an active Gemini job in this repository
argument-hint: '[job]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" cancel "$ARGUMENTS"`

Report the line above.
