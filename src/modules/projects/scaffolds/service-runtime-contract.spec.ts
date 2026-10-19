import {
  buildProjectScaffold,
  scaffoldRuntimeContract,
  type ScaffoldFile,
} from '../scaffold.builder';
import {
  SCAFFOLD_RUNTIME_CONTRACTS,
  type CanonicalStack,
} from './service-runtime-contract';

/*
 * On-prem assigns each scaffolded app the port and health path declared in
 * SCAFFOLD_RUNTIME_CONTRACTS. These tests build every scaffold and read what it
 * actually serves, so a Dockerfile, listen port or health route that drifts
 * from the declaration fails here instead of at a customer's health check.
 */

const STACKS = Object.keys(SCAFFOLD_RUNTIME_CONTRACTS) as CanonicalStack[];

function file(files: ScaffoldFile[], path: string | RegExp): string {
  const found = files.find((item) =>
    typeof path === 'string' ? item.path === path : path.test(item.path),
  );
  if (!found) throw new Error(`The scaffold has no ${String(path)}`);
  return found.content;
}

/** Every port a Dockerfile exposes. */
function exposed(dockerfile: string): number[] {
  return [...dockerfile.matchAll(/^EXPOSE\s+(\d+)/gm)].map((match) =>
    Number(match[1]),
  );
}

/** The port the image tells the app to listen on. */
function listenPort(dockerfile: string): number | null {
  const match =
    /^ENV PORT=(\d+)$/m.exec(dockerfile) ??
    /^ENV ASPNETCORE_URLS=http:\/\/\+:(\d+)$/m.exec(dockerfile);
  return match ? Number(match[1]) : null;
}

/** What each stack serves, read from the files its scaffold writes. */
function served(stack: CanonicalStack, files: ScaffoldFile[], dir = '') {
  const dockerfile = file(files, `${dir}Dockerfile`);
  switch (stack) {
    case 'nestjs': {
      const main = file(files, `${dir}src/main.ts`);
      const controller = file(files, `${dir}src/health.controller.ts`);
      return {
        exposed: exposed(dockerfile),
        listen: listenPort(dockerfile),
        // `app.listen(process.env.PORT ?? N)`: the local default agrees too.
        fallbackListen: Number(/process\.env\.PORT \?\? (\d+)/.exec(main)?.[1]),
        health: `/${/@Controller\('([^']*)'\)/.exec(controller)?.[1]}`,
      };
    }
    case 'nodejs':
      return {
        exposed: exposed(dockerfile),
        listen: listenPort(dockerfile),
      };
    case 'dotnet': {
      const program = file(files, /^src\/[^/]+\/Program\.cs$/);
      return {
        exposed: exposed(dockerfile),
        listen: listenPort(dockerfile),
        health: /app\.MapGet\("([^"]+)", \(IServiceStatus/.exec(program)?.[1],
      };
    }
    case 'nextjs':
      return {
        exposed: exposed(dockerfile),
        listen: listenPort(dockerfile),
        // The App Router page at src/app/page.tsx is what answers `/`.
        health: files.some((item) => item.path === `${dir}src/app/page.tsx`)
          ? '/'
          : null,
      };
    case 'react': {
      const nginx = file(files, `${dir}nginx.conf`);
      const probe = /http:\/\/127\.0\.0\.1:(\d+)(\/\S*)/.exec(dockerfile);
      return {
        exposed: exposed(dockerfile),
        listen: Number(/^\s*listen (\d+);/m.exec(nginx)?.[1]),
        healthcheckPort: Number(probe?.[1]),
        health: probe?.[2],
      };
    }
  }
}

