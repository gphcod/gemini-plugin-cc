---
description: Show the stored output of a finished Gemini job
argument-hint: '[job]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Present the result above. For a review, list every finding with exact file:line. For a long answer, summarize and point to the `full:` file.
