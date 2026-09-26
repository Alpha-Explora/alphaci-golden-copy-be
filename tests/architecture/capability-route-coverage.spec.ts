import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'ALL'
  | 'HEAD'
  | 'OPTIONS';

interface BaselineRoute {
  readonly handler: string;
  readonly method: HttpMethod;
}

interface BaselineController {
  readonly reason: string;
  readonly routes: readonly BaselineRoute[];
}

interface CapabilityMetadata {
  readonly present: boolean;
  readonly keys: readonly string[];
  readonly invalidArguments: readonly string[];
}

interface ParsedRoute {
  readonly controllerPath: string;
  readonly className: string;
  readonly handler: string;
  readonly methods: readonly HttpMethod[];
  readonly capabilityKeys: readonly string[];
  readonly hasCapabilityMetadata: boolean;
  readonly invalidCapabilityArguments: readonly string[];
  readonly hasCapabilityGuard: boolean;
}

interface ParsedController {
  readonly controllerPath: string;
  readonly classNames: readonly string[];
  readonly routes: readonly ParsedRoute[];
}

const HTTP_DECORATORS: Readonly<Record<string, HttpMethod>> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  All: 'ALL',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

const CAPABILITY_ROUTE_BASELINE: Readonly<Record<string, BaselineController>> =
  {
    'src/app.controller.ts': {
      reason: 'always-on core surface',
      routes: [{ handler: 'getServiceInfo', method: 'GET' }],
    },
    'src/health/health.controller.ts': {
      reason: 'unauthenticated health probe',
      routes: [{ handler: 'getHealth', method: 'GET' }],
    },
    'src/modules/billing/subscription/api/subscription.controller.ts': {
      reason: 'billing-owned subscription lifecycle',
      routes: [
        { handler: 'getSubscription', method: 'GET' },
        { handler: 'activateMonthly', method: 'POST' },
        { handler: 'cancelMonthly', method: 'POST' },
      ],
    },
    'src/modules/billing/usage/api/usage.controller.ts': {
      reason: 'billing-owned usage surface',
      routes: [{ handler: 'getMyUsage', method: 'GET' }],
    },
    'src/modules/identity-access/admin/api/admin.controller.ts': {
      reason: 'platform-admin surface',
      routes: [
        { handler: 'listUsers', method: 'GET' },
        { handler: 'getUser', method: 'GET' },
        { handler: 'getUserErrors', method: 'GET' },
        { handler: 'listAdmins', method: 'GET' },
        { handler: 'grantRole', method: 'POST' },
        { handler: 'revokeRole', method: 'DELETE' },
        { handler: 'setAppRole', method: 'PATCH' },
        { handler: 'resetAppRole', method: 'POST' },
        { handler: 'listFeedback', method: 'GET' },
        { handler: 'triageFeedback', method: 'PATCH' },
        { handler: 'getAccessLog', method: 'GET' },
      ],
    },
    'src/modules/identity-access/auth/api/auth.controller.ts': {
      reason: 'authentication and account lifecycle surface',
      routes: [
        { handler: 'githubStart', method: 'GET' },
        { handler: 'githubCallback', method: 'GET' },
        // Local-only development fixture session; guarded by explicit config
        // and loopback checks rather than a product capability.
        { handler: 'devQuickLogin', method: 'POST' },
        { handler: 'configCheck', method: 'GET' },
        { handler: 'me', method: 'GET' },
        { handler: 'completeOnboarding', method: 'POST' },
        { handler: 'logout', method: 'POST' },
        { handler: 'deleteAccount', method: 'DELETE' },
        { handler: 'getPendingArchivedAccount', method: 'GET' },
        { handler: 'restoreArchivedAccount', method: 'POST' },
        { handler: 'startFreshAccount', method: 'POST' },
      ],
    },
    'src/modules/identity-access/capabilities/api/capabilities.controller.ts': {
      reason: 'capability compatibility metadata endpoint',
      routes: [{ handler: 'getCapabilities', method: 'GET' }],
    },
    'src/modules/identity-access/directory/api/directory.controller.ts': {
      // Serves the ungated hierarchy member picker and client systems alike;
      // readable only by people in the directory (ADR-0011).
      reason: 'identity member directory surface',
      routes: [
        { handler: 'describe', method: 'GET' },
        { handler: 'listMembers', method: 'GET' },
      ],
    },
    'src/modules/identity-access/hierarchy/api/assignments.controller.ts': {
      reason: 'identity hierarchy surface',
      routes: [
        { handler: 'createAssignment', method: 'POST' },
        { handler: 'listAssignments', method: 'GET' },
        { handler: 'removeAssignment', method: 'DELETE' },
        { handler: 'reconcileAssignment', method: 'POST' },
        { handler: 'getAccessStatus', method: 'GET' },
      ],
    },
    'src/modules/identity-access/hierarchy/api/delivery-projects.controller.ts':
      {
        reason: 'identity hierarchy surface',
        routes: [
          { handler: 'getDeliveryProject', method: 'GET' },
          { handler: 'updateDeliveryProject', method: 'PATCH' },
          { handler: 'archiveDeliveryProject', method: 'POST' },
          { handler: 'createRepository', method: 'POST' },
          { handler: 'listRepositories', method: 'GET' },
        ],
      },
    'src/modules/identity-access/hierarchy/api/groups.controller.ts': {
      reason: 'identity hierarchy surface',
      routes: [
        { handler: 'createGroup', method: 'POST' },
        { handler: 'getMyGroups', method: 'GET' },
        { handler: 'getGroup', method: 'GET' },
        { handler: 'updateGroup', method: 'PATCH' },
        { handler: 'archiveGroup', method: 'POST' },
        { handler: 'deleteGroup', method: 'DELETE' },
        { handler: 'reopenGroup', method: 'POST' },
        { handler: 'transferGroup', method: 'POST' },
        { handler: 'listMembers', method: 'GET' },
        { handler: 'addMember', method: 'POST' },
        { handler: 'searchEligibleUsers', method: 'GET' },
        { handler: 'updateMemberRole', method: 'PATCH' },
        { handler: 'removeMember', method: 'DELETE' },
        { handler: 'listActivity', method: 'GET' },
      ],
    },
    'src/modules/identity-access/hierarchy/api/me.controller.ts': {
      reason: 'identity hierarchy surface',
      routes: [
        { handler: 'getMyGroups', method: 'GET' },
        { handler: 'getMyAssignedRepositories', method: 'GET' },
      ],
    },
    'src/modules/identity-access/hierarchy/api/repo-config-broker.controller.ts':
      {
        reason: 'identity hierarchy configuration surface',
        routes: [
          { handler: 'listConfiguration', method: 'GET' },
          { handler: 'writeVariable', method: 'PUT' },
          { handler: 'writeSecret', method: 'PUT' },
          { handler: 'deleteConfiguration', method: 'DELETE' },
        ],
      },
    'src/modules/identity-access/hierarchy/api/project-folders.controller.ts': {
      reason: 'identity hierarchy surface',
      routes: [{ handler: 'listProjectFolders', method: 'GET' }],
    },
    'src/modules/identity-access/hierarchy/api/repositories.controller.ts': {
      reason: 'identity hierarchy surface',
      routes: [
        { handler: 'getRepository', method: 'GET' },
        { handler: 'updateRepository', method: 'PATCH' },
        { handler: 'moveRepository', method: 'POST' },
        { handler: 'archiveRepository', method: 'POST' },
      ],
    },
    'src/modules/identity-access/hierarchy/api/systems.controller.ts': {
      reason: 'identity hierarchy surface',
      routes: [
        { handler: 'createSystem', method: 'POST' },
        { handler: 'listSystems', method: 'GET' },
        { handler: 'createEmptyProject', method: 'POST' },
        { handler: 'getSystem', method: 'GET' },
        { handler: 'updateSystem', method: 'PATCH' },
        { handler: 'archiveSystem', method: 'POST' },
        { handler: 'createDeliveryProject', method: 'POST' },
        { handler: 'listDeliveryProjects', method: 'GET' },
      ],
    },
    'src/modules/pipelines/ci/api/ci.controller.ts': {
      reason: 'CI integration surface',
      routes: [
        { handler: 'validate', method: 'POST' },
        { handler: 'ingestReport', method: 'POST' },
        { handler: 'getRuns', method: 'GET' },
      ],
    },
    'src/modules/runtime/api/releases.controller.ts': {
      // Same surface, same credential: a generated pipeline calling with the
      // project's ALPHACI_TOKEN. It is not a capability-gated product feature
      // and has no signed-in subject to resolve a capability set from.
      reason: 'CI integration surface',
      routes: [
        { handler: 'startRelease', method: 'POST' },
        { handler: 'getRelease', method: 'GET' },
      ],
    },
    'src/modules/pipelines/github/api/github-webhook.controller.ts': {
      reason: 'inbound webhook',
      routes: [{ handler: 'handleWebhook', method: 'POST' }],
    },
    'src/modules/pipelines/github/api/github.controller.ts': {
      reason: 'GitHub integration surface',
      routes: [
        { handler: 'getAppInstallUrl', method: 'GET' },
        { handler: 'linkInstallation', method: 'POST' },
        { handler: 'listLinkedRepos', method: 'GET' },
        { handler: 'listInstallationAccounts', method: 'GET' },
        { handler: 'tokenScopes', method: 'GET' },
        { handler: 'repos', method: 'GET' },
        { handler: 'createRepo', method: 'POST' },
      ],
    },
    'src/modules/platform-ops/feedback/api/feedback.controller.ts': {
      reason: 'authenticated feedback surface',
      routes: [
        { handler: 'submit', method: 'POST' },
        { handler: 'listMine', method: 'GET' },
      ],
    },
    'src/modules/projects/api/catalog.controller.ts': {
      reason: 'project catalog surface',
      routes: [
        { handler: 'getProjectOptions', method: 'GET' },
        { handler: 'centralWorkflowTags', method: 'GET' },
        { handler: 'categories', method: 'GET' },
        { handler: 'templates', method: 'GET' },
        { handler: 'templateById', method: 'GET' },
      ],
    },
    'src/modules/projects/api/existing-repos.controller.ts': {
      reason: 'project integration surface',
      routes: [
        { handler: 'discover', method: 'POST' },
        { handler: 'setupPullRequest', method: 'POST' },
      ],
    },
    'src/modules/projects/api/project-workspace.controller.ts': {
      reason: 'project workspace surface',
      routes: [
        { handler: 'listBranches', method: 'GET' },
        { handler: 'listFiles', method: 'GET' },
        { handler: 'listRuns', method: 'GET' },
        { handler: 'listRunJobs', method: 'GET' },
        { handler: 'getRunFailureLog', method: 'GET' },
        { handler: 'getJobLog', method: 'GET' },
        { handler: 'listPullRequests', method: 'GET' },
        { handler: 'getPullRequestFiles', method: 'GET' },
        { handler: 'getPullRequestDetail', method: 'GET' },
        { handler: 'mergePullRequest', method: 'POST' },
        { handler: 'compareBranches', method: 'GET' },
        { handler: 'createPullRequest', method: 'POST' },
      ],
    },
    'src/modules/projects/api/projects.controller.ts': {
      reason: 'project lifecycle surface',
      routes: [
        { handler: 'createProject', method: 'POST' },
        { handler: 'setupProject', method: 'POST' },
        { handler: 'listProjects', method: 'GET' },
        { handler: 'getProjectOverview', method: 'GET' },
        { handler: 'syncProjectSnapshot', method: 'POST' },
        { handler: 'getWorkflowSettings', method: 'GET' },
        { handler: 'previewWorkflowSettings', method: 'POST' },
        { handler: 'createWorkflowUpdatePullRequest', method: 'POST' },
        { handler: 'listCiRuns', method: 'GET' },
        { handler: 'getCiRun', method: 'GET' },
        { handler: 'rerunCiRun', method: 'POST' },
        { handler: 'listDeployments', method: 'GET' },
        { handler: 'listPreviews', method: 'GET' },
        { handler: 'listDriftFindings', method: 'GET' },
        { handler: 'runDriftDetection', method: 'POST' },
        { handler: 'repairDriftFinding', method: 'POST' },
        { handler: 'listProjectAuditEvents', method: 'GET' },
        { handler: 'disconnectProject', method: 'DELETE' },
        { handler: 'syncProjects', method: 'POST' },
      ],
    },
    'src/modules/projects/api/workflows.controller.ts': {
      reason: 'project workflow surface',
      routes: [
        { handler: 'generate', method: 'POST' },
        { handler: 'history', method: 'GET' },
      ],
    },
    'src/modules/runtime/api/deployment-providers.controller.ts': {
      reason: 'runtime provider catalog',
      routes: [{ handler: 'list', method: 'GET' }],
    },
  };

