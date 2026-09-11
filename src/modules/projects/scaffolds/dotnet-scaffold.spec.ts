import {
  buildProjectScaffold,
  defaultIncludeDocker,
} from '../scaffold.builder';
import { toDotnetProjectName, toTargetFramework } from './dotnet-scaffold';

/**
 * The scaffold has to pass the pipeline the same repository is born with. The
 * expensive parts of that were verified by generating this tree to disk and
 * running the real toolchain over it: restore, a -warnaserror build, the tests,
 * ReportGenerator, the coverage gate, `dotnet format --severity warn` and the
 * NuGet audit all passed, with coverage at 100%.
 *
 * These tests hold the properties that verification depended on, so a change
 * that would break the generated repository's first uat promotion fails here
 * instead.
 */

const files = () =>
  buildProjectScaffold({
    serviceName: 'st-peter-api',
    stack: 'dotnet',
    includeDocker: true,
    runtimeVersion: '10.0.x',
  });

const contentOf = (path: string): string => {
  const file = files().find((candidate) => candidate.path === path);
  if (!file) throw new Error(`scaffold has no ${path}`);
  return file.content;
};

describe('dotnet scaffold', () => {
  it('names the project as a valid namespace', () => {
    expect(toDotnetProjectName('st-peter-api')).toBe('StPeterApi');
    expect(toDotnetProjectName('orders')).toBe('Orders');
    // A namespace cannot start with a digit.
    expect(toDotnetProjectName('2fa-service')).toBe('Svc2faService');
    expect(toDotnetProjectName('!!!')).toBe('Service');
  });

  it('derives the target framework from the declared SDK version', () => {
    // global.json, the csproj and setup-dotnet must describe one version.
    expect(toTargetFramework('10.0.x')).toBe('net10.0');
    expect(toTargetFramework('9.0.x')).toBe('net9.0');
    expect(toTargetFramework('nonsense')).toBe('net10.0');
  });

  it('emits no package.json, so nothing mistakes it for a Node repo', () => {
    const paths = files().map((file) => file.path);

    expect(paths).not.toContain('package.json');
    expect(paths).not.toContain('tsconfig.json');
    expect(paths).toContain('StPeterApi.sln');
    expect(paths).toContain('global.json');
  });

  it('ships coverlet.collector, without which the pipeline reports no coverage', () => {
    // dotnet-test.yml collects with the XPlat collector, which lives in this
    // package. A test project without it runs green and covers nothing.
    expect(
      contentOf('tests/StPeterApi.Tests/StPeterApi.Tests.csproj'),
    ).toContain('coverlet.collector');
  });

  it('ships an .editorconfig, without which dotnet format checks almost nothing', () => {
    const editorconfig = contentOf('.editorconfig');

    expect(editorconfig).toContain('root = true');
    expect(editorconfig).toContain('[*.cs]');
  });

  it('exposes /health, which the production gate probes', () => {
    expect(contentOf('src/StPeterApi/Program.cs')).toContain('"/health"');
  });

  it('enables analyzers so a local build agrees with the strict CI build', () => {
    const csproj = contentOf('src/StPeterApi/StPeterApi.csproj');

    expect(csproj).toContain('<EnableNETAnalyzers>true</EnableNETAnalyzers>');
    expect(csproj).toContain('<TargetFramework>net10.0</TargetFramework>');
  });

  it('pins the SDK to the declared version', () => {
    expect(contentOf('global.json')).toContain('"version": "10.0.0"');
  });

  it('builds a runtime image, since render deploys a pushed image', () => {
    const dockerfile = contentOf('Dockerfile');

    expect(dockerfile).toContain('mcr.microsoft.com/dotnet/sdk:10.0');
    expect(dockerfile).toContain('mcr.microsoft.com/dotnet/aspnet:10.0');
    expect(dockerfile).toContain('ENTRYPOINT ["dotnet", "StPeterApi.dll"]');
  });

  it('includes Docker by default, like the other backend stacks', () => {
    expect(defaultIncludeDocker('dotnet')).toBe(true);
  });

  /*
   * The inverse of what this used to assert, because the file it checked for
   * was breaking every .NET pipeline it shipped in.
   *
   * SonarScanner for .NET refuses to start when a sonar-project.properties is
   * present — "files are not understood by the SonarScanner for .NET" — and
   * fails after the build. C# is configured entirely on the command line by
   * sonarcloud-dotnet-scan.yml, which passes the project key, organisation,
   * sources, tests, coverage paths and quality gate. The file only duplicated
   * those and then refused the scan.
   */
  it('does not write a sonar-project.properties, which .NET cannot scan with', () => {
    const paths = files().map((file) => file.path);

    expect(paths).not.toContain('sonar-project.properties');
  });
});

