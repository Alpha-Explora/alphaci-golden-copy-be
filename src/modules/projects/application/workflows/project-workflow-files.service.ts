import { readFile } from 'node:fs/promises';

import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import yaml from 'js-yaml';

import { CatalogService } from '../catalog/catalog.service';
import {
  buildStagedWorkflowBundle,
  type DeploymentWorkflowTarget,
  type StagedWorkflowFile,
} from './index';
import type { DeploymentProviderId as DeploymentProvider } from '#kernel/ports/deployment-runtime.port';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

interface GitHubContentsResponse {
  content: { html_url?: string };
  commit: { sha: string; html_url?: string };
}

/**
 * Workflow bundle assembly + GitHub Contents API pushes.
 *
 * Owns the two I/O-ish halves of repo provisioning that are not project-row
 * state: turning a catalog template into staged workflow files (with the
 * generated input defaults and enhancement flags), and pushing arbitrary
 * text files to a repository via the Contents API.
 */
@Injectable()
export class ProjectWorkflowFilesService {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly workflowFragmentRegistry?: WorkflowFragmentRegistry,
  ) {}

  async buildWorkflowBundle(options: {
    templateId: string;
    serviceName: string;
    servicePath?: string | undefined;
    nodeVersion?: string | undefined;
    coverageThreshold?: number | undefined;
    customOutputFileName?: string | undefined;
    enhancements?:
      | Array<
          | 'strictProductionApproval'
          | 'enableUatApproval'
          | 'disablePlaywright'
          | 'disableK6'
        >
      | undefined;
    deploymentProvider?: DeploymentProvider | undefined;
    deploymentTargets?: DeploymentWorkflowTarget[] | undefined;
    workflowVariant?: 'backend' | 'frontend' | undefined;
    centralWorkflowRef?: string | undefined;
    /**
     * True when the workflow targets a service path that carries the
     * scaffold's tests/ directory (product-created repos). Leave unset for
     * BYO/setup repos and monorepo roots (their tests live under packages/).
     */
    hasTestsDirectory?: boolean | undefined;
    /** `owner/repo` of the paired frontend/backend repository (multi-repo only). See StagedWorkflowOptions. */
    siblingRepoFullName?: string | undefined;
  }): Promise<{ workflowFiles: StagedWorkflowFile[]; outputFileName: string }> {
    const {
      templateId,
      serviceName,
      servicePath,
      nodeVersion,
      coverageThreshold,
      customOutputFileName,
      enhancements,
      deploymentProvider,
      deploymentTargets = [],
      workflowVariant,
      centralWorkflowRef,
      hasTestsDirectory,
      siblingRepoFullName,
    } = options;

    const template = await this.catalogService.getTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template '${templateId}' not found`);
    }

    const bundle = buildStagedWorkflowBundle(
      template,
      {
        templateId,
        serviceName,
        ...(servicePath !== undefined && { servicePath }),
        ...(nodeVersion !== undefined && { nodeVersion }),
        ...(coverageThreshold !== undefined && { coverageThreshold }),
        ...(enhancements !== undefined && { enhancements }),
        ...(deploymentProvider !== undefined && { deploymentProvider }),
        ...(deploymentTargets.length > 0 && { deploymentTargets }),
        ...(workflowVariant !== undefined && { workflowVariant }),
        ...(centralWorkflowRef !== undefined && { centralWorkflowRef }),
        ...(hasTestsDirectory !== undefined && { hasTestsDirectory }),
        ...(siblingRepoFullName !== undefined && { siblingRepoFullName }),
      },
      this.workflowFragmentRegistry,
    );

    const outputFileName = customOutputFileName ?? '00-alphaci-access.yml';
    return {
      workflowFiles: bundle.workflowFiles,
      outputFileName,
    };
  }

  async pushWorkflowFiles(
    accessToken: string,
    owner: string,
    repo: string,
    workflowFiles: StagedWorkflowFile[],
    branch = 'main',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    let latest: { commitSha: string; commitUrl: string | null } | null = null;

    for (const file of workflowFiles) {
      latest = await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.yaml,
        undefined,
        branch,
      );
    }

    if (!latest) {
      throw new UnprocessableEntityException(
        'No workflow files were generated',
      );
    }

    return latest;
  }

  /**
   * Push a file to a GitHub repository via the Contents API.
   * If the file already exists (sha required), this will overwrite it.
   * Returns the commit SHA and HTML URL.
   */
  async pushWorkflowFile(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    commitMessage = 'ci: add ALPHACI workflow',
    /*
     * The branch to commit to.
     *
     * Defaulted rather than required so the new-repository flows — which build
     * `main` themselves moments earlier — stay unchanged. It exists for
     * ONBOARDING: an existing repository's default branch is whatever its
     * owner chose, and this was previously hardcoded to 'main', so every repo
     * on `master` or `develop` failed the push after its secrets had already
     * been written.
     */
    branch = 'main',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    const encodedContent = Buffer.from(content, 'utf8').toString('base64');

    // Check whether the file already exists so we can supply its sha (required for updates)
    let existingSha: string | undefined;
    try {
      // Read the sha FROM THE TARGET BRANCH. Without ?ref this asked the
      // default branch, so updating a file on any other branch would send a
      // sha that does not belong there and GitHub would reject the write.
      const checkRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (checkRes.ok) {
        const existing = (await checkRes.json()) as { sha?: string };
        existingSha = existing.sha;
      }
    } catch {
      // Not critical — proceed without sha; GitHub will reject if required
    }

    const body: Record<string, unknown> = {
      message: commitMessage,
      content: encodedContent,
      branch,
    };

    if (existingSha) {
      body['sha'] = existingSha;
    }

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new UnprocessableEntityException(
        `GitHub file push failed (${String(putRes.status)}): ${err}`,
      );
    }

    const response = (await putRes.json()) as GitHubContentsResponse;
    const commitSha = response.commit?.sha ?? '';
    const commitUrl = response.commit?.html_url ?? null;

    return { commitSha, commitUrl };
  }

  /**
   * Load the template from the catalog, apply substitutions, and return the
   * generated YAML string plus the derived output file name.
   */
  async buildWorkflowYaml(
    templateId: string,
    serviceName: string,
    servicePath?: string,
    nodeVersion?: string,
    coverageThreshold?: number,
    customOutputFileName?: string,
    enhancements?: Array<
      | 'strictProductionApproval'
      | 'enableUatApproval'
      | 'disablePlaywright'
      | 'disableK6'
    >,
  ): Promise<{ generatedYaml: string; outputFileName: string }> {
    const template = await this.catalogService.getTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template '${templateId}' not found`);
    }

    const source = await readFile(template.workflowPath, 'utf8');

    // Use DEFAULT_SCHEMA (the js-yaml default) explicitly to document that no
    // unsafe tag constructors (!!js/function, !!js/regexp, etc.) are permitted.
    // This is equivalent to yaml.load() with no schema option, but makes the
    // intent clear and is resilient to any future js-yaml API drift.
    const parsed = yaml.load(source, {
      schema: yaml.DEFAULT_SCHEMA,
    }) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UnprocessableEntityException(
        'Workflow template could not be parsed',
      );
    }

    parsed.name = `${serviceName} - ${template.name}`;

    const onConfig = ensureObject(parsed, 'on');
    const dispatchConfig = ensureObject(onConfig, 'workflow_dispatch');
    const inputConfig = ensureObject(dispatchConfig, 'inputs');

    setInputDefault(inputConfig, 'service_name', serviceName, 'string');
    if (servicePath) {
      setInputDefault(inputConfig, 'service_path', servicePath, 'string');
    }
    if (nodeVersion) {
      setInputDefault(inputConfig, 'node_version', nodeVersion, 'string');
    }
    if (coverageThreshold !== undefined) {
      setInputDefault(
        inputConfig,
        'coverage_threshold',
        coverageThreshold,
        'number',
      );
    }

    const pipelineConfig = ensureObject(
      ensureObject(parsed, 'jobs'),
      'pipeline',
    );
    const withConfig = ensureObject(pipelineConfig, 'with');
    applyEnhancements(withConfig, enhancements ?? []);

    const generatedYaml = yaml.dump(parsed, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    const outputFileName =
      customOutputFileName ?? deriveOutputFileName(serviceName, template.id);

    return { generatedYaml, outputFileName };
  }
}

export function deriveOutputFileName(
  serviceName: string,
  templateId: string,
): string {
  const normalized = serviceName
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');

  return `${normalized || 'service'}-${templateId}.yml`;
}

function ensureObject(
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

function setInputDefault(
  inputs: Record<string, unknown>,
  key: string,
  value: string | number,
  type: 'string' | 'number',
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
    record['default'] = value;
    if (!record['type']) {
      record['type'] = type;
    }
  }
}

export function applyEnhancements(
  withConfig: Record<string, unknown>,
  enhancements: Array<
    | 'strictProductionApproval'
    | 'enableUatApproval'
    | 'disablePlaywright'
    | 'disableK6'
  >,
): void {
  for (const enhancement of enhancements) {
    switch (enhancement) {
      case 'disablePlaywright':
        withConfig['run-playwright'] = false;
        break;
      case 'disableK6':
        withConfig['run-k6'] = false;
        break;
      case 'enableUatApproval':
        withConfig['require-uat-approval'] = true;
        break;
      case 'strictProductionApproval':
        withConfig['require-production-approval'] = true;
        break;
      default:
        break;
    }
  }
}
