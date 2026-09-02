import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  WORKSPACE_ACCESS_PORT,
  type WorkspaceAccessPort,
} from '#kernel/ports/workspaces.port';
import { CustomDomainsRepository } from '../infrastructure/repositories/custom-domains.repository';
import { DeploymentTargetsService } from './deployment-targets.service';
import {
  PROVIDER_CLIENT_REGISTRY,
  type ProviderClientRegistryPort,
} from './ports/provider-client-registry.port';
import type { CustomDomainSummary } from '../core/deployments.types';

/**
 * A hostname, as strictly as we can check locally.
 *
 * Deliberately not a full RFC validator: the provider is the authority and
 * will reject what it does not like. This only turns the obviously-wrong
 * cases -- a URL pasted whole, a bare label, trailing whitespace -- into a
 * clear local error rather than an opaque provider one.
 */
const HOSTNAME_PATTERN =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export interface AddCustomDomainInput {
  deploymentTargetId: string;
  hostname: string;
  /** Pins the hostname to one branch. Omitted means the production domain. */
  gitBranch?: string | null;
}

@Injectable()
export class CustomDomainsService {
  private readonly logger = new Logger(CustomDomainsService.name);

  constructor(
    private readonly repository: CustomDomainsRepository,
    private readonly deploymentTargetsService: DeploymentTargetsService,
    @Inject(PROVIDER_CLIENT_REGISTRY)
    private readonly clientRegistry: ProviderClientRegistryPort,
    @Optional()
    @Inject(WORKSPACE_ACCESS_PORT)
    private readonly workspaceAccessService?: WorkspaceAccessPort,
    @Optional()
    private readonly auditEventsService?: AuditEventPublisher,
  ) {}

  async listDomains(
    projectId: string,
    userId: string,
  ): Promise<CustomDomainSummary[]> {
    await this.assertReadAccess(projectId, userId);
    return this.repository.listForProject(projectId);
  }

  async addDomain(
    projectId: string,
    userId: string,
    input: AddCustomDomainInput,
  ): Promise<CustomDomainSummary> {
    await this.assertMutationAccess(projectId, userId);
    const hostname = this.normalizeHostname(input.hostname);
    const gitBranch = input.gitBranch?.trim() || null;

    const { target, token, scope } =
      await this.deploymentTargetsService.providerContextForTarget(
        projectId,
        input.deploymentTargetId,
        userId,
      );
    const client = this.requireDomainClient(target.provider);

    const result = await client.addDomain!({
      token,
      targetId: target.providerProjectId,
      hostname,
      gitBranch,
      ...scope,
    }).catch((error: unknown) => {
      throw this.toClientException(error);
    });

    const domain = await this.repository.insert({
      projectId,
      deploymentTargetId: target.id,
      provider: target.provider,
      hostname: result.hostname || hostname,
      apexDomain: result.apexDomain,
      gitBranch,
      verified: result.verified,
      verification: result.verification,
      misconfigured: result.misconfigured,
      createdBy: userId,
    });

    await this.recordEvent(
      userId,
      projectId,
      'custom_domain_added',
      `${domain.hostname} was attached to ${target.provider}.`,
      {
        hostname: domain.hostname,
        deploymentTargetId: target.id,
        gitBranch,
        verified: domain.verified,
      },
    );

    return domain;
  }

  /**
   * Re-asks the provider whether the domain is ready.
   *
   * The stored row is refreshed from the answer either way, so a domain that
   * has since been pointed correctly stops showing stale instructions, and one
   * that has broken stops claiming to be live.
   */
  async verifyDomain(
    projectId: string,
    domainId: string,
    userId: string,
  ): Promise<CustomDomainSummary> {
    await this.assertMutationAccess(projectId, userId);
    const domain = await this.getDomainOrThrow(projectId, domainId);

    const { target, token, scope } =
      await this.deploymentTargetsService.providerContextForTarget(
        projectId,
        domain.deploymentTargetId,
        userId,
      );
    const client = this.requireDomainClient(target.provider);

    try {
      const result = await client.verifyDomain!({
        token,
        targetId: target.providerProjectId,
        hostname: domain.hostname,
        ...scope,
      });

      const updated = await this.repository.updateState({
        id: domain.id,
        verified: result.verified,
        verification: result.verification,
        misconfigured: result.misconfigured,
        lastErrorSafeMessage: null,
      });
      return updated ?? domain;
    } catch (error) {
      // A failed check is recorded on the row rather than thrown away, so the
      // reason is visible next to the domain instead of only in a toast that
      // is gone by the time anyone looks.
      const message = this.safeMessage(error);
      this.logger.warn(
        `Domain verification failed for ${domain.hostname}: ${message}`,
      );
      const updated = await this.repository.updateState({
        id: domain.id,
        verified: domain.verified,
        verification: domain.verification,
        misconfigured: domain.misconfigured,
        lastErrorSafeMessage: message,
      });
      return updated ?? domain;
    }
  }

