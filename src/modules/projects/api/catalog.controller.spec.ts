import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from '../application/catalog/catalog.service.js';
import type { WorkflowTemplate } from '../application/catalog/catalog.service.js';
import { GithubService } from '#modules/pipelines/github/github.service.js';
import { GITHUB_PROJECT_PORT } from '#kernel/ports/github.port.js';

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

const makeCatalogService = (): Partial<CatalogService> => ({
  listCategories: jest.fn().mockResolvedValue([{ name: 'Backend', count: 1 }]),
  listTemplates: jest.fn().mockResolvedValue([fakeTemplate]),
  getTemplateById: jest.fn().mockResolvedValue(fakeTemplate),
  getProjectOptions: jest.fn().mockReturnValue({
    repoShapes: [],
    projectTypes: [],
    recipes: [],
    nodeVersions: [],
  }),
});

const makeGithubService = (): Partial<GithubService> => ({
  getEnforcedOrg: jest.fn().mockReturnValue('Alpha-Explora'),
});

describe('CatalogController', () => {
  let controller: CatalogController;
  let service: Partial<CatalogService>;
  let githubService: Partial<GithubService>;

  beforeEach(async () => {
    service = makeCatalogService();
    githubService = makeGithubService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        { provide: CatalogService, useValue: service },
        { provide: GITHUB_PROJECT_PORT, useValue: githubService },
      ],
    })
      .overrideGuard(
        require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
      )
      .useValue({ canActivate: () => true })
      .overrideGuard(
        require('#kernel/auth/subscription.guard.js').SubscriptionGuard,
      )
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(CatalogController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getProjectOptions merges the enforced org onto the catalog response', () => {
    const result = controller.getProjectOptions();
    expect(result).toEqual(
      expect.objectContaining({ enforcedOrg: 'Alpha-Explora' }),
    );
    expect(service.getProjectOptions).toHaveBeenCalled();
    expect(githubService.getEnforcedOrg).toHaveBeenCalled();
  });

  it('categories returns wrapped list', async () => {
    const result = await controller.categories();
    expect(result).toEqual({ categories: [{ name: 'Backend', count: 1 }] });
  });

  it('templates returns wrapped list', async () => {
    const result = await controller.templates({});
    expect(result).toEqual({ templates: [fakeTemplate] });
  });

  it('templateById returns wrapped template', async () => {
    const result = await controller.templateById('nestjs-be');
    expect(result).toEqual({ template: fakeTemplate });
  });

  it('templateById throws NotFoundException when template not found', async () => {
    (service.getTemplateById as jest.Mock).mockResolvedValueOnce(null);
    await expect(controller.templateById('missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});
