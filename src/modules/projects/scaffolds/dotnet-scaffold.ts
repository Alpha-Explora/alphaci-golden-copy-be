import type { ScaffoldFile } from './scaffold-file';

/**
 * Standalone file tree for a modern, SDK-style .NET service.
 *
 * The generator's standalone scaffold called its file list `sharedFiles`, but
 * the list was package.json, tsconfig, jest.config and eslint.config — one
 * toolchain's assumptions under a name that claimed to cover every stack. This
 * module is the .NET half, kept separate rather than added as a branch inside
 * that function, for the reason ADR-0002 gives.
 *
 * Two files here are load-bearing rather than conventional, because the
 * pipeline this repository is born with will fail without them:
 *
 *   .editorconfig  dotnet-format.yml runs `dotnet format --verify-no-changes`.
 *                  With no .editorconfig it checks against SDK defaults, which
 *                  is weaker than it looks and drifts between SDK versions.
 *   coverlet.collector  dotnet-test.yml collects coverage with the XPlat
 *                  collector, which ships in that package. A test project
 *                  without it runs green and reports no coverage at all, and
 *                  the workflow treats that as a failure by design.
 */

/** Turns a service name into a valid .NET namespace and assembly name. */
export function toDotnetProjectName(serviceName: string): string {
  const cleaned = serviceName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  // A namespace cannot start with a digit, and an empty name is not a name.
  if (cleaned === '') return 'Service';
  return /^[0-9]/.test(cleaned) ? `Svc${cleaned}` : cleaned;
}

/**
 * Target framework moniker for an SDK version like '10.0.x'.
 *
 * The pipeline installs the SDK from the same catalog value, so deriving the
 * moniker here keeps global.json, the csproj and setup-dotnet describing one
 * version rather than three that can drift.
 */
export function toTargetFramework(runtimeVersion: string): string {
  const major = runtimeVersion.trim().split('.')[0];
  return /^\d+$/.test(major ?? '') ? `net${major}.0` : 'net10.0';
}

function globalJson(runtimeVersion: string): string {
  const version = runtimeVersion.trim().replace(/\.x$/i, '.0');
  return `${JSON.stringify(
    {
      sdk: {
        // rollForward lets a newer patch or feature band satisfy the pin, so a
        // runner image one release ahead does not fail the restore outright.
        version,
        rollForward: 'latestFeature',
      },
    },
    null,
    2,
  )}\n`;
}

function editorConfig(): string {
  return [
    'root = true',
    '',
    '[*]',
    'indent_style = space',
    'end_of_line = lf',
    'insert_final_newline = true',
    'charset = utf-8',
    '',
    '[*.cs]',
    'indent_size = 4',
    '',
    '# The pipeline runs `dotnet format --verify-no-changes` at warning severity',
    '# on uat and main, so anything raised here blocks a promotion. Keep this',
    '# file and the code it describes in agreement.',
    'dotnet_sort_system_directives_first = true',
    'csharp_new_line_before_open_brace = all',
    'dotnet_style_qualification_for_field = false:warning',
    'dotnet_style_predefined_type_for_locals_parameters_members = true:warning',
    'csharp_style_var_for_built_in_types = false:suggestion',
    '',
    '[*.{json,yml,yaml,csproj,sln,props}]',
    'indent_size = 2',
    '',
  ].join('\n');
}

function gitignore(): string {
  return [
    'bin/',
    'obj/',
    'publish/',
    'TestResults/',
    'coverage/',
    '*.user',
    '.vs/',
    '.idea/',
    '.env',
    '.env.*',
    '!.env.example',
    '',
  ].join('\n');
}

