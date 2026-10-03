import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import type {
  AuditExternalIngestPort,
  ExternalAuditBatch,
  GithubActivitySyncState,
  ProjectAuditPage,
  ProjectAuditQuery,
} from '#kernel/ports/audit.port';
import {
  AuditEventsRepository,
  type CreateAuditEventInput,
} from '../infrastructure/audit-events.repository';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class AuditEventsService implements AuditExternalIngestPort {
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
    await this.repository.create(input);
  }

  /** Security-sensitive administrative events bypass the optional UI flag. */
  async recordAlwaysOn(input: CreateAuditEventInput): Promise<void> {
    await this.repository.create(input);
  }

  async recordProjectEvent(input: CreateAuditEventInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.warn(
        `Audit event '${input.eventCode}' was not recorded: ${String(error)}`,
      );
    }
  }

  async listProjectEvents(query: ProjectAuditQuery): Promise<ProjectAuditPage> {
    if (!this.enabled()) {
      return { enabled: false, items: [], next: null };
    }
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );
    // One extra row tells us whether another page exists.
    const rows = await this.repository.listForProject({
      projectId: query.projectId,
      deliveryProjectId: query.deliveryProjectId ?? null,
      limit: limit + 1,
      before: query.before ?? null,
    });
    const items = rows.slice(0, limit);
    return {
      enabled: true,
      items,
      next: rows.length > limit ? (items.at(-1)?.createdAt ?? null) : null,
    };
  }

  isRecording(): boolean {
    return this.enabled();
  }

  async findUnrecordedExternalIds(externalIds: string[]): Promise<Set<string>> {
    if (!this.enabled()) {
      return new Set();
    }
    const recorded = await this.repository.findRecordedExternalIds(externalIds);
    return new Set(externalIds.filter((id) => !recorded.has(id)));
  }

  async ingestExternalEvents(
    batch: ExternalAuditBatch,
  ): Promise<{ inserted: number }> {
    // Same gate as record(): with recording off nothing is stored, so the
    // first sync after it is turned on still has the whole 90 days to ingest.
    if (!this.enabled()) {
      return { inserted: 0 };
    }
    return { inserted: await this.repository.insertExternalBatch(batch) };
  }

  getGithubSyncState(
    repoFullName: string,
  ): Promise<GithubActivitySyncState | null> {
    return this.repository.findGithubSyncState(repoFullName);
  }

  saveGithubSyncState(
    repoFullName: string,
    state: GithubActivitySyncState,
  ): Promise<void> {
    return this.repository.saveGithubSyncState(repoFullName, state);
  }

  private enabled(): boolean {
    return (
      this.capabilityResolver?.deployment().has('platform.audit-events') ??
      false
    );
  }
}
