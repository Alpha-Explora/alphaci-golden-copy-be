import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

interface SourceRecord {
  key: string;
  context: string;
  description: string;
  maturity: string;
  configuration: string;
  configurationFlags: string[];
  requires: string[];
  editions: string[];
  surface: {
    apiField: string | null;
    viewFlag: string | null;
    domains: string[];
    routes: string[];
    featureBarrels: string[];
  };
}

const compositionSource = require(
  resolve(__dirname, '../../scripts/lib/composition-source.cjs'),
) as {
  EDITIONS: string[];
  SOURCE_PATH: string;
  REGISTRY_PATH: string;
  MANIFESTS_PATH: string;
  loadSource: () => { capabilities: SourceRecord[] };
  validateSource: (document: unknown) => string[];
  renderRegistry: (document: { capabilities: SourceRecord[] }) => string;
  renderManifests: (document: { capabilities: SourceRecord[] }) => string;
};

const committed = compositionSource.loadSource();

const clone = (): { capabilities: SourceRecord[] } =>
  JSON.parse(JSON.stringify(committed)) as { capabilities: SourceRecord[] };

const withFirst = (changes: Partial<SourceRecord>) => {
  const document = clone();
  document.capabilities[0] = { ...document.capabilities[0]!, ...changes };
  return document;
};

describe('composition authoring source', () => {
  it('accepts the committed source', () => {
    expect(compositionSource.validateSource(committed)).toEqual([]);
  });

  it('rejects a malformed record', () => {
    expect(
      compositionSource
        .validateSource(withFirst({ key: 'Identity.Workspaces' }))
        .join(' '),
    ).toMatch(/key must be lowercase/);
    expect(
      compositionSource
        .validateSource(withFirst({ maturity: 'experimental' }))
        .join(' '),
    ).toMatch(/maturity must be one of/);
    expect(
      compositionSource
        .validateSource(withFirst({ description: '  ' }))
        .join(' '),
    ).toMatch(/description is required/);
  });

  it('rejects an unknown or unordered edition list', () => {
    expect(
      compositionSource
        .validateSource(withFirst({ editions: ['partner'] }))
        .join(' '),
    ).toMatch(/editions must be drawn from/);
    expect(
      compositionSource
        .validateSource(withFirst({ editions: ['enterprise', 'saas'] }))
        .join(' '),
    ).toMatch(/editions must be listed as/);
  });

  it('rejects a dependency that is absent from a pack the capability is in', () => {
    const document = clone();
    const dependant = document.capabilities.find(
      (record) => record.requires.length > 0,
    );
    expect(dependant).toBeDefined();
    const dependency = document.capabilities.find(
      (record) => record.key === dependant!.requires[0],
    );
    dependency!.editions = dependency!.editions.filter(
      (edition) => !dependant!.editions.includes(edition),
    );

    expect(compositionSource.validateSource(document).join(' ')).toMatch(
      /but its dependency .* is not/,
    );
  });

  it('rejects self-reference, an unknown dependency, and a cycle', () => {
    const first = committed.capabilities[0]!.key;
    const second = committed.capabilities[1]!.key;

    expect(
      compositionSource
        .validateSource(withFirst({ requires: [first] }))
        .join(' '),
    ).toMatch(/cannot require itself/);
    expect(
      compositionSource
        .validateSource(withFirst({ requires: ['projects.missing'] }))
        .join(' '),
    ).toMatch(/requires unknown capability/);

    const cyclic = clone();
    cyclic.capabilities[0]!.requires = [second];
    cyclic.capabilities[1]!.requires = [first];
    cyclic.capabilities[0]!.editions = [...compositionSource.EDITIONS];
    cyclic.capabilities[1]!.editions = [...compositionSource.EDITIONS];
    expect(compositionSource.validateSource(cyclic).join(' ')).toMatch(
      /dependency cycle/,
    );
  });

  it('rejects a malformed surface', () => {
    const document = clone();
    document.capabilities[0]!.surface = {
      apiField: 7 as unknown as string,
      viewFlag: null,
      domains: [],
      routes: [],
      featureBarrels: 'all' as unknown as string[],
    };

    const errors = compositionSource.validateSource(document).join(' ');
    expect(errors).toMatch(/surface.apiField must be a string or null/);
    expect(errors).toMatch(
      /surface.featureBarrels must be an array of strings/,
    );
  });

  it('keeps the generated registry and manifests in step with the source', () => {
    // The generator formats with Prettier, whose CJS entry cannot load inside
    // the Jest VM, so the drift assertion runs the real command instead.
    const run = () =>
      execFileSync(
        process.execPath,
        [
          resolve(__dirname, '../../scripts/generate-composition-source.mjs'),
          '--check',
        ],
        { cwd: resolve(__dirname, '../..'), encoding: 'utf8' },
      );

    expect(run).not.toThrow();
    expect(run()).toContain('Checked 2 composition file(s)');
  });

  it('derives pack membership from the source', () => {
    const manifests = compositionSource.renderManifests(committed);
    for (const record of committed.capabilities) {
      if (record.editions.includes('saas')) {
        expect(manifests).toContain(JSON.stringify(record.key));
      }
    }
    expect(manifests).toContain(
      'as const satisfies Record<Edition, CapabilityManifest>',
    );
  });
});