const repositoryRoot = resolve(__dirname, '../..');
const sourceRoot = resolve(repositoryRoot, 'src');
const catalogPath = resolve(
  repositoryRoot,
  'src/kernel/composition/catalog.source.json',
);

function decoratorsOn(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = decorator.expression;
  const target = ts.isCallExpression(expression)
    ? expression.expression
    : expression;

  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function matchingDecorators(
  node: ts.Node,
  name: string,
): readonly ts.Decorator[] {
  return decoratorsOn(node).filter(
    (decorator) => decoratorName(decorator) === name,
  );
}

function matchingDecoratorCalls(
  node: ts.Node,
  name: string,
): readonly ts.CallExpression[] {
  return matchingDecorators(node, name).flatMap((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression) ? [expression] : [];
  });
}

function capabilityMetadata(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): CapabilityMetadata {
  const matches = matchingDecorators(node, 'RequiresCapability');
  const keys: string[] = [];
  const invalidArguments: string[] = [];

  for (const decorator of matches) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) {
      invalidArguments.push(
        'RequiresCapability must be called with string-literal capability names',
      );
      continue;
    }

    if (expression.arguments.length === 0) {
      invalidArguments.push(
        'RequiresCapability must name at least one capability',
      );
    }

    for (const argument of expression.arguments) {
      if (ts.isStringLiteralLike(argument)) {
        keys.push(argument.text);
      } else {
        invalidArguments.push(argument.getText(sourceFile));
      }
    }
  }

  return {
    present: matches.length > 0,
    keys,
    invalidArguments,
  };
}

function capabilityGuardBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const bindings = new Set<string>(['CapabilityGuard']);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName ?? specifier.name;
      if (
        ts.isIdentifier(importedName) &&
        importedName.text === 'CapabilityGuard'
      ) {
        bindings.add(specifier.name.text);
      }
    }
  }

  return bindings;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isCapabilityGuardExpression(
  expression: ts.Expression,
  bindings: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return bindings.has(unwrapped.text);
  return (
    ts.isPropertyAccessExpression(unwrapped) &&
    unwrapped.name.text === 'CapabilityGuard'
  );
}

function hasCapabilityGuard(
  node: ts.Node,
  bindings: ReadonlySet<string>,
): boolean {
  return matchingDecoratorCalls(node, 'UseGuards').some((call) =>
    call.arguments.some((argument) =>
      isCapabilityGuardExpression(argument, bindings),
    ),
  );
}

function routeMethods(method: ts.MethodDeclaration): readonly HttpMethod[] {
  return decoratorsOn(method)
    .map(decoratorName)
    .map((name) => (name === undefined ? undefined : HTTP_DECORATORS[name]))
    .filter((methodName): methodName is HttpMethod => methodName !== undefined);
}

function handlerName(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): string {
  if (method.name && ts.isIdentifier(method.name)) return method.name.text;
  return method.name?.getText(sourceFile) ?? '<anonymous handler>';
}