  async removeDomain(
    projectId: string,
    domainId: string,
    userId: string,
  ): Promise<{
    removed: true;
    hostname: string;
    providerError: string | null;
  }> {
    await this.assertMutationAccess(projectId, userId);
    const domain = await this.getDomainOrThrow(projectId, domainId);

    let providerError: string | null = null;
    try {
      const { target, token, scope } =
        await this.deploymentTargetsService.providerContextForTarget(
          projectId,
          domain.deploymentTargetId,
          userId,
        );
      const client = this.clientRegistry.getClient(target.provider);
      if (client.removeDomain) {
        await client.removeDomain({
          token,
          targetId: target.providerProjectId,
          hostname: domain.hostname,
          ...scope,
        });
      }
    } catch (error) {
      // Detaching locally must not be blocked by a provider having a bad
      // moment -- otherwise a hostname stays stuck in the UI with no way out.
      // The failure is reported so the reader knows to remove it there too.
      providerError = this.safeMessage(error);
      this.logger.warn(
        `Provider domain removal failed for ${domain.hostname}: ${providerError}`,
      );
    }

    const removed = await this.repository.deleteById(domain.id);
    if (!removed) {
      throw new NotFoundException('Custom domain not found');
    }

    await this.recordEvent(
      userId,
      projectId,
      'custom_domain_removed',
      `${domain.hostname} was detached.`,
      {
        hostname: domain.hostname,
        deploymentTargetId: domain.deploymentTargetId,
        providerError,
      },
    );

    return { removed: true, hostname: domain.hostname, providerError };
  }

  private normalizeHostname(value: string): string {
    const hostname = value.trim().toLowerCase().replace(/\.$/, '');
    if (!hostname) {
      throw new BadRequestException('hostname is required');
    }
    if (hostname.includes('/') || hostname.includes(':')) {
      throw new BadRequestException(
        'Enter the hostname only, without a scheme or path (for example app.example.com).',
      );
    }
    if (hostname.length > 253 || !HOSTNAME_PATTERN.test(hostname)) {
      throw new BadRequestException(`${hostname} is not a valid hostname`);
    }
    return hostname;
  }

  private requireDomainClient(provider: string) {
    const client = this.clientRegistry.getClient(provider);
    if (!client.addDomain || !client.verifyDomain) {
      throw new ServiceUnavailableException(
        `Custom domains are not supported for ${provider} in this deployment.`,
      );
    }
    return client;
  }

  private async getDomainOrThrow(
    projectId: string,
    domainId: string,
  ): Promise<CustomDomainSummary> {
    const domain = await this.repository.findById(domainId);
    // Checked against the project in the path, not just the id: a domain id
    // alone must not be enough to act on another project's domain.
    if (!domain || domain.projectId !== projectId) {
      throw new NotFoundException('Custom domain not found');
    }
    return domain;
  }

  private toClientException(error: unknown): Error {
    const message = this.safeMessage(error);
    return message.includes('already assigned')
      ? new ConflictException(message)
      : new BadRequestException(message);
  }

  private safeMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 400);
  }

  private async assertReadAccess(
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(projectId, userId, [
      'admin',
      'delegated_lead',
      'member',
      'viewer',
    ]);
  }

  private async assertMutationAccess(
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(projectId, userId, [
      'admin',
      'delegated_lead',
      'member',
    ]);
  }

  private async recordEvent(
    userId: string,
    projectId: string,
    eventCode: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      actorUserId: userId,
      projectId,
      eventCode,
      message,
      metadata,
    });
  }
}
