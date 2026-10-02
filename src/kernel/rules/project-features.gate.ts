import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { ProjectRequirementsReadinessPort } from '#kernel/ports/project-requirements-readiness.port';
import { projectFeaturesRequired } from './persona-access.errors';
import { repositoryCreateRequiresFeature } from './persona-access.rules';

/**
 * The Feature gate shared by every repository-create path (the projects
 * wizard / setup paths and the hierarchy create route): a Developer files a
 * repository into a Project only once a Product owner wrote at least one
 * active Feature in it. 409 PROJECT_FEATURES_REQUIRED otherwise.
 *
 * No-ops for admins (exempt), for a create with no Project (the Project-required
 * rule answers that), and when the QA capability is off. Call it BEFORE any
 * GitHub call so a refusal never strands a repository.
 */
export async function assertProjectHasFeatureForRepositoryCreate(
  readiness: ProjectRequirementsReadinessPort,
  role: PlatformAppRole,
  deliveryProjectId: string | null | undefined,
): Promise<void> {
  if (!repositoryCreateRequiresFeature(role) || !deliveryProjectId) {
    return;
  }
  if (!readiness.isFeatureRuleEnabled()) {
    return;
  }
  const counts = await readiness.countActiveFeatures([deliveryProjectId]);
  if ((counts.get(deliveryProjectId) ?? 0) < 1) {
    throw projectFeaturesRequired(deliveryProjectId);
  }
}
