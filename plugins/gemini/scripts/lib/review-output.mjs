// Extracts the structured review object from an agy result. agy enforces the
// schema natively when the run passes --json-schema and returns the parsed
// object as result.structured_output; the brace scanner is the fallback for
// results that carry the JSON only inside the response text.

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Returns the first balanced top-level {...} in `text` that parses as JSON.
// String-aware, so braces inside JSON strings do not end the scan, and a
// code fence inside a string value cannot truncate the object.
export function extractFirstJsonObject(text) {
  const source = String(text ?? "");
  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (character === "\\") {
          escaping = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function parseStructuredOutput(agyResult, { partial = "", failureMessage = "" } = {}) {
  const rawOutput = typeof agyResult?.response === "string" && agyResult.response.trim()
    ? agyResult.response
    : partial;

  if (isObject(agyResult?.structured_output)) {
    return { parsed: agyResult.structured_output, rawOutput, parseError: null };
  }

  const scanned = extractFirstJsonObject(rawOutput);
  if (scanned) {
    return { parsed: scanned, rawOutput, parseError: null };
  }

  const detail = String(failureMessage ?? "").trim();
  return {
    parsed: null,
    rawOutput,
    parseError: detail
      ? `No structured review JSON found in the output. ${detail}`
      : "No structured review JSON found in the output."
  };
}
