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

  it('points Sonar at the merged report the pipeline writes', () => {
    expect(contentOf('sonar-project.properties')).toContain(
      'coverage/coverage.cobertura.xml',
    );
  });
});
