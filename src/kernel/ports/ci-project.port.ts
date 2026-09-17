export interface ProjectTokenStatus {
  status: 'active' | 'revoked';
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface CiTokenStatusLookup {
  findProjectTokenStatus(projectId: string): Promise<ProjectTokenStatus | null>;
}

export interface CiProjectPort {
  issueProjectToken(projectId: string): Promise<{
    token: string;
    tokenPrefix: string;
  }>;
}

export const CI_PROJECT_PORT = Symbol('CiProjectPort');
export const CI_TOKEN_STATUS_LOOKUP = Symbol('CiTokenStatusLookup');

/**
 * Validation of a pipeline's project token.
 *
 * Runtime needs this to accept a release request from a generated pipeline:
 * the caller is a workflow holding the project's ALPHACI_TOKEN, not a signed-in
 * user, and the token is the only thing that says which project it may act on.
 * Exposed as a port so Runtime never imports the CI implementation, and the
 * dependency keeps pointing Runtime -> Pipelines.
 */
export interface CiRunValidationPort {
  validateRun(input: {
    token: string;
    repoFullName: string;
    stage: string;
  }): Promise<{ authorized: boolean; projectId: string; repoFullName: string }>;
}

export const CI_RUN_VALIDATION = Symbol('CiRunValidation');
