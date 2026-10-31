import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { makeTempDir } from "./helpers.mjs";
import { isProbablyText, readJsonFile, readStdinIfPiped, StdinTimeoutError } from "../plugins/gemini/scripts/lib/fs.mjs";
import fs from "node:fs";
import path from "node:path";

test("isProbablyText rejects a NUL byte in the first 4 KiB only", () => {
  assert.equal(isProbablyText(Buffer.from("plain text\n")), true);
  assert.equal(isProbablyText(Buffer.from([0x50, 0x00, 0x4b])), false);
  const lateNul = Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0])]);
  assert.equal(isProbablyText(lateNul), true);
  assert.equal(isProbablyText(Buffer.alloc(0)), true);
});

test("readJsonFile parses a file", () => {
  const file = path.join(makeTempDir(), "x.json");
  fs.writeFileSync(file, '{"a":1}');
  assert.deepEqual(readJsonFile(file), { a: 1 });
});

test("a TTY stdin is not read", async () => {
  assert.equal(await readStdinIfPiped({ stdin: { isTTY: true } }), "");
});

test("piped stdin is read to the end, across chunks", async () => {
  const stdin = new PassThrough();
  const reading = readStdinIfPiped({ stdin, inactivityMs: 1000 });
  stdin.write("first ");
  setTimeout(() => stdin.end("second\n"), 20);
  assert.equal(await reading, "first second\n");
});

test("each chunk re-arms the inactivity deadline", async () => {
  const stdin = new PassThrough();
  const reading = readStdinIfPiped({ stdin, inactivityMs: 150 });
  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    stdin.write(`${sent} `);
    if (sent === 4) {
      clearInterval(timer);
      stdin.end();
    }
  }, 80);
  assert.equal(await reading, "1 2 3 4 ");
});

test("stdin left open without input times out instead of hanging", async () => {
  const stdin = new PassThrough();
  const started = Date.now();
  await assert.rejects(readStdinIfPiped({ stdin, inactivityMs: 100 }), StdinTimeoutError);
  assert.ok(Date.now() - started < 2000);
  assert.equal(stdin.destroyed, true);
});

test("a stdin error is reported", async () => {
  const stdin = new PassThrough();
  const reading = readStdinIfPiped({ stdin, inactivityMs: 1000 });
  stdin.destroy(new Error("pipe broke"));
  await assert.rejects(reading, /pipe broke/);
});
