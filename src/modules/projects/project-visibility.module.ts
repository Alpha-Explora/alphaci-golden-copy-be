import { Global, Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { APP_ROLE_LOOKUP } from '#kernel/ports/app-role.port';
import { PROJECT_VISIBILITY_LOOKUP } from '#kernel/ports/project-visibility.port';
import { ProjectsRepository } from './infrastructure/projects.repository';

/**
 * Composition-only ACL: Projects owns provisioned_projects and the
 * role-aware visibility predicate on it; Pipelines' CI reports service
 * needs to reuse it for GET /ci/runs (see ci-reports.service.ts's
 * assertOwnership) without depending on the Projects module — ProjectsModule
 * already imports CiModule (for CiService), so CiModule importing
 * ProjectsModule back would be a cross-context cycle dependency-cruiser's
 * no-cross-context-cycles rule forbids.
 *
 * Wired globally instead, same pattern as ProjectReferenceModule /
 * DEPLOYMENT_PROJECT_REFERENCE_LOOKUP: Pipelines does not import this
 * module; the root application graph (via ProjectsModule importing it below)
 * wires it globally, and any module can @Inject(PROJECT_VISIBILITY_LOOKUP)
 * without adding an import edge.
 *
 * Also carries APP_ROLE_LOOKUP (identity.app_users.app_role, platform_admins
 * override folded in — see ProjectsRepository.findAppRole) for the same
 * reason and the same way: Runtime's env-vars/deployment-secrets gates (see
 * persona-access.rules.ts in kernel/rules/) need the caller's global persona,
 * and Projects already imports Runtime (RuntimeModule), so the reverse
 * import would close a cross-context cycle.
 *
 * ProjectsRepository is re-declared as a provider here (not exported from
 * ProjectsModule) rather than imported from it — stateless wrapper around
 * the DatabaseService singleton, so a second instance is harmless; see the
 * identical justification on QaChecklistsModule.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    ProjectsRepository,
    {
      provide: PROJECT_VISIBILITY_LOOKUP,
      useExisting: ProjectsRepository,
    },
    {
      provide: APP_ROLE_LOOKUP,
      useExisting: ProjectsRepository,
    },
  ],
  exports: [PROJECT_VISIBILITY_LOOKUP, APP_ROLE_LOOKUP],
})
export class ProjectVisibilityModule {}
