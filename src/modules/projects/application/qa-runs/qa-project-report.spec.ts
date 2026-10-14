import {
  buildQaProjectReport,
  buildQaProjectReportFilename,
  renderQaProjectReportMarkdown,
} from './qa-project-report';
import type { ProjectQaRun, ProjectQaRunItem } from './qa-runs.contracts';

const item = (overrides: Partial<ProjectQaRunItem> = {}): ProjectQaRunItem =>
  ({
    id: 'ri-1',
    runId: 'run-1',
    position: 0,
    title: 'Pay by card',
    description: null,
    targetPersona: 'all',
    verificationType: 'manual',
    testIdentifier: null,
    status: 'passed',
    notes: null,
    defectSeverity: null,
    reproductionSteps: null,
    fixRequest: null,
    verifiedBy: { id: 'qa-1', login: 'qa' },
    verifiedAt: '2026-10-01T00:00:00.000Z',
    rowVersion: 2,
    canUpdate: false,
    previous: null,
    automated: null,
    sourceItemId: 'item-1',
    requirementId: 'req-1',
    requirementName: 'Checkout',
    requirementKind: 'functional',
    acceptanceCriteria: 'Receipt | shown',
    progress: 'done',
    attachmentCount: 0,
    fixProofCount: 0,
    canAttachFixProof: false,
    ...overrides,
  }) as ProjectQaRunItem;

const run = (items: ProjectQaRunItem[]): ProjectQaRun =>
  ({
    id: 'abcdef0123',
    scope: 'project',
    deliveryProjectId: 'dp-1',
    deliveryProjectName: 'Checkout / Web',
    branch: 'uat',
    status: 'signed_off',
    createdBy: { id: 'qa-1', login: 'qa' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T01:00:00.000Z',
    summary: {
      total: items.length,
      byStatus: {
        pending: 0,
        in_progress: 0,
        passed: items.filter((i) => i.status === 'passed').length,
        failed: items.filter((i) => i.status === 'failed').length,
        blocked: 0,
        returned_to_dev: 0,
      },
      openDefects: items.filter((i) => i.status === 'failed').length,
      blockers: 0,
    },
    signoff: {
      id: 's1',
      verdict: 'REJECTED',
      summary: 'Not yet',
      conditions: null,
      signedBy: { id: 'qa-1', login: 'qa' },
      signedAt: '2026-10-01T01:00:00.000Z',
    },
    repositories: [
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        runSha: 'a'.repeat(40),
        currentSha: 'a'.repeat(40),
        moved: false,
      },
    ],
    stale: false,
    requirementsChanged: false,
    items,
    permissions: {
      canSetVerification: false,
      canSignOff: false,
      canReopen: true,
      canDispatch: false,
    },
    attachments: { enabled: true, canAdd: false, canAddFixProof: false },
    automation: { verify: null, quality: null },
    automationByRepository: [],
  }) as ProjectQaRun;

describe('qa-report/v2', () => {
  const report = buildQaProjectReport({
    generatedAt: '2026-10-01T02:00:00.000Z',
    frozen: true,
    run: run([
      item(),
      item({
        id: 'ri-2',
        position: 1,
        title: 'Refund',
        status: 'failed',
        defectSeverity: 'major',
        requirementId: 'req-2',
        requirementName: 'API checks',
        requirementKind: 'system',
      }),
    ]),
    signoffHistory: [],
  });

  it('is v1 plus repositories and the requirement on every defect', () => {
    expect(report.schemaVersion).toBe('qa-report/v2');
    expect(report.project).toEqual({ id: 'dp-1', name: 'Checkout / Web' });
    expect(report.repositories).toEqual([
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        name: 'api',
        headSha: 'a'.repeat(40),
      },
    ]);
    expect(report.summary).toMatchObject({
      totalItems: 2,
      passed: 1,
      failed: 1,
      verdict: 'REJECTED',
    });
    expect(report.defects).toEqual([
      expect.objectContaining({
        title: 'Refund',
        requirementName: 'API checks',
        requirementKind: 'system',
      }),
    ]);
  });

  it('names the file after the Project and run, sanitised', () => {
    expect(buildQaProjectReportFilename(report, 'json')).toBe(
      'QA-Report-Checkout-Web-abcdef0.json',
    );
    expect(buildQaProjectReportFilename(report, 'md')).toBe(
      'QA-Report-Checkout-Web-abcdef0.md',
    );
  });

  it('renders Markdown grouped by requirement, escaping table cells', () => {
    const markdown = renderQaProjectReportMarkdown(report);

    expect(markdown).toContain('# QA Report - Checkout / Web');
    expect(markdown).toContain('| acme/api | `aaaaaaa` |');
    expect(markdown).toContain('### Checkout (Feature)');
    expect(markdown).toContain('### API checks (System requirement)');
    expect(markdown).toContain('Receipt \\| shown');
    expect(markdown).toContain('- **Verdict:** REJECTED');
    expect(markdown).toContain('## Defects');
  });
});

describe('qa-report/v2 attachments', () => {
  const withAttachments = buildQaProjectReport({
    generatedAt: '2026-10-01T02:00:00.000Z',
    frozen: true,
    run: run([
      item({
        attachments: [
          {
            id: 'att-1',
            caption: 'Receipt | shown',
            kind: 'evidence',
            contentType: 'image/png',
          },
          {
            id: 'att-2',
            caption: null,
            kind: 'evidence',
            contentType: 'image/jpeg',
          },
          {
            id: 'att-3',
            caption: 'Receipt after the fix',
            kind: 'fix_proof',
            contentType: 'image/png',
          },
        ],
      }),
      item({ id: 'ri-2', position: 1, title: 'Refund', attachments: [] }),
    ]),
    signoffHistory: [],
  });

  it('carries items[].attachments (ids, caption, kind, content type) and no URLs', () => {
    expect(withAttachments.run.items[0]?.attachments).toEqual([
      {
        id: 'att-1',
        caption: 'Receipt | shown',
        kind: 'evidence',
        contentType: 'image/png',
      },
      {
        id: 'att-2',
        caption: null,
        kind: 'evidence',
        contentType: 'image/jpeg',
      },
      {
        id: 'att-3',
        caption: 'Receipt after the fix',
        kind: 'fix_proof',
        contentType: 'image/png',
      },
    ]);
    expect(JSON.stringify(withAttachments)).not.toMatch(/https?:\/\//);
  });

  it('labels each attachment line by kind: "QA evidence" or "Fix proof"', () => {
    const markdown = renderQaProjectReportMarkdown(withAttachments);

    expect(markdown).toContain(
      '- #1 Pay by card - QA evidence: Receipt | shown',
    );
    expect(markdown).toContain('- #1 Pay by card - QA evidence: (no caption)');
    expect(markdown).toContain(
      '- #1 Pay by card - Fix proof: Receipt after the fix',
    );
    expect(markdown.match(/- (QA evidence|Fix proof):/g)).toHaveLength(3);
  });

  it('renders a report without attachments (frozen before this existed) unchanged', () => {
    const before = buildQaProjectReport({
      generatedAt: '2026-10-01T02:00:00.000Z',
      frozen: true,
      run: run([item()]),
      signoffHistory: [],
    });

    expect(renderQaProjectReportMarkdown(before)).not.toContain('Screenshot');
  });
});
