# Egress-only, self-hosted AlphaCI: GitHub is the bus, AlphaCI is the notary

Status: design synthesized on 2026-10-18 through `/architect`. Three independent candidates were drafted (Opus, Sonnet, GPT-6.1-sol) and scored by a separate judge. Nothing in this document is implemented yet. It describes intended behavior, not shipped behavior.

## Problem

AlphaCI must be installable on the customer's own server, inside their network, with **no inbound path from the internet**: no vendor relay, no tunnel, no GitHub webhooks, and no runner callbacks. The server may make outbound HTTPS calls. The customer keeps using **github.com, GitHub-hosted runners, GHCR and SonarCloud**. The release trust root must be held by the customer, not by Alpha Explora's Cloud KMS. SaaS AlphaCI keeps running.

Today the pipeline depends on inbound calls at every stage.

- **Access gate.** Every stage's `validate-access` job calls `POST /ci/validate`, and its preflight refuses any non-public URL (`staged-workflow.builder.ts` L2158-2204). An unreachable AlphaCI stops every pipeline at stage 1.
- **Release registration.** `register-release` gets its release id from `POST /ci/releases`.
- **Signing.** `sign-release.yml` signs on the runner with Alpha Explora's KMS through WIF, then calls `PUT /ci/releases/:id/manifest`.
- **Deploy status.** Deploy jobs report back with `/ci/releases/:id/deployment-status` and `/ci/deployments/:id/status`.
- **Visual baselines.** Runners download them from AlphaCI.
- **Webhooks.** Four GitHub webhook events drive lifecycle state.

Constraints found while tracing the current system:

- **Wrong commit on chained runs.** A chained `workflow_run` stage reports the default branch's tip as its `head_sha`, not the commit that was pushed (builder L137-172). Only the push-triggered access run reports the true commit. The generated workflows already pass branch and sha forward in the `alphaci-pipeline-context` artifact.
- **No job outputs over REST.** GitHub's REST API does not expose job outputs, so detailed results have to travel as artifacts.
- **Outbox.** It allows one handler per topic, uses lease plus `SKIP LOCKED`, and relays on a 15 s default interval.
- **Host agent v1.** It verifies `.envelope.manifest` (jq canonical form, sha256, openssl, `projectId`). It has no environment binding and no anti-replay.
- **Architecture rules.** The kernel never imports modules. Cross-context access goes only through `index.ts`, `contracts/` or injection tokens. Each schema has one owner. GCP code lives under `providers/gcp`.
- **Supabase.** At runtime it is only a GoTrue health ping and QA attachment storage, which is already behind a port. The database is plain `pg`. Migrations replay on Postgres 16 with two shims, the `anon`/`authenticated` roles and `storage.buckets`, and there is no migration ledger.

## Usage (caller's view)

**Operator, on one server:**

```bash
cp alphaci.env.example alphaci.env          # PLATFORM_URL may be a LAN name; GitHub App + OAuth App ids; DB password
alphaci-ctl github-app-manifest --org acme  # creates the customer's own GitHub App, webhook disabled
alphaci-ctl keys-init                       # customer-held release key (file or PKCS#11); prints fingerprint
docker compose up -d                        # proxy, web, api, migrate (one-shot), db
alphaci-ctl admin-grant --github-login alice --tier super_admin
alphaci-ctl doctor                          # DB, migrations at head, signer, egress, App permissions, clock, licence
```

The firewall allows outbound 443 only. Nothing on the internet can reach the server. Browsers and host agents on the LAN reach it on 443.

**Generated pipeline.** A runner never calls AlphaCI. It leaves its results on GitHub:

```yaml
- uses: Alpha-Explora/alphaci-workflow/.github/actions/emit-evidence@<pinned-sha>
  with: { kind: stage-report, stage: quality, payload-file: report.json }
```

- Generated YAML contains no AlphaCI URL and no `ALPHACI_TOKEN`.
- Gating reads the repo variable `vars.ALPHACI_ACCESS`.
- Deploys arrive as `workflow_dispatch` with a signed `directive` input.

**Backend, promotion (session user):**

```ts
const deployment = await this.releases.createPromotion(user, projectId, envId, releaseId); // existing checks
return this.deliveries.start(deployment.id); // one method: first env, promotion, rollback; host or workflow
```

**Backend, consuming pipeline facts.** Each fact topic has exactly one owner, so a new consumer subscribes to the owner's domain event rather than to the raw topic:

