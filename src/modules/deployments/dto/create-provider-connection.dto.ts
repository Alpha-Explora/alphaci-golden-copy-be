import type { EnvProvider } from '../core/deployments.types';

export interface CreateProviderConnectionDto {
  provider: EnvProvider;
  label: string;
  token: string;
  vercelTeamId?: string;
  vercelTeamSlug?: string;
}