function normalizedControllerPath(filePath: string): string {
  return relative(repositoryRoot, filePath).split(sep).join('/');
}

function enumerateControllerFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) return enumerateControllerFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.controller.ts')
        ? [entryPath]
        : [];
    })
    .sort();
}

function scanController(filePath: string): ParsedController {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = capabilityGuardBindings(sourceFile);
  const controllerPath = normalizedControllerPath(filePath);
  const classNames: string[] = [];
  const routes: ParsedRoute[] = [];

  sourceFile.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;

    const className = node.name?.text ?? '<anonymous controller>';
    const classCapabilities = capabilityMetadata(node, sourceFile);
    const classHasCapabilityGuard = hasCapabilityGuard(node, bindings);
    classNames.push(className);

    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;

      const methods = routeMethods(member);
      if (methods.length === 0) continue;

      const methodCapabilities = capabilityMetadata(member, sourceFile);
      routes.push({
        controllerPath,
        className,
        handler: handlerName(member, sourceFile),
        methods,
        capabilityKeys: [...classCapabilities.keys, ...methodCapabilities.keys],
        hasCapabilityMetadata:
          classCapabilities.present || methodCapabilities.present,
        invalidCapabilityArguments: [
          ...classCapabilities.invalidArguments,
          ...methodCapabilities.invalidArguments,
        ],
        hasCapabilityGuard:
          classHasCapabilityGuard || hasCapabilityGuard(member, bindings),
      });
    }
  });

  return { controllerPath, classNames, routes };
}

