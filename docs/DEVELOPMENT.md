# Development notes

Practical notes for working on the plugin. The design goals are the ones in the
[agent plugin design comparison](https://github.com/gphcod/handbook/blob/main/agent_plugin_design_comparison.md):
one model-visible skill, user-only generated commands, one Bash call per turn,
completion by notification instead of polling, and a small per-call overhead.

## Budgets enforced by `npm test`

| What | Budget | Checked by |
|---|---|---|
| `skills/gemini/SKILL.md` | ≤ 3,000 B; description ≤ 200 B | `tests/commands.test.mjs` |
| Each command file | ≤ 1,000 B, identical to the generator's output | `tests/commands.test.mjs` |
| Bytes per call besides the answer | ≤ 150 B (59 B at 2.0.0) | `npm run measure -- --check 150` |
| Answer on stdout | ≤ 24 KiB; full text in the job's `.txt` file | `tests/runtime.test.mjs` |

Command files are generated. Edit `scripts/generate-commands.mjs`, then run
`npm run generate-commands`; never edit `plugins/gemini/commands/*.md` by hand.

## The agy contract

`plugins/gemini/scripts/lib/agy.mjs` relies on these `agy` behaviours, verified
against agy 1.4.12 by `npm run test:live` (needs a signed-in `agy`; makes a few
small paid calls):

- `--input-format stream-json` reads one NDJSON `{"event":"user",...}` message from stdin; `--output-format stream-json` writes one JSON event per line: `init` first (with `conversation_id`), `step_update` events, then one `result`.
- `result` carries `status`, `response`, `conversation_id`, `usage`, and with `--json-schema` a validated `structured_output`.
- `--conversation <id>` resumes a conversation.
- `--mode plan` is read-only for a one-shot run, but `agy` ignores it when `--disable-slash-commands` is set. Plan runs therefore keep slash expansion on, and a plan task starting with `/` is prefixed with `Task: `.
- When `--print-timeout` fires, `agy` exits 0 with `status: SUCCESS` and `finished_reason: "print_timeout"`. The runner treats that as incomplete.
- `--sandbox` restricts terminal commands; file edits still work in `accept-edits` mode.
- An unknown flag exits 2.

Re-run `npm run test:live` after every `agy` upgrade. The offline fake
(`tests/fixtures/fake-agy.mjs`) mirrors these shapes; update both together.

## Plugin loader lessons

- `/reload-plugins` refreshes files the loader already knows about. It does not discover new command, agent, or skill files; start a new Claude Code session after adding or removing one.
- The command is `/reload-plugins`. `/plugin reload` does not exist.
- A command or agent whose frontmatter lists a deferred tool (for example `Monitor`), has invalid YAML, or starts with a byte-order mark is rejected without an error. If a command disappears, check its frontmatter first.
- An installed plugin exists in three places: the marketplace clone, the cache slot the loader actually reads, and `installed_plugins.json`. For live development, point the cache slot at your working tree with a symlink, or start Claude Code with `--plugin-dir plugins/gemini`.

## Running the companion directly

```bash
node plugins/gemini/scripts/gemini-companion.mjs setup
node plugins/gemini/scripts/gemini-companion.mjs task --plan -- "what does lib/agy.mjs do?"
node plugins/gemini/scripts/gemini-companion.mjs review --json
```

Put a directory containing an `agy` wrapper for `tests/fixtures/fake-agy.mjs`
first on `PATH` to run without a model; `AGY_TEST_SCENARIO` picks its behaviour.
