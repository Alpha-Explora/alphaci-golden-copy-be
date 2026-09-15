#!/usr/bin/env node
'use strict';

/**
 * Checks every declared build profile by compiling an isolated, profile-aware
 * TypeScript artifact and scanning that artifact. Tests and the composition
 * policy declaration are excluded because neither is pack-owned implementation
 * code. The inventory currently contains reservations only; no pack-exclusive
 * implementation source exists in this checkout. The generated profile config
 * still excludes every declared root for an absent pack so future pack source
 * cannot enter that profile artifact by default.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE_PROFILE_EXCLUDES = [
  'node_modules',
  'test',
  'tests',
  'dist',
  '**/*.spec.ts',
  '**/*.e2e-spec.ts',
];

function createProfileTsConfig(outputDirectory, excludedSourceRoots = []) {
  return {
    extends: './tsconfig.build.json',
    compilerOptions: {
      outDir: outputDirectory,
      incremental: false,
    },
    include: ['src'],
    exclude: [...BASE_PROFILE_EXCLUDES, ...excludedSourceRoots],
  };
}

function loadCompiledComposition(excludedSourceRoots = []) {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'alphaci-profile-build-'),
  );
  const profileConfig = path.join(
    ROOT,
    `tsconfig.profile.${path.basename(outputDirectory)}.json`,
  );
  fs.writeFileSync(
    profileConfig,
    `${JSON.stringify(
      createProfileTsConfig(outputDirectory, excludedSourceRoots),
      null,
      2,
    )}\n`,
    'utf8',
  );
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [tsc, '-p', profileConfig],
      { cwd: ROOT, encoding: 'utf8' },
    );
  } finally {
    fs.rmSync(profileConfig, { force: true });
  }
  if (result.status !== 0) {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
    throw new Error(`isolated profile build failed: ${result.stderr || result.stdout}`);
  }

  const compiled = (file) => require(path.join(outputDirectory, 'src/kernel/composition', file));
  const composition = {
    capabilities: compiled('capability-registry.js').CAPABILITIES,
    manifests: compiled('manifests.js').PACK_MANIFESTS,
    profiles: compiled('build-profile.js'),
    resolver: compiled('capability-resolver.js').resolveCapabilities,
    scanner: compiled('artifact-exclusion.js').assertArtifactExclusionsAbsent,
  };
  return { outputDirectory, composition };
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function compiledArtifactEntries(outputDirectory) {
  const policyFiles = new Set(['src/kernel/composition/build-profile.js']);
  return filesUnder(outputDirectory)
    .filter((file) => /\.(?:js|mjs|cjs)$/.test(file))
    .map((file) => ({
      path: path.relative(outputDirectory, file).replaceAll('\\', '/'),
      content: fs.readFileSync(file, 'utf8'),
    }))
    .filter((entry) => !policyFiles.has(entry.path));
}

function allEnabledConfig(capabilities, profile, edition) {
  const config = { composition: { profile, edition } };
  for (const capability of capabilities) {
    for (const flag of capability.configurationFlags) {
      let current = config;
      const segments = flag.split('.');
      for (const segment of segments.slice(0, -1)) {
        current[segment] ??= {};
        current = current[segment];
      }
      current[segments.at(-1)] = true;
    }
  }
  return config;
}

function expectedResolvedKeys(capabilities, manifests, edition) {
  const notImplemented = new Set(
    capabilities.filter((capability) => capability.maturity === 'not-implemented').map(
      (capability) => capability.key,
    ),
  );
  return manifests[edition].capabilities.filter(
    (key) => !notImplemented.has(key),
  );
}

function checkProfile(profile, entries, composition) {
  const { capabilities, manifests, profiles, resolver, scanner } = composition;
  if (entries.length === 0) {
    throw new Error(`profile '${profile}' produced no compiled artifact entries`);
  }
  const editions = profiles.BUILD_PROFILES[profile].editions;
  const results = [];
  for (const edition of editions) {
    const manifest = manifests[edition];
    profiles.assertManifestWithinBuildProfile(profile, manifest);
    const actual = [
      ...resolver({
        manifest,
        config: allEnabledConfig(capabilities, profile, edition),
      }),
    ];
    const expected = expectedResolvedKeys(capabilities, manifests, edition);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${profile}/${edition} resolved keys differ from the manifest projection`,
      );
    }
    scanner({ profile, entries });
    const exclusions = profiles.artifactExclusionsFor(profile);
    results.push({
      edition,
      capabilityCount: actual.length,
      excludedSourceRoots: exclusions.sourceRoots.length,
      excludedSymbols: exclusions.symbols.length,
      artifactEquivalent: 'compiled-output',
    });
  }
  return results;
}

function runConformance() {
  const baseline = loadCompiledComposition();
  const profileBuilds = [];
  try {
    return Object.fromEntries(
      Object.keys(baseline.composition.profiles.BUILD_PROFILES).map((profile) => {
        const exclusions = baseline.composition.profiles.artifactExclusionsFor(profile);
        const profileBuild = loadCompiledComposition(exclusions.sourceRoots);
        profileBuilds.push(profileBuild);
        return [
          profile,
          checkProfile(
            profile,
            compiledArtifactEntries(profileBuild.outputDirectory),
            profileBuild.composition,
          ),
        ];
      }),
    );
  } finally {
    for (const profileBuild of profileBuilds) {
      fs.rmSync(profileBuild.outputDirectory, { recursive: true, force: true });
    }
    fs.rmSync(baseline.outputDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const result = runConformance();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const [profile, editions] of Object.entries(result)) {
      for (const item of editions) {
        console.log(
          `Profile ${profile}/${item.edition} OK (${item.capabilityCount} resolved capabilities; compiled-output artifact scan; ${item.excludedSourceRoots} declared excluded roots, ${item.excludedSymbols} declared excluded symbols absent).`,
        );
      }
    }
  }
}

module.exports = {
  allEnabledConfig,
  checkProfile,
  compiledArtifactEntries,
  createProfileTsConfig,
  expectedResolvedKeys,
  runConformance,
};
