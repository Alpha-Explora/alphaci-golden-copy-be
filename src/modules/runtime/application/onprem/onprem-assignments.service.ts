import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WORKSPACE_ACCESS_PORT,
  type WorkspaceAccessPort,
} from '#kernel/ports/workspaces.port';
import {
  APP_ROLE_LOOKUP,
  type AppRoleLookup,
} from '#kernel/ports/app-role.port';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  DEPLOYMENT_TARGETS_QUERY,
  type DeploymentProjectReferenceLookup,
  type DeploymentTargetsQuery,
} from '#kernel/ports/deployment-runtime.port';
import type {
  AssignmentConfig,
  OnpremAssignmentPort,
} from '#kernel/ports/onprem-assignment.port';
import { canManageHosting } from '#kernel/rules/persona-access.rules';
import { OnpremAssignmentsRepository } from '../../infrastructure/repositories/onprem-assignments.repository';

export function validateAssignmentConfig(
  config: AssignmentConfig,
  slots: string[],
  production: boolean,
) {
  if (
    !Array.isArray(config?.ports) ||
    !config.ports.length ||
    config.ports.length !== slots.length
  )
    throw new BadRequestException(
      'Configure one port mapping for each target slot.',
    );
  const seen = new Set<string>(),
    ports = new Set<number>();
  for (const port of config.ports) {
    if (!port || !slots.includes(port.slot) || seen.has(port.slot))
      throw new BadRequestException(
        'Port slots must match the environment targets exactly.',
      );
    seen.add(port.slot);
    if (
      !Number.isInteger(port.hostPort) ||
      !Number.isInteger(port.containerPort) ||
      port.hostPort < 1 ||
      port.hostPort > 65535 ||
      port.containerPort < 1 ||
      port.containerPort > 65535 ||
      ports.has(port.hostPort)
    )
      throw new BadRequestException(
        'Ports must be distinct integers from 1 to 65535.',
      );
    ports.add(port.hostPort);
  }
  if (!Array.isArray(config.health) || config.health.length !== slots.length)
    throw new BadRequestException(
      'Record a health path or explicitly mark it absent for every target.',
    );
  const healthSlots = new Set<string>();
  for (const health of config.health) {
    if (
      !health ||
      !slots.includes(health.slot) ||
      healthSlots.has(health.slot) ||
      (health.path !== null &&
        (typeof health.path !== 'string' ||
          !/^\/(?!\/)[A-Za-z0-9/_?.=&%-]*$/.test(health.path) ||
          health.path.includes('..') ||
          /%(?:2e|2f|5c)/i.test(health.path)))
    )
      throw new BadRequestException(
        'Health paths must stay within the assigned application.',
      );
    healthSlots.add(health.slot);
  }
  if (
    !config.ingress ||
    !['direct', 'configured'].includes(config.ingress.mode)
  )
    throw new BadRequestException(
      'Select direct access or configured ingress.',
    );
  if (config.ingress.publicUrl !== null) {
    let url: URL;
    try {
      url = new URL(config.ingress.publicUrl);
    } catch {
      throw new BadRequestException('Ingress URL is invalid.');
    }
    if (
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new BadRequestException(
        'Ingress URL must be HTTP or HTTPS without credentials.',
      );
  }
  if (
    production &&
    (config.ingress.mode !== 'configured' ||
      !config.ingress.publicUrl?.startsWith('https://'))
  )
    throw new BadRequestException(
      'Production requires an explicitly configured HTTPS ingress URL.',
    );
}

@Injectable()
export class OnpremAssignmentsService implements OnpremAssignmentPort {
  constructor(
    private readonly repository: OnpremAssignmentsRepository,
    @Inject(WORKSPACE_ACCESS_PORT) private readonly access: WorkspaceAccessPort,
    @Inject(APP_ROLE_LOOKUP) private readonly roles: AppRoleLookup,
    @Inject(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP)
    private readonly projects: DeploymentProjectReferenceLookup,
    @Inject(DEPLOYMENT_TARGETS_QUERY)
    private readonly targets: DeploymentTargetsQuery,
    private readonly config: ConfigService,
  ) {}
  async current(projectId: string, environmentId: string, userId: string) {
    await this.visible(projectId, environmentId, userId);
    return this.repository.current(projectId, environmentId);
  }
  async assign(
    projectId: string,
    environmentId: string,
    userId: string,
    input: {
      machineId: string;
      expectedAssignmentId: string | null;
      requestId: string;
      config: AssignmentConfig;
    },
  ) {
    const environment = await this.visible(projectId, environmentId, userId);
    const membership = await this.manager(projectId, userId);
    if (
      (await this.repository.machineWorkspace(input.machineId)) !==
      membership.workspaceId
    )
      throw new NotFoundException(
        'Active machine not found in this workspace.',
      );
    const targets = (
      await this.targets.listDeploymentTargets(projectId)
    ).filter((target) => target.environmentId === environmentId);
    if (
      !targets.length ||
      targets.some((target) => target.provider !== 'onprem-compose')
    )
      throw new BadRequestException(
        'All environment targets must use on-prem Compose.',
      );
    validateAssignmentConfig(
      input.config,
      targets.map((target) => target.slot),
      environment.role === 'production',
    );
    return this.repository.assign({
      ...input,
      projectId,
      environmentId,
      userId,
      workspaceId: membership.workspaceId,
    });
  }
  async unassign(
    projectId: string,
    environmentId: string,
    userId: string,
    expectedId: string,
  ) {
    await this.visible(projectId, environmentId, userId);
    await this.manager(projectId, userId);
    await this.repository.unassign(projectId, environmentId, expectedId);
  }
  async assignProvisionedEnvironment(
    projectId: string,
    environmentId: string,
    userId: string,
    input: { machineId: string; requestId: string; config: AssignmentConfig },
  ) {
    const result = await this.assign(projectId, environmentId, userId, {
      ...input,
      expectedAssignmentId: null,
    });
    return { assignmentId: result.id };
  }
  private async visible(
    projectId: string,
    environmentId: string,
    userId: string,
  ) {
    if (this.config.get('ONPREM_RELEASES_ENABLED') !== 'true')
      throw new ForbiddenException('On-prem delivery is disabled.');
    if (!(await this.projects.findProjectReference(projectId, userId)))
      throw new NotFoundException('Project not found.');
    const environment = await this.projects.findProjectEnvironment(
      projectId,
      environmentId,
    );
    if (!environment) throw new NotFoundException('Environment not found.');
    return environment;
  }
  private async manager(projectId: string, userId: string) {
    if (!canManageHosting(await this.roles.findAppRole(userId)))
      throw new ForbiddenException(
        'Your application role cannot manage hosting.',
      );
    const membership = await this.access.assertProjectRole(projectId, userId, [
      'admin',
      'delegated_lead',
      'member',
    ]);
    if (!membership)
      throw new ForbiddenException(
        'Reusable hosts require a workspace project.',
      );
    return membership;
  }
}
