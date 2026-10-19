import { existsSync, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';

import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import type { ServiceRuntimeContract } from '#kernel/ports/deployment-runtime.port';
import { scaffoldRuntimeContract } from '../../scaffold.builder';
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
  /**
   * The container port and health path of the app AlphaCI scaffolds for this
   * type, from the scaffold's own declaration. Absent for a type with no
   * scaffold. The create wizard pre-fills on-prem hosting with it.
   */
  serviceRuntime?: ServiceRuntimeContract;
}

/** Joins each project type to its scaffold's runtime contract. */
function withServiceRuntime(
  options: ProjectOptionsResult,
): ProjectOptionsResult {
  return {
    ...options,
    projectTypes: options.projectTypes.map((type) => {
      const serviceRuntime = scaffoldRuntimeContract(type.id);
      return serviceRuntime ? { ...type, serviceRuntime } : type;
    }),
  };
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
  stack:
    | 'nextjs'
    | 'react'
    | 'react-native'
    | 'expo'
    | 'nestjs'
    | 'nodejs'
    | 'dotnet';
  /**
   * Whether the stack produces a service or a site, taken from the catalog.
   *
   * The generator previously re-derived this by comparing the stack identifier
   * against a hardcoded list, which meant a stack the list did not name was
   * classified as a frontend by omission rather than rejected. The catalog has
   * always declared it. See ADR-0006.
   *
   * Optional because templates predating the catalog have no entry to join to;
   * callers fall back rather than assume.
   */
  kind?: 'frontend' | 'backend';
  /** Toolchain family the stack runs on, from the catalog: 'node' or 'dotnet'. */
  runtime?: string;
  /**
   * Default version of that runtime, from the catalog.
   *
   * Declared per stack because the generate DTO only carries `nodeVersion`,
   * which is meaningless to a stack that does not run on Node — handing a .NET
   * pipeline a Node major would produce a `dotnet-version: 24` that resolves to
   * no SDK. The DTO still wins when a project pins a version explicitly.
   */
  runtimeVersion?: string;
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
  /** Declared default runtime version, e.g. '10.0.x' for .NET. */
  defaultRuntimeVersion?: string;
  /**
   * Customer pipeline template this stack provisions with.
   *
   * Declared because it was previously reconstructed from `serviceWorkflow`
   * through a hardcoded map plus a `${key}-service-pipeline` fallback, so a new
   * stack resolved to a filename nobody had written and creation failed with a
   * 404 in front of the customer. The workflow repository validates that the
   * declared file exists, which moves that failure to the commit causing it.
   */
  serviceTemplate?: string;
  /**
   * Repo shapes this stack can actually be provisioned in.
   *
   * Declared because the shapes were derived from `kind`, which offered every
   * backend stack the monorepo and microservices shapes. Those assume npm
   * workspaces and a docker-compose pair, so a stack without an equivalent was
   * offered in the picker and then failed at provisioning.
   */
  repoShapes?: string[];
  /**
   * Source language shown in the project-type picker.
   *
   * Was hardcoded to 'TypeScript' for every stack, which was true only while
   * every stack ran on Node. Declared here so adding a stack does not silently
   * mislabel it.
   */
  language?: string;
  serviceWorkflow?: string;
}

interface EngineWorkflowRefsFile {
  currentStable?: string;
  repository?: string;
  nodeVersions?: Array<{ value: string; label: string }>;
  workflows?: Record<string, string>;
}

// The reusable gated-stage workflow logic (Access, Quality, Package) that every
// generated pipeline calls into via `uses: <repo>/<workflow>@<ref>`. The
// repository is configuration (templates.centralWorkflowRepo), not a constant,
// so a deployment can be repointed without a code change and the value cannot
// drift away from the one the workflow generator uses.

function resolveDefaultCentralWorkflowRef(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env['CENTRAL_WORKFLOW_REF']?.trim() || 'v1';
}

@Injectable()
export class CatalogService implements OnModuleInit {
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

  /**
   * Assert the baked central-workflow content is actually present.
   *
   * Both failure paths used to be silent in the ways that matter. A missing
   * templates folder surfaced as a 503 on the first catalog request, while the
   * container's health check — which never touches the catalog — kept reporting
   * healthy. A missing catalog folder was quieter still: `getProjectOptions`
   * caught the error and served a hardcoded fallback stack list, so the product
   * answered successfully with different data and logged one warning.
   *
   * That second path is not hypothetical. The repoPath default named a
   * directory that resolved for nobody, so local runs served the fallback while
   * deployed instances served the real catalog, and nothing said so.
   *
   * Production fails to boot, because an image whose templates did not copy is
   * broken and should never take traffic. Elsewhere this warns loudly at boot
   * rather than lazily on first use, so a developer without the sibling
   * checkout still sees which catalog they are actually running against.
   */
  async onModuleInit(): Promise<void> {
    const repoPath = this.resolveTemplateRepoPath();
    const missing: string[] = [];

    const templatesRoot = join(repoPath, this.config.templates.workflowDir);
    if (await this.pathExists(templatesRoot)) {
      // Existing but empty is the failure this check used to miss. The
      // templates live in a subdirectory, so a workflowDir pointing one level
      // too high names a real directory that holds no templates at all: the
      // assertion passed, every lookup then returned nothing, and project
      // creation failed with `Template '...' not found` for every stack. A
      // check that cannot tell zero templates from fifteen is not checking the
      // thing that matters.
      const entries = await readdir(templatesRoot, { withFileTypes: true });
      const templateCount = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith('.properties.json'),
      ).length;

      if (templateCount === 0) {
        missing.push(
          `workflow templates (${templatesRoot} exists but contains no *.properties.json; TEMPLATE_WORKFLOW_DIR may be pointing above the folder that holds them)`,
        );
      }
    } else {
      missing.push(`workflow templates (${templatesRoot})`);
    }

