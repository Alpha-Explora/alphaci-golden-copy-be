import { resolve } from 'node:path';

import {
  PACK_ARTIFACT_INVENTORY,
  artifactExclusionsFor,
} from '../../src/kernel/composition/build-profile.js';

const conformanceScript = require(
  resolve(__dirname, '../../scripts/check-build-profile-conformance.cjs'),
) as {
  createProfileTsConfig: (
    outputDirectory: string,
    excludedSourceRoots: readonly string[],
  ) => {
    compilerOptions: {
      paths: Record<string, readonly string[]>;
    };
    exclude: readonly string[];
  };
};

describe('build profile conformance configuration', () => {
  it.each(['hosted-saas', 'hosted-edu', 'enterprise'] as const)(
    'adds every declared root for absent packs to the generated %s tsconfig exclude list',
    (profile) => {
      const exclusions = artifactExclusionsFor(
        profile,
        PACK_ARTIFACT_INVENTORY,
      );
      const config = conformanceScript.createProfileTsConfig(
        'temporary-profile-output',
        exclusions.sourceRoots,
      );

      expect(config.exclude).toEqual(
        expect.arrayContaining(exclusions.sourceRoots),
      );
      expect(config.compilerOptions.paths).toEqual({
        '#kernel/*': ['src/kernel/*'],
        '#modules/*': ['src/modules/*'],
      });
    },
  );
});
