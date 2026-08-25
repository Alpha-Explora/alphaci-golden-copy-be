import type { ProjectTokenStatus } from './infra/ci-tokens.repository';

export interface CiTokenStatusLookup {
  findProjectTokenStatus(projectId: string): Promise<ProjectTokenStatus | null>;
}

export const CI_TOKEN_STATUS_LOOKUP = Symbol('CI_TOKEN_STATUS_LOOKUP');

export type { ProjectTokenStatus };
