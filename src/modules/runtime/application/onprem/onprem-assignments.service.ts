import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
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
  type ServiceRuntimeContract,
} from '#kernel/ports/deployment-runtime.port';
import type {
  AssignmentRequestConfig,
  OnpremAssignmentPort,
} from '#kernel/ports/onprem-assignment.port';
import {
  onpremAppsAddress,
  resolveOnpremAppsDomain,
  type OnpremAppsDomain,
} from '#kernel/config/onprem-apps-domain';
import { canManageHosting } from '#kernel/rules/persona-access.rules';
import {
  effectivePublicAddress,
  servedSlot,
  tunnelReport,
} from '../../domain/onprem-tunnel';
import {
  OnpremAssignmentsRepository,
  requestedConfig,
  type CurrentMachineAssignment,
  type MachineAssignment,
} from '../../infrastructure/repositories/onprem-assignments.repository';

const ONPREM_COMPOSE = 'onprem-compose';

/**
 * Container port and health path for a slot whose app has no known contract:
 * a repository AlphaCI did not scaffold (imported or brought by the customer),
 * or a slot the project's scaffold does not fill. The values are a guess, so
 * Hosting shows them for a person to correct.
 */
function fallbackSlotRuntime(slot: 'frontend' | 'backend') {
  return { containerPort: slot === 'frontend' ? 3000 : 4000, healthPath: '/' };
}

/**
 * What an environment gets when nobody chose: one port and health path per
 * slot. A slot the project's scaffold fills takes that app's port and health
 * path (`serviceRuntime`); any other slot takes the fallback.
 */
export function defaultAssignmentConfig(
  slots: ReadonlyArray<string>,
  serviceRuntime?: ServiceRuntimeContract | null,
): AssignmentRequestConfig {
  const known = slots.filter(
    (slot): slot is 'frontend' | 'backend' =>
      slot === 'frontend' || slot === 'backend',
  );
  const runtime = (slot: 'frontend' | 'backend') =>
    serviceRuntime?.slot === slot ? serviceRuntime : fallbackSlotRuntime(slot);
  return {
    ports: known.map((slot) => ({
      slot,
      containerPort: runtime(slot).containerPort,
    })),
    health: known.map((slot) => ({ slot, path: runtime(slot).healthPath })),
    // A frontend is what people open, from QA Studio and their own browsers,
    // so it gets the automatic HTTPS address. Direct access only answers on
    // the machine's own network, which left every new environment with no
    // address anyone else could reach. A backend alone stays direct: its
    // frontend reaches it over the machine's private service link.
    ingress: known.includes('frontend')
      ? { mode: 'tunnel', publicUrl: null }
      : { mode: 'direct', publicUrl: null },
  };
}

/**
 * `https://<environment>-<repository>.<apps domain>`, and for production the
 * plain `https://<repository>.<apps domain>` (each with `-<suffix>` before the
 * domain when ONPREM_APPS_LABEL_SUFFIX is set): one DNS label, so a single
 * wildcard record (`*.<apps domain>`) covers them all, or with a suffix one
 * record per name, and a certificate per name.
 */
export function appsDomainAddress(
  apps: OnpremAppsDomain,
  environmentSlug: string,
  repoFullName: string,
  production = false,
): string {
  const repo = repoFullName.split('/').at(-1) ?? repoFullName;
  return onpremAppsAddress(
    apps,
    production ? repo : `${environmentSlug}-${repo}`,
  );
}

/**
 * "The automatic HTTPS address", made concrete for this server. With
 * ONPREM_APPS_DOMAIN set (AlphaCI and its deployments on the customer's own
 * server, `*.<domain>` pointing at it) it is a permanent address under that
 * domain, which the server's proxy routes to the environment; without it, the
 * machine's Cloudflare quick tunnel, whose address changes when it restarts.
 */
export function withAppsDomain(
  config: AssignmentRequestConfig,
  apps: OnpremAppsDomain | undefined,
  environmentSlug: string,
  repoFullName: string,
  production = false,
): AssignmentRequestConfig {
  if (!apps || config.ingress?.mode !== 'tunnel') return config;
  return {
    ...config,
    ingress: {
      mode: 'configured',
      publicUrl: appsDomainAddress(
        apps,
        environmentSlug,
        repoFullName,
        production,
      ),
    },
  };
}

