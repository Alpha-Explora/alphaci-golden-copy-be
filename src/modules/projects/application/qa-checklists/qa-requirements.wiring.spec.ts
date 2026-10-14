import type { InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { DatabaseService } from '#kernel/db/database.service';
import {
  AuditEventPublisher,
  NotificationEventPublisher,
} from '#kernel/events/platform-event-publisher.js';
import { AUDIT_LATEST_EVENT_QUERY_PORT } from '#kernel/ports/audit.port';
import { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import { QaRunAttachmentsRepository } from '../../infrastructure/qa-run-attachments.repository';
import { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import { QaRunsModule } from '../qa-runs/qa-runs.module';
import { QaAccessService } from './qa-access.service';
import { QaProjectContextService } from './qa-project-context.service';
import { QaRequirementsService } from './qa-requirements.service';

/**
 * The Ready for QA notification counts fix proofs through
 * QaRunAttachmentsRepository. QaRequirementsService lives under qa-checklists
 * but is provided by QaRunsModule, and a collaborator that fails to resolve
 * (an @Optional() alias without @Inject, an undecorated class) is injected as
 * undefined without any error until the call. These tests resolve the REAL
 * service from Nest's container and run the real count through it.
 */
describe('QaRequirementsService wiring: QaRunAttachmentsRepository', () => {
  it('QaRunsModule provides both the service and the repository it now depends on', () => {
    const providers = Reflect.getMetadata(
      'providers',
      QaRunsModule,
    ) as unknown[];

    expect(providers).toEqual(
      expect.arrayContaining([
        QaRequirementsService,
        QaRunAttachmentsRepository,
      ]),
    );
  });

  it('resolves a real QaRunAttachmentsRepository into the service (not undefined) and counts through it', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ count: '3' }] });
    const stub = (token: InjectionToken) => ({ provide: token, useValue: {} });
    const moduleRef = await Test.createTestingModule({
      providers: [
        QaRequirementsService,
        QaRunAttachmentsRepository,
        { provide: DatabaseService, useValue: { query } },
        stub(QaChecklistsRepository),
        stub(QaRequirementsRepository),
        stub(QaProjectRunsRepository),
        stub(QaRunsRepository),
        stub(QaAccessService),
        stub(QaProjectContextService),
        stub(AUDIT_LATEST_EVENT_QUERY_PORT),
        stub(AuditEventPublisher),
        stub(NotificationEventPublisher),
      ],
    }).compile();

    const service = moduleRef.get(QaRequirementsService);
    const injected = (service as unknown as { runAttachments: unknown })
      .runAttachments;

    expect(injected).toBeInstanceOf(QaRunAttachmentsRepository);
    await expect(
      (injected as QaRunAttachmentsRepository).countFixProofs(['ri-1']),
    ).resolves.toBe(3);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
