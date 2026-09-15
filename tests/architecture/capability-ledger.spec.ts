import { resolve } from 'node:path';

interface LedgerEntry {
  date: string;
  change: string;
  keys: string[];
  summary: string;
  reference: string;
  compositionHash: string;
}

const ledgerGate = require(
  resolve(__dirname, '../../scripts/lib/capability-ledger.cjs'),
) as {
  CHANGE_TYPES: string[];
  compositionHash: (state: {
    capabilities: Array<Record<string, unknown>>;
  }) => string;
  compositionState: () => {
    capabilities: Array<{ key: string; maturity: string; editions: string[] }>;
  };
  readLedger: () => { entries: LedgerEntry[] };
  validateLedger: (
    ledger: unknown,
    currentHash: string,
    knownKeys: ReadonlySet<string>,
  ) => string[];
};

const state = ledgerGate.compositionState();
const currentHash = ledgerGate.compositionHash(state);
const knownKeys = new Set(state.capabilities.map((record) => record.key));
const committed = ledgerGate.readLedger();

const entryFor = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  date: '2026-09-16',
  change: 'added',
  keys: [state.capabilities[0]!.key],
  summary: 'Added a capability.',
  reference: 'CHANGELOG.md',
  compositionHash: currentHash,
  ...overrides,
});

const ledgerOf = (...entries: LedgerEntry[]) => ({
  entries: [
    {
      date: '2026-09-15',
      change: 'baseline',
      keys: [],
      summary: 'Baseline.',
      reference: 'adr-0007-runtime-composition-resolution.md',
      compositionHash: currentHash,
    },
    ...entries,
  ],
});

describe('capability ledger', () => {
  it('accepts the committed ledger for the current catalog', () => {
    expect(
      ledgerGate.validateLedger(committed, currentHash, knownKeys),
    ).toEqual([]);
  });

  it('rejects a catalog that moved without a new entry', () => {
    const errors = ledgerGate.validateLedger(
      committed,
      'sha256:' + 'a'.repeat(64),
      knownKeys,
    );

    expect(errors.join(' ')).toMatch(
      /changed without a ledger entry.*ledger:record/s,
    );
  });

  it('requires a baseline first and only once', () => {
    expect(
      ledgerGate.validateLedger(
        { entries: [entryFor()] },
        currentHash,
        knownKeys,
      ),
    ).toContain('entry 0: the first entry must be a baseline');

    expect(
      ledgerGate.validateLedger(
        ledgerOf(entryFor({ change: 'baseline', keys: [] })),
        currentHash,
        knownKeys,
      ),
    ).toContain('entry 1: only the first entry may be a baseline');
  });

  it('rejects dates that move backwards', () => {
    expect(
      ledgerGate.validateLedger(
        ledgerOf(entryFor({ date: '2026-09-14' })),
        currentHash,
        knownKeys,
      ),
    ).toContain('entry 1: dates must not move backwards');
  });

  it('rejects a malformed entry', () => {
    const errors = ledgerGate.validateLedger(
      ledgerOf(
        entryFor({
          change: 'invented',
          summary: '   ',
          compositionHash: 'sha256:short',
        }),
      ),
      currentHash,
      knownKeys,
    );

    expect(errors.join(' ')).toMatch(/change must be one of/);
    expect(errors.join(' ')).toMatch(/summary is required/);
    expect(errors.join(' ')).toMatch(/compositionHash must be/);
  });

  it('names an unknown key only when the capability still exists', () => {
    expect(
      ledgerGate
        .validateLedger(
          ledgerOf(entryFor({ keys: ['projects.retired'] })),
          currentHash,
          knownKeys,
        )
        .join(' '),
    ).toMatch(/names unknown capability 'projects.retired'/);

    expect(
      ledgerGate.validateLedger(
        ledgerOf(entryFor({ change: 'removed', keys: ['projects.retired'] })),
        currentHash,
        knownKeys,
      ),
    ).toEqual([]);
  });

  it('hashes catalog facts rather than prose', () => {
    const renamedDescription = {
      capabilities: state.capabilities.map((record) => ({ ...record })),
    };
    const movedMembership = {
      capabilities: state.capabilities.map((record, index) =>
        index === 0 ? { ...record, editions: [] } : { ...record },
      ),
    };

    expect(ledgerGate.compositionHash(renamedDescription)).toBe(currentHash);
    expect(ledgerGate.compositionHash(movedMembership)).not.toBe(currentHash);
  });
});