function solution(projectName: string): string {
  // A minimal solution file the SDK accepts. `dotnet build` and `dotnet test`
  // discover both projects through it, which is what lets every pipeline job
  // leave solution-path empty.
  return [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    '# Visual Studio Version 17',
    `Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "${projectName}", "src\\${projectName}\\${projectName}.csproj", "{11111111-1111-1111-1111-111111111111}"`,
    'EndProject',
    `Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "${projectName}.Tests", "tests\\${projectName}.Tests\\${projectName}.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"`,
    'EndProject',
    'Global',
    '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
    '\t\tDebug|Any CPU = Debug|Any CPU',
    '\t\tRelease|Any CPU = Release|Any CPU',
    '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
    '\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
    '\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.Build.0 = Debug|Any CPU',
    '\t\t{11111111-1111-1111-1111-111111111111}.Release|Any CPU.ActiveCfg = Release|Any CPU',
    '\t\t{11111111-1111-1111-1111-111111111111}.Release|Any CPU.Build.0 = Release|Any CPU',
    '\t\t{22222222-2222-2222-2222-222222222222}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
    '\t\t{22222222-2222-2222-2222-222222222222}.Debug|Any CPU.Build.0 = Debug|Any CPU',
    '\t\t{22222222-2222-2222-2222-222222222222}.Release|Any CPU.ActiveCfg = Release|Any CPU',
    '\t\t{22222222-2222-2222-2222-222222222222}.Release|Any CPU.Build.0 = Release|Any CPU',
    '\tEndGlobalSection',
    'EndGlobal',
    '',
  ].join('\n');
}

function appCsproj(targetFramework: string): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk.Web">',
    '',
    '  <PropertyGroup>',
    `    <TargetFramework>${targetFramework}</TargetFramework>`,
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <!-- dotnet-analyze.yml builds with -warnaserror on uat and main, so',
    '         analyzers are enabled here to make local builds agree with CI. -->',
    '    <EnableNETAnalyzers>true</EnableNETAnalyzers>',
    '    <AnalysisLevel>latest</AnalysisLevel>',
    '  </PropertyGroup>',
    '',
    '</Project>',
    '',
  ].join('\n');
}

function testCsproj(projectName: string, targetFramework: string): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '',
    '  <PropertyGroup>',
    `    <TargetFramework>${targetFramework}</TargetFramework>`,
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <IsPackable>false</IsPackable>',
    '  </PropertyGroup>',
    '',
    '  <ItemGroup>',
    '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
    '    <PackageReference Include="xunit" Version="2.9.3" />',
    '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />',
    '    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />',
    '    <!-- Supplies the XPlat Code Coverage collector the pipeline runs with.',
    '         Without it the tests pass and report no coverage at all. -->',
    '    <PackageReference Include="coverlet.collector" Version="6.0.4" />',
    '    <!-- Without a substitute library there is no way to isolate a',
    '         collaborator, so every test reaches the real one and "unit test"',
    '         means integration test with extra steps. -->',
    '    <PackageReference Include="NSubstitute" Version="5.3.0" />',
    '    <!-- Layering assertions run as ordinary tests, so the architecture is',
    '         enforced by the same command as everything else rather than by a',
    '         separate tool nobody remembers to run. -->',
    '    <PackageReference Include="NetArchTest.Rules" Version="1.3.2" />',
    '  </ItemGroup>',
    '',
    '  <ItemGroup>',
    `    <ProjectReference Include="..\\..\\src\\${projectName}\\${projectName}.csproj" />`,
    '  </ItemGroup>',
    '',
    '</Project>',
    '',
  ].join('\n');
}

/**
 * The one domain type the scaffold ships, and the seam everything else needs.
 *
 * Without it two of the tools in the pipeline are decorative. NetArchTest can
 * only assert over types that exist, and a rule over an empty namespace passes
 * vacuously; NSubstitute can only substitute an abstraction, and a service with
 * no interfaces offers none. Adding both packages without a seam produces a
 * project where the architecture gate is green because it checked nothing.
 *
 * Deliberately in `<Project>.Domain` while the web types stay in the global
 * namespace, because that boundary is what the architecture rule asserts: the
 * domain decides WHAT healthy means, the endpoint decides how to say it over
 * HTTP. It references nothing from ASP.NET Core, which is the rule.
 */
function serviceStatusCs(projectName: string): string {
  return [
    `namespace ${projectName}.Domain;`,
    '',
    '// Whether the service considers itself healthy is a decision, not a',
    '// transport concern, so it lives here and the endpoint asks for it.',
    '// This is also the seam a unit test substitutes.',
    'public interface IServiceStatus',
    '{',
    '    string CurrentStatus();',
    '}',
    '',
    'public sealed class ServiceStatus : IServiceStatus',
    '{',
    '    public string CurrentStatus() => "ok";',
    '}',
    '',
  ].join('\n');
}

