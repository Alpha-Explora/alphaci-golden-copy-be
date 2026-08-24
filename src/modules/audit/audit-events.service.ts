import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import {
  AuditEventsRepository,
  type AuditEventRecord,
  type CreateAuditEventInput,
} from './audit-events.repository';

@Injectable()
export class AuditEventsService {
  private readonly logger = new Logger(AuditEventsService.name);

  constructor(
    private readonly repository: AuditEventsRepository,
    private readonly configService: ConfigService,
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
    const config = this.configService.getOrThrow<AppConfig>('app');
    return config.auditEvents?.enabled ?? false;
  }
}
