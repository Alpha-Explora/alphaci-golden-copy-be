import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const root = join(__dirname, '..', '..');
const workflowPath = join(
  root,
  '.github',
  'workflows',
  'onprem-agent-release.yml',
);
const manifestPath = join(
  root,
  'deploy',
  'onprem',
  'agent',
  'release-manifest.json',
);

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
}
interface WorkflowJob {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}
interface Workflow {
  permissions?: Record<string, string>;
  on: { push?: { tags?: string[] }; workflow_dispatch?: unknown };
  jobs: Record<string, WorkflowJob>;
}

const workflow = load(readFileSync(workflowPath, 'utf8')) as Workflow;
const script = (name: string) => join(root, 'scripts', name);
const allRuns = () =>
  Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.run ?? '')
    .join('\n');
const checkTag = (tag: string) =>
  spawnSync(process.execPath, [script('check-onprem-agent-tag.mjs'), tag], {
    encoding: 'utf8',
  });

describe('on-prem agent release workflow', () => {
  it('runs on onprem-agent tags and on manual dispatch', () => {
    expect(workflow.on.push?.tags).toEqual(['onprem-agent-v*']);
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });

  it('packages the installer with the packaging script', () => {
    expect(existsSync(script('package-onprem-agent.mjs'))).toBe(true);
    expect(allRuns()).toContain('node scripts/package-onprem-agent.mjs');
  });

  it('checks a tag against the installer manifest only on tag builds', () => {
    const check = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .find((step) => step.run?.includes('check-onprem-agent-tag.mjs'));
    expect(check?.if).toBe("github.ref_type == 'tag'");
    expect(check?.run).toBe('node scripts/check-onprem-agent-tag.mjs "$TAG"');
    expect(existsSync(script('check-onprem-agent-tag.mjs'))).toBe(true);
  });

  it('accepts the tag that matches the manifest and rejects any other', () => {
    const { version } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string;
    };
    expect(checkTag(`onprem-agent-v${version}`).status).toBe(0);
    expect(checkTag('onprem-agent-v9.9.9').status).toBe(1);
    expect(checkTag(`onprem-agent-v${version}-rc.1`).status).toBe(1);
    expect(checkTag(`v${version}`).status).toBe(1);
  });

  it('rejects a run with no tag argument', () => {
    const result = spawnSync(
      process.execPath,
      [script('check-onprem-agent-tag.mjs')],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
  });

  it('attaches the archive, its checksum, and installer-release.json to the release', () => {
    const publish = workflow.jobs.publish?.steps
      .map((step) => step.run ?? '')
      .join('\n');
    expect(publish).toContain('alphaci-agent-*.tar.gz');
    expect(publish).toContain('alphaci-agent-*.tar.gz.sha256');
    expect(publish).toContain('installer-release.json');
    expect(workflow.jobs.publish?.if).toBe("github.ref_type == 'tag'");
  });

  it('names release assets exactly as the packaging script writes them', () => {
    const packaging = readFileSync(script('package-onprem-agent.mjs'), 'utf8');
    expect(packaging).toContain('.sha256');
    expect(packaging).toContain("'installer-release.json'");
    expect(packaging).toContain('alphaci-agent-${release.version}.tar.gz');
  });

  it('grants release write access only to the publish job', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.package?.permissions).toBeUndefined();
    expect(workflow.jobs.publish?.permissions).toEqual({ contents: 'write' });
  });
});
