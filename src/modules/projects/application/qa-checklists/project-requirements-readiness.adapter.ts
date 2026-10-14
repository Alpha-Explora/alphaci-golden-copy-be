import { Inject, Injectable } from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import type { ProjectRequirementsReadinessPort } from '#kernel/ports/project-requirements-readiness.port';
import { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import { ProjectIterationsService } from './project-iterations.service';

/**
 * ProjectRequirementsReadinessPort: projects owns qa_checklists, so the
 * "does this Project have a Feature yet" read lives here and identity-access
 * reaches it through the kernel port. The rule is skipped (capability off)
 * when `projects.qa-checklists` is disabled for the deployment.
 */
@Injectable()
export class ProjectRequirementsReadinessAdapter implements ProjectRequirementsReadinessPort {
  constructor(
    private readonly checklists: QaChecklistsRepository,
    private readonly iterations: ProjectIterationsService,
    // Explicit token: an interface-typed constructor param emits as Object and
    // Nest would find no provider.
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver: CapabilityResolverPort,
  ) {}

  isFeatureRuleEnabled(): boolean {
    return this.capabilityResolver.deployment().has('projects.qa-checklists');
  }

  async countActiveFeatures(
    deliveryProjectIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>(
      deliveryProjectIds.map((id) => [id, 0]),
    );
    if (!this.isFeatureRuleEnabled() || deliveryProjectIds.length === 0) {
      return counts;
    }
    // Features count in each Project's current Iteration only. Read-only: a
    // Project with no Iteration yet has no Feature either.
    const current =
      await this.iterations.findCurrentForProjects(deliveryProjectIds);
    const active = await this.checklists.countActiveFeaturesByIteration(
      [...current.values()].map((iteration) => iteration.id),
    );
    for (const [id, count] of active) {
      counts.set(id, count);
    }
    return counts;
  }
}