describe('dotnet scaffold — the tools a test project needs to be a test project', () => {
  it('ships a substitute library, so a unit test can isolate a collaborator', () => {
    // Without one there is no way to stand in for a dependency, so every
    // "unit" test reaches the real thing and the suite is integration tests
    // with extra steps. xUnit and Coverlet were present; this was not.
    expect(
      contentOf('tests/StPeterApi.Tests/StPeterApi.Tests.csproj'),
    ).toContain('NSubstitute');
  });

  it('ships the architecture rules library', () => {
    expect(
      contentOf('tests/StPeterApi.Tests/StPeterApi.Tests.csproj'),
    ).toContain('NetArchTest.Rules');
  });

  it('writes an architecture test that asserts something real', () => {
    // A scaffolded architecture test with no rule in it passes forever and
    // teaches the team that the file is decoration. This one fails if a domain
    // type reaches for the web framework.
    const test = contentOf('tests/StPeterApi.Tests/ArchitectureTests.cs');

    expect(test).toContain('NetArchTest.Rules');
    expect(test).toContain('ShouldNot()');
    expect(test).toContain('HaveDependencyOn("Microsoft.AspNetCore")');
    expect(test).toContain('Assert.True(');
  });

  it('names the architecture test after the project, not a fixed namespace', () => {
    const test = contentOf('tests/StPeterApi.Tests/ArchitectureTests.cs');

    expect(test).toContain('namespace StPeterApi.Tests;');
    expect(test).toContain(
      'const string DomainNamespace = "StPeterApi.Domain"',
    );
  });

  it('anchors the assembly on a domain type, not on Program', () => {
    // `Program` is declared in the GLOBAL namespace by the minimal-hosting
    // template, so `typeof(StPeterApi.Program)` does not compile — the first
    // version of this file would have failed the build rather than the rule.
    const test = contentOf('tests/StPeterApi.Tests/ArchitectureTests.cs');

    expect(test).toContain('typeof(IServiceStatus).Assembly');
    expect(test).not.toContain('typeof(StPeterApi.Program)');
  });

  it('fails when the domain namespace is empty, rather than passing vacuously', () => {
    // A NetArchTest rule with nothing to check reports success. Without this
    // guard, renaming or emptying the namespace silently disables the rule
    // while leaving a green test that looks like enforcement.
    const test = contentOf('tests/StPeterApi.Tests/ArchitectureTests.cs');

    expect(test).toContain('Domain_Namespace_Is_Not_Empty');
    expect(test).toContain('Assert.NotEmpty(domainTypes)');
  });

  it('keeps the architecture test in the test project the pipeline runs', () => {
    // dotnet-test.yml runs the solution, so a rules file outside the test
    // project would never execute — enforced by nothing, in a file that looks
    // like enforcement.
    const paths = files().map((file) => file.path);

    expect(paths).toContain('tests/StPeterApi.Tests/ArchitectureTests.cs');
  });
});

