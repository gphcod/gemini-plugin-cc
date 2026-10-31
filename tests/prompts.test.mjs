import test from "node:test";
import assert from "node:assert/strict";

import { PLUGIN_ROOT } from "./helpers.mjs";
import { interpolateTemplate, loadPromptTemplate } from "../plugins/gemini/scripts/lib/prompts.mjs";

test("templates fill known variables and blank unknown ones, in one pass", () => {
  assert.equal(interpolateTemplate("A {{ONE}} B {{TWO}} C", { ONE: "1" }), "A 1 B  C");
  assert.equal(interpolateTemplate("{{ONE}}", { ONE: "{{TWO}}", TWO: "no" }), "{{TWO}}", "values are not re-expanded");
  assert.equal(interpolateTemplate("{{lower}} {{ONE}}", { ONE: "x", lower: "y" }), "{{lower}} x");
});

test("every shipped prompt template loads and names its variables", () => {
  for (const [name, variables] of [
    ["review", ["TARGET_LABEL", "USER_FOCUS", "REVIEW_COLLECTION_GUIDANCE", "REVIEW_INPUT"]],
    ["adversarial-review", ["TARGET_LABEL", "USER_FOCUS", "REVIEW_COLLECTION_GUIDANCE", "REVIEW_INPUT"]],
    ["stop-review-gate", ["CLAUDE_RESPONSE_BLOCK", "REPO_CHANGES_BLOCK"]]
  ]) {
    const template = loadPromptTemplate(PLUGIN_ROOT, name);
    for (const variable of variables) {
      assert.ok(template.includes(`{{${variable}}}`), `${name} uses {{${variable}}}`);
    }
  }
});

test("read-only prompts do not tell Gemini to run commands it cannot run", () => {
  for (const name of ["review", "adversarial-review", "stop-review-gate"]) {
    const template = loadPromptTemplate(PLUGIN_ROOT, name);
    assert.doesNotMatch(template, /run read-only git commands|run_command|git log yourself/i, name);
  }
});
