import type { Server } from 'node:http';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CapabilityGuard } from '#kernel/composition/index.js';
import { QaAutomationDispatchService } from '../application/qa-runs/qa-automation-dispatch.service';
import { QaProjectRunsService } from '../application/qa-runs/qa-project-runs.service';
import { QaRequirementsService } from '../application/qa-checklists/qa-requirements.service';
import {
  DeliveryProjectQaMyItemsController,
  DeliveryProjectQaRunsController,
} from './qa-project-runs.controller';
import {
  DeliveryProjectRequirementsController,
  RequirementsController,
  WorkspaceQaRequirementsController,
} from './qa-requirements.controller';

const ID = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

async function createApp() {
  const requirements = {
    listForProject: jest.fn().mockResolvedValue({ requirements: [] }),
    create: jest.fn().mockResolvedValue({ id: 'req-1' }),
    createBatch: jest.fn().mockResolvedValue({ requirements: [] }),
    getById: jest.fn().mockResolvedValue({ id: 'req-1' }),
    update: jest.fn().mockResolvedValue({ id: 'req-1' }),
    archive: jest.fn().mockResolvedValue({ id: 'req-1' }),
    addItem: jest.fn().mockResolvedValue({ id: 'item-1' }),
    updateItem: jest.fn().mockResolvedValue({ id: 'item-1' }),
    deleteItem: jest.fn().mockResolvedValue(undefined),
    reorderItems: jest.fn().mockResolvedValue({ id: 'req-1' }),
    setProgress: jest
      .fn()
      .mockResolvedValue({ item: {}, readyForQaNotified: false }),
    overview: jest.fn().mockResolvedValue({ groups: [] }),
  };
  const projectRuns = {
    list: jest.fn().mockResolvedValue({ runs: [], next: null }),
    current: jest
      .fn()
      .mockResolvedValue({ run: null, heads: [], stale: false }),
    create: jest.fn(),
    getById: jest.fn().mockResolvedValue({ id: 'run-1' }),
    updateItem: jest.fn().mockResolvedValue({ id: 'run-1' }),
    signoff: jest.fn().mockResolvedValue({ id: 'run-1' }),
    reopen: jest.fn().mockResolvedValue({ id: 'run-1' }),
    myItems: jest.fn().mockResolvedValue({ returned: [] }),
    buildReport: jest.fn(),
  };
  const dispatch = {
    dispatch: jest.fn().mockResolvedValue({ dispatched: [], failed: [] }),
  };

  const module = await Test.createTestingModule({
    controllers: [
      DeliveryProjectRequirementsController,
      RequirementsController,
      WorkspaceQaRequirementsController,
      DeliveryProjectQaRunsController,
      DeliveryProjectQaMyItemsController,
    ],
    providers: [
      { provide: QaRequirementsService, useValue: requirements },
      { provide: QaProjectRunsService, useValue: projectRuns },
      { provide: QaAutomationDispatchService, useValue: dispatch },
    ],
  })
    .overrideGuard(SessionAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(CapabilityGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app: INestApplication = module.createNestApplication();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = {
      user: { id: 'user-1', login: 'tone' },
      githubAccessToken: 'tok',
    };
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return { app, requirements, projectRuns, dispatch };
}

describe('requirements and Project run controllers', () => {
  let fixture: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    fixture = await createApp();
  });
  afterEach(async () => {
    await fixture.app.close();
  });

  const http = () => request(fixture.app.getHttpServer() as Server);

  it('creates a requirement (201) with a validated body; unknown fields are refused', async () => {
    await http()
      .post(`/delivery-projects/${ID}/requirements`)
      .send({
        kind: 'functional',
        name: 'Checkout',
        items: [{ title: 'Pay', acceptanceCriteria: 'Receipt' }],
      })
      .expect(201);
    expect(fixture.requirements.create).toHaveBeenCalledWith(
      ID,
      'user-1',
      expect.objectContaining({ kind: 'functional', name: 'Checkout' }),
    );

    await http()
      .post(`/delivery-projects/${ID}/requirements`)
      .send({ kind: 'system', name: 'x', sneaky: true })
      .expect(400);
    await http()
      .post(`/delivery-projects/${ID}/requirements`)
      .send({ kind: 'system', name: '' })
      .expect(400);
    await http()
      .post(`/delivery-projects/${ID}/requirements`)
      .send({
        kind: 'system',
        name: 'x',
        items: [{ title: 'y', acceptanceCriteria: 'z'.repeat(4001) }],
      })
      .expect(400);
  });

  it('creates a batch (201) with the validated nested body; unknown fields are refused', async () => {
    await http()
      .post(`/delivery-projects/${ID}/requirements/batch`)
      .send({
        kind: 'functional',
        requirements: [
          {
            name: 'Checkout',
            description: 'Pay',
            items: [{ title: 'Pay', verificationType: 'playwright' }],
          },
          { name: 'Search' },
        ],
      })
      .expect(201)
      .expect({ requirements: [] });
    expect(fixture.requirements.createBatch).toHaveBeenCalledWith(
      ID,
      'user-1',
      expect.objectContaining({
        kind: 'functional',
        requirements: [
          expect.objectContaining({ name: 'Checkout' }),
          expect.objectContaining({ name: 'Search' }),
        ],
      }),
    );

    const post = (body: unknown) =>
      http()
        .post(`/delivery-projects/${ID}/requirements/batch`)
        .send(body as object);
    // Top-level and nested unknown fields (including a per-entry kind).
    await post({
      kind: 'system',
      requirements: [{ name: 'x' }],
      sneaky: 1,
    }).expect(400);
    await post({
      kind: 'system',
      requirements: [{ name: 'x', kind: 'system' }],
    }).expect(400);
    await post({
      kind: 'system',
      requirements: [{ name: 'x', items: [{ title: 'y', sneaky: true }] }],
    }).expect(400);
    // Per-field limits are the single create's.
    await post({ kind: 'system', requirements: [{ name: '' }] }).expect(400);
    await post({
      kind: 'system',
      requirements: [{ name: 'n'.repeat(201) }],
    }).expect(400);
    await post({
      kind: 'system',
      requirements: [
        {
          name: 'x',
          items: [{ title: 'y', acceptanceCriteria: 'z'.repeat(4001) }],
        },
      ],
    }).expect(400);
    await post({ kind: 'system' }).expect(400);
    await post({ kind: 'system', requirements: 'nope' }).expect(400);
    expect(fixture.requirements.createBatch).toHaveBeenCalledTimes(1);
  });

  it('passes the list filters through', async () => {
    await http()
      .get(
        `/delivery-projects/${ID}/requirements?kind=system&includeArchived=true`,
      )
      .expect(200);
    expect(fixture.requirements.listForProject).toHaveBeenCalledWith(
      ID,
      'user-1',
      { kind: 'system', includeArchived: true },
    );
  });

  it('validates the Progress body: an enum value and an expectedRowVersion', async () => {
    await http()
      .patch(`/requirements/${ID}/items/${ITEM}/progress`)
      .send({ progress: 'done', expectedRowVersion: 3, note: 'ok' })
      .expect(200);
    expect(fixture.requirements.setProgress).toHaveBeenCalledWith(
      ID,
      ITEM,
      { userId: 'user-1', userLogin: 'tone' },
      { progress: 'done', expectedRowVersion: 3, note: 'ok' },
    );

    await http()
      .patch(`/requirements/${ID}/items/${ITEM}/progress`)
      .send({ progress: 'finished', expectedRowVersion: 3 })
      .expect(400);
    await http()
      .patch(`/requirements/${ID}/items/${ITEM}/progress`)
      .send({ progress: 'done' })
      .expect(400);
  });

  it('routes PUT items/order to reorder, not to the item update, and DELETE item answers 204', async () => {
    await http()
      .put(`/requirements/${ID}/items/order`)
      .send({ itemIds: [ITEM] })
      .expect(200);
    expect(fixture.requirements.reorderItems).toHaveBeenCalled();
    await http()
      .put(`/requirements/${ID}/items/order`)
      .send({ itemIds: ['not-a-uuid'] })
      .expect(400);

    await http().delete(`/requirements/${ID}/items/${ITEM}`).expect(204);
    expect(fixture.requirements.deleteItem).toHaveBeenCalledWith(
      ID,
      ITEM,
      'user-1',
    );
  });

  it('PATCH requirement and item need their version guards', async () => {
    await http().patch(`/requirements/${ID}`).send({ name: 'x' }).expect(400);
    await http()
      .patch(`/requirements/${ID}`)
      .send({ name: 'x', expectedVersion: 1 })
      .expect(200);
    await http()
      .patch(`/requirements/${ID}/items/${ITEM}`)
      .send({ title: 'x' })
      .expect(400);
    await http()
      .patch(`/requirements/${ID}/items/${ITEM}`)
      .send({ title: 'x', acceptanceCriteria: null, expectedRowVersion: 2 })
      .expect(200);
  });

  it('serves the team overview', async () => {
    await http().get(`/workspaces/${ID}/qa-requirements/overview`).expect(200);
    expect(fixture.requirements.overview).toHaveBeenCalledWith(
      ID,
      'user-1',
      false,
    );
  });

  it('starts a Project run: 201 when created, 200 for the same heads', async () => {
    fixture.projectRuns.create.mockResolvedValueOnce({
      created: true,
      run: { id: 'r' },
    });
    await http().post(`/delivery-projects/${ID}/qa-runs`).expect(201);

    fixture.projectRuns.create.mockResolvedValueOnce({
      created: false,
      run: { id: 'r' },
    });
    await http().post(`/delivery-projects/${ID}/qa-runs`).expect(200);
    expect(fixture.projectRuns.create).toHaveBeenCalledWith(ID, {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'tok',
    });
  });

  it('validates the verification, sign-off and dispatch bodies and parses the page cursor', async () => {
    const run = '33333333-3333-4333-8333-333333333333';
    await http()
      .patch(`/delivery-projects/${ID}/qa-runs/${run}/items/${ITEM}`)
      .send({ status: 'passed', expectedRowVersion: 2 })
      .expect(200);
    await http()
      .patch(`/delivery-projects/${ID}/qa-runs/${run}/items/${ITEM}`)
      .send({ status: 'passed' })
      .expect(400);
    await http()
      .post(`/delivery-projects/${ID}/qa-runs/${run}/signoff`)
      .send({ verdict: 'MAYBE' })
      .expect(400);
    await http()
      .post(`/delivery-projects/${ID}/qa-runs/${run}/automation/dispatch`)
      .send({ projectId: ITEM })
      .expect(202);
    await http()
      .post(`/delivery-projects/${ID}/qa-runs/${run}/automation/dispatch`)
      .send({ projectId: 'nope' })
      .expect(400);

    await http()
      .get(`/delivery-projects/${ID}/qa-runs?limit=5&cursor=abc`)
      .expect(200);
    expect(fixture.projectRuns.list).toHaveBeenCalledWith(ID, 'user-1', {
      limit: 5,
      cursor: 'abc',
    });
    await http().get(`/delivery-projects/${ID}/qa-runs/current`).expect(200);
    expect(fixture.projectRuns.current).toHaveBeenCalled();
    await http().get(`/delivery-projects/${ID}/qa/my-items`).expect(200);
    expect(fixture.projectRuns.myItems).toHaveBeenCalled();
  });

  it('streams the v2 report as JSON or Markdown, accepting md and markdown, and refuses other formats', async () => {
    const report = {
      schemaVersion: 'qa-report/v2',
      project: { id: ID, name: 'Checkout' },
      run: {
        id: 'abcdef0123',
        items: [],
        createdBy: { login: 'qa' },
        createdAt: '2026-10-01T00:00:00Z',
        status: 'open',
        branch: 'uat',
        signoff: null,
      },
      repositories: [],
      summary: {
        verdict: null,
        totalItems: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        returnedToDev: 0,
        pending: 0,
        completionRate: 0,
        openDefects: 0,
        blockers: 0,
      },
      defects: [],
      signoffHistory: [],
      generatedAt: '2026-10-01T00:00:00Z',
      frozen: false,
    };
    fixture.projectRuns.buildReport.mockResolvedValue(report);

    const json = await http()
      .get(`/delivery-projects/${ID}/qa-runs/r1/report`)
      .expect(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.headers['content-disposition']).toContain(
      'QA-Report-Checkout-abcdef0.json',
    );

    for (const format of ['md', 'markdown']) {
      const md = await http()
        .get(`/delivery-projects/${ID}/qa-runs/r1/report?format=${format}`)
        .expect(200);
      expect(md.headers['content-type']).toContain('text/markdown');
      expect(md.text).toContain('# QA Report - Checkout');
    }

    const xlsx = await http()
      .get(`/delivery-projects/${ID}/qa-runs/r1/report?format=xlsx`)
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(xlsx.headers['content-disposition']).toContain(
      'QA-Report-Checkout-abcdef0.xlsx',
    );

    await http()
      .get(`/delivery-projects/${ID}/qa-runs/r1/report?format=xml`)
      .expect(400);
  });
});
