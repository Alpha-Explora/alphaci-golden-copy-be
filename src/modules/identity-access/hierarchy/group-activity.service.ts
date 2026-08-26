import { Injectable } from '@nestjs/common';

import {
  GroupActivityRepository,
  type GroupActivityRow,
} from './group-activity.repository';
import { HierarchyAccessService } from './hierarchy-access.service';
import type { QueryActivityDto } from './dto/query-activity.dto';

export type ActivityTargetType =
  | 'group'
  | 'system'
  | 'delivery_project'
  | 'repository'
  | 'assignment'
  | 'configuration';

export interface GroupActivityItem {
  id: string;
  eventCode: string;
  message: string;
  actorUserId: string | null;
  actorLabel: string | null;
  targetType: ActivityTargetType;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  githubLink?: {
    type: 'commit' | 'pull_request' | 'workflow_run' | 'deployment';
    url: string;
  };
}

@Injectable()
export class GroupActivityService {
  constructor(
    private readonly activityRepository: GroupActivityRepository,
    private readonly accessService: HierarchyAccessService,
  ) {}

  async listActivity(
    groupId: string,
    userId: string,
    query: QueryActivityDto,
  ): Promise<{ items: GroupActivityItem[]; nextCursor: string | null }> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin', 'delegated_lead'],
    );

    const { rows, nextCursor } = await this.activityRepository.list(
      groupId,
      query,
    );
    return { items: rows.map((row) => this.toItem(row)), nextCursor };
  }

  private toItem(row: GroupActivityRow): GroupActivityItem {
    const metadata: Record<string, unknown> =
      typeof row.metadata_json === 'string'
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : row.metadata_json;

    const { targetType, targetId } = this.resolveTarget(
      row.event_code,
      metadata,
    );

    return {
      id: row.id,
      eventCode: row.event_code,
      message: row.message,
      actorUserId: row.actor_user_id,
      actorLabel: row.actor_login,
      targetType,
      targetId,
      metadata,
      createdAt: row.created_at,
    };
  }

  private resolveTarget(
    eventCode: string,
    metadata: Record<string, unknown>,
  ): { targetType: ActivityTargetType; targetId: string | null } {
    const asString = (value: unknown): string | null =>
      typeof value === 'string' ? value : null;

    if (eventCode.startsWith('hierarchy.group.')) {
      return { targetType: 'group', targetId: asString(metadata['groupId']) };
    }
    if (eventCode.startsWith('hierarchy.system.')) {
      return {
        targetType: 'system',
        targetId: asString(metadata['systemId']),
      };
    }
    if (eventCode.startsWith('hierarchy.delivery_project.')) {
      return {
        targetType: 'delivery_project',
        targetId: asString(metadata['deliveryProjectId']),
      };
    }
    if (eventCode.startsWith('hierarchy.repository.')) {
      return {
        targetType: 'repository',
        targetId: asString(metadata['repositoryId']),
      };
    }
    if (eventCode.startsWith('hierarchy.assignment.')) {
      return {
        targetType: 'assignment',
        targetId: asString(metadata['assignmentId']),
      };
    }
    return {
      targetType: 'configuration',
      targetId: asString(metadata['repositoryId']),
    };
  }
}
