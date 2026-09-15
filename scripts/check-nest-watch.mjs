#!/usr/bin/env node
'use strict';

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'dist');
const nestCli = path.join(root, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
const successMessage = 'Found 0 errors. Watching for file changes.';
const failureMessage = "Cannot read properties of undefined (reading 'checkJsDirective')";
const timeoutMs = 60_000;

await rm(outputDir, { recursive: true, force: true });

const output = [];
const child = spawn(process.execPath, [nestCli, 'build', '--watch'], {
  cwd: root,
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

const result = await new Promise((resolve, reject) => {
  let settled = false;
  const timer = setTimeout(() => {
    finish(new Error(`Timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const stopChild = () => {
    if (child.exitCode === null && !child.killed) child.kill();
  };

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stopChild();
    if (error) reject(error);
    else resolve(value);
  };

  const consume = (chunk) => {
    output.push(String(chunk));
    const text = output.join('');
    if (text.includes(failureMessage)) {
      finish(new Error(`Nest watch emitted the known compiler failure: ${failureMessage}`));
    } else if (text.includes(successMessage)) {
      finish(null, successMessage);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', (error) => finish(error));
  child.on('exit', (code, signal) => {
    if (!settled) {
      finish(new Error(`Nest watch exited before the success marker (code=${code}, signal=${signal}).`));
    }
  });
});

console.log(`Nest watch regression passed: ${result}`);
