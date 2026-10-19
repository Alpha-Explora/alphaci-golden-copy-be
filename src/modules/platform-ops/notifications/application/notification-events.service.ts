import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import { NotificationsRepository } from '../infrastructure/notifications.repository';

export interface NotificationEventInput {
  userId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  sourceEventId?: string | null;
  eventCode: string;
  title: string;
  body: string;
}

@Injectable()
export class NotificationEventsService {
  constructor(
    private readonly repository: NotificationsRepository,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
  ) {}

  async record(input: NotificationEventInput): Promise<void> {
    if (!this.capabilityResolver?.deployment().has('platform.notifications')) {
      return;
    }

    const preferences = await this.repository.getPreferences(input.userId);
    if (!preferences.inAppEnabled) {
      return;
    }

    await this.repository.createForUser(input);
  }
}