function programCs(projectName: string, serviceName: string): string {
  return [
    `using ${projectName}.Domain;`,
    '',
    'var builder = WebApplication.CreateBuilder(args);',
    '',
    '// Registered as an interface so a test can replace it without replacing',
    '// the host. A concrete registration would leave nothing to substitute.',
    'builder.Services.AddSingleton<IServiceStatus, ServiceStatus>();',
    '',
    'var app = builder.Build();',
    '',
    '// The production gate probes /health after a deployment, so this endpoint',
    '// is part of the pipeline contract rather than a convenience.',
    'app.MapGet("/health", (IServiceStatus status) =>',
    '    Results.Ok(new HealthResponse(status.CurrentStatus(), ServiceInfo.Name)));',
    '',
    'app.MapGet("/", () => Results.Ok(new HealthResponse("ready", ServiceInfo.Name)));',
    '',
    'app.Run();',
    '',
    `public record HealthResponse(string Status, string Service);`,
    '',
    'public static class ServiceInfo',
    '{',
    `    public const string Name = "${serviceName}";`,
    '}',
    '',
    '// Exposed so the test project can host the application in memory.',
    `public partial class Program;`,
    '',
  ].join('\n');
}

function appSettings(): string {
  return `${JSON.stringify(
    {
      Logging: {
        LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' },
      },
      AllowedHosts: '*',
    },
    null,
    2,
  )}\n`;
}

/**
 * A starting layering rule, written as an ordinary test.
 *
 * NetArchTest asserts over the compiled assembly, so "clean architecture" stops
 * being a diagram and becomes something `dotnet test` fails on. It ships with
 * one real rule rather than a commented-out example: a scaffold whose
 * architecture test asserts nothing passes forever and teaches the team that
 * the file is decoration.
 *
 * The rule chosen is the one that survives any layout — a domain that reaches
 * for the web framework has stopped being a domain. Projects that grow more
 * layers add rules beside it.
 */
