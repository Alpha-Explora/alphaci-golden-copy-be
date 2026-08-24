import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { WorkflowsService } from './workflows.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { WorkflowHistoryRepository } from './infra/workflow-history.repository.js';
import { OutboxRepository } from '../../kernel/events/outbox.repository.js';
import type { WorkflowTemplate } from '../catalog/catalog.service.js';

jest.mock('node:fs/promises');
import * as fs from 'node:fs/promises';
const mockFs = fs as jest.Mocked<typeof fs>;

const baseYaml = `
name: placeholder
on:
  workflow_dispatch:
    inputs:
      service_name:
        description: Service name
        required: true
        type: string
jobs:
  pipeline:
    uses: cicd-external-project/cicd-workflow/.github/workflows/be-pipeline.yml@main
    with:
      service_name: placeholder
`.trim();

const fakeTemplate: WorkflowTemplate = {
  id: 'nestjs-be',
  name: 'NestJS Backend',
  description: 'CI/CD for NestJS',
  iconName: 'octicon package',
  categories: ['Backend'],
  filePatterns: ['**/*.ts'],
  stack: 'nestjs',
  propertiesPath: '/path/nestjs-be.properties.json',
  workflowPath: '/path/nestjs-be.yml',
};

const makeCatalogService = (template: WorkflowTemplate | null = fakeTemplate) =>
  ({
    getTemplateById: jest.fn().mockResolvedValue(template),
  }) as unknown as CatalogService;

const makeHistoryRepo = () =>
  ({
    create: jest.fn().mockResolvedValue(undefined),
  }) as unknown as WorkflowHistoryRepository;

const makeOutboxRepo = () =>
  ({
    publishLater: jest.fn().mockResolvedValue(undefined),
  }) as unknown as OutboxRepository;

const toWorkflowMetadata = (file: {
  stage: 'access' | 'quality' | 'package' | 'guard';
  name: string;
  path: string;
  gated: boolean;
}) => ({
  stage: file.stage,
  name: file.name,
  path: file.path,
  gated: file.gated,
});

