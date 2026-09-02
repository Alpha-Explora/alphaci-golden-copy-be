import type { EnvLane, EnvVarInput } from '../../core/deployments.types';

export interface ProvisionEnvVarsDto {
  deploymentTargetId: string;
  lane: EnvLane;
  /**
   * Branch these values apply to. Required for the preview lane, rejected for
   * production — see EnvVarsService.resolveScope, which is the single place
   * that pairing is validated.
   */
  gitBranch?: string | null;
  vars: EnvVarInput[];
}
