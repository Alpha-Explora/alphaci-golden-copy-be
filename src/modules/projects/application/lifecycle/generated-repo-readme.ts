import {
  normalizeProjectStack,
  normalizeRepoShape,
} from '../../scaffold.builder';

/**
 * Pure README/description builders for generated repositories. No Nest,
 * no I/O — the exact text pushed to every new repo's README.md.
 */

export function describeGeneratedStack(stack: string | undefined): string {
  switch (normalizeProjectStack(stack)) {
    case 'nestjs':
      return 'NestJS API';
    case 'nextjs':
      return 'Next.js app';
    case 'react':
      return 'React app';
    case 'dotnet':
      return '.NET service';
    case 'nodejs':
    default:
      return 'Node.js service';
  }
}

export function generatedStructureLines(opts: {
  projectName: string;
  stack: string;
  repoShape?: string;
  frontendStack?: string;
  frontendServiceName?: string;
  backendServiceName?: string;
}): string[] {
  const stack = normalizeProjectStack(opts.stack);
  const repoShape = normalizeRepoShape(opts.repoShape);

  if (repoShape === 'monorepo') {
    return [
      '- `package.json`, `tsconfig.json`, `jest.config.ts`, and `eslint.config.mjs` define the workspace-level toolchain.',
      `- \`packages/core/\` contains the ${describeGeneratedStack(opts.stack)} starter package and tests.`,
      '- Add more packages under `packages/` when the project grows beyond the initial core package.',
    ];
  }

  if (repoShape === 'microservices') {
    return [
      `- \`backend/\` contains ${opts.backendServiceName ?? opts.projectName} as a ${describeGeneratedStack(opts.stack)}.`,
      `- \`frontend/\` contains ${opts.frontendServiceName ?? `${opts.projectName}-fe`} as a ${describeGeneratedStack(opts.frontendStack ?? 'nextjs')}.`,
      '- Each service owns its own `package.json`, TypeScript config, Jest config, ESLint config, source folder, and `tests/` folder.',
      '- `docker-compose.yml` is included when Docker scaffolding is enabled for the backend service.',
    ];
  }

  if (stack === 'nestjs') {
    return [
      '- `src/main.ts` boots the NestJS app.',
      '- `src/app.module.ts` is the initial application module.',
      '- `tests/unit/` holds the unit test suites; the starter spec verifies the exported service name.',
    ];
  }

  if (stack === 'dotnet') {
    return [
      '- `src/<Project>/Program.cs` boots the minimal API and exposes `/health`, which the production gate probes after each deployment.',
      '- `tests/<Project>.Tests/` hosts the application in memory with `WebApplicationFactory`, so coverage reflects code that actually runs.',
      '- `.editorconfig` is what `dotnet format` checks against; the pipeline runs it at warning severity on uat and main.',
      '- `global.json` pins the SDK so local builds and CI resolve the same version.',
    ];
  }

  if (stack === 'nextjs') {
    return [
      '- `src/app/layout.tsx` provides the App Router root layout.',
      '- `src/app/page.tsx` is the starter page.',
      '- `tests/unit/` holds the unit test suites; CI verifies this folder exists.',
      '- `next.config.ts` and the shared TypeScript/Jest/ESLint configs are ready for the generated workflow.',
    ];
  }

  if (stack === 'react') {
    return [
      '- `src/App.tsx` contains the starter React component.',
      '- `tests/unit/App.spec.tsx` renders the component with `react-dom/server` so unit tests pass without choosing a bundler for you.',
      '- Add Vite, Next.js, or another bundler when you are ready to build the real app shell.',
    ];
  }

  return [
    '- `src/index.ts` is the starter Node.js entrypoint.',
    '- `tests/unit/index.spec.ts` verifies the exported service name.',
    '- Docker scaffolding starts `dist/index.js`, matching the TypeScript build output.',
  ];
}

export function gettingStartedCommands(
  repoShape?: string,
  stack?: string,
): string[] {
  // The commands below are npm's. A .NET repository has no package.json, and a
  // README telling its developer to run `npm install` is worse than no README.
  if (
    stack !== undefined &&
    normalizeProjectStack(stack) === 'dotnet' &&
    normalizeRepoShape(repoShape) !== 'microservices'
  ) {
    return [
      '```bash',
      'dotnet restore',
      'dotnet format --verify-no-changes',
      'dotnet build --configuration Release --no-restore',
      'dotnet test --collect:"XPlat Code Coverage"',
      '```',
    ];
  }

  if (normalizeRepoShape(repoShape) === 'microservices') {
    return [
      '```bash',
      'cd backend',
      'npm install',
      'npm run lint',
      'npm test',
      'npm run build',
      '',
      'cd ../frontend',
      'npm install',
      'npm run lint',
      'npm test',
      'npm run build',
      '```',
    ];
  }

  return [
    '```bash',
    'npm install',
    'npm run lint',
    'npm test',
    'npm run build',
    '```',
  ];
}

export function repoShapeLabel(repoShape?: string): string {
  switch (normalizeRepoShape(repoShape)) {
    case 'monorepo':
      return 'monorepo workspace';
    case 'microservices':
      return 'microservices repository';
    case 'multi-repo':
      return 'single-service repository in a multi-repo project';
    case 'standalone':
    default:
      return 'standalone repository';
  }
}

export function buildGeneratedRepoReadme(opts: {
  projectName: string;
  stack: string;
  repoShape?: string;
  frontendStack?: string;
  frontendServiceName?: string;
  backendServiceName?: string;
}): string {
  return [
    `# ${opts.projectName}`,
    '',
    `Created by ALPHACI as a ${describeGeneratedStack(opts.stack)} ${repoShapeLabel(opts.repoShape)}.`,
    '',
    'This starter already includes source files, package scripts, TypeScript, ESLint, Jest coverage, SonarQube metadata, branch protections, and ALPHACI workflow files that match the selected stack. Use it as the first working baseline, then replace the starter code with your application code.',
    '',
    '## Project structure',
    '',
    ...generatedStructureLines(opts),
    '',
    '## Branch strategy',
    '',
    '| Branch  | Purpose |',
    '|---------|---------|',
    '| main    | Production - protected |',
    '| uat     | Integration and test - protected |',
    '| develop | Development integration - unprotected, no CI pipeline |',
    '',
    '## CI/CD',
    '',
    'Workflow files live in `.github/workflows/`. The CI pipeline runs on `uat` and `main` only. `develop` and user-created branches do not trigger workflows. Push to `uat` to trigger your first run.',
    '',
    '## Getting started',
    '',
    ...gettingStartedCommands(opts.repoShape, opts.stack),
    '',
    'Create a feature branch, open a pull request into `dev`, and let ALPHACI promote green changes through `uat` to `main`.',
  ].join('\n');
}
