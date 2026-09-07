import {
  DEFAULT_CENTRAL_WORKFLOW_REPO,
  resolveCentralWorkflowBase,
  resolveCentralWorkflowRepo,
} from './central-workflow';

describe('central workflow repository resolution', () => {
  it('defaults to the repository the product runs on, so a deployment that configures nothing is still correct', () => {
    expect(resolveCentralWorkflowRepo({})).toBe('Alpha-Explora/alphaci-workflow');
    expect(resolveCentralWorkflowBase({})).toBe(
      'Alpha-Explora/alphaci-workflow/.github/workflows',
    );
  });

  // The two shapes were previously separate hardcoded constants in different
  // bounded contexts. Deriving one from the other is what makes it impossible
  // for a provider fragment and the quality stages of the same pipeline to name
  // different repositories.
  it('repoints both shapes together', () => {
    const env = { CENTRAL_WORKFLOW_REPO: 'Alpha-Explora/alphaci-workflow-staging' };

    expect(resolveCentralWorkflowRepo(env)).toBe(
      'Alpha-Explora/alphaci-workflow-staging',
    );
    expect(resolveCentralWorkflowBase(env)).toBe(
      'Alpha-Explora/alphaci-workflow-staging/.github/workflows',
    );
  });

  it('treats blank and whitespace-only values as unset rather than emitting an empty owner', () => {
    expect(resolveCentralWorkflowRepo({ CENTRAL_WORKFLOW_REPO: '' })).toBe(
      DEFAULT_CENTRAL_WORKFLOW_REPO,
    );
    expect(resolveCentralWorkflowRepo({ CENTRAL_WORKFLOW_REPO: '   ' })).toBe(
      DEFAULT_CENTRAL_WORKFLOW_REPO,
    );
  });

  it('trims a padded value so a stray newline in a deployment secret cannot break every generated uses:', () => {
    expect(
      resolveCentralWorkflowBase({
        CENTRAL_WORKFLOW_REPO: '  Alpha-Explora/alphaci-workflow-staging\n',
      }),
    ).toBe('Alpha-Explora/alphaci-workflow-staging/.github/workflows');
  });
});