/** Host ports are not part of a request: the server allocates them. */
export function validateAssignmentConfig(
  config: AssignmentRequestConfig,
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
  const seen = new Set<string>();
  for (const port of config.ports) {
    if (!port || !slots.includes(port.slot) || seen.has(port.slot))
      throw new BadRequestException(
        'Port slots must match the environment targets exactly.',
      );
    seen.add(port.slot);
    if (
      !Number.isInteger(port.containerPort) ||
      port.containerPort < 1 ||
      port.containerPort > 65535
    )
      throw new BadRequestException(
        'Container ports must be integers from 1 to 65535.',
      );
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
    !(['direct', 'configured', 'tunnel'] as string[]).includes(
      config.ingress.mode,
    )
  )
    throw new BadRequestException(
      'Select direct access, configured ingress, or the automatic HTTPS address.',
    );
  // The machine reports a tunnel's address; a client never sets it.
  if (config.ingress.mode === 'tunnel' && config.ingress.publicUrl !== null)
    throw new BadRequestException(
      'The automatic HTTPS address is reported by the machine, so no public URL can be set.',
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
  // A tunnel's HTTPS address exists once the machine reports it, so the
  // requirement is checked then, by readiness, not when the assignment is saved.
  if (
    production &&
    config.ingress.mode !== 'tunnel' &&
    (config.ingress.mode !== 'configured' ||
      !config.ingress.publicUrl?.startsWith('https://'))
  )
    throw new BadRequestException(
      'Production requires an HTTPS address: a configured HTTPS ingress URL or the automatic HTTPS address.',
    );
}

/** A just-saved assignment has no tunnel report yet. */
function presented(assignment: MachineAssignment): CurrentMachineAssignment {
  return {
    ...assignment,
    tunnel:
      assignment.config.ingress.mode === 'tunnel'
        ? tunnelReport({
            status: null,
            url: null,
            message: null,
            reportedAt: null,
            fresh: false,
          })
        : null,
  };
}

@Injectable()
export class OnpremAssignmentsService implements OnpremAssignmentPort {
  private readonly logger = new Logger(OnpremAssignmentsService.name);
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
  /** ONPREM_APPS_DOMAIN: its addresses point at this server, which routes them. */
  private appsDomain(): OnpremAppsDomain | undefined {
    return resolveOnpremAppsDomain((key) => this.config.get<string>(key));
  }
  async current(projectId: string, environmentId: string, userId: string) {
    await this.visible(projectId, environmentId, userId);
    return this.repository.current(projectId, environmentId);
  }
  /**
   * The container port and health path per slot that an assignment of this
   * environment starts from, the same ones automatic assignment uses. Hosting
   * pre-fills its form with them.
   */
  async defaults(
    projectId: string,
    environmentId: string,
    userId: string,
  ): Promise<Pick<AssignmentRequestConfig, 'ports' | 'health'>> {
    const { project } = await this.visible(projectId, environmentId, userId);
    const slots = await this.onpremSlots(projectId, environmentId);
    if (!slots)
      throw new BadRequestException(
        'All environment targets must use on-prem Compose.',
      );
    const { ports, health } = defaultAssignmentConfig(
      slots,
      project.serviceRuntime,
    );
    return { ports, health };
  }
  async assign(
    projectId: string,
    environmentId: string,
    userId: string,
    input: {
      /** Omitted: the workspace's only healthy machine. */
      machineId?: string | null;
      expectedAssignmentId: string | null;
      requestId: string;
      config: AssignmentRequestConfig;
    },
  ) {
    const { environment, project } = await this.visible(
      projectId,
      environmentId,
      userId,
    );
    input = {
      ...input,
      config: withAppsDomain(
        input.config,
        this.appsDomain(),
        environment.slug,
        project.repoFullName,
        environment.role === 'production',
      ),
    };
    const membership = await this.manager(projectId, userId);
    const machineId = input.machineId ?? null;
    if (
      machineId &&
      (await this.repository.machineWorkspace(machineId)) !==
        membership.workspaceId
    )
      throw new NotFoundException(
        'Active machine not found in this workspace.',
      );
    const slots = await this.onpremSlots(projectId, environmentId);
    if (!slots)
      throw new BadRequestException(
        'All environment targets must use on-prem Compose.',
      );
    validateAssignmentConfig(
      input.config,
      slots,
      environment.role === 'production',
    );
    const result = await this.repository.assign({
      ...input,
      machineId,
      config: requestedConfig(input.config),
      projectId,
      environmentId,
      userId,
      workspaceId: membership.workspaceId,
    });
    return presented(result);
  }
  async ensureAutomaticAssignment(
    projectId: string,
    environmentId: string,
    userId: string,
  ): Promise<{ assignmentId: string } | null> {
    if (this.config.get('ONPREM_RELEASES_ENABLED') !== 'true') return null;
    try {
      const { environment, project } = await this.visible(
        projectId,
        environmentId,
        userId,
      );
      const slots = await this.onpremSlots(projectId, environmentId);
      if (!slots) return null;
      const current = await this.repository.current(projectId, environmentId);
      if (current?.config) {
        const assigned: string[] = current.config.ports.map(
          (port) => port.slot,
        );
        if (
          assigned.length === slots.length &&
          slots.every((slot) => assigned.includes(slot))
        )
          return { assignmentId: current.id };
        // A slot was added or removed: reassign on the same machine. Kept
        // slots keep their settings and host ports; new ones get defaults.
        const defaults = defaultAssignmentConfig(slots, project.serviceRuntime);
        const config = current.config;
        const result = await this.assign(projectId, environmentId, userId, {
          machineId: current.machineId,
          expectedAssignmentId: current.id,
          requestId: randomUUID(),
          config: {
            ...config,
            ports: defaults.ports.map(
              (port) =>
                config.ports.find((item) => item.slot === port.slot) ?? port,
            ),
            health: defaults.health.map(
              (item) =>
                config.health.find((old) => old.slot === item.slot) ?? item,
            ),
          },
        });
        return { assignmentId: result.id };
      }
      // A legacy host keeps its registration until a person replaces it.
      // Production needs an HTTPS address, so it is only assigned here when
      // this server has an apps domain to give it a permanent one.
      const appsDomain = this.appsDomain();
      if (current || (environment.role === 'production' && !appsDomain))
        return null;
      const membership = await this.manager(projectId, userId);
      const healthy = await this.repository.healthyMachines(
        membership.workspaceId,
      );
      if (healthy.length !== 1) return null;
      const result = await this.assign(projectId, environmentId, userId, {
        machineId: null,
        expectedAssignmentId: null,
        requestId: randomUUID(),
        // "tunnel" is the automatic HTTPS address; with an apps domain,
        // assign() makes it a permanent name under that domain.
        config: appsDomain
          ? {
              ...defaultAssignmentConfig(slots, project.serviceRuntime),
              ingress: { mode: 'tunnel', publicUrl: null },
            }
          : defaultAssignmentConfig(slots, project.serviceRuntime),
      });
      return { assignmentId: result.id };
    } catch (error) {
      // A convenience only: Hosting still offers the explicit assignment.
      this.logger.warn(
        `Automatic host assignment skipped for environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
  /** The environment's target slots, when every one of them is on-prem Compose. */
  private async onpremSlots(
    projectId: string,
    environmentId: string,
  ): Promise<string[] | null> {
    const targets = (
      await this.targets.listDeploymentTargets(projectId)
    ).filter((target) => target.environmentId === environmentId);
    if (
      !targets.length ||
      targets.some((target) => target.provider !== ONPREM_COMPOSE)
    )
      return null;
    return targets.map((target) => target.slot);
  }
  /**
   * The address users reach the environment at: the machine's reported tunnel
   * address or the configured URL. Null when there is none yet, and null rather
   * than an error when on-prem delivery is off, so target listings still load.
   */
  async publicAddress(
    projectId: string,
    environmentId: string,
    slot: string,
  ): Promise<string | null> {
    if (this.config.get('ONPREM_RELEASES_ENABLED') !== 'true') return null;
    const current = await this.repository.current(projectId, environmentId);
    // The address belongs to the slot the tunnel serves, not to every slot.
    if (!current?.config || servedSlot(current.config.ports) !== slot)
      return null;
    return effectivePublicAddress(current.config.ingress, current.tunnel);
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
    input: {
      machineId?: string;
      requestId: string;
      config: AssignmentRequestConfig;
    },
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
    const project = await this.projects.findProjectReference(projectId, userId);
    if (!project) throw new NotFoundException('Project not found.');
    const environment = await this.projects.findProjectEnvironment(
      projectId,
      environmentId,
    );
    if (!environment) throw new NotFoundException('Environment not found.');
    return { environment, project };
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
