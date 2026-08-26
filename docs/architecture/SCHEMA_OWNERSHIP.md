# Schema ownership

The migration tree is organized by the six bounded contexts. This is an
ownership map only; it does not change schemas, roles, `search_path`, replay
order, or foreign-key behavior.

| Owner | Schemas |
|---|---|
| `identity-access` | `identity`, `orgs`, `hierarchy` |
| `projects` | `projects`, `workflow` |
| `pipelines` | `github_app`, `ci`, `workflow` |
| `runtime` | `runtime`, `env_provisioning`, `runtime_deployments`, `runtime_domains`, `runtime_secrets`, `gcp_operations` |
| `billing` | `billing`, `usage`, `billing_lifecycle` |
| `platform-ops` | `platform`, `audit`, `notifications`, `support` |

`workflow` is retained in both `projects` and `pipelines` because the current
database contains both workflow-generation and CI-run tables. Existing
cross-context migrations are explicitly listed in
`scripts/check-schema-ownership.cjs`; they are compatibility debt, not a new
permission to add cross-context SQL. New migrations must remain within their
owner's schema set.

`db:apply:all --dry-run` recursively discovers owner folders and globally
sorts by the timestamp-prefixed filename, preserving the former flat replay
sequence. `db:apply` accepts either a bare migration filename or an explicit
`<owner>/<filename>` path.