    const catalogRoot = join(repoPath, 'catalog');
    if (!(await this.pathExists(catalogRoot))) {
      missing.push(`engine catalog (${catalogRoot})`);
    }

    if (missing.length === 0) {
      this.logger.log(
        `Central workflow content resolved at ${repoPath} (repository: ${this.config.templates.centralWorkflowRepo}).`,
      );
      return;
    }

    const detail = `Central workflow content is not available: ${missing.join(', ')}. Set TEMPLATE_REPO_PATH to a checkout of ${this.config.templates.centralWorkflowRepo}.`;

    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(detail);
    }

    this.logger.warn(
      `${detail} Project options will fall back to the built-in stack list, which does not match the catalog this deployment generates pipelines from.`,
    );
  }

  getProjectOptions(): ProjectOptionsResult {
    if (this.projectOptionsCache) {
      return this.projectOptionsCache;
    }

    try {
      const options = withServiceRuntime(this.loadEngineProjectOptions());
      this.projectOptionsCache = options;
      return options;
    } catch (error) {
      this.logger.warn(
        `Could not load engine project catalog; using static fallback: ${(error as Error).message}`,
      );
      return withServiceRuntime(STATIC_PROJECT_OPTIONS);
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
        `https://api.github.com/repos/${this.config.templates.centralWorkflowRepo}/tags?per_page=30`,
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

  /**
   * Declared default runtime version for a stack, from `catalog/stacks.json`.
   *
   * The scaffold needs it for stacks that do not run on Node, where the generate
   * DTO's `nodeVersion` means nothing. Returned from the catalog rather than
   * defaulted in the scaffold so the SDK the repository pins and the SDK the
   * pipeline installs come from one place.
   */
  getStackRuntimeVersion(stackKey: string): string | undefined {
    return this.readStackCatalog().get(stackKey)?.defaultRuntimeVersion;
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

    const stacksByKey = this.readStackCatalog();

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

          const stack = this.inferStack(id, categories);
          const catalogEntry = stacksByKey.get(stack);

          return {
            id,
            name: parsed.name ?? id,
            description: parsed.description ?? '',
            iconName: parsed.iconName ?? 'octicon package',
            categories,
            filePatterns,
            stack,
            // Joined from catalog/stacks.json rather than re-derived. The key
            // still comes from the template id, for templates that predate the
            // catalog; kind and runtime are declared, not inferred. ADR-0006.
            ...(catalogEntry?.kind === 'frontend' ||
            catalogEntry?.kind === 'backend'
              ? { kind: catalogEntry.kind }
              : {}),
            ...(catalogEntry?.runtime ? { runtime: catalogEntry.runtime } : {}),
            ...(catalogEntry?.defaultRuntimeVersion
              ? { runtimeVersion: catalogEntry.defaultRuntimeVersion }
              : {}),
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
        stack.repoShapes && stack.repoShapes.length > 0
          ? stack.repoShapes
          : stack.kind === 'backend'
            ? ['standalone', 'multi', 'microservices']
            : ['standalone', 'mono', 'multi', 'microservices'];

      return {
        id: stack.key,
        label: stack.label,
        kind: stack.kind === 'backend' ? 'backend' : 'frontend',
        runtime: stack.runtime ?? 'node',
        language: stack.language ?? 'TypeScript',
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
        this.templateIdForStack(
          stack.key,
          stack.serviceWorkflow,
          stack.serviceTemplate,
        ),
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

  /**
   * The catalog's stack declarations, keyed for lookup.
   *
   * Returns an empty map when the catalog is unavailable rather than throwing:
   * a template can still be served without its catalog entry, it simply has no
   * declared kind or runtime and callers fall back. Failing here would take the
   * whole template listing down over metadata that is additive.
   */
  private readStackCatalog(): Map<string, EngineStackFile> {
    try {
      const catalogRoot = join(this.resolveTemplateRepoPath(), 'catalog');
      const stacks = this.readCatalogJson<EngineStackFile[]>(
        catalogRoot,
        'stacks.json',
      );

      return new Map(
        stacks
          .filter((stack): stack is EngineStackFile & { key: string } =>
            Boolean(stack.key),
          )
          .map((stack) => [stack.key, stack]),
      );
    } catch (error) {
      this.logger.warn(
        `Stack catalog unavailable; templates will carry no declared kind or runtime: ${(error as Error).message}`,
      );
      return new Map();
    }
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
    serviceTemplate?: string,
  ): string {
    const workflowKeyMap: Record<string, string> = {
      nextjsService: 'nextjs-service-pipeline',
      nestjsService: 'nest-service-pipeline',
      nodeService: 'nodejs-service-pipeline',
      reactService: 'react-service-pipeline',
      reactNativeService: 'react-native-service-pipeline',
      expoService: 'expo-service-pipeline',
    };

    // Declared value wins. The map below stays only for catalogs published
    // before serviceTemplate existed.
    if (serviceTemplate) {
      return serviceTemplate;
    }

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
  ): WorkflowTemplate['stack'] {
    const normalizedId = templateId.toLowerCase();
    const normalizedCategories = categories.map((category) =>
      category.toLowerCase(),
    );

    // Checked first because the fallback below returns 'react': a stack this
    // function does not name is classified as a frontend rather than rejected,
    // so a .NET template that reached the end would be handed setup-node and a
    // frontend test workflow. See ADR-0006.
    if (
      normalizedId.includes('dotnet') ||
      normalizedCategories.includes('dotnet') ||
      normalizedCategories.includes('csharp')
    ) {
      return 'dotnet';
    }

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
