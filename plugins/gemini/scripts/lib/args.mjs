export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

function tokenizeWithOffsets(raw) {
  const tokens = [];
  let current = "";
  let start = -1;
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      if (start === -1) start = index;
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      if (start === -1) start = index;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (start !== -1) {
        tokens.push({ value: current, start });
        current = "";
        start = -1;
      }
      continue;
    }
    if (start === -1) start = index;
    current += character;
  }

  if (escaping) current += "\\";
  if (start !== -1) tokens.push({ value: current, start });
  return tokens;
}

export function splitRawArgumentString(raw) {
  return tokenizeWithOffsets(raw).map((token) => token.value);
}

function consumeFlagTokens(tokens, raw, config, readValue) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const value = token.value;

    if (value === "--") {
      return { options, textFrom: index + 1 };
    }

    if (!value.startsWith("-") || value === "-") {
      return { options, textFrom: index };
    }

    const isLong = value.startsWith("--");
    const [rawKey, inlineValue] = (isLong ? value.slice(2) : value.slice(1)).split("=", 2);
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      index += 1;
      continue;
    }

    if (valueOptions.has(key)) {
      if (inlineValue !== undefined) {
        options[key] = inlineValue;
        index += 1;
        continue;
      }
      const next = tokens[index + 1];
      if (!next) {
        throw new Error(`Missing value for ${isLong ? "--" : "-"}${rawKey}`);
      }
      options[key] = readValue(next);
      index += 2;
      continue;
    }

    // An unrecognized dash token starts the prose text; never swallow it.
    return { options, textFrom: index };
  }

  return { options, textFrom: tokens.length };
}

// Parses a command line whose tail is free-form prose (a prompt or focus
// text). Flags are only recognized at the front; the first token that is not
// a known flag starts the text, which is returned verbatim from the original
// string so quotes, backslashes, and embedded `--flags` survive untouched.
// `--` explicitly ends flag parsing.
export function parseProseCommand(argv, config = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { options: {}, text: "" };
  }

  if (argv.length === 1) {
    const raw = String(argv[0] ?? "");
    if (!raw.trim()) {
      return { options: {}, text: "" };
    }
    const tokens = tokenizeWithOffsets(raw);
    const { options, textFrom } = consumeFlagTokens(tokens, raw, config, (next) => next.value);
    const text = textFrom < tokens.length ? raw.slice(tokens[textFrom].start) : "";
    return { options, text: text.trim() };
  }

  const tokens = argv.map((value) => ({ value: String(value), start: -1 }));
  const { options, textFrom } = consumeFlagTokens(tokens, "", config, (next) => next.value);
  return { options, text: argv.slice(textFrom).join(" ").trim() };
}
