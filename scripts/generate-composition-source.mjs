#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const prettier = require('prettier');
const source = require('./lib/composition-source.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const normalize = (text) => text.replace(/\r\n/g, '\n');

async function format(code, filepath) {
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(code, {
    ...config,
    filepath,
    parser: 'typescript',
    endOfLine: 'lf',
  });
}

async function main() {
  const check = process.argv.includes('--check');
  const document = source.loadSource();
  const errors = source.validateSource(document);
  if (errors.length > 0) {
    console.error('Composition source is invalid: ' + errors.length + ' error(s).');
    for (const error of errors) console.error('  ' + error);
    process.exitCode = 1;
    return;
  }

  const outputs = [
    [source.REGISTRY_PATH, source.renderRegistry(document)],
    [source.MANIFESTS_PATH, source.renderManifests(document)],
  ];

  let clean = true;
  for (const [file, raw] of outputs) {
    const content = await format(raw, file);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (normalize(current) !== normalize(content)) {
        console.error('Composition output is stale: ' + relative(file));
        clean = false;
      }
      continue;
    }
    fs.writeFileSync(file, content, 'utf8');
  }

  if (!clean) {
    process.exitCode = 1;
    return;
  }
  console.log(
    (check ? 'Checked ' : 'Generated ') +
      outputs.length +
      ' composition file(s) from ' +
      relative(source.SOURCE_PATH) +
      ' (' +
      document.capabilities.length +
      ' capabilities).',
  );
}

await main();