```ts
@Injectable() export class StageFactHandler implements OutboxTopicHandler {
  readonly topics = [CI_FACT_TOPICS.stageObserved];       // typed StageObserved; no GitHub, tokens, ETags, zips
  async handle({ payload }: { payload: StageObserved }) { /* idempotent on payload.factKey */ }
}
// after causing a run:
await this.runWatch.expect(repoId, { kind: 'deployment-dispatched', deploymentId }, addMinutes(now, 30));
```

**Host agent.** The transport is unchanged and stays on the LAN. The agent polls `GET /onprem/assignments`, and each item is `{assignment, envelope (v1 wire), directive}`. Agent v2 also verifies the directive: its signature, the audience machine, the environment, a `seq` greater than the last stored one, and `notAfter`.

## Shape

### Load-bearing decisions

1. **One transport for SaaS and self-hosted: AlphaCI pulls from GitHub.** SaaS keeps its webhook endpoint only as a *nudge*. HMAC-verified deliveries mark a repo hot, and their payloads are never applied. State changes happen only in the reconciler (per single-source-of-truth). The appliance registers no webhook.
2. **Releases are admitted builds, signed at birth inside AlphaCI with the customer-held key.**
   - The runner never signs. `sign-release.yml`, WIF/KMS on runners, `ALPHACI_TOKEN` and `ALPHACI_RELEASE_SIGNING_KEY` are deleted.
   - A release row is inserted already `verified`, so "registered but unsigned" stops existing (per encode-lessons-in-structure).
   - Only a branded `VerifiedBuildFacts` value can reach the signer, and only the admission policy produces it.
   - The release id is deterministic: UUIDv5 over `(project, sourceEnv, commit, sorted digests, runId, attempt)`.
   - Signing is insert-if-absent. A retry reads the stored signature and never re-signs, because ECDSA signatures are randomized.
3. **Every deployment starts through `DeploymentDelivery.start(deploymentId)`.** This includes the first environment. The package workflow only builds and attests. The first-environment deploy moves into the same dispatched `40-alphaci-deploy.yml` (workflow delivery) or host assignment (host delivery) that promotion uses.
   - Each deployment carries one signed **directive** (`alphaci.directive/v1`).
   - The directive has a per-environment monotonic `seq`, an audience (machine id or repo id), and `notAfter`.
   - A rollback is a new directive for an older release.
