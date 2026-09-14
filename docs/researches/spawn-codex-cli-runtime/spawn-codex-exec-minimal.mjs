#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prompt = process.argv.slice(2).join(" ").trim()
  || "请只回复一句中文：spawn codex ok";

const runtimeDir = mkdtempSync(join(tmpdir(), "spawn-codex-exec-"));
const lastMessagePath = join(runtimeDir, "last-message.txt");

const args = [
  "--ask-for-approval",
  "never",
  "exec",
  "--ephemeral",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "-C",
  runtimeDir,
  "--json",
  "--output-last-message",
  lastMessagePath,
  prompt,
];

console.log(`[spawn] codex ${args.join(" ")}`);

const child = spawn("codex", args, {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();

  stdoutBuffer += text;
  consumeJsonlLines();
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();

  stderr += text;
  process.stderr.write(`[stderr] ${text}`);
});

child.on("error", (error) => {
  cleanup();
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code) => {
  try {
    consumeJsonlLines({ flush: true });
    console.log(`[close] ${code}`);

    if (code !== 0) {
      if (stderr.trim()) {
        console.error(`[stderr-summary] ${stderr.trim()}`);
      }
      process.exitCode = code ?? 1;
      return;
    }

    const finalMessage = readFileSync(lastMessagePath, "utf8").trim();
    console.log(`[last-message] ${finalMessage}`);
  } finally {
    cleanup();
  }
});

function consumeJsonlLines(options = {}) {
  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");

    if (newlineIndex < 0) {
      break;
    }

    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    consumeJsonlLine(line);
  }

  if (options.flush && stdoutBuffer.trim()) {
    consumeJsonlLine(stdoutBuffer.trim());
    stdoutBuffer = "";
  }
}

function consumeJsonlLine(line) {
  if (!line) {
    return;
  }

  const event = JSON.parse(line);

  if (event.type) {
    console.log(`[event] ${event.type}`);
  }

  if (event.type === "thread.started" && event.thread_id) {
    console.log(`[thread_id] ${event.thread_id}`);
  }

  if (event.item?.type === "agent_message") {
    console.log(`[agent_message] ${event.item.text}`);
  }
}

function cleanup() {
  rmSync(runtimeDir, { recursive: true, force: true });
}
