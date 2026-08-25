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
      "name": "deployments-domain-is-framework-free",
      "severity": "error",
      "comment": "Deployment domain rules must stay framework- and vendor-independent. Import Nest, pg, Supabase, API controllers, or adapters only from application/ or infrastructure/.",
      "from": {
        "path": "^src/modules/deployments/domain/"
      },
      "to": {
        "path": [
          "@nestjs/",
          "pg",
          "@supabase/",
          "^src/modules/deployments/api/",
          "^src/modules/deployments/dto/",
          "^src/modules/deployments/infrastructure/"
        ]
      }
    },
    {
      "name": "deployments-api-cannot-reach-infrastructure",
      "severity": "error",
      "comment": "Controllers translate HTTP and delegate to application services; they never import a repository or provider client directly.",
      "from": {
        "path": "^src/modules/deployments/(api/)?[^/]*controller\\.ts$"
      },
      "to": {
        "path": [
          "^src/modules/deployments/(application/)?[^/]*repository\\.ts$",
          "^src/modules/deployments/infrastructure/providers/"
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
      "comment": "A provider adapter must never know another adapter exists. Add shared behavior to infrastructure/providers/core instead.",
      "from": {
        "path": "^src/modules/deployments/infrastructure/providers/(render|vercel)/"
      },
      "to": {
        "path": "^src/modules/deployments/infrastructure/providers/(?!core/)"
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
          "(^|/)main\\.ts$"
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
  }
};
