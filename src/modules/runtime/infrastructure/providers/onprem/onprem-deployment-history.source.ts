import { Injectable } from '@nestjs/common';
import type { DeploymentHistorySource } from '../../../application/ports/deployment-history-source.port';
import type { DeploymentTargetSummary } from '../../../core/deployments.types';
import { ReleaseRegistryRepository } from '../../repositories/release-registry.repository';
import { ONPREM_COMPOSE_PROVIDER_ID } from './onprem-compose.provider';

@Injectable()
export class OnpremDeploymentHistorySource implements DeploymentHistorySource {
  readonly provider = ONPREM_COMPOSE_PROVIDER_ID;
  constructor(private readonly releases: ReleaseRegistryRepository) {}

  read(target: DeploymentTargetSummary) {
    return this.releases.listTargetDeploymentHistory(
      target.projectId,
      target.id,
    );
  }
}