function catalogKeys(): ReadonlySet<string> {
  const source = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    capabilities: readonly { key: string }[];
  };
  return new Set(source.capabilities.map((record) => record.key));
}

function routeLabel(route: ParsedRoute, method: HttpMethod): string {
  return (
    route.controllerPath +
    '; class ' +
    route.className +
    '; HTTP ' +
    method +
    '; handler ' +
    route.handler
  );
}

function routeFix(route: ParsedRoute, method: HttpMethod): string {
  return (
    'Fix: annotate the route with @RequiresCapability(...) and include ' +
    'CapabilityGuard in @UseGuards, or add { handler: ' +
    JSON.stringify(route.handler) +
    ', method: ' +
    JSON.stringify(method) +
    ' } to CAPABILITY_ROUTE_BASELINE[' +
    JSON.stringify(route.controllerPath) +
    '].routes with a one-line reason.'
  );
}

function inertMetadataFix(route: ParsedRoute, method: HttpMethod): string {
  return (
    'Fix: add CapabilityGuard to @UseGuards so the annotation is effective, ' +
    'or remove the misleading annotation and add { handler: ' +
    JSON.stringify(route.handler) +
    ', method: ' +
    JSON.stringify(method) +
    ' } to CAPABILITY_ROUTE_BASELINE[' +
    JSON.stringify(route.controllerPath) +
    '].routes with a one-line reason if this route is intentionally ungated.'
  );
}

function baselineHasRoute(
  controllerPath: string,
  handler: string,
  method: HttpMethod,
): boolean {
  return (
    CAPABILITY_ROUTE_BASELINE[controllerPath]?.routes.some(
      (entry) => entry.handler === handler && entry.method === method,
    ) ?? false
  );
}

