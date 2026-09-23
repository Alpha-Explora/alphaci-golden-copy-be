import { Module } from '@nestjs/common';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { DirectoryModule } from './directory/directory.module';
import { HierarchyModule } from './hierarchy/hierarchy.module';
import { HierarchyProjectLinkModule } from './hierarchy/project-link/hierarchy-project-link.module';
import { GithubRoleAccessModule } from './admin/github-role-access.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ProjectProvisioningModule } from '#modules/projects/project-provisioning.module.js';

/**
 * Bounded-context composition root for identity and access management.
 * Feature modules remain independently testable; the application imports this
 * root rather than wiring identity features one by one.
 */
@Module({
  imports: [
    AuthModule,
    AdminModule,
    CapabilitiesModule,
    DirectoryModule,
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
    DirectoryModule,
    WorkspacesModule,
    HierarchyModule,
    HierarchyProjectLinkModule,
    GithubRoleAccessModule,
    ProjectProvisioningModule,
  ],
})
export class IdentityAccessModule {}
