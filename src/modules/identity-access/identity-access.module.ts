import { Module, type Type } from '@nestjs/common';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { HierarchyModule } from './hierarchy/hierarchy.module';
import { HierarchyProjectLinkModule } from './hierarchy/project-link/hierarchy-project-link.module';
import { GithubRoleAccessModule } from './admin/github-role-access.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ProjectProvisioningModule } from '#modules/projects/project-provisioning.module.js';

type ProfileModule = Type<unknown>;

/**
 * The EDU auth slice is a profile-owned implementation. Keep this seam
 * dynamic so the hosted-SaaS and Enterprise TypeScript artifacts can exclude
 * the EDU source tree rather than merely hiding its routes at runtime.
 */
function profileOwnedImports(): ProfileModule[] {
  if (process.env['ALPHACI_BUILD_PROFILE'] !== 'hosted-edu') return [];

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('./auth/edu/edu-auth.module.js') as {
    EduAuthModule?: ProfileModule;
  };
  if (!loaded.EduAuthModule) {
    throw new Error(
      '[composition] hosted-edu requires the EDU authentication module',
    );
  }
  return [loaded.EduAuthModule];
}

const PROFILE_OWNED_IMPORTS = profileOwnedImports();

/**
 * Bounded-context composition root for identity and access management.
 * Feature modules remain independently testable; the application imports this
 * root rather than wiring identity features one by one.
 */
@Module({
  imports: [
    ...PROFILE_OWNED_IMPORTS,
    AuthModule,
    AdminModule,
    CapabilitiesModule,
    WorkspacesModule,
    HierarchyModule,
    HierarchyProjectLinkModule,
    GithubRoleAccessModule,
    ProjectProvisioningModule,
  ],
  exports: [
    AuthModule,
    AdminModule,
    CapabilitiesModule,
    WorkspacesModule,
    HierarchyModule,
    HierarchyProjectLinkModule,
    GithubRoleAccessModule,
    ProjectProvisioningModule,
  ],
})
export class IdentityAccessModule {}