function expected(stack: CanonicalStack) {
  const { containerPort, healthPath } = SCAFFOLD_RUNTIME_CONTRACTS[stack];
  switch (stack) {
    case 'nestjs':
      return {
        exposed: [containerPort],
        listen: containerPort,
        fallbackListen: containerPort,
        health: healthPath,
      };
    case 'nodejs':
      return { exposed: [containerPort], listen: containerPort };
    case 'react':
      return {
        exposed: [containerPort],
        listen: containerPort,
        healthcheckPort: containerPort,
        health: healthPath,
      };
    default:
      return {
        exposed: [containerPort],
        listen: containerPort,
        health: healthPath,
      };
  }
}

describe('scaffold runtime contracts', () => {
  it('declares the port and health path of every stack', () => {
    expect(SCAFFOLD_RUNTIME_CONTRACTS).toEqual({
      nestjs: { slot: 'backend', containerPort: 3000, healthPath: '/health' },
      nodejs: { slot: 'backend', containerPort: 3000, healthPath: '/health' },
      dotnet: { slot: 'backend', containerPort: 8080, healthPath: '/health' },
      nextjs: { slot: 'frontend', containerPort: 3000, healthPath: '/' },
      react: { slot: 'frontend', containerPort: 8080, healthPath: '/' },
    });
  });

  describe.each(['standalone', 'multi'])('%s repository', (repoShape) => {
    it.each(STACKS)('%s serves what it declares', (stack) => {
      const files = buildProjectScaffold({
        serviceName: 'orders',
        stack,
        includeDocker: true,
        repoShape,
      });
      expect(served(stack, files)).toEqual(expected(stack));
    });
  });

  it.each([
    ['nestjs', 'nextjs'],
    ['nestjs', 'react'],
    ['nodejs', 'react'],
  ] as const)(
    'a %s + %s repository serves what both declare, compose included',
    (backend, frontend) => {
      const files = buildProjectScaffold({
        serviceName: 'orders',
        stack: backend,
        frontendStack: frontend,
        includeDocker: true,
        repoShape: 'microservices',
      });
      expect(served(backend, files, 'backend/')).toEqual(expected(backend));
      // The Next.js frontend of this shape ships no Dockerfile of its own.
      if (frontend === 'react')
        expect(served(frontend, files, 'frontend/')).toEqual(
          expected(frontend),
        );
      const compose = file(files, 'docker-compose.yml');
      const containerPorts = [...compose.matchAll(/"\d+:(\d+)"/g)].map(
        (match) => Number(match[1]),
      );
      expect(containerPorts).toEqual([
        SCAFFOLD_RUNTIME_CONTRACTS[backend].containerPort,
        SCAFFOLD_RUNTIME_CONTRACTS[frontend].containerPort,
      ]);
    },
  );

  it('reads the backend port into .env.example', () => {
    for (const stack of ['nestjs', 'nodejs'] as const) {
      const files = buildProjectScaffold({
        serviceName: 'orders',
        stack,
        includeDocker: true,
      });
      expect(file(files, '.env.example')).toContain(
        `PORT=${SCAFFOLD_RUNTIME_CONTRACTS[stack].containerPort}`,
      );
    }
  });
});

describe('scaffoldRuntimeContract', () => {
  it.each([
    ['nestjs', SCAFFOLD_RUNTIME_CONTRACTS.nestjs],
    ['nestjs-api', SCAFFOLD_RUNTIME_CONTRACTS.nestjs],
    ['dotnet', SCAFFOLD_RUNTIME_CONTRACTS.dotnet],
    ['nodejs', SCAFFOLD_RUNTIME_CONTRACTS.nodejs],
    ['nextjs', SCAFFOLD_RUNTIME_CONTRACTS.nextjs],
    ['react-app', SCAFFOLD_RUNTIME_CONTRACTS.react],
  ])('resolves %s', (projectTypeId, contract) => {
    expect(scaffoldRuntimeContract(projectTypeId)).toEqual(contract);
  });

  it.each([[null], [undefined], [''], ['  '], ['expo'], ['react-native']])(
    'has no contract for %j: no scaffold, so the caller keeps its fallback',
    (projectTypeId) => {
      expect(scaffoldRuntimeContract(projectTypeId)).toBeNull();
    },
  );
});
