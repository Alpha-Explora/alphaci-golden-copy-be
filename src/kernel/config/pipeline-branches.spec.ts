import { projectPipelineBranches } from './pipeline-branches';

describe('projectPipelineBranches', () => {
  it("takes the first environment's branch as the base and scans it with the fixed tiers", () => {
    expect(
      projectPipelineBranches([
        { sourceBranch: 'develop' },
        { sourceBranch: 'main' },
      ]),
    ).toEqual({
      base: 'develop',
      branches: ['develop', 'main', 'dev', 'uat'],
    });
  });

  it('falls back to the working tier for a project with no environments', () => {
    expect(projectPipelineBranches([])).toEqual({
      base: 'dev',
      branches: ['dev', 'uat', 'main'],
    });
  });

  it('ignores a blank source branch', () => {
    expect(
      projectPipelineBranches([
        { sourceBranch: '  ' },
        { sourceBranch: 'staging' },
      ]),
    ).toMatchObject({ base: 'staging' });
  });
});