4. **Build-to-commit binding has three parts. Each one is checked, because none is enough alone:**
   - **(a) Builder attestation.** The pinned central `docker-build.yml` attests every pushed digest with `actions/attest-build-provenance`, plus a custom `alphaci.build/v1` predicate (also signed by Sigstore under the central workflow's identity). The predicate records `builtCommit = git rev-parse HEAD` after checkout. This fixes a problem the base candidate missed: standard SLSA provenance on a `workflow_run`-triggered run records the default branch's tip, not the commit that was built.
   - **(b) Chain claim, verified.** The run's `alphaci-pipeline-context` artifact names the access run id. AlphaCI treats that as a claim and checks it against GitHub. The claimed run must:
     - exist in the same repo;
     - have `event=push`;
     - have the workflow path `00-alphaci-access.yml`;
     - have concluded `success`;
     - have been created before this run;
     - have a `head_sha` equal to `builtCommit`.
   - **(c) Ancestry and integrity.**
     - `builtCommit` is an ancestor of, or equal to, the environment's source branch (compare API).
     - The generated pipeline files at the default branch match what AlphaCI generated (drift hash).
5. **Provenance grades plus a ratchet floor.**
   - `attested` means (a), (b) and (c) all pass.
   - `observed` means (b) and (c) pass, plus the image jobs succeeded and the digest sits under the repo owner's GHCR namespace. This is for private repos without GitHub Enterprise Cloud, where attestations are unavailable.
   - The grade is signed into the manifest.
   - A per-project floor only ever rises. Once a project has an `attested` release, it can never fall back to `observed`.
   - `RELEASE_MIN_PROVENANCE` sets where new projects start.
6. **Access gate.**
   - **Authoritative check:** the pure function `decidePipelineAccess()` (in `pipelines/ci`, not the kernel) runs at ingestion. Denied projects produce no facts, release, signature, directive or dashboard entry.
   - **Advisory check:** the function's result is also written to `ALPHACI_ACCESS` and checked offline by the access job. A missing value **fails closed** on new projects.
7. **One protocol module** lists what a pipeline leaves on GitHub: workflow files, artifact names, variables, and the JSON Schemas of the evidence kinds. The schemas are the single source.
   - The backend validates evidence with them, and types are derived from them.
   - The `emit-evidence` composite action is generated from them, and a build check fails on drift.
   - A shared test-vector file proves signing and verification agree across the backend, the agent and the `verify-directive` action.
8. **Customer-owned identity.** The customer creates its own GitHub App, with no webhook and no `secrets: write`, and its own OAuth App. Alpha Explora's App key never reaches customer infrastructure.

### Data structures (dominant access patterns traced)

- **`ci.run_watches`**, columns `(repo_id PK, installation_id, runs_etag, watermark, expect_until, last_activity_at, next_poll_at, failures, lease_owner, lease_until)`:
  - "Which repos are due" uses an index on `next_poll_at`, read with `FOR UPDATE SKIP LOCKED LIMIT n`.
  - Cadence is derived each tick: hot 10 s while a run is open or a dispatch is expected, warm 30 s for 15 min after activity, idle 120 s. Failures back off with jitter.
- **`ci.observed_runs`**, columns `(run_id, run_attempt) PK, repo_id, stage, status, conclusion, created_at, access_run_id, built_commit, outcome`:
  - Open runs are tracked by id until they complete, so runs open longer than the watermark overlap are not lost.
  - "Already harvested?" is a primary-key lookup.
- **`ci.evidence_ledger`**, columns `(artifact_id PK, run_id, kind, state: applied|retry|rejected|expired|ignored_untrusted, attempts, reason)`. It records each artifact exactly once. An attestation that has not appeared yet gets `retry` with backoff for 30 min, then `rejected` with an admin re-queue.
- **Fact hand-off is the outbox.** Facts are inserted in the transaction that marks the run harvested, with `ON CONFLICT (fact_key) DO NOTHING` and `fact_key = runId:attempt:topic`. There are four topics with one owner each:
  - `ci.stage.observed`, owned by pipelines/ci (`CiReportsService.ingestReport`, read model unchanged);
  - `ci.build.observed`, owned by runtime release intake;
  - `ci.deploy-run.observed`, owned by runtime delivery;
  - `ci.visual.observed`, owned by pipelines/ci visual regression.

  The appliance wakes the relay with `LISTEN/NOTIFY` on insert, so the 15 s relay interval is not added to deploy latency.
- **`RunTrust`** is computed only from GitHub-controlled fields:
  - `release-grade`: same repo, push or `workflow_run` chain, generated workflow path;
  - `report-only`: same-repo pull request;
  - `untrusted`: fork. Fork runs are ignored.
- **runtime:**
  - `releases` gains `release_seq`, `source_run_attempt`, `repo_id`, `provenance_grade`, `access_run_id` and `built_commit`.
  - `deployments` gains `directive` (exact signed bytes), `directive_seq`, `dispatched_at` and `run_id`.
  - New tables: `runtime.environment_directive_seq` (`UPDATE … RETURNING` in the deployment transaction) and `runtime.project_provenance_floor`.
- **Envelopes.**
  - Release manifests keep the v1 wire (RFC 8785 canonical JSON) so v1 agents keep verifying.
  - Directives are **exact-bytes** envelopes: base64 payload plus a signature over those bytes, so no executor re-serializes JSON.
- **Agent state:** `state/<project>/<env>/last_seq`, written when a directive is accepted.

### Core types (sketch)

```ts
// runtime/application/ports/release-signer.port.ts
export interface ReleaseSigner {
  readonly activeKeyId: string;
  sign(bytes: Uint8Array): Promise<Signature>;   // file-p256 | pkcs11 (appliance); gcp-kms under providers/gcp (SaaS)
  trustKeys(): Promise<TrustKey[]>;              // derived; replaces hand-set ALPHACI_RELEASE_TRUST_KEYS_JSON
}
export const RELEASE_SIGNER = Symbol('ReleaseSigner');

// runtime/domain/build-admission.policy.ts  (pure)
declare const verified: unique symbol;
export type VerifiedBuildFacts = BuildFacts & { readonly [verified]: true; grade: 'attested' | 'observed' };
export type AdmissionDecision =
  | { kind: 'admit'; facts: VerifiedBuildFacts; autoDeploy: boolean }   // autoDeploy=false if commit not ahead of env
  | { kind: 'refuse'; reason: AdmissionRefusal };
export function admitBuild(ctx: AdmissionContext): AdmissionDecision { throw new Error('not implemented'); }

// runtime/application/deployment-delivery.service.ts
export interface DeploymentDelivery {
  start(deploymentId: string): Promise<DeliveryStarted>;  // signs directive, host-assign or dispatch (idempotent)
}

// pipelines/github-sync (internal) -> exported port
export interface RunWatch {
  expect(repoId: number, reason: ExpectReason, until: Date): Promise<void>;   // make hot
}
export const RUN_WATCH = Symbol('RunWatch');
```

### Flow: push to the first environment, through deployment

1. The **access** run (push) emits `stage-report` evidence and the `alphaci-pipeline-context` artifact. **Quality** and **package** (`workflow_run`) emit `stage-report` and `build-facts` evidence. The central builder pushes to GHCR and attests each digest.
2. **`RunSyncService.tick`** does the following, then writes the facts in one transaction:
   - a conditional `listRuns` (`If-None-Match`) plus the tracked open runs;
   - `planRun`;
   - harvest jobs, artifacts and attestation bundles;
   - verify the chain claim;
   - `decidePipelineAccess`.
3. **`ReleaseIntake`** (handler of `ci.build.observed`) runs `admitBuild`, then `CommitOrder.compare`. On admit it does an insert-if-absent of the release and signs it. If the commit is ahead of what the environment runs, it creates the first-environment deployment. A re-run of an old commit never rolls dev back.
4. **`DeploymentDelivery.start`** allocates `seq` and signs the directive:
   - **Host delivery:** the directive appears in `/onprem/assignments`.
   - **Workflow delivery:** AlphaCI first searches recent runs for `run-name: alphaci-deploy <deploymentId>`. Only if none is found does it dispatch `40-alphaci-deploy.yml` with an installation token, then call `RunWatch.expect`.
5. **The deploy run** runs `verify-directive` against `vars.ALPHACI_TRUST_KEYS` and deploys only the digests named in the directive. AlphaCI observes the run, which becomes `ci.deploy-run.observed`. `deploymentStatusFromRun` is monotonic and ignores runs not started by the App bot. AlphaCI posts the commit statuses `alphaci/release` and `alphaci/deploy-<env>` outbound.

**Promotion** is steps 4 and 5. **Visual baselines:** approval in AlphaCI makes `VisualBaselinePublisher` commit the `alphaci/visual-baselines` branch through the Git Data API, idempotent by tree sha. The runner checks out that ref with its own `GITHUB_TOKEN`. **Lifecycle:** `GithubEstateReconciler` runs every 5 min with conditional requests.

### Module map

| Module (owner) | Change | Public surface |
|---|---|---|
| `pipelines/ci/contracts/pipeline-protocol.ts` | NEW: workflows, artifacts, variables, evidence JSON Schemas, derived types | contract (dependency-free) |
| `pipelines/ci/application/pipeline-access.ts` | NEW: `decidePipelineAccess` (pure) + `PipelineAccessProjector` (sole writer of `ALPHACI_ACCESS`) | internal |
| `pipelines/github-sync/` | NEW sub-module, `ci` schema: run sync worker, `GithubActionsReader` (ETag), `RateGovernor` (interactive first, then P0 release/deploy, P1 reports, P2 estate, P3 idle), `SigstoreProvenanceVerifier`, `GithubEstateReconciler`, evidence ledger | `RUN_WATCH`, `CI_FACT_TOPICS` + payload types |
| `pipelines/github` webhook controller/processor | SHRINKS to a nudge (SaaS only, capability-gated); the 4 mutating handlers are deleted | none |
| `pipelines/ci/api/*` (13 routes) | MOVED to `api/legacy/`, mounted only for `push-v1` projects in SaaS | legacy |
| `runtime/domain/{signed-statements,build-admission.policy,release-manifest(v2 additive)}.ts` | NEW / extended, pure | internal |
| `runtime/application/{release-intake.handler,deployment-delivery.service,deploy-run.handler,deployment-timeout.sweep}.ts` | NEW; `release-registry.service` loses register/attach/report/dispatch | `DeploymentDelivery.start` (runtime-internal) |
| `runtime/application/ports/release-signer.port.ts` + `infrastructure/signing/{file-p256,pkcs11}` + `infrastructure/providers/gcp/signing/kms-release-signer.ts` | NEW, one binding per install | `RELEASE_SIGNER` |
| `projects/application/workflows/staged-workflow.builder.ts` | Generates protocol v2 from `pipeline-protocol.ts`; records the protocol per project | unchanged entry point |
| `projects/.../drift` | v1 to v2 repair: delete the token/URL secrets, write variables, open a regeneration PR | none |
| `projects/infrastructure/qa-attachment-storage.postgres.ts` | NEW adapter on the existing port (bytea + HMAC URLs) | none |
| `kernel/db/migration-runner.ts`, `src/cli/alphaci-ctl.ts`, `health/` | NEW / changed: ledgered migrations with an advisory lock compiled into `dist`; health = `SELECT 1` + sync lag + signer state (degraded, never down) | CLI |
| `kernel/config/{ci-api-base-url,ci-api-connectivity,release-signing-provisioning}.ts` | DELETED after the v1 sunset | none |
| `identity-access` | Pending platform-admin grant by login, applied at first sign-in (makes the migration-seeded `lloydlim1` inert) | used by `alphaci-ctl` |
| `billing` | Offline signed licence file (vendor key) feeds `decidePipelineAccess` | internal |
| `deploy/appliance/` | compose, Caddyfile, postgres-init (shared with the e2e harness), `release.lock.env` | operator files |
| `deploy/onprem/agent/alphaci-agent.sh` | v2: verify directive + persist `last_seq` | wire: `directive` |
| `alphaci-workflow` | `docker-build.yml`: provenance + `alphaci.build/v1` attestations; new actions `emit-evidence`, `verify-directive`; `playwright-e2e.yml`: baseline branch checkout + evidence; DELETE `sign-release.yml`, `release.yml`, `validate-subscription.yml`, `gcp-cloud-run-deploy.yml` (calls routes this BE does not serve) | tag `v2`, referenced by commit SHA |

### Fate of every inbound surface

| # | Route | Fate | Replacement |
|---|---|---|---|
| 1 | `POST /ci/validate` | Removed | Authoritative gate at ingestion; advisory `vars.ALPHACI_ACCESS` checked offline |
| 2 | `POST /ci/report` | Pull | `stage-report` evidence becomes `ci.stage.observed`, then the existing `ingestReport`. Identity comes from GitHub's run object, not the payload |
| 3 | `POST /ci/playwright-progress` | Removed (degraded) | Per-test results arrive when the job ends; live run/job/step state is already polled |
| 4 | `GET /ci/visual-baselines` | Moved | Runner checks out `alphaci/visual-baselines` |
| 5 | `GET /ci/visual-baselines/file` | Moved | Same branch |
| 6 | `POST /ci/visual-summary` | Pull | `visual-results` evidence |
| 7 | `POST /ci/visual-results/file` | Pull | PNG blobs in the same artifact (byte-capped) |
| 8 | `POST /ci/releases` (registry) | Pull + admission | `build-facts` evidence + attestations become `ci.build.observed`, then `admitBuild` and sign |
| 9 | `POST /ci/releases` (Render branch mode) | SaaS legacy only | Regenerate to environments mode; appliance does not support branch mode |
| 10 | `GET /ci/releases/:id` | Removed | Directive carries commit, digests and targets |
| 11 | `PUT /ci/releases/:id/manifest` | Removed | AlphaCI signs at admission |
| 12 | `POST /ci/releases/:id/deployment-status` | Pull | Deploy-run job conclusions, or the host's LAN status report |
| 13 | `POST /ci/deployments/:id/status` | Pull | Same, correlated by run-name, bot actor and `dispatched_at` |

| Webhook | Fate | Replacement |
|---|---|---|
| `repository` deleted | Polling | Repo id missing from `GET /installation/repositories`, then two 404s at least 5 min apart from `GET /repositories/{id}`, mark it `orphaned`. Hard-delete after a grace period (default 7 d; 0 restores today's behavior). Renames are detected by id |
| `membership` | Existing worker | `GithubTeamRoleReconcileWorker`, on by default in the appliance (5 min), leased, plus login-time sync |
| `installation` | Polling | `GET /app/installations` (App JWT). Any 401/403/404 on an installation token triggers an immediate run |
| `installation_repositories` | Polling | `GET /installation/repositories` (ETag), then `replaceRepos` |

`/onprem/*` (LAN) and the OAuth callback (browser redirect, outbound token exchange) are unchanged.

### Security model

**Trust roots.**

| Root | Held by | Purpose |
|---|---|---|
| Release key | The customer: a file with mode 0600 in a compose secret, or PKCS#11/HSM | Signs releases and directives |
| Host-pinned public keys | Hosts | Verify releases and directives |
| GitHub App key | The customer (appliance file) | Reads runs/artifacts, writes variables/contents, dispatches |
| Sigstore trusted root | Public. Pinned, refreshed outbound | Verifies build attestations |
| Central workflow identity | Appliance config (repo, path, **commit SHA**) | Checks who signed the attestation |
| Vendor licence key | Alpha Explora | Offline entitlement |
| Vendor image signature | Alpha Explora (cosign). Digests pinned in `release.lock.env`, verified at install and upgrade | Integrity of the platform code. This is deliberately separate from the customer's release root |

**Binding chain:** digest → builder attestation (repo id, run, attempt, `builtCommit`, pinned builder) → verified chain claim (push access run, same `head_sha`) → ancestry of the environment branch plus default-branch pipeline integrity → release manifest v2 (customer key, grade, seq) → directive (environment, audience, seq, `notAfter`) → executor check.

**A compromised repo or workflow can:**
- burn its own minutes;
- write false dashboard telemetry for its own project;
- push images to its own packages;
- get a release for a commit that really is on its environment branch. That is the product working; branch protection is the control.

**It cannot:**
- obtain a signature or contact AlphaCI. No URL or token exists in the repo. Today a leaked `ALPHACI_TOKEN` can register releases from anywhere.
- get a release admitted from a fork, a pull request, an unentitled project, a modified pipeline, or a non-central builder;
- lower the provenance floor;
- make a host pull an unsigned digest, or replay or retarget a directive to a host.

**Residual risks:**
- **Stateless workflow targets.** A repo writer who re-dispatches an old directive is bounded by `notAfter` (1 h) and the per-environment `concurrency` group. AlphaCI ignores the run. The writer already holds those targets' provider secrets.
- **Repo admins** can edit `ALPHACI_TRUST_KEYS` and `ALPHACI_ACCESS`. Both are advisory for workflow targets, and authoritative checks live in AlphaCI and on the hosts.
- **The AlphaCI process can sign**, because the key is in its process or HSM session. PKCS#11 adds non-exportability and audit, not a policy boundary.

### Operability

- **Latency.**
  - Stage visible: about 10-20 s after the job ends.
  - Push to first-environment deploy start: about +15-35 s over today for workflow delivery (detect, harvest, sign, dispatch, queue). For host delivery, detection plus the agent's 30 s timer.
  - Promotion: unchanged start. Status reaches AlphaCI at most 10 s late.
- **Rate budget** (5,000/h per installation minimum; conditional 304s assumed free, which must be verified):
  - Idle watching is about 0.
  - One push-to-deploy cycle is about 30-35 counted calls, so roughly 140-160 cycles/h per installation.
  - `RateGovernor` reads `X-RateLimit-*` and keeps interactive UI calls first. It sheds P3 idle polls first and never sheds P0 release/deploy work. It caps per-installation concurrency at 4, which keeps under GitHub's secondary limits.
- **Idempotency.**
  - A tick is a pure re-derivation, keyed by `runId:attempt:topic`.
  - A crash before commit means the tick is redone. A crash after commit makes the redo a no-op.
  - Dispatch searches before dispatching.
  - A timeout sweep frees a deployment stuck in flight.
  - Leases make a second api replica safe.
- **Observability.**
  - `/health`: DB status for the container, plus sync lag, minimum remaining rate limit, and signer state.
  - A per-project "GitHub sync" panel: last poll, last run seen, and refusals with reasons.
  - Commit statuses written back to GitHub.

### Packaging (one server, `docker compose`)

- **Services:** `proxy` (Caddy, customer or internal-CA certificate), `web`, `api`, a one-shot `migrate`, and `db` (postgres:16).
  - `web` is one Next.js image with same-origin `/api/v1`, so it is identical for every customer.
  - `api` runs with `PORT=3000`, matching the Dockerfile.
- **Supabase is removed:**
  - The health check becomes `SELECT 1`.
  - Supabase env vars are required only when `STORAGE_DRIVER=supabase`.
  - QA attachments use the bytea adapter.
  - The session store is forced to Postgres.
  - `postgres-init` creates the `anon`/`authenticated` roles and a stub `storage.buckets`, and the e2e harness mounts the same script.
- **Config and secrets:** secrets are read via `*_FILE`. A corporate egress proxy is honored via `EnvHttpProxyAgent`. Internal CA trust comes from `NODE_EXTRA_CA_CERTS`.
- **Images:** built in Alpha Explora's CI, so the template-clone token never sits on the customer box. They are cosign-signed and digest-pinned.
- **Appliance egress allowlist:**
  - `api.github.com`, `github.com` (OAuth), `uploads.github.com`
  - artifact blob hosts: `*.actions.githubusercontent.com`, `*.blob.core.windows.net`
  - `ghcr.io`, `pkg-containers.githubusercontent.com`
  - `tuf-repo-cdn.sigstore.dev`
  - `sonarcloud.io` (optional direct reads)

  Hosts need GHCR for pulls.
- **Backup:** the database dump plus the release key, both covered by `alphaci-ctl backup`.
- **Key loss:** `alphaci-ctl keys-rotate` adds the new key to `trustKeys()`. Hosts accept a signed key-rotation directive from the old key, or must re-enroll if the old key is gone.

### Migration path

1. **Shadow.** Ship `github-sync` on SaaS in shadow mode. It observes and records but emits no facts for `push-v1` projects. Compare its facts with what the legacy routes wrote.
2. **Generator v2 and `alphaci-workflow` v2.**
   - Projects record `pipeline_protocol`.
   - Drift repair opens regeneration PRs, and merging one flips the project to `pull-v2`.
   - Legacy routes refuse `pull-v2` projects, and sync skips `push-v1` projects, so a project always has exactly one writer.
3. **Appliance.** It launches pull-only. Legacy ingress is not in its manifest.
4. **SaaS signing.** It moves from runner KMS into AlphaCI via the `gcp-kms` adapter. The key is the same, so v1 SaaS agents keep verifying. Agent v2 rolls out, and directives become required per environment once the host reports agent ≥ v2.
5. **Delete legacy.** Once no project is on `push-v1` (a count trigger, not a date), delete `api/legacy/`, the token tables, the protocol column and the v1 workflows.

Customers moving from SaaS on-prem to the appliance re-enroll their hosts against the new key.

## Synthesis decision

- **Base: the Opus candidate.** The judge scored it 27/30, against 22 for Sonnet and 21 for GPT-6.1-sol. My own reading agreed.
  - It is the only one with a single deploy path: `DeploymentDelivery.start` covers the first environment, promotion, rollback, host and workflow.
  - It handles the `workflow_run` commit quirk.
  - It has the strongest binding chain, the provenance floor ratchet, and a one-writer-per-project migration arbiter.
- **All three candidates converged** on: one pull transport, artifacts as evidence, AlphaCI-side signing with a customer key, signed directives with seq and expiry, a repo-variable advisory gate, a git branch for visual baselines, reconcilers in place of webhooks, and a Compose appliance with no Supabase. This is a strong agreement signal.
- **Grafted from Sonnet:**
  - the JSON Schema single source plus an `emit-evidence` composite action, replacing Opus's `toString()`-inlined serializers, which were fragile;
  - provenance grades (`observed` fallback for private repos without GitHub Enterprise Cloud);
  - `RunTrust` fork/PR classification;
  - the pipeline-file integrity check;
  - open-run tracking and an evidence ledger with retry/rejected/expired states;
  - interactive-first rate budgeting;
  - signer-derived `trustKeys()`;
  - the shared test-vector file;
  - vendor-image trust as a separate root.
- **Grafted from GPT-6.1-sol:**
  - exact-bytes envelopes for directives;
  - the branded `VerifiedBuildFacts` type;
  - deterministic release ids with insert-if-absent signing;
  - search-before-dispatch correlation;
  - the trust-roots and failure tables.
- **Added during synthesis:**
  - the `alphaci.build/v1` builder attestation of `builtCommit`, because no candidate bound the built commit cryptographically on `workflow_run` runs;
  - verification of the job-written upstream-run claim (the judge caught that Opus treated it as GitHub-controlled);
  - `LISTEN/NOTIFY` on the outbox;
  - the offline licence;
  - backup and key rotation;
  - completing the egress list.
- **Rejected:**
  - GPT-6.1-sol's use of `workflow_run.head_sha` for the commit and run-name. It would build the default branch's code.
  - Mandatory attestations with no fallback.
  - The advisory-lock leader. Leases already handle replicas.
  - Sonnet's inline first-environment deploy, which keeps two deploy paths and is unsigned.
  - A fail-open access gate.
  - Purpose-prefixed signing bytes on the release wire, which would break v1 agents.
  - A local "previously healthy" rollback exception on hosts, which allows replay.
  - A sunset that fails the build on a calendar date.

Candidate packages and the judge report are kept outside the repo, in the session scratchpad (`architect/`).

## Tradeoffs accepted

- We accept losing live per-test Playwright progress in exchange for zero inbound and no runner credential.
- We accept about 15-35 s of extra first-environment latency for workflow-delivered targets in exchange for one deploy path and a signed, gated first deploy.
- We accept that `observed` provenance is weaker than `attested` on private repos without GitHub Enterprise Cloud. In exchange it works on every plan. The grade is signed and the floor only rises.
- We accept that the release key is usable by the AlphaCI process, with no separate policy signer, in exchange for one admission policy in one place.
- We accept `@sigstore/verify` and `@sigstore/tuf` and Sigstore egress in exchange for provenance a compromised repo cannot forge.
- We accept orphan-then-purge instead of an immediate hard delete in exchange for safety against transient 404s.
- We accept that SaaS keeps a webhook endpoint. It is a nudge with no data path, which looks like a second way but cannot write state.
- We accept PNG history in customer repos, from the baseline branch, in exchange for a channel runners read with `GITHUB_TOKEN` alone.
- We accept that each customer must create its own GitHub App, in exchange for no shared vendor App key.

## Alternatives considered

- **Push in SaaS, pull in the appliance, behind one ingestion port.** The port hides only transport. It forks the YAML dialect, the signing location and the security model forever: two ways to do one task.
- **Runner-side signing with a customer key (cosign) or a customer cloud KMS via OIDC.** The key or its trust sits in GitHub's reach. There is no monotonic directive, so no anti-replay. The kill switch cannot live in the signer.
- **Self-hosted runners in the customer network, keeping push.** This violates the GitHub-hosted runner constraint. It stays compatible as an add-on, but nothing depends on it.
- **Check-run output as the fact channel.** It has a 64 kB cap and no binaries, so PNGs would still need artifacts, giving two channels.
- **Hosts poll GitHub and verify provenance themselves, with no AlphaCI release step.** This loses the registry and promotion state, and every host would need GitHub credentials.

## Implementation reconciliation

_Record accepted deviations here during implementation._

## Open questions and risks

1. **Plans.** Which GitHub plans do the first customers have? Artifact attestations on private repos need GitHub Enterprise Cloud. Should `RELEASE_MIN_PROVENANCE` default to `observed` or `attested`?
2. **App token reach.** Can GitHub App installation tokens read `GET /repos/{r}/attestations/{digest}` and HEAD private GHCR manifests? If not, does AlphaCI accept a server-held read-only PAT for the `observed` registry check? `doctor` must prove whichever path is chosen.
3. **Rate limits.** Do conditional 304s really not count, and how does the installation limit scale with repo count? This needs measurement before the cadence defaults are fixed.
4. **Central workflows.** Can customer orgs call `Alpha-Explora/alphaci-workflow@<sha>` on github.com, or must it be mirrored? Mirroring changes the pinned builder identity.
5. **Licence.** How does Alpha Explora issue and renew the offline licence, and what happens at expiry? Proposal: stop new releases and directives; never stop running workloads.
6. **Multi-repo projects.** A release spanning several repos needs a cross-repo admission rule. That is not designed here.
7. **Branch-mode Render.** Does any SaaS customer still use `release.yml`? They block the legacy deletion.
8. **Dispatch run details.** Is `return_run_details` on `workflow_dispatch` available? The run-name, bot actor and timestamp correlation is the fallback and is sufficient alone.
9. **First-environment approval.** Do customers want an optional "approve release" step before AlphaCI signs?
10. **Fake GitHub harness.** A recorded-fixture plus fake-GitHub harness is needed before the sync engine can be tested end to end.
11. **Clock skew** between the appliance and GitHub affects the watermark overlap and `notAfter`. `doctor` should check it.

## Next implementation step

Write `pipelines/ci/contracts/pipeline-protocol.ts` with the `stage-report` JSON Schema and the generated `emit-evidence` action. Add a contract test that round-trips the access stage's generated YAML step through the parser. Then build `RunSyncService.tick` with `planRun` and chain-claim verification against recorded GitHub fixtures, in shadow mode.
