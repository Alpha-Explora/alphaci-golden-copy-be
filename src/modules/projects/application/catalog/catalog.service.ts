import { existsSync, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import type { ListCatalogQueryDto } from './dto/list-catalog-query.dto';

// ─── Project Options types ────────────────────────────────────────────────────

export interface RepoShapeOption {
  id: string;
  label: string;
  enabled: boolean;
  description?: string;
}

export interface ProjectOptionSet {
  lint?: boolean;
  unit?: boolean;
  build?: boolean;
  coverage?: boolean;
  security?: boolean;
  docker?: boolean;
  e2e?: boolean;
}

export interface ProjectTypeOption {
  id: string;
  label: string;
  kind?: 'frontend' | 'backend';
  runtime?: string;
  language: string;
  framework: string;
  starterPath?: string;
  repoShapes: string[];
  reservedRepoShapes?: string[];
  defaultRecipe: string;
  allowedRecipes: string[];
  defaultOptions: ProjectOptionSet;
}

export interface WorkflowRecipeOption {
  id: string;
  label: string;
  description?: string;
  supportedProjectTypes: string[];
  templateByProjectType: Record<string, string>;
  workflowRefByProjectType?: Record<string, string>;
  mandatoryJobs?: string[];
  supportedOptions: ProjectOptionSet;
  optionJobs: Partial<
    Record<
      'lint' | 'unit' | 'build' | 'coverage' | 'security' | 'docker' | 'e2e',
      string
    >
  >;
}

export interface NodeVersionOption {
  value: string;
  label: string;
}

export interface ProjectOptionsResult {
  repoShapes: RepoShapeOption[];
  projectTypes: ProjectTypeOption[];
  recipes: WorkflowRecipeOption[];
  nodeVersions: NodeVersionOption[];
}

export interface CentralWorkflowTagsResult {
  tags: string[];
  defaultRef: string;
}

// ─── Static fallback catalog ─────────────────────────────────────────────────

// Order matters: the FE preselects the first enabled shape, so the simplest
// option (standalone) must come first. 'microservices' (backend + frontend in
// one repo) is archived and intentionally omitted from this list — not just
// disabled — so it never appears in the create-project picker at all; the
// product surfaces exactly two shapes: a single application, or backend +
// frontend as two repositories. The backend still recognizes the id
// internally (existing projects, normalizeRepoShape) for back-compat. 'mono'
// is parked as disabled (shown, greyed out) until the monorepo scaffold
// produces a real multi-package workspace with per-package pipelines — today
// it would mislead users into a generic TS workspace.
const STATIC_PROJECT_OPTIONS: ProjectOptionsResult = {
  repoShapes: [
    {
      id: 'standalone',
      label: 'Single application',
      enabled: true,
      description:
        'One repository with one app. The simplest way to start — best for most projects.',
    },
    {
      id: 'multi',
      label: 'Backend + frontend (two repos)',
      enabled: true,
      description:
        'Creates two repositories — one for your backend API, one for your frontend app — each with its own CI/CD pipeline.',
    },
    {
      id: 'mono',
      label: 'Monorepo (workspaces)',
      enabled: false,
      description: 'Multiple packages in one repository. Coming soon.',
    },
  ],
  projectTypes: [
    {
      id: 'nextjs',
      label: 'Next.js',
      runtime: 'node',
      language: 'TypeScript',
      framework: 'Next.js',
      starterPath: 'starters/nextjs',
      repoShapes: ['standalone', 'mono', 'multi', 'microservices'],
      defaultRecipe: 'standard',
      allowedRecipes: ['standard', 'minimal'],
      defaultOptions: { lint: true, unit: true, build: true, coverage: true },
    },
    {
      id: 'react',
      label: 'React',
      runtime: 'node',
      language: 'TypeScript',
      framework: 'React',
      starterPath: 'starters/react',
      repoShapes: ['standalone', 'mono', 'multi', 'microservices'],
      defaultRecipe: 'standard',
      allowedRecipes: ['standard', 'minimal'],
      defaultOptions: { lint: true, unit: true, build: true, coverage: true },
    },
    {
      id: 'nestjs',
      label: 'NestJS',
      runtime: 'node',
      language: 'TypeScript',
      framework: 'NestJS',
      starterPath: 'starters/nestjs',
      repoShapes: ['standalone', 'multi', 'microservices'],
      defaultRecipe: 'standard',
      allowedRecipes: ['standard', 'minimal'],
      defaultOptions: { lint: true, unit: true, build: true, coverage: true },
    },
    {
      id: 'nodejs',
      label: 'Node.js',
      runtime: 'node',
      language: 'TypeScript',
      framework: 'Express/Fastify',
      starterPath: 'starters/nodejs',
      repoShapes: ['standalone', 'multi', 'microservices'],
      defaultRecipe: 'standard',
      allowedRecipes: ['standard', 'minimal'],
      defaultOptions: { lint: true, unit: true, build: true },
    },
    {
      id: 'react-native',
      label: 'React Native',
      runtime: 'node',
      language: 'TypeScript',
      framework: 'React Native',
      starterPath: 'starters/react-native',
      repoShapes: ['standalone'],
      defaultRecipe: 'mobile',
      allowedRecipes: ['mobile', 'minimal'],
      defaultOptions: { lint: true, unit: true, build: true },
    },
    {
      id: 'expo',
      label: 'Expo',
      runtime: 'node',
      language: 'TypeScript',
      framework: 'Expo',
      starterPath: 'starters/expo',
      repoShapes: ['standalone'],
      defaultRecipe: 'mobile',
      allowedRecipes: ['mobile', 'minimal'],
      defaultOptions: { lint: true, unit: true, build: true },
    },
  ],
  recipes: [
    {
      id: 'standard',
      label: 'Standard',
      description:
        'Full CI pipeline: lint, test, build, coverage, security scan',
      supportedProjectTypes: ['nextjs', 'react', 'nestjs', 'nodejs'],
      templateByProjectType: {
        nextjs: 'nextjs-service-pipeline',
        react: 'react-service-pipeline',
        nestjs: 'nest-service-pipeline',
        nodejs: 'nodejs-service-pipeline',
      },
      mandatoryJobs: ['lint', 'build'],
      supportedOptions: {
        lint: true,
        unit: true,
        build: true,
        coverage: true,
        security: true,
        docker: true,
        e2e: true,
      },
      optionJobs: {
        lint: 'lint',
        unit: 'test',
        coverage: 'coverage',
        security: 'security-scan',
        docker: 'docker-build',
        e2e: 'e2e',
      },
    },
    {
      id: 'minimal',
      label: 'Minimal',
      description: 'Lightweight CI: lint and build only',
      supportedProjectTypes: [
        'nextjs',
        'react',
        'nestjs',
        'nodejs',
        'react-native',
        'expo',
      ],
      templateByProjectType: {
        nextjs: 'nextjs-service-pipeline',
        react: 'react-service-pipeline',
        nestjs: 'nest-service-pipeline',
        nodejs: 'nodejs-service-pipeline',
        'react-native': 'react-native-service-pipeline',
        expo: 'expo-service-pipeline',
      },
      mandatoryJobs: ['lint', 'build'],
      supportedOptions: { lint: true, unit: true, build: true },
      optionJobs: { lint: 'lint', unit: 'test' },
    },
    {
      id: 'mobile',
      label: 'Mobile',
      description: 'Mobile-optimised CI: lint, test, and app build',
      supportedProjectTypes: ['react-native', 'expo'],
      templateByProjectType: {
        'react-native': 'react-native-service-pipeline',
        expo: 'expo-service-pipeline',
      },
      mandatoryJobs: ['lint', 'build'],
      supportedOptions: { lint: true, unit: true, build: true, coverage: true },
      optionJobs: { lint: 'lint', unit: 'test', coverage: 'coverage' },
    },
  ],
  nodeVersions: [
    { value: '20', label: 'Node 20 LTS (Iron)' },
    { value: '22', label: 'Node 22 LTS (Jod)' },
    { value: '24', label: 'Node 24 LTS (Noble)' },
  ],
};

// ─── Template types ───────────────────────────────────────────────────────────

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  iconName: string;
  categories: string[];
  filePatterns: string[];
  stack: 'nextjs' | 'react' | 'react-native' | 'expo' | 'nestjs' | 'nodejs';
  propertiesPath: string;
  workflowPath: string;
}

