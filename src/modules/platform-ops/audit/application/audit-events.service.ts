import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import {
  AuditEventsRepository,
  type AuditEventRecord,
  type CreateAuditEventInput,
} from '../infrastructure/audit-events.repository';

@Injectable()
export class AuditEventsService {
  private readonly logger = new Logger(AuditEventsService.name);

  constructor(
    private readonly repository: AuditEventsRepository,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
  ) {}

  async record(input: CreateAuditEventInput): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    await this.repository.createDeploymentGlobal(input);
  }

  /** Security-sensitive administrative events bypass the optional UI flag. */
  async recordAlwaysOn(input: CreateAuditEventInput): Promise<void> {
    await this.repository.createDeploymentGlobal(input);
  }

  /**
   * Explicit deployment-global project-event sink for workers/outbox paths.
   * The event may carry a project_id for audit attribution, but this write does
   * not authorize or read that project. User-facing project reads go through
   * listProjectEvents, whose repository query requires tenant context.
   */
  async recordDeploymentGlobalProjectEvent(
    input: CreateAuditEventInput,
  ): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.warn(
        `Audit event '${input.eventCode}' was not recorded: ${String(error)}`,
      );
    }
  }

  /** Compatibility name retained for existing worker callers. */
  async recordProjectEvent(input: CreateAuditEventInput): Promise<void> {
    return this.recordDeploymentGlobalProjectEvent(input);
  }

  async listProjectEvents(
    projectId: string,
    userId: string,
  ): Promise<{ enabled: boolean; items: AuditEventRecord[] }> {
    if (!this.enabled()) {
      return { enabled: false, items: [] };
    }
    return {
      enabled: true,
      items: await this.repository.listByProjectForUser(projectId, userId),
    };
  }

  private enabled(): boolean {
    return (
      this.capabilityResolver?.deployment().has('platform.audit-events') ??
      false
    );
  }
}
