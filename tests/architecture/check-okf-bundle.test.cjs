'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const { validateBundle } = require('../../scripts/check-okf-bundle.cjs');

function createBundle(files) {
  const root = mkdtempSync(join(tmpdir(), 'alphaci-okf-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

test('accepts an OKF v0.2 bundle with concepts, indexes, and a log', () => {
  const root = createBundle({
    'index.md': `---
okf_version: "0.2"
---
# Bundle

* [Guide](guide.md) - A guide.
`,
    'guide.md': `---
type: Reference
title: Guide
description: A guide.
tags: [docs]
---
# Guide

See the [architecture](architecture/).
`,
    'architecture/index.md': `# Architecture

* [Current](current.md) - Current architecture.
`,
    'architecture/current.md': `---
type: Architecture Map
title: Current architecture
description: Current architecture.
---
# Current architecture
`,
    'log.md': `# Directory Update Log

## 2026-08-28
* **Creation**: Added the bundle.
`,
  });

  try {
    assert.deepEqual(validateBundle(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects concepts without frontmatter and nested indexes with frontmatter', () => {
  const root = createBundle({
    'index.md': `---
okf_version: "0.2"
---
# Bundle
`,
    'missing.md': '# Missing frontmatter\n',
    'nested/index.md': `---
type: Index
---
# Invalid nested index
`,
    'log.md': '# Directory Update Log\n',
  });

  try {
    const errors = validateBundle(root);
    assert.equal(
      errors.some((error) => error.includes('missing.md')),
      true,
    );
    assert.equal(
      errors.some((error) => error.includes('nested/index.md')),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