describe('WorkflowsService', () => {
  let service: WorkflowsService;
  let catalogService: CatalogService;
  let historyRepo: WorkflowHistoryRepository;
  let outboxRepo: OutboxRepository;

  beforeEach(async () => {
    jest.clearAllMocks();
    catalogService = makeCatalogService();
    historyRepo = makeHistoryRepo();
    outboxRepo = makeOutboxRepo();

    mockFs.readFile.mockResolvedValue(baseYaml);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowsService,
        { provide: CatalogService, useValue: catalogService },
        { provide: WorkflowHistoryRepository, useValue: historyRepo },
        { provide: OutboxRepository, useValue: outboxRepo },
      ],
    }).compile();

    service = module.get(WorkflowsService);
  });

  describe('generate', () => {
    it('throws NotFoundException when template does not exist', async () => {
      (catalogService.getTemplateById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        service.generate('user-1', {
          templateId: 'missing',
          serviceName: 'my-svc',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('generates workflow YAML with substituted service name', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
      });

      expect(result.yaml).toContain('my-service');
      expect(result.metadata.templateId).toBe('nestjs-be');
      expect(result.metadata.stack).toBe('nestjs');
      expect(result.metadata.outputFileName).toBe('my-service-nestjs-be.yml');
    });

    it('returns the staged workflow bundle plus env guard with every stage gated', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        servicePath: '.',
        nodeVersion: '24',
      });

      expect(result.workflowFiles).toHaveLength(4);
      expect(result.workflowFiles.map((file) => file.stage)).toEqual([
        'access',
        'quality',
        'package',
        'guard',
      ]);
      expect(result.workflowFiles.map((file) => file.path)).toEqual([
        '.github/workflows/00-alphaci-access.yml',
        '.github/workflows/10-alphaci-quality.yml',
        '.github/workflows/20-alphaci-package.yml',
        '.github/workflows/05-alphaci-env-guard.yml',
      ]);
      // the staged chain is platform-gated; the env guard is self-contained
      expect(
        result.workflowFiles
          .filter((file) => file.stage !== 'guard')
          .every((file) => file.gated),
      ).toBe(true);
      expect(result.workflowFiles[1]?.yaml).toContain('workflow_run:');
      expect(result.workflowFiles[1]?.yaml).toContain('workflows:');
      expect(result.workflowFiles[1]?.yaml).toContain('ALPHACI Access Gate');
      expect(result.workflowFiles[1]?.yaml).toContain(
        "conclusion == 'success'",
      );
      expect(result.workflowFiles[1]?.yaml).toContain(
        'cicd-external-project/cicd-workflow/.github/workflows/backend-tests.yml@v1',
      );
      expect(result.workflowFiles[1]?.yaml).toContain(
        'http://localhost:4000/api/v1/ci/validate',
      );
      expect(result.workflowFiles[2]?.yaml).toContain('ALPHACI Quality');
      expect(result.workflowFiles[2]?.yaml).toContain(
        "conclusion == 'success'",
      );
      expect(result.metadata.workflowFiles).toEqual(
        result.workflowFiles.map(toWorkflowMetadata),
      );
    });

    it('emits branch-scoped Vercel deploy jobs when deployment targets are provided', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        servicePath: '.',
        deploymentTargets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            deploymentStrategy: 'vercel_ci_pushed',
            rootDirectory: '.',
            secretNames: {
              token: 'VERCEL_FRONTEND_TOKEN',
              orgId: 'VERCEL_FRONTEND_ORG_ID',
              projectId: 'VERCEL_FRONTEND_PROJECT_ID',
            },
          },
        ],
      });

      const packageWorkflow = result.workflowFiles[2]?.yaml ?? '';
      expect(packageWorkflow).toContain('vercel-deploy.yml');
      expect(packageWorkflow).not.toContain('deploy-vercel-frontend-test:');
      expect(packageWorkflow).toContain('deploy-vercel-frontend-uat:');
      expect(packageWorkflow).toContain('deploy-vercel-frontend-main:');
      expect(packageWorkflow).toContain('VERCEL_FRONTEND_TOKEN');
      expect(packageWorkflow).toContain(
        'ref: ${{ github.event.workflow_run.head_sha || github.sha }}',
      );
    });

    it('saves to history and publishes outbox event', async () => {
      await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
      });

      const createHistory = (historyRepo as unknown as { create: jest.Mock })
        .create;
      const publishLater = (
        outboxRepo as unknown as { publishLater: jest.Mock }
      ).publishLater;

      expect(createHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', templateId: 'nestjs-be' }),
      );
      expect(publishLater).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'workflow.generated' }),
      );
    });

    it('applies disablePlaywright enhancement', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        enhancements: ['disablePlaywright'],
      });

      expect(result.yaml).toContain('run-playwright: false');
      expect(result.metadata.enhancementsApplied).toContain(
        'disablePlaywright',
      );
    });

    it('applies disableK6 enhancement', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        enhancements: ['disableK6'],
      });

      expect(result.yaml).toContain('run-k6: false');
    });

    it('applies enableUatApproval enhancement', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        enhancements: ['enableUatApproval'],
      });

      expect(result.yaml).toContain('require-uat-approval: true');
    });

    it('applies strictProductionApproval enhancement', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        enhancements: ['strictProductionApproval'],
      });

      expect(result.yaml).toContain('require-production-approval: true');
    });

    it('applies optional substitutions when provided', async () => {
      const result = await service.generate('user-1', {
        templateId: 'nestjs-be',
        serviceName: 'my-service',
        servicePath: './apps/backend',
        nodeVersion: '22',
        coverageThreshold: 90,
      });

      expect(result.metadata.substitutionsApplied).toContain(
        'service_path.default',
      );
      expect(result.metadata.substitutionsApplied).toContain(
        'node_version.default',
      );
      expect(result.metadata.substitutionsApplied).toContain(
        'coverage_threshold.default',
      );
    });
  });

  describe('getHistory', () => {
    it('delegates to workflow history repository', async () => {
      const entries = [
        {
          id: 'wh-1',
          createdAt: '2026-01-01T00:00:00Z',
          templateId: 'nestjs-be',
          templateName: 'NestJS Backend',
          stack: 'nestjs',
          serviceName: 'my-service',
          outputFileName: 'my-service-nestjs-be.yml',
          sourceWorkflowFile: '/path',
          sourcePropertiesFile: '/path',
          lineCount: 100,
          yaml: 'name: test',
        },
      ];

      const listByUser = jest.fn().mockResolvedValue(entries);
      (historyRepo as unknown as { listByUser: jest.Mock }).listByUser =
        listByUser;

      const result = await service.getHistory('user-1', 10);
      expect(result).toEqual(entries);
      expect(listByUser).toHaveBeenCalledWith('user-1', 10);
    });

    it('clamps limit to safe range', async () => {
      const listByUser = jest.fn().mockResolvedValue([]);
      (historyRepo as unknown as { listByUser: jest.Mock }).listByUser =
        listByUser;

      await service.getHistory('user-1', 200);
      expect(listByUser).toHaveBeenCalledWith('user-1', 100);
    });

    it('defaults limit to 25 for NaN input', async () => {
      const listByUser = jest.fn().mockResolvedValue([]);
      (historyRepo as unknown as { listByUser: jest.Mock }).listByUser =
        listByUser;

      await service.getHistory('user-1', NaN);
      expect(listByUser).toHaveBeenCalledWith('user-1', 25);
    });
  });
});
