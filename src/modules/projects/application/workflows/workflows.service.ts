import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import yaml from 'js-yaml';

import {
  CatalogService,
  type WorkflowTemplate,
} from '../catalog/catalog.service';
import { WorkflowHistoryRepository } from './infrastructure/workflow-history.repository';
import type { GenerateWorkflowDto } from './dto/generate-workflow.dto';
import { buildStagedWorkflowBundle } from './staged-workflow.builder';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

type Enhancement =
  | 'strictProductionApproval'
  | 'enableUatApproval'
  | 'disablePlaywright'
  | 'disableK6';

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly workflowHistoryRepository: WorkflowHistoryRepository,
    @Optional()
    private readonly workflowFragmentRegistry?: WorkflowFragmentRegistry,
  ) {}

  async generate(userId: string, dto: GenerateWorkflowDto) {
    const template = await this.catalogService.getTemplateById(dto.templateId);
    if (!template) {
      throw new NotFoundException(`Template '${dto.templateId}' not found`);
    }

    const source = await readFile(template.workflowPath, 'utf8');
    const { generatedYaml, substitutionsApplied, enhancementsApplied } =
      this.buildWorkflow(source, template, dto);
    const workflowBundle = buildStagedWorkflowBundle(
      template,
      dto,
      this.workflowFragmentRegistry,
    );

    const sha256 = createHash('sha256').update(generatedYaml).digest('hex');
    const lineCount = generatedYaml.split(/\r?\n/).length;
    const outputFileName = this.outputFileName(dto.serviceName, template.id);

    await this.workflowHistoryRepository.create({
      userId,
      templateId: template.id,
      templateName: template.name,
      stack: template.stack,
      serviceName: dto.serviceName,
      outputFileName,
      sourcePropertiesFile: template.propertiesPath,
      sourceWorkflowFile: template.workflowPath,
      lineCount,
      yaml: generatedYaml,
      sha256,
    });

    return {
      yaml: generatedYaml,
      metadata: {
        templateId: template.id,
        templateName: template.name,
        stack: template.stack,
        generatedAt: new Date().toISOString(),
        sha256,
        byteSize: Buffer.byteLength(generatedYaml, 'utf8'),
        lineCount,
        substitutionsApplied,
        enhancementsApplied,
        sourcePropertiesFile: template.propertiesPath,
        sourceWorkflowFile: template.workflowPath,
        outputFileName,
        workflowFiles: workflowBundle.metadata,
      },
      workflowFiles: workflowBundle.workflowFiles,
    };
  }

  async getHistory(userId: string, limit = 25) {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, limit))
      : 25;
    return this.workflowHistoryRepository.listByUser(userId, safeLimit);
  }

  private buildWorkflow(
    source: string,
    template: WorkflowTemplate,
    dto: GenerateWorkflowDto,
  ) {
    const substitutionsApplied: string[] = [];
    const enhancementsApplied: string[] = [];

    const parsed = yaml.load(source) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Workflow template could not be parsed');
    }

    parsed.name = `${dto.serviceName} - ${template.name}`;
    substitutionsApplied.push('name');

    const onConfig = this.ensureObject(parsed, 'on');
    const dispatchConfig = this.ensureObject(onConfig, 'workflow_dispatch');
    const inputConfig = this.ensureObject(dispatchConfig, 'inputs');

    this.setInputDefault(
      inputConfig,
      'service_name',
      dto.serviceName,
      'string',
      substitutionsApplied,
    );

    if (dto.servicePath !== undefined) {
      this.setInputDefault(
        inputConfig,
        'service_path',
        dto.servicePath,
        'string',
        substitutionsApplied,
      );
    }

    if (dto.nodeVersion !== undefined) {
      this.setInputDefault(
        inputConfig,
        'node_version',
        dto.nodeVersion,
        'string',
        substitutionsApplied,
      );
    }

    if (dto.coverageThreshold !== undefined) {
      this.setInputDefault(
        inputConfig,
        'coverage_threshold',
        dto.coverageThreshold,
        'number',
        substitutionsApplied,
      );
    }

    const pipelineConfig = this.ensureObject(
      this.ensureObject(parsed, 'jobs'),
      'pipeline',
    );
    const withConfig = this.ensureObject(pipelineConfig, 'with');

    this.applyEnhancements(
      withConfig,
      dto.enhancements ?? [],
      enhancementsApplied,
    );

    const generatedYaml = yaml.dump(parsed, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    return {
      generatedYaml,
      substitutionsApplied,
      enhancementsApplied,
    };
  }

  private applyEnhancements(
    withConfig: Record<string, unknown>,
    enhancements: Enhancement[],
    enhancementsApplied: string[],
  ): void {
    for (const enhancement of enhancements) {
      switch (enhancement) {
        case 'disablePlaywright':
          withConfig['run-playwright'] = false;
          enhancementsApplied.push(enhancement);
          break;
        case 'disableK6':
          withConfig['run-k6'] = false;
          enhancementsApplied.push(enhancement);
          break;
        case 'enableUatApproval':
          withConfig['require-uat-approval'] = true;
          enhancementsApplied.push(enhancement);
          break;
        case 'strictProductionApproval':
          withConfig['require-production-approval'] = true;
          enhancementsApplied.push(enhancement);
          break;
        default:
          break;
      }
    }
  }

  private ensureObject(
    parent: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const existing = parent[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      parent[key] = next;
      return next;
    }

    return existing as Record<string, unknown>;
  }

  private setInputDefault(
    inputs: Record<string, unknown>,
    key: string,
    value: string | number,
    type: 'string' | 'number',
    substitutionsApplied: string[],
  ): void {
    const existing = inputs[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      inputs[key] = {
        description: `Auto-generated default for ${key}`,
        required: false,
        type,
        default: value,
      };
    } else {
      const record = existing as Record<string, unknown>;
      record.default = value;
      if (!record.type) {
        record.type = type;
      }
    }

    substitutionsApplied.push(`${key}.default`);
  }

  private outputFileName(serviceName: string, templateId: string): string {
    const normalized = serviceName
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');

    return `${normalized || 'service'}-${templateId}.yml`;
  }
}
