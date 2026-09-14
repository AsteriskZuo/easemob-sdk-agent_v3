#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const codexBin = args.codexBin ?? 'codex';
const cwd = args.cwd ?? process.cwd();
const model = args.model;
const profile = args.profile;
const skipExec = args.skipExec === true;

const tempDir = mkdtempSync(join(tmpdir(), 'codex-cli-smoke-'));

main();

function main() {
try {
  console.log(`# Codex CLI smoke test`);
  console.log(`cwd: ${cwd}`);
  console.log(`codex: ${codexBin}`);

  runAndPrint('version', [codexBin, '--version'], { cwd });
  runAndPrint('mcp list', [codexBin, 'mcp', 'list'], { cwd, allowFailure: true });
  runAndPrint('plugin list', [codexBin, 'plugin', 'list', '--json'], { cwd, allowFailure: true });

  if (skipExec) {
    console.log('exec: skipped by --skip-exec');
    return;
  }

  const schemaFile = join(tempDir, 'schema.json');
  const outputFile = join(tempDir, 'last-message.json');

  writeFileSync(schemaFile, JSON.stringify({
    type: 'object',
    properties: {
      status: { type: 'string' },
      source: { type: 'string' },
    },
    required: ['status', 'source'],
    additionalProperties: false,
  }, null, 2));

  const execArgs = [
    codexBin,
    '--ask-for-approval',
    'never',
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '-C',
    cwd,
    '--json',
    '--output-schema',
    schemaFile,
    '--output-last-message',
    outputFile,
  ];

  if (model) {
    execArgs.splice(1, 0, '--model', model);
  }

  if (profile) {
    execArgs.splice(1, 0, '--profile', profile);
  }

  execArgs.push('Return exactly this JSON object: {"status":"ok","source":"codex-exec-smoke-test"}');

  const result = spawnSync(execArgs[0], execArgs.slice(1), {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });

  console.log(`\n## exec --json`);
  console.log(`exitCode: ${result.status}`);

  if (result.stderr.trim()) {
    console.log(`stderr:\n${trim(result.stderr, 4000)}`);
  }

  const events = parseJsonl(result.stdout);
  console.log(`events: ${events.length}`);
  console.log(`eventTypes: ${[...new Set(events.map((event) => event.type))].join(', ')}`);

  const agentMessages = events
    .filter((event) => event.item?.type === 'agent_message')
    .map((event) => event.item.text);
  console.log(`agentMessages: ${agentMessages.length}`);

  if (agentMessages.length > 0) {
    console.log(`lastAgentMessage: ${agentMessages[agentMessages.length - 1]}`);
  }

  if (result.status !== 0) {
    throw new Error('codex exec failed');
  }

  const finalMessage = readFileSync(outputFile, 'utf8').trim();
  console.log(`outputLastMessage: ${finalMessage}`);

  const parsed = JSON.parse(finalMessage);
  if (parsed.status !== 'ok' || parsed.source !== 'codex-exec-smoke-test') {
    throw new Error('unexpected structured output');
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--codex-bin') {
      parsed.codexBin = argv[++index];
    } else if (arg === '--cwd') {
      parsed.cwd = argv[++index];
    } else if (arg === '--model') {
      parsed.model = argv[++index];
    } else if (arg === '--profile') {
      parsed.profile = argv[++index];
    } else if (arg === '--skip-exec') {
      parsed.skipExec = true;
    } else if (arg === '--help') {
      printHelpAndExit();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage:
  node docs/research/codex-cli/codex-exec-smoke-test.mjs [options]

Options:
  --cwd <dir>          Git repository used as Codex workdir. Default: process.cwd()
  --codex-bin <path>   Codex binary. Default: codex
  --model <model>      Optional model override passed to Codex.
  --profile <name>     Optional Codex profile.
  --skip-exec          Only inspect version, MCP list, and plugins.
`);
  process.exit(0);
}

function runAndPrint(label, command, options) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 5,
  });

  console.log(`\n## ${label}`);
  console.log(`exitCode: ${result.status}`);

  if (result.stdout.trim()) {
    console.log(trim(result.stdout, 4000));
  }

  if (result.stderr.trim()) {
    console.log(`stderr:\n${trim(result.stderr, 4000)}`);
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${label} failed`);
  }
}

function parseJsonl(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function trim(text, maxLength) {
  if (text.length <= maxLength) {
    return text.trim();
  }

  return `${text.slice(0, maxLength).trim()}\n...<truncated>`;
}
