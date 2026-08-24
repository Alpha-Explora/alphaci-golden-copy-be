# Deployment Provisioning

## Current Behavior

FlowCI can create provider deployment targets during project setup and push initial runtime env vars directly to the provider. Env var values are write-only: FlowCI sends them to Render or Vercel and stores only metadata.

## Provider Strategy

```text
vercel + flowci_managed            => vercel_ci_pushed
vercel + byo                       => vercel_ci_pushed
render + flowci_managed            => render_image_pushed
render + byo + image deploy        => render_image_pushed
render + byo + native Git build    => render_git_connected
render + existing service          => render_existing_service
```

`provider_native` and `vercel_git_connected` remain legacy/future strategy types, but normal project provisioning should not select them for new Vercel or managed Render targets.

## Managed Render

For FlowCI-managed Render targets:

1. FlowCI creates an image-backed Render service through the Render API.
2. The initial service image is `FLOWCI_RENDER_BOOTSTRAP_IMAGE`.
3. FlowCI installs deterministic per-slot GitHub Actions secrets into the generated GitHub repo.
4. The generated package workflow builds the backend Docker image, pushes it to GHCR, then calls the central `render-deploy.yml` reusable workflow.
5. The reusable workflow calls `POST /v1/services/{serviceId}/deploys` with the pushed `imageUrl`.

This avoids requiring the user to install Render's GitHub integration for managed deployments.

Required backend env vars:

```env
ENV_PROVISIONING_ENABLED=true
FLOWCI_RENDER_API_KEY=<flowci-managed-render-api-key>
FLOWCI_RENDER_OWNER_ID=<render-workspace-owner-id>
FLOWCI_RENDER_DEFAULT_REGION=singapore
FLOWCI_RENDER_DEFAULT_INSTANCE_TYPE=free
FLOWCI_RENDER_ALLOWED_INSTANCE_TYPES=free
FLOWCI_RENDER_ALLOW_PAID_MANAGED=false
FLOWCI_RENDER_MANAGED_MAX_SERVICES_PER_USER=2
FLOWCI_RENDER_BOOTSTRAP_IMAGE=docker.io/library/nginx:alpine
FLOWCI_RENDER_REGISTRY_CREDENTIAL_ID=<optional-render-registry-credential-id>
```

`FLOWCI_RENDER_REGISTRY_CREDENTIAL_ID` is needed when Render must pull private GHCR images.

## Canonical Provider Discovery and GCP

`GET /deployment-providers` is the provider-neutral discovery endpoint. It
returns only public metadata: provider IDs, supported slots, capabilities,
form schemas, and enabled state. It never returns credentials.

Render and Vercel remain compatibility providers in this registry; their
existing deployment routes and generated workflows are unchanged.

GCP is disabled by default. When enabled, it uses Application Default
Credentials through `google-auth-library` and its runtime port can ensure an
Artifact Registry repository and a Cloud Run service. Configuration:

```env
GCP_DEPLOYMENTS_ENABLED=true
GCP_SHARED_PROJECT_ID=<shared-gcp-project-id>
GCP_REGION=asia-southeast1
GCP_ARTIFACT_REGISTRY_REPOSITORY=<artifact-registry-repository>
```

The application service persists a target plus an idempotent provisioning job;
the executor is intentionally not scheduled or exposed over HTTP in this
change. A worker integration must claim that job under the deployment
authorization boundary before it can make Google Cloud calls. This keeps the
feature safe to deploy and test without creating live resources.

## Managed Vercel

For FlowCI-managed Vercel targets:

1. FlowCI creates the Vercel project through the Vercel API.
2. The Vercel project is created without `gitRepository`.
3. FlowCI installs per-slot GitHub Actions secrets into the generated GitHub repo.
4. The generated package workflow deploys with the central `vercel-deploy.yml` reusable workflow.

This avoids requiring the user to install the Vercel GitHub App.

Required backend env vars:

```env
FLOWCI_VERCEL_TOKEN=<flowci-managed-vercel-token>
FLOWCI_VERCEL_TEAM_ID=<flowci-vercel-team-id>
FLOWCI_VERCEL_TEAM_SLUG=<optional-flowci-vercel-team-slug>
```

## GitHub Actions Secrets

For CI-pushed Vercel targets, FlowCI installs deterministic per-slot secrets:

```text
VERCEL_FRONTEND_TOKEN
VERCEL_FRONTEND_ORG_ID
VERCEL_FRONTEND_PROJECT_ID

VERCEL_BACKEND_TOKEN
VERCEL_BACKEND_ORG_ID
VERCEL_BACKEND_PROJECT_ID

VERCEL_STANDALONE_TOKEN
VERCEL_STANDALONE_ORG_ID
VERCEL_STANDALONE_PROJECT_ID
```

For Render image-pushed targets, FlowCI installs:

```text
RENDER_BACKEND_API_KEY
RENDER_BACKEND_SERVICE_ID
RENDER_BACKEND_OWNER_ID
RENDER_BACKEND_REGISTRY_CREDENTIAL_ID

RENDER_STANDALONE_API_KEY
RENDER_STANDALONE_SERVICE_ID
RENDER_STANDALONE_OWNER_ID
RENDER_STANDALONE_REGISTRY_CREDENTIAL_ID
```

Managed targets use FlowCI provider tokens. BYO targets use the user's saved provider connection token.

## Generated Workflow Contract

Generated package-stage workflows call:

```text
cicd-external-project/cicd-workflow/.github/workflows/vercel-deploy.yml@v1
cicd-external-project/cicd-workflow/.github/workflows/render-deploy.yml@v1
```

The Render reusable workflow expects:

```text
RENDER_API_KEY
RENDER_SERVICE_ID
RENDER_OWNER_ID
RENDER_REGISTRY_CREDENTIAL_ID
```

The generated workflow maps those reusable-workflow secrets from the per-slot repository secrets above.

## Cost Controls

Managed Render defaults to:

```text
service type: web_service
instance type: free
paid managed provisioning: disabled
```

Paid managed instance types require `FLOWCI_RENDER_ALLOW_PAID_MANAGED=true` and must also be listed in `FLOWCI_RENDER_ALLOWED_INSTANCE_TYPES`.

## Live Verification

After deploying backend, frontend, and central workflow to test:

1. Ensure managed Render and Vercel env vars are present in the backend deployment.
2. Create a backend project with `Managed by FlowCI` and Render.
3. Confirm a Render service was created in `FLOWCI_RENDER_OWNER_ID`.
4. Confirm the generated GitHub repo has `RENDER_BACKEND_API_KEY`, `RENDER_BACKEND_SERVICE_ID`, and `RENDER_BACKEND_OWNER_ID`.
5. Push to `test` and confirm the package workflow builds and pushes a GHCR image.
6. Confirm the central Render workflow calls the Render deploy API with `imageUrl`.
7. Create a frontend project with `Managed by FlowCI` and confirm the existing Vercel flow still works.

Use `docs/deployment-provisioning-live-smoke.md` for the full live smoke
checklist and cleanup sequence. The live smoke creates temporary GitHub, Vercel,
and Render resources and must only be run after explicit approval.