describe('dotnet scaffold — the seam both tools need to mean anything', () => {
  it('ships a domain type, so the architecture rule has something to check', () => {
    // Without this the rule matches an empty set and NetArchTest reports
    // success. The gate would be green because it checked nothing.
    const paths = files().map((file) => file.path);

    expect(paths).toContain('src/StPeterApi/Domain/ServiceStatus.cs');
    expect(contentOf('src/StPeterApi/Domain/ServiceStatus.cs')).toContain(
      'namespace StPeterApi.Domain;',
    );
  });

  it('keeps the domain free of the framework the rule forbids', () => {
    // The scaffold must satisfy its own architecture test on the first run.
    // Shipping a project whose own rule fails teaches the team to delete it.
    const domain = contentOf('src/StPeterApi/Domain/ServiceStatus.cs');

    expect(domain).not.toContain('Microsoft.AspNetCore');
    expect(domain).not.toContain('using Microsoft');
  });

  it('registers the domain behind an interface, so it can be substituted', () => {
    // A concrete registration would leave NSubstitute nothing to replace.
    const program = contentOf('src/StPeterApi/Program.cs');

    expect(program).toContain(
      'builder.Services.AddSingleton<IServiceStatus, ServiceStatus>();',
    );
    expect(program).toContain('using StPeterApi.Domain;');
  });

  it('makes the endpoint consult the domain rather than a literal', () => {
    // /health is what the production gate probes. If it answers "ok" from a
    // constant it reports the endpoint is reachable, not that the service is
    // healthy — and the substitution test could not detect the difference.
    const program = contentOf('src/StPeterApi/Program.cs');

    expect(program).toContain('status.CurrentStatus()');
    expect(program).not.toContain('new HealthResponse("ok"');
  });

  it('demonstrates substitution through the real DI container', () => {
    const test = contentOf('tests/StPeterApi.Tests/ServiceStatusTests.cs');

    expect(test).toContain('Substitute.For<IServiceStatus>()');
    // The part that is not guessable, and the reason writing it down matters.
    expect(test).toContain('WithWebHostBuilder');
    expect(test).toContain('ConfigureTestServices');
    expect(test).toContain('status.Received(1).CurrentStatus()');
  });

  it('asserts the substitute actually changed the response', () => {
    // Registering a substitute proves nothing on its own; the test has to show
    // the endpoint returned the substituted value.
    const test = contentOf('tests/StPeterApi.Tests/ServiceStatusTests.cs');

    expect(test).toContain('Returns("degraded")');
    expect(test).toContain('Assert.Equal("degraded", body!.Status)');
  });
});

/*
 * The scaffold has to pass its own strict lint gate.
 *
 * `dotnet format --severity warn` sorts using directives: System namespaces
 * first, then the rest alphabetically. Two test files were added with the
 * project namespace placed after `Xunit`, which sorts before it, and the
 * generated repository failed `IMPORTS: Fix imports ordering` with exit 2.
 *
 * On dev that is invisible — `fail-on-warning` is false there, so the job
 * reports and passes. It only bites on uat and main, where the same gate
 * blocks. So a freshly scaffolded project built fine, tested fine, and could
 * never be promoted, and nothing in this suite noticed. These assertions are
 * cheap; running `dotnet format` in a unit test is not.
 */
describe('dotnet scaffold — usings survive the strict format gate', () => {
  const usingsOf = (content: string): string[] =>
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('using ') && line.endsWith(';'))
      .map((line) => line.slice('using '.length, -1));

  /** System directives first, then the rest alphabetically — the format rule. */
  const sortedTheWayFormatWants = (usings: string[]): string[] => {
    const isSystem = (name: string) =>
      name === 'System' || name.startsWith('System.');
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

    return [
      ...usings.filter(isSystem).sort(compare),
      ...usings.filter((name) => !isSystem(name)).sort(compare),
    ];
  };

  const csharpFiles = () => files().filter((file) => file.path.endsWith('.cs'));

  it('generates C# files to check, so this is not a vacuous pass', () => {
    expect(csharpFiles().length).toBeGreaterThanOrEqual(4);
  });

  it('orders every using directive the way dotnet format demands', () => {
    for (const file of csharpFiles()) {
      const usings = usingsOf(file.content);

      expect({ path: file.path, usings }).toEqual({
        path: file.path,
        usings: sortedTheWayFormatWants(usings),
      });
    }
  });

  it('puts the project namespace before Xunit, which is where it broke', () => {
    const architecture = contentOf(
      'tests/StPeterApi.Tests/ArchitectureTests.cs',
    );
    const usings = usingsOf(architecture);

    expect(usings.indexOf('StPeterApi.Domain')).toBeLessThan(
      usings.indexOf('Xunit'),
    );
  });
});
