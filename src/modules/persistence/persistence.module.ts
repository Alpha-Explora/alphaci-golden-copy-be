import { Module } from '@nestjs/common';

import { SESSION_USER_LOOKUP } from '../../kernel/auth/session-user-lookup.contract';
import { DatabaseModule } from '../../kernel/db/database.module';
import { OAuthStateRepository } from './oauth-state.repository';
import { OutboxRepository } from './outbox.repository';
import { SubscriptionsRepository } from './subscriptions.repository';
import { UsersRepository } from './users.repository';
import { WorkflowHistoryRepository } from './workflow-history.repository';
import { CiTokensRepository } from '../ci/ci-tokens.repository';

@Module({
  imports: [DatabaseModule],
  providers: [
    UsersRepository,
    SubscriptionsRepository,
    WorkflowHistoryRepository,
    OutboxRepository,
    OAuthStateRepository,
    CiTokensRepository,
    {
      provide: SESSION_USER_LOOKUP,
      useFactory: (usersRepository: UsersRepository) => ({
        findSessionUser: (userId: string) => usersRepository.findById(userId),
      }),
      inject: [UsersRepository],
    },
  ],
  exports: [
    UsersRepository,
    SubscriptionsRepository,
    WorkflowHistoryRepository,
    OutboxRepository,
    OAuthStateRepository,
    CiTokensRepository,
    SESSION_USER_LOOKUP,
  ],
})
export class PersistenceModule {}
