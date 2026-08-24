import type { EnvProvider } from '../deployments.types';

export interface CreateProviderConnectionDto {
  provider: EnvProvider;
  label: string;
  token: string;
  vercelTeamId?: string;
  vercelTeamSlug?: string;
}