interface WorkflowPropertiesFile {
  name?: string;
  description?: string;
  iconName?: string;
  categories?: string[];
  filePatterns?: string[];
}

interface EngineStackFile {
  key?: string;
  label?: string;
  kind?: string;
  runtime?: string;
  serviceWorkflow?: string;
}

interface EngineWorkflowRefsFile {
  currentStable?: string;
  repository?: string;
  nodeVersions?: Array<{ value: string; label: string }>;
  workflows?: Record<string, string>;
}

// The reusable gated-stage workflow logic (Access, Quality, Package) that every
// generated pipeline calls into via `uses: <repo>/<workflow>@<ref>`. Public
// repo — tags are readable via GitHub's unauthenticated REST API.
const CENTRAL_WORKFLOW_REPO = 'cicd-external-project/cicd-workflow';

function resolveDefaultCentralWorkflowRef(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env['CENTRAL_WORKFLOW_REF']?.trim() || 'v1';
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly config: AppConfig;
  private cache: { loadedAt: number; templates: WorkflowTemplate[] } | null =
    null;
  private projectOptionsCache: ProjectOptionsResult | null = null;
  private readonly cacheTtlMs = 20_000;
  private centralWorkflowTagsCache: {
    loadedAt: number;
    tags: string[];
  } | null = null;
  private readonly centralWorkflowTagsCacheTtlMs = 5 * 60_000;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.getOrThrow<AppConfig>('app');
  }

  getProjectOptions(): ProjectOptionsResult {
    if (this.projectOptionsCache) {
      return this.projectOptionsCache;
    }

    try {
      const options = this.loadEngineProjectOptions();
      this.projectOptionsCache = options;
      return options;
    } catch (error) {
      this.logger.warn(
        `Could not load engine project catalog; using static fallback: ${(error as Error).message}`,
      );
      return STATIC_PROJECT_OPTIONS;
    }
  }

  /**
   * Lists the git tags published on the central-workflow repo, so the
   * "Central workflow ref" field can be a dropdown of real, existing refs
   * instead of free text a user could mistype into a broken pipeline. Falls
   * back to just the configured default ref if GitHub is unreachable or
   * rate-limits the (unauthenticated, public-repo) request — the field must
   * always have at least one valid, selectable value.
   */
  async getCentralWorkflowTags(): Promise<CentralWorkflowTagsResult> {
    const defaultRef = resolveDefaultCentralWorkflowRef();

    if (
      this.centralWorkflowTagsCache &&
      Date.now() - this.centralWorkflowTagsCache.loadedAt <
        this.centralWorkflowTagsCacheTtlMs
    ) {
      return { tags: this.centralWorkflowTagsCache.tags, defaultRef };
    }

    try {
      const response = await fetch(
        `https://api.github.com/repos/${CENTRAL_WORKFLOW_REPO}/tags?per_page=30`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'alphaci-platform',
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `GitHub tags request failed with status ${String(response.status)}`,
        );
      }

      const body = (await response.json()) as Array<{ name?: string }>;
      const tags = body
        .map((tag) => tag.name)
        .filter(
          (name): name is string => typeof name === 'string' && name.length > 0,
        );

      this.centralWorkflowTagsCache = { loadedAt: Date.now(), tags };
      return { tags, defaultRef };
    } catch (error) {
      this.logger.warn(
        `Could not fetch central-workflow tags from GitHub; falling back to the default ref only: ${(error as Error).message}`,
      );
      return { tags: [defaultRef], defaultRef };
    }
  }

  async listCategories() {
    const templates = await this.getTemplates();
    const counts = new Map<string, number>();

    for (const template of templates) {
      for (const category of template.categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.name.localeCompare(right.name),
      );
  }

  async listTemplates(query: ListCatalogQueryDto = {}) {
    const templates = await this.getTemplates();
    const normalizedCategory = query.category?.trim().toLowerCase();
    const normalizedSearch = query.q?.trim().toLowerCase();

    return templates.filter((template) => {
      if (query.stack && template.stack !== query.stack) {
        return false;
      }

      if (normalizedCategory) {
        const hasCategory = template.categories.some(
          (category) => category.toLowerCase() === normalizedCategory,
        );
        if (!hasCategory) {
          return false;
        }
      }

      if (!normalizedSearch) {
        return true;
      }

      const haystack = [
        template.name,
        template.description,
        template.stack,
        template.categories.join(' '),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }

  async getTemplateById(templateId: string): Promise<WorkflowTemplate | null> {
    const templates = await this.getTemplates();
    return templates.find((template) => template.id === templateId) ?? null;
  }

  getResolvedStarterPath(projectTypeId: string): string | null {
    const option = STATIC_PROJECT_OPTIONS.projectTypes.find(
      (pt) => pt.id === projectTypeId,
    );
    if (!option?.starterPath) return null;

    return join(this.resolveTemplateRepoPath(), option.starterPath);
  }

  private async getTemplates(): Promise<WorkflowTemplate[]> {
    if (this.cache && Date.now() - this.cache.loadedAt < this.cacheTtlMs) {
      return this.cache.templates;
    }

    // Resolve the repo path relative to this source file when a relative path
    // is configured. Using __dirname (dist/modules/projects/application/catalog) keeps the anchor
    // stable regardless of the process working directory — critical in Docker
    // where cwd is /app, not the project root. In production, set an absolute
    // TEMPLATE_REPO_PATH in your environment or Dockerfile to be explicit.
    const anchoredRepoPath = this.resolveTemplateRepoPath();

    const templatesRoot = join(
      anchoredRepoPath,
      this.config.templates.workflowDir,
    );
    const rootExists = await this.pathExists(templatesRoot);
    if (!rootExists) {
      throw new ServiceUnavailableException(
        `Template source folder is not available: ${templatesRoot}`,
      );
    }

    const entries = await readdir(templatesRoot, { withFileTypes: true });
    const propertyFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.properties.json'),
    );

    const loaded = await Promise.all(
      propertyFiles.map(async (entry) => {
        const id = entry.name.replace('.properties.json', '');
        const propertiesPath = join(templatesRoot, entry.name);
        const workflowPath = join(templatesRoot, `${id}.yml`);

        if (!(await this.pathExists(workflowPath))) {
          return null;
        }

        try {
          const raw = await readFile(propertiesPath, 'utf8');
          const parsed = JSON.parse(raw) as WorkflowPropertiesFile;

          const categories = Array.isArray(parsed.categories)
            ? parsed.categories.filter(
                (value): value is string => typeof value === 'string',
              )
            : [];

          const filePatterns = Array.isArray(parsed.filePatterns)
            ? parsed.filePatterns.filter(
                (value): value is string => typeof value === 'string',
              )
            : [];

          return {
            id,
            name: parsed.name ?? id,
            description: parsed.description ?? '',
            iconName: parsed.iconName ?? 'octicon package',
            categories,
            filePatterns,
            stack: this.inferStack(id, categories),
            propertiesPath,
            workflowPath,
          } satisfies WorkflowTemplate;
        } catch {
          return null;
        }
      }),
    );

    const templates = loaded
      .filter((template): template is WorkflowTemplate => template !== null)
      .sort((left, right) => left.name.localeCompare(right.name));

    this.cache = {
      loadedAt: Date.now(),
      templates,
    };

    return templates;
  }

  private loadEngineProjectOptions(): ProjectOptionsResult {
    const catalogRoot = join(this.resolveTemplateRepoPath(), 'catalog');
    const stacks = this.readCatalogJson<EngineStackFile[]>(
      catalogRoot,
      'stacks.json',
    );
    this.readCatalogJson<unknown[]>(catalogRoot, 'actions.json');
    this.readCatalogJson<unknown[]>(catalogRoot, 'providers.json');
    this.readCatalogJson<unknown[]>(catalogRoot, 'plans.json');
    const workflowRefs = this.readCatalogJson<EngineWorkflowRefsFile>(
      catalogRoot,
      'workflow-refs.json',
    );

    const usableStacks = stacks.filter(
      (
        stack,
      ): stack is Required<Pick<EngineStackFile, 'key' | 'label'>> &
        EngineStackFile =>
        typeof stack.key === 'string' &&
        stack.key.length > 0 &&
        typeof stack.label === 'string' &&
        stack.label.length > 0,
    );

    if (usableStacks.length === 0) {
      throw new Error('stacks.json did not contain usable stacks');
    }

    const projectTypes = usableStacks.map((stack) => {
      // Frontend stacks must include 'multi': the multi-repo shape provisions
      // a frontend repository, so its Language picker draws from this list.
      const repoShapes =
        stack.kind === 'backend'
          ? ['standalone', 'multi', 'microservices']
          : ['standalone', 'mono', 'multi', 'microservices'];

      return {
        id: stack.key,
        label: stack.label,
        kind: stack.kind === 'backend' ? 'backend' : 'frontend',
        runtime: stack.runtime ?? 'node',
        language: 'TypeScript',
        framework: stack.label,
        repoShapes,
        defaultRecipe: 'standard',
        allowedRecipes: ['standard', 'minimal'],
        defaultOptions: { lint: true, unit: true, build: true, coverage: true },
      } satisfies ProjectTypeOption;
    });

    const templateByProjectType = Object.fromEntries(
      usableStacks.map((stack) => [
        stack.key,
        this.templateIdForStack(stack.key, stack.serviceWorkflow),
      ]),
    );
    const workflowRefByProjectType = Object.fromEntries(
      usableStacks.map((stack) => [
        stack.key,
        this.workflowRefForStack(stack.serviceWorkflow, workflowRefs),
      ]),
    );
    const supportedProjectTypes = usableStacks.map((stack) => stack.key);

    const nodeVersions = (workflowRefs.nodeVersions ?? []).filter(
      (v): v is NodeVersionOption =>
        typeof v.value === 'string' &&
        v.value.length > 0 &&
        typeof v.label === 'string' &&
        v.label.length > 0,
    );

    return {
      repoShapes: STATIC_PROJECT_OPTIONS.repoShapes,
      projectTypes,
      nodeVersions:
        nodeVersions.length > 0
          ? nodeVersions
          : STATIC_PROJECT_OPTIONS.nodeVersions,
      recipes: [
        {
          id: 'standard',
          label: 'Standard',
          description:
            'Full CI pipeline generated from the workflow engine catalog.',
          supportedProjectTypes,
          templateByProjectType,
          workflowRefByProjectType,
          mandatoryJobs: ['lint', 'build'],
          supportedOptions: {
            lint: true,
            unit: true,
            build: true,
            coverage: true,
            security: true,
            docker: true,
            e2e: true,
          },
          optionJobs: {
            lint: 'lint',
            unit: 'test',
            coverage: 'coverage',
            security: 'security-scan',
            docker: 'docker-build',
            e2e: 'e2e',
          },
        },
        {
          id: 'minimal',
          label: 'Minimal',
          description:
            'Lightweight CI generated from the workflow engine catalog.',
          supportedProjectTypes,
          templateByProjectType,
          workflowRefByProjectType,
          mandatoryJobs: ['lint', 'build'],
          supportedOptions: { lint: true, unit: true, build: true },
          optionJobs: { lint: 'lint', unit: 'test' },
        },
      ],
    };
  }

  private readCatalogJson<T>(catalogRoot: string, fileName: string): T {
    const raw = readFileSync(join(catalogRoot, fileName), 'utf8');
    return JSON.parse(raw) as T;
  }

  private resolveTemplateRepoPath(): string {
    const configuredPath = this.config.templates.repoPath;
    if (isAbsolute(configuredPath)) {
      return configuredPath;
    }

    const cwdCandidate = resolve(process.cwd(), configuredPath);
    if (existsSync(cwdCandidate)) {
      return cwdCandidate;
    }

    return resolve(__dirname, configuredPath);
  }

  private templateIdForStack(
    stackKey: string,
    serviceWorkflow?: string,
  ): string {
    const workflowKeyMap: Record<string, string> = {
      nextjsService: 'nextjs-service-pipeline',
      nestjsService: 'nest-service-pipeline',
      nodeService: 'nodejs-service-pipeline',
      reactService: 'react-service-pipeline',
      reactNativeService: 'react-native-service-pipeline',
      expoService: 'expo-service-pipeline',
    };

    return serviceWorkflow
      ? (workflowKeyMap[serviceWorkflow] ?? `${stackKey}-service-pipeline`)
      : `${stackKey}-service-pipeline`;
  }

  private workflowRefForStack(
    serviceWorkflow: string | undefined,
    refs: EngineWorkflowRefsFile,
  ): string {
    if (!serviceWorkflow || !refs.repository || !refs.currentStable) {
      return '';
    }

    const workflowPath = refs.workflows?.[serviceWorkflow];
    if (!workflowPath) {
      return '';
    }

    return `${refs.repository}/${workflowPath}@${refs.currentStable}`;
  }

  private inferStack(
    templateId: string,
    categories: string[],
  ): 'nextjs' | 'react' | 'react-native' | 'expo' | 'nestjs' | 'nodejs' {
    const normalizedId = templateId.toLowerCase();
    const normalizedCategories = categories.map((category) =>
      category.toLowerCase(),
    );

    if (
      normalizedId.includes('react-native') ||
      normalizedCategories.includes('react native')
    ) {
      return 'react-native';
    }

    if (
      normalizedId.includes('nextjs') ||
      normalizedCategories.includes('next.js')
    ) {
      return 'nextjs';
    }

    if (
      (normalizedId.includes('nest') &&
        !normalizedId.includes('react-native')) ||
      normalizedCategories.includes('nestjs')
    ) {
      return 'nestjs';
    }

    if (
      normalizedId.includes('nodejs') ||
      normalizedCategories.includes('node.js')
    ) {
      return 'nodejs';
    }

    if (normalizedId.includes('expo')) {
      return 'expo';
    }

    return 'react';
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