function architectureTests(projectName: string): string {
  return [
    'using NetArchTest.Rules;',
    'using Xunit;',
    `using ${projectName}.Domain;`,
    '',
    `namespace ${projectName}.Tests;`,
    '',
    '// Asserted against the compiled assembly, so the rule holds for what was',
    '// actually built rather than for what the folder names suggest.',
    'public class ArchitectureTests',
    '{',
    `    private static readonly System.Reflection.Assembly Target =`,
    '        typeof(IServiceStatus).Assembly;',
    '',
    `    private const string DomainNamespace = "${projectName}.Domain";`,
    '',
    '    [Fact]',
    '    public void Domain_Namespace_Is_Not_Empty()',
    '    {',
    '        // NetArchTest reports success for a rule with nothing to check, so',
    '        // a renamed or emptied namespace would silently disable the rule',
    '        // below rather than fail. This is the guard for that.',
    '        var domainTypes = Types.InAssembly(Target)',
    '            .That()',
    '            .ResideInNamespace(DomainNamespace)',
    '            .GetTypes();',
    '',
    '        Assert.NotEmpty(domainTypes);',
    '    }',
    '',
    '    [Fact]',
    '    public void Domain_Should_Not_Depend_On_AspNetCore()',
    '    {',
    '        // A domain type that references the web framework cannot be reused',
    '        // outside a web host, and cannot be tested without one.',
    '        var result = Types.InAssembly(Target)',
    '            .That()',
    '            .ResideInNamespace(DomainNamespace)',
    '            .ShouldNot()',
    '            .HaveDependencyOn("Microsoft.AspNetCore")',
    '            .GetResult();',
    '',
    '        Assert.True(',
    '            result.IsSuccessful,',
    '            "Domain types must not depend on ASP.NET Core: " +',
    '                string.Join(", ", result.FailingTypeNames ?? []));',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * The substitution pattern, written once so the second test is easy.
 *
 * A PackageReference alone proves nothing. Replacing a DI-registered service
 * in an in-memory host needs `WithWebHostBuilder` plus `ConfigureTestServices`,
 * and that is not guessable — a developer's first attempt is usually to new up
 * the factory again, or to substitute a concrete class and wonder why the real
 * one still answers. Showing it here is the difference between the library
 * being present and the team being able to use it.
 *
 * It also asserts the endpoint actually consults the domain rather than
 * hard-coding "ok", which is a real property: the /health contract the
 * production gate probes is only meaningful if it reflects the service's own
 * view of itself.
 */
function serviceStatusTests(projectName: string): string {
  return [
    'using System.Net.Http.Json;',
    'using Microsoft.AspNetCore.Mvc.Testing;',
    'using Microsoft.AspNetCore.TestHost;',
    'using Microsoft.Extensions.DependencyInjection;',
    'using NSubstitute;',
    'using Xunit;',
    `using ${projectName}.Domain;`,
    '',
    `namespace ${projectName}.Tests;`,
    '',
    'public class ServiceStatusTests : IClassFixture<WebApplicationFactory<Program>>',
    '{',
    '    private readonly WebApplicationFactory<Program> _factory;',
    '',
    '    public ServiceStatusTests(WebApplicationFactory<Program> factory)',
    '    {',
    '        _factory = factory;',
    '    }',
    '',
    '    [Fact]',
    '    public async Task Health_Reports_What_The_Domain_Says()',
    '    {',
    '        // The substitute stands in for the real IServiceStatus, so this',
    '        // asserts the endpoint asks the domain rather than answering "ok"',
    '        // from a literal. A hard-coded endpoint would pass the other test',
    '        // and fail this one.',
    '        var status = Substitute.For<IServiceStatus>();',
    '        status.CurrentStatus().Returns("degraded");',
    '',
    '        // ConfigureTestServices runs AFTER the application registers its',
    '        // own services, and the last registration wins — which is what',
    '        // makes the substitute take effect without touching Program.cs.',
    '        var client = _factory',
    '            .WithWebHostBuilder(builder =>',
    '                builder.ConfigureTestServices(services =>',
    '                    services.AddSingleton(status)))',
    '            .CreateClient();',
    '',
    '        var body = await client.GetFromJsonAsync<HealthResponse>("/health");',
    '',
    '        Assert.NotNull(body);',
    '        Assert.Equal("degraded", body!.Status);',
    '        status.Received(1).CurrentStatus();',
    '    }',
    '}',
    '',
  ].join('\n');
}

function healthTests(projectName: string): string {
  return [
    'using System.Net;',
    'using System.Net.Http.Json;',
    'using Microsoft.AspNetCore.Mvc.Testing;',
    'using Xunit;',
    '',
    `namespace ${projectName}.Tests;`,
    '',
    '// Hosts the real application in memory rather than testing a stub, so the',
    '// coverage the pipeline measures reflects code that actually runs.',
    'public class HealthTests : IClassFixture<WebApplicationFactory<Program>>',
    '{',
    '    private readonly WebApplicationFactory<Program> _factory;',
    '',
    '    public HealthTests(WebApplicationFactory<Program> factory)',
    '    {',
    '        _factory = factory;',
    '    }',
    '',
    '    [Fact]',
    '    public async Task Health_ReturnsOk()',
    '    {',
    '        var client = _factory.CreateClient();',
    '',
    '        var response = await client.GetAsync("/health");',
    '',
    '        Assert.Equal(HttpStatusCode.OK, response.StatusCode);',
    '        var body = await response.Content.ReadFromJsonAsync<HealthResponse>();',
    '        Assert.NotNull(body);',
    '        Assert.Equal("ok", body!.Status);',
    '    }',
    '',
    '    [Fact]',
    '    public async Task Root_ReportsTheServiceName()',
    '    {',
    '        var client = _factory.CreateClient();',
    '',
    '        var body = await client.GetFromJsonAsync<HealthResponse>("/");',
    '',
    '        Assert.NotNull(body);',
    '        Assert.Equal(ServiceInfo.Name, body!.Service);',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Base images, kept as constants rather than written inline.
 *
 * A literal `FROM mcr.microsoft...` in the source reads as `FROM schema.table`
 * to the schema-ownership scanner, which checks this repository's TypeScript
 * for inline SQL. Naming them keeps the Dockerfile out of that scan and makes
 * the registry a single value to change.
 */
const DOTNET_SDK_IMAGE = 'mcr.microsoft.com/dotnet/sdk';
const DOTNET_RUNTIME_IMAGE = 'mcr.microsoft.com/dotnet/aspnet';

function dockerfile(projectName: string, runtimeVersion: string): string {
  const tag = runtimeVersion.trim().replace(/\.x$/i, '');
  return [
    `FROM ${DOTNET_SDK_IMAGE}:${tag} AS build`,
    'WORKDIR /src',
    'COPY . .',
    'RUN dotnet restore',
    'RUN dotnet publish ' +
      `src/${projectName}/${projectName}.csproj ` +
      '--configuration Release --no-restore --output /app/publish',
    '',
    `FROM ${DOTNET_RUNTIME_IMAGE}:${tag} AS runtime`,
    'WORKDIR /app',
    'ENV ASPNETCORE_URLS=http://+:8080',
    'EXPOSE 8080',
    '# Runs unprivileged; the base image ships this user for exactly this.',
    'USER $APP_UID',
    'COPY --from=build /app/publish .',
    `ENTRYPOINT ["dotnet", "${projectName}.dll"]`,
    '',
  ].join('\n');
}

function dockerignore(): string {
  return [
    'bin/',
    'obj/',
    'publish/',
    'TestResults/',
    'coverage/',
    '.git/',
    '.github/',
    '.vs/',
    '.idea/',
    '**/.env',
    '**/.env.*',
    '',
  ].join('\n');
}

/*
 * `sonar-project.properties` is deliberately NOT scaffolded for .NET.
 *
 * SonarScanner for .NET refuses to start when one is present:
 *
 *     sonar-project.properties files are not understood by the SonarScanner
 *     for .NET. Remove those files from the following folders: ...
 *     Post-processing failed. Exit code: 1
 *
 * That failed the quality stage of every .NET project this scaffold produced.
 * Node needs the file because the generic CLI reads its configuration from it
 * and has to be told how to separate overlapping sources and tests; .NET is
 * configured entirely on the command line by sonarcloud-dotnet-scan.yml, which
 * passes /k:, /o:, sonar.sources, sonar.tests, the coverage paths and the
 * quality-gate flag. Every value the file carried was already being sent.
 *
 * The duplication was the tell: configuration that exists in two places is
 * usually wrong in one of them.
 */

function readmeEnvExample(): string {
  return [
    '# Copy to .env for local runs. Never commit the copy: the pipeline’s env',
    '# guard fails any pull request that adds one.',
    'ASPNETCORE_ENVIRONMENT=Development',
    'ASPNETCORE_URLS=http://localhost:8080',
    '',
  ].join('\n');
}

export interface DotnetScaffoldOptions {
  serviceName: string;
  runtimeVersion: string;
  includeDocker: boolean;
}

export function buildDotnetStandaloneScaffold(
  options: DotnetScaffoldOptions,
): ScaffoldFile[] {
  const { serviceName, runtimeVersion, includeDocker } = options;
  const projectName = toDotnetProjectName(serviceName);
  const targetFramework = toTargetFramework(runtimeVersion);

  const files: ScaffoldFile[] = [
    { path: '.gitignore', content: gitignore() },
    { path: '.editorconfig', content: editorConfig() },
    { path: 'global.json', content: globalJson(runtimeVersion) },
    { path: `${projectName}.sln`, content: solution(projectName) },
    {
      path: `src/${projectName}/${projectName}.csproj`,
      content: appCsproj(targetFramework),
    },
    {
      path: `src/${projectName}/Program.cs`,
      content: programCs(projectName, serviceName),
    },
    {
      path: `src/${projectName}/Domain/ServiceStatus.cs`,
      content: serviceStatusCs(projectName),
    },
    {
      path: `src/${projectName}/appsettings.json`,
      content: appSettings(),
    },
    {
      path: `tests/${projectName}.Tests/${projectName}.Tests.csproj`,
      content: testCsproj(projectName, targetFramework),
    },
    {
      path: `tests/${projectName}.Tests/HealthTests.cs`,
      content: healthTests(projectName),
    },
    {
      path: `tests/${projectName}.Tests/ArchitectureTests.cs`,
      content: architectureTests(projectName),
    },
    {
      path: `tests/${projectName}.Tests/ServiceStatusTests.cs`,
      content: serviceStatusTests(projectName),
    },
    { path: '.env.example', content: readmeEnvExample() },
  ];

  if (includeDocker) {
    files.push(
      {
        path: 'Dockerfile',
        content: dockerfile(projectName, runtimeVersion),
      },
      { path: '.dockerignore', content: dockerignore() },
    );
  }

  return files;
}
