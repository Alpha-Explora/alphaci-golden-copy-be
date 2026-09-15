import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const packageScript = require(
  resolve(__dirname, '../../scripts/package-capability-catalog.cjs'),
) as {
  PACKAGE_DIR: string;
  buildPackage: () => {
    provenance: { artifactDigest: string; catalogSourceDigest: string };
  };
};
const packageChecker = require(
  resolve(__dirname, '../../scripts/check-capability-package.cjs'),
) as { collect: (packageDirectory?: string) => string[] };
/* eslint-enable @typescript-eslint/no-require-imports */

function withPackageCopy(run: (packageDirectory: string) => void): void {
  const packageDirectory = mkdtempSync(
    join(tmpdir(), 'alphaci-capability-package-'),
  );
  cpSync(packageScript.PACKAGE_DIR, packageDirectory, { recursive: true });
  try {
    run(packageDirectory);
  } finally {
    rmSync(packageDirectory, { recursive: true, force: true });
  }
}

describe('capability package provenance', () => {
  it('accepts a clean generated package', () => {
    withPackageCopy((packageDirectory) => {
      expect(packageChecker.collect(packageDirectory)).toEqual([]);
    });
  });

  it('rejects a canonical package file edit', () => {
    withPackageCopy((packageDirectory) => {
      appendFileSync(
        join(packageDirectory, 'index.js'),
        '\n// tampered\n',
        'utf8',
      );

      expect(packageChecker.collect(packageDirectory).join(' ')).toMatch(
        /canonical package artifact digest does not match provenance/,
      );
    });
  });

  it('rejects a provenance source-digest edit', () => {
    withPackageCopy((packageDirectory) => {
      const provenancePath = join(packageDirectory, 'provenance.json');
      const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as {
        catalogSourceDigest: string;
      };
      provenance.catalogSourceDigest = `sha256:${'0'.repeat(64)}`;
      writeFileSync(
        provenancePath,
        `${JSON.stringify(provenance, null, 2)}\n`,
        'utf8',
      );

      expect(packageChecker.collect(packageDirectory).join(' ')).toMatch(
        /provenance\.json is stale or tampered/,
      );
    });
  });

  it('derives a stable provenance digest from the generated source and files', () => {
    const generated = packageScript.buildPackage();
    expect(generated.provenance.catalogSourceDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(generated.provenance.artifactDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});
