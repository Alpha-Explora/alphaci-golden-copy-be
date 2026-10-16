import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Renders cloud-init user-data for an on-prem Ubuntu VM. The enrollment code is read
// from a file, never from the command line, and is checked before it goes into the
// user-data. The output holds the code: keep it private and delete it after the VM
// has enrolled.
// Usage: node scripts/render-onprem-user-data.mjs --api <https URL> --archive-url <https URL>
//          --archive-sha256 <hex> --code-file <path> [--out <path>]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDirectory = path.join(root, 'deploy/onprem/images');
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

function requireHttpsUrl(value, label) {
  if (!HTTPS_URL.test(value ?? ''))
    throw new Error(
      `${label} must be a public HTTPS address with no credentials, query or spaces.`,
    );
}

// Block scalars need every line of the inlined file indented under its `content: |` key.
function indent(text) {
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line === '' ? '' : '      ' + line))
    .join('\n');
}

export function renderUserData({
  apiUrl,
  archiveUrl,
  archiveSha256,
  code,
  template,
  firstBootScript,
  firstBootUnit,
}) {
  requireHttpsUrl(apiUrl, 'API URL');
  requireHttpsUrl(archiveUrl, 'Archive URL');
  if (!/^[0-9a-f]{64}$/.test(archiveSha256 ?? ''))
    throw new Error(
      'Archive SHA-256 must be 64 lowercase hexadecimal characters.',
    );
  if (!/^[A-Za-z0-9_-]{43}$/.test(code ?? ''))
    throw new Error('The enrollment code is not in the issued format.');
  // Function replacements: the inlined script contains `$` sequences that a string
  // replacement would otherwise expand.
  return template
    .replace('{{ENROLLMENT_CODE}}', () => code)
    .replace('{{API_URL}}', () => apiUrl)
    .replace('{{ARCHIVE_URL}}', () => archiveUrl)
    .replace('{{ARCHIVE_SHA256}}', () => archiveSha256)
    .replace('{{FIRST_BOOT_SCRIPT}}', () => indent(firstBootScript))
    .replace('{{FIRST_BOOT_UNIT}}', () => indent(firstBootUnit));
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith('--') || argv[index + 1] === undefined)
      throw new Error('Options come in --name value pairs.');
    options[name.slice(2)] = argv[index + 1];
  }
  return options;
}

function main(argv) {
  const options = parseOptions(argv);
  for (const required of ['api', 'archive-url', 'archive-sha256', 'code-file'])
    if (!options[required]) throw new Error(`Missing --${required}.`);
  const userData = renderUserData({
    apiUrl: options.api,
    archiveUrl: options['archive-url'],
    archiveSha256: options['archive-sha256'],
    code: readFileSync(options['code-file'], 'utf8').trim(),
    template: readFileSync(
      path.join(imagesDirectory, 'cloud-init/user-data.yaml.tmpl'),
      'utf8',
    ),
    firstBootScript: readFileSync(
      path.join(imagesDirectory, 'first-boot/alphaci-first-boot.sh'),
      'utf8',
    ),
    firstBootUnit: readFileSync(
      path.join(imagesDirectory, 'first-boot/alphaci-first-boot.service'),
      'utf8',
    ),
  });
  if (options.out) writeFileSync(options.out, userData, { mode: 0o600 });
  else process.stdout.write(userData);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