function routeIsCovered(route: ParsedRoute): boolean {
  return route.hasCapabilityMetadata && route.hasCapabilityGuard;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function validateBaseline(
  controllers: readonly ParsedController[],
  violations: string[],
): void {
  const controllersByPath = new Map(
    controllers.map((controller) => [controller.controllerPath, controller]),
  );

  for (const [controllerPath, baseline] of Object.entries(
    CAPABILITY_ROUTE_BASELINE,
  )) {
    if (
      baseline.reason.trim().length === 0 ||
      baseline.reason.includes('\n') ||
      baseline.reason.includes('\r')
    ) {
      violations.push(
        'Invalid capability route baseline for ' +
          controllerPath +
          ': its controller reason must be a non-empty one-line string.',
      );
    }

    const controller = controllersByPath.get(controllerPath);
    const fallbackClassName =
      controller?.classNames[0] ?? '<removed controller>';
    const seenRoutes = new Set<string>();

    for (const entry of baseline.routes) {
      const identity = entry.method + ' ' + entry.handler;
      if (seenRoutes.has(identity)) {
        violations.push(
          'Duplicate capability route baseline entry: ' +
            controllerPath +
            '; class ' +
            fallbackClassName +
            '; HTTP ' +
            entry.method +
            '; handler ' +
            entry.handler +
            ' appears more than once. Remove the duplicate route entry.',
        );
      }
      seenRoutes.add(identity);

      const matchingRoutes =
        controller?.routes.filter(
          (route) =>
            route.handler === entry.handler &&
            route.methods.includes(entry.method),
        ) ?? [];

      if (matchingRoutes.length === 0) {
        violations.push(
          'Stale capability route baseline: ' +
            controllerPath +
            '; class ' +
            fallbackClassName +
            '; HTTP ' +
            entry.method +
            '; handler ' +
            entry.handler +
            ' is listed, but that controller or route no longer exists. ' +
            'Fix: annotate the current route and remove this stale entry, or ' +
            'update the baseline route list with the current handler and HTTP method ' +
            'plus its one-line reason.',
        );
        continue;
      }

      const coveredRoute = matchingRoutes.find(routeIsCovered);
      if (coveredRoute) {
        violations.push(
          'Stale capability route baseline: ' +
            routeLabel(coveredRoute, entry.method) +
            ' is listed, but the route is now covered. Remove the stale baseline ' +
            'entry. Fix: keep the effective annotation and remove this entry, or ' +
            'if the route is intentionally ungated, remove the annotation and ' +
            'keep an explicit baseline entry with a one-line reason.',
        );
      }
    }
  }
}

function findViolations(): readonly string[] {
  const controllers = enumerateControllerFiles(sourceRoot).map(scanController);
  const routes = controllers.flatMap((controller) => controller.routes);
  const knownCapabilities = catalogKeys();
  const violations: string[] = [];

  for (const route of routes) {
    for (const method of route.methods) {
      const label = routeLabel(route, method);

      for (const invalidArgument of route.invalidCapabilityArguments) {
        violations.push(
          label +
            ' has an invalid @RequiresCapability(...) argument ' +
            JSON.stringify(invalidArgument) +
            '; capability names must be string literals present in ' +
            'src/kernel/composition/catalog.source.json. ' +
            routeFix(route, method),
        );
      }

      for (const key of unique(route.capabilityKeys)) {
        if (knownCapabilities.has(key)) continue;
        violations.push(
          label +
            ' references capability ' +
            JSON.stringify(key) +
            ', which is absent from src/kernel/composition/catalog.source.json. ' +
            routeFix(route, method),
        );
      }

      if (route.hasCapabilityMetadata && !route.hasCapabilityGuard) {
        violations.push(
          'INERT capability metadata: ' +
            label +
            ' has @RequiresCapability(...) metadata, but CapabilityGuard is ' +
            'absent from @UseGuards at both class and handler scope. The metadata ' +
            'is inert and this route is NOT actually gated at runtime. ' +
            inertMetadataFix(route, method),
        );
        continue;
      }

      if (
        !route.hasCapabilityMetadata &&
        !baselineHasRoute(route.controllerPath, route.handler, method)
      ) {
        violations.push(
          label +
            ' has no explicit capability decision and is not in the capability ' +
            'route baseline. ' +
            routeFix(route, method),
        );
      }
    }
  }

  validateBaseline(controllers, violations);
  return violations.sort();
}

describe('capability route coverage architecture', () => {
  it('requires every HTTP route to be effectively gated or explicitly baselined', () => {
    expect(findViolations()).toEqual([]);
  });
});
