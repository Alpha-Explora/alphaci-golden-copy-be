/**
 * Module boundary enforcement.
 *
 * The structure in src/modules/ is only real if crossing a boundary fails
 * the build.
 *
 *   npm run boundaries        # report (ignores known violations)
 *   npm run boundaries:new    # strict report (no ignore list)
 *   npm run boundaries:graph  # visual graph (needs graphviz)
 */
// The top-level module folders are the six bounded contexts. Keep this map
// next to the dependency rules so every gate uses the same context data.
const contextByModule = Object.freeze({
  'identity-access': 'identity-access',
  projects: 'projects',
  pipelines: 'pipelines',
  runtime: 'runtime',
  billing: 'billing',
  'platform-ops': 'platform-ops',
});

module.exports = {
  "forbidden": [
    {
      "name": "no-deep-module-imports",
      "severity": "error",
      "comment": "Import a module through its index.ts, never one of its internal files. If you need something that is not exported, export it deliberately - that is the decision this rule is asking you to make consciously. Nest *.module.ts composition files are the sole wiring exception. Applies to anything outside kernel/ and modules/ too, so src/common/, src/config/, src/scripts/, etc. cannot bypass a module public index.",
      "from": {
        "path": "^src/(?!kernel/)(?!modules/)"
      },
      "to": {
        "path": "^src/modules/([^/]+)/(?!index\\.ts$).+",
        "pathNot": [
          "^src/modules/[^/]+/.*\\.module\\.ts$",
          "^src/modules/[^/]+/.+/index\\.ts$",
          "^src/app\\.module\\.ts$"
        ]
      }
    },
    {
      "name": "no-cross-module-deep-imports",
      "severity": "error",
      "comment": "Inside src/modules/, import other modules only through their public index.ts or their Nest composition module. Internal files are private.",
      "from": {
        "path": "^src/modules/([^/]+)/"
      },
      "to": {
        "path": "^src/modules/([^/]+)/(?!index\\.ts$).+",
        "pathNot": [
          "^src/modules/$1/",
          "^src/modules/[^/]+/.*\\.module\\.ts$",
          "^src/modules/[^/]+/.+/index\\.ts$"
        ]
      }
    },
    {
      "name": "kernel-must-not-know-features",
      "severity": "error",
      "comment": "kernel/ is infrastructure and sits below every feature. A kernel file importing a module inverts that and makes the kernel un-reusable.",
      "from": {
        "path": "^src/kernel/"
      },
      "to": {
        "path": "^src/modules/"
      }
    },
    {
      "name": "no-circular",
      "severity": "error",
      "comment": "A cycle between modules means the boundary is fictional - neither side can be understood, tested, or moved without the other.",
      "from": {},
      "to": {
        "circular": true
      }
    },
    {
      "name": "no-cross-context-cycles",
      "severity": "error",
      "comment": "Context-level cycles are tracked from the contextByModule map above; no cross-context cycle is permitted before physical consolidation.",
      "from": {
        "path": "^src/modules/"
      },
      "to": {
        "path": "^src/modules/",
        "circular": true
      }
    },
    {
      "name": "contracts-are-dependency-free",
      "severity": "error",
      "comment": "Published contracts contain serialisable types only and cannot drag Nest, database clients, Supabase, or infrastructure adapters across a future service boundary.",
      "from": {
        "path": "^src/modules/[^/]+/contracts/"
      },
      "to": {
        "path": [
          "^@nestjs/",
          "^pg$",
          "^@supabase/",
          "^src/modules/[^/]+/infrastructure/"
        ]
      }
    },
    {
      "name": "deployments-domain-is-framework-free",
      "severity": "error",
      "comment": "Deployment domain rules must stay framework- and vendor-independent. Import Nest, pg, Supabase, API controllers, or adapters only from application/ or infrastructure/.",
      "from": {
        "path": "^src/modules/runtime/domain/"
      },
      "to": {
        "path": [
          "@nestjs/",
          "pg",
          "@supabase/",
          "^src/modules/runtime/api/",
          "^src/modules/runtime/dto/",
          "^src/modules/runtime/infrastructure/"
        ]
      }
    },
    {
      "name": "deployments-api-cannot-reach-infrastructure",
      "severity": "error",
      "comment": "Controllers translate HTTP and delegate to application services; they never import a repository or provider client directly.",
      "from": {
        "path": "^src/modules/runtime/(api/)?[^/]*controller\\.ts$"
      },
      "to": {
        "path": [
          "^src/modules/runtime/(application/)?[^/]*repository\\.ts$",
          "^src/modules/runtime/infrastructure/providers/"
        ],
        "pathNot": [
          "\\.types\\.ts$",
          "\\.contract\\.ts$"
        ]
      }
    },
    {
      "name": "deployment-providers-are-isolated",
      "severity": "error",
      "comment": "Render provider code must not import Vercel provider code. Same-provider policy composition is allowed; shared behavior belongs in infrastructure/providers/core.",
      "from": {
        "path": "^src/modules/runtime/infrastructure/providers/render/"
      },
      "to": {
        "path": "^src/modules/runtime/infrastructure/providers/vercel/"
      }
    },
    {
      "name": "deployment-providers-are-isolated-reciprocal",
      "severity": "error",
      "comment": "Vercel provider code must not import Render provider code. Same-provider policy composition is allowed; shared behavior belongs in infrastructure/providers/core.",
      "from": {
        "path": "^src/modules/runtime/infrastructure/providers/vercel/"
      },
      "to": {
        "path": "^src/modules/runtime/infrastructure/providers/render/"
      }
    },
    {
      "name": "gcp-provider-isolated",
      "severity": "error",
      "comment": "GCP provider implementation code must not import Render/Vercel adapters; shared behavior belongs in providers/core.",
      "from": {
        "path": "^src/modules/runtime/infrastructure/providers/gcp/"
      },
      "to": {
        "path": "^src/modules/runtime/infrastructure/providers/(render|vercel)/"
      }
    },
    {
      "name": "no-orphans",
      "severity": "warn",
      "comment": "Unreachable file - dead code, or a missing wire-up.",
      "from": {
        "orphan": true,
        "pathNot": [
          "\\.d\\.ts$",
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$",
          "(^|/)tsconfig\\.json$",
          "\\.module\\.ts$",
          "(^|/)main\\.ts$",
          "(^|/)__fixtures__/"
        ]
      },
      "to": {}
    },
    {
      "name": "no-test-imports-in-src",
      "severity": "error",
      "comment": "Production code must never import from tests/.",
      "from": {
        "path": "^src/"
      },
      "to": {
        "path": "^tests/"
      }
    }
  ],
  "options": {
    "doNotFollow": {
      "path": "node_modules"
    },
    "exclude": {
      "path": "\\.spec\\.ts$"
    },
    "tsPreCompilationDeps": true,
    "tsConfig": {
      "fileName": "tsconfig.json"
    },
    "enhancedResolveOptions": {
      "exportsFields": [
        "exports"
      ],
      "conditionNames": [
        "import",
        "require",
        "node",
        "default",
        "types"
      ],
      "extensions": [
        ".js",
        ".ts"
      ]
    },
    "reporterOptions": {
      "dot": {
        "collapsePattern": "^src/(kernel|modules)/[^/]+"
      },
      "archi": {
        "collapsePattern": "^src/(kernel|modules)/[^/]+"
      }
    }
  },
};

Object.defineProperty(module.exports, 'contextByModule', {
  value: contextByModule,
  enumerable: false,
});
