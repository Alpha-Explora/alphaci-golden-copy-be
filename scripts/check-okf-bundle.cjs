#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const OKF_VERSION = '0.2';
const RESERVED_FILES = new Set(['index.md', 'log.md']);
const LIFECYCLE_STATUSES = new Set(['draft', 'stable', 'deprecated']);
const SKIP_DIRECTORIES = new Set(['superpowers', 'node_modules']);

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...filesUnder(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function relativePath(bundleRoot, filePath) {
  return path.relative(bundleRoot, filePath).replace(/\\/g, '/');
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFrontmatter(text, relative) {
  if (text.startsWith('\uFEFF')) {
    return { error: `${relative}: UTF-8 BOM is not allowed` };
  }

  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { error: `${relative}: missing YAML frontmatter` };
  }

  const closing = /\r?\n---(?:\r?\n|$)/.exec(text.slice(3));
  if (!closing) {
    return { error: `${relative}: unterminated YAML frontmatter` };
  }

  const yamlText = text.slice(4, 3 + closing.index);
  const body = text.slice(3 + closing.index + closing[0].length);
  let metadata;
  try {
    metadata = yaml.load(yamlText);
  } catch (error) {
    return {
      error: `${relative}: invalid YAML frontmatter: ${error.message}`,
    };
  }

  if (!isObject(metadata)) {
    return { error: `${relative}: frontmatter must be a YAML mapping` };
  }

  return { metadata, body };
}

function validateMetadata(metadata, relative) {
  const errors = [];
  if (typeof metadata.type !== 'string' || metadata.type.trim() === '') {
    errors.push(`${relative}: frontmatter requires a non-empty type`);
  }
  if (
    metadata.status !== undefined &&
    (typeof metadata.status !== 'string' ||
      !LIFECYCLE_STATUSES.has(metadata.status))
  ) {
    errors.push(
      `${relative}: status must be one of draft, stable, or deprecated`,
    );
  }
  if (metadata.title !== undefined && typeof metadata.title !== 'string') {
    errors.push(`${relative}: title must be a string when present`);
  }
  if (
    metadata.description !== undefined &&
    typeof metadata.description !== 'string'
  ) {
    errors.push(`${relative}: description must be a string when present`);
  }
  if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) {
    errors.push(`${relative}: tags must be a YAML list when present`);
  }
  return errors;
}

function validateRootIndex(text, relative) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return [`${relative}: root index must declare okf_version: "${OKF_VERSION}"`];
  }
  const parsed = readFrontmatter(text, relative);
  if (parsed.error) return [parsed.error];
  if (parsed.metadata.okf_version !== OKF_VERSION) {
    return [
      `${relative}: okf_version must be "${OKF_VERSION}" (found ${String(parsed.metadata.okf_version)})`,
    ];
  }
  if (parsed.metadata.type !== undefined) {
    return [`${relative}: root index must not declare a concept type`];
  }
  return [];
}

function validateLog(text, relative) {
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    return [`${relative}: log.md must not contain concept frontmatter`];
  }
  const dates = [...text.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm)].map(
    (match) => match[1],
  );
  const errors = [];
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] > dates[index - 1]) {
      errors.push(`${relative}: log dates must be newest first`);
      break;
    }
  }
  return errors;
}

function isExternalLink(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

function linkTarget(href) {
  const withoutTitle = href.trim().split(/\s+/u, 1)[0];
  const hashIndex = withoutTitle.indexOf('#');
  return hashIndex === -1 ? withoutTitle : withoutTitle.slice(0, hashIndex);
}

function validateLinks(bundleRoot, filePath, body, relative) {
  const errors = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(body)) !== null) {
    let href = linkTarget(match[1]);
    if (!href || href.startsWith('#') || isExternalLink(href)) continue;
    try {
      href = decodeURIComponent(href);
    } catch {
      errors.push(`${relative}: invalid percent-encoding in link '${href}'`);
      continue;
    }
    const target = href.startsWith('/')
      ? path.resolve(bundleRoot, `.${href}`)
      : path.resolve(path.dirname(filePath), href);
    if (!target.startsWith(bundleRoot + path.sep) && target !== bundleRoot) {
      errors.push(`${relative}: link escapes the OKF bundle: '${href}'`);
      continue;
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      if (!fs.existsSync(path.join(target, 'index.md'))) {
        errors.push(`${relative}: linked directory has no index.md: '${href}'`);
      }
      continue;
    }
    if (!fs.existsSync(target)) {
      errors.push(`${relative}: linked concept does not exist: '${href}'`);
    }
  }
  return errors;
}

function validateBundle(bundleDirectory) {
  const bundleRoot = path.resolve(bundleDirectory);
  const errors = [];
  if (!fs.existsSync(bundleRoot) || !fs.statSync(bundleRoot).isDirectory()) {
    return [`OKF bundle directory does not exist: ${bundleRoot}`];
  }

  const markdownFiles = filesUnder(bundleRoot).filter((file) =>
    file.toLowerCase().endsWith('.md'),
  );
  const rootIndex = path.join(bundleRoot, 'index.md');
  if (!fs.existsSync(rootIndex)) {
    errors.push('index.md: root OKF index is required by this repository');
  }

  for (const filePath of markdownFiles) {
    const relative = relativePath(bundleRoot, filePath);
    const basename = path.basename(filePath).toLowerCase();
    const text = fs.readFileSync(filePath, 'utf8');

    if (relative === 'index.md') {
      errors.push(...validateRootIndex(text, relative));
      errors.push(...validateLinks(bundleRoot, filePath, text, relative));
      continue;
    }
    if (basename === 'index.md') {
      if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
        errors.push(`${relative}: nested index.md must not contain frontmatter`);
      }
      errors.push(...validateLinks(bundleRoot, filePath, text, relative));
      continue;
    }
    if (basename === 'log.md') {
      errors.push(...validateLog(text, relative));
      errors.push(...validateLinks(bundleRoot, filePath, text, relative));
      continue;
    }

    const parsed = readFrontmatter(text, relative);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    errors.push(...validateMetadata(parsed.metadata, relative));
    errors.push(...validateLinks(bundleRoot, filePath, parsed.body, relative));
  }

  return errors;
}

function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== '--json');
  const bundleDirectory = args[0] ?? path.resolve(__dirname, '..', 'docs');
  const errors = validateBundle(bundleDirectory);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ bundle: path.resolve(bundleDirectory), errors }, null, 2));
  } else if (errors.length > 0) {
    console.error(`OKF bundle validation failed: ${errors.length} error(s).`);
    errors.forEach((error) => console.error(`  ${error}`));
  } else {
    console.log(`OKF v${OKF_VERSION} bundle is valid: ${path.resolve(bundleDirectory)}`);
  }
  process.exitCode = errors.length > 0 ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  OKF_VERSION,
  parseFrontmatter: readFrontmatter,
  validateBundle,
  validateLinks,
};
