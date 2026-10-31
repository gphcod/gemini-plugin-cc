import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, parseProseCommand, splitRawArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";

const CONFIG = {
  valueOptions: ["model", "effort", "request-id"],
  booleanOptions: ["plan", "json", "wait"],
  aliasMap: { m: "model" }
};

test("leading flags are parsed and the rest of a raw string is kept verbatim", () => {
  const { options, text } = parseProseCommand([`--plan -m flash why does "--json" 'break' here\\?`], CONFIG);
  assert.deepEqual(options, { plan: true, model: "flash" });
  assert.equal(text, `why does "--json" 'break' here\\?`);
});

test("a flag after the text starts is part of the text", () => {
  const { options, text } = parseProseCommand(["explain the --plan flag"], CONFIG);
  assert.deepEqual(options, {});
  assert.equal(text, "explain the --plan flag");
});

test("-- ends flag parsing in raw and split forms", () => {
  assert.deepEqual(parseProseCommand(["--wait -- --plan is text"], CONFIG), { options: { wait: true }, text: "--plan is text" });
  assert.deepEqual(parseProseCommand(["--wait", "--", "--plan", "is", "text"], CONFIG), { options: { wait: true }, text: "--plan is text" });
});

test("an unknown dash token starts the text instead of being dropped", () => {
  const { options, text } = parseProseCommand(["--plan -x marks the spot"], CONFIG);
  assert.deepEqual(options, { plan: true });
  assert.equal(text, "-x marks the spot");
});

test("quoted flag values and inline values are read", () => {
  assert.deepEqual(parseProseCommand([`--request-id "r 1" --effort=high go`], CONFIG), {
    options: { "request-id": "r 1", effort: "high" },
    text: "go"
  });
});

test("a value flag without a value is a usage error", () => {
  assert.throws(() => parseProseCommand(["--model"], CONFIG), /Missing value for --model/);
});

test("empty input yields empty text", () => {
  assert.deepEqual(parseProseCommand([""], CONFIG), { options: {}, text: "" });
  assert.deepEqual(parseProseCommand([], CONFIG), { options: {}, text: "" });
});

test("splitRawArgumentString and parseArgs keep their flag-command behaviour", () => {
  assert.deepEqual(splitRawArgumentString(`a "b c" 'd' e\\ f`), ["a", "b c", "d", "e f"]);
  assert.deepEqual(parseArgs(["--json", "job1"], { booleanOptions: ["json"] }), { options: { json: true }, positionals: ["job1"] });
});
