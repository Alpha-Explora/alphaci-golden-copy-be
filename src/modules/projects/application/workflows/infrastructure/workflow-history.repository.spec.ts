import { WorkflowHistoryRepository } from './workflow-history.repository';

describe('WorkflowHistoryRepository', () => {
  it('writes workflow history through the database service', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const repository = new WorkflowHistoryRepository(databaseService as never);

    await repository.create({
      userId: 'user-1',
      templateId: 'nestjs-be',
      templateName: 'NestJS Backend',
      stack: 'nestjs',
      serviceName: 'payments-api',
      outputFileName: 'payments-api-nestjs-be.yml',
      sourceWorkflowFile: '/templates/workflow.yml',
      sourcePropertiesFile: '/templates/properties.json',
      lineCount: 20,
      yaml: 'name: payments-api',
      sha256: 'hash',
    });

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workflow_generations'),
      expect.arrayContaining(['user-1', 'nestjs-be', 'payments-api']),
    );
  });
});
