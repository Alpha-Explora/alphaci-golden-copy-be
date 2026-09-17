import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const compositionRoot = resolve(__dirname);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return file.endsWith('.ts') && !file.endsWith('.spec.ts') ? [file] : [];
  });
}

describe('client policy pack boundary', () => {
  it('does not statically import the Enterprise pack from the shared kernel', () => {
    const staticEnterpriseImport =
      /(?:from|require\()\s*['"][^'"]*packs[\\/]enterprise/;
    const offenders = sourceFiles(compositionRoot).filter((file) =>
      staticEnterpriseImport.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
