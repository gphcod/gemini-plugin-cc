import fs from "node:fs";

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export const STDIN_INACTIVITY_MS = 10_000;

export class StdinTimeoutError extends Error {}

// Claude Code's Bash tool can leave stdin open when a command holds a heredoc,
// so a read that sees no byte (or no end of input) within the inactivity
// window fails instead of hanging the turn.
export function readStdinIfPiped({ inactivityMs = STDIN_INACTIVITY_MS, stdin = process.stdin } = {}) {
  if (stdin.isTTY) {
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        stdin.destroy();
        reject(new StdinTimeoutError(
          `No end of input on stdin within ${Math.round(inactivityMs / 1000)} seconds. Pass the prompt as an argument or close stdin.`
        ));
      }, inactivityMs);
    };
    function onData(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      arm();
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    arm();
  });
}
