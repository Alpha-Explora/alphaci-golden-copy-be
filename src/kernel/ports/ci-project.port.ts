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
