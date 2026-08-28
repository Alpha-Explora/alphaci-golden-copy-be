---
type: "Playbook"
title: "Deployment provisioning live smoke"
description: "Approved external-resource smoke checklist for current Render, Vercel, GitHub, and Runtime provisioning paths."
tags: [runbook, runtime, providers, smoke-test]
status: stable
sources:
  - id: provisioning
    resource: "/runbooks/runbook-deployment-provisioning.md"
    title: "Deployment provisioning runbook"
  - id: provider-tests
    resource: "tests/architecture/provider-plugin.acceptance.spec.ts"
    title: "Provider acceptance test"
---
# Deployment provisioning live smoke

Use this checklist only after explicit approval to create temporary external resources. Use a unique prefix and record evidence before cleanup.

## Preconditions

- Backend runs against the intended database with current migrations applied.
- `ENV_PROVISIONING_ENABLED=true`.
- Managed Render values are configured: API key, owner ID, region, instance policy, service limit, bootstrap image, and registry credential when required.
- Managed Vercel values are configured: token, team ID, and optional team slug.
- GitHub App credentials can create a disposable repository under the test owner.
- The test user has the subscription state required by the current product flow.
- The test prefix is unique, for example `flowci-smoke-YYYYMMDD-HHMM`.

## Test matrix

Run in order:

1. Managed Vercel frontend target with CI-pushed deployment.
2. Managed Render backend target with image-pushed deployment.
3. BYO Render existing-service attach only when a disposable service is available and the current target policy permits it.

Do not use paid Render instance types for the smoke test.

## Managed target smoke

1. Sign in as the test user and create a project with the unique name.
2. Enable deployment provisioning.
3. Configure a Vercel frontend target and a Render backend target using the current provider and slot policies.
4. Add one harmless environment value such as `FLOWCI_SMOKE_ID=<prefix>`.
5. Submit project setup and confirm the response is `completed` with the expected workflow files and target statuses.
6. Confirm the generated repository contains the provider secrets for the configured slots.
7. Confirm the Vercel project and Render service exist in the configured accounts.
8. Push or dispatch the generated package workflow on the test branch.
9. Confirm access, quality, package, image build, and provider deployment steps complete.
10. Confirm the smoke environment value is present at both provider targets.

## Existing-service smoke

Only when a disposable Render service is available:

1. Connect the configured provider connection.
2. Register the existing service with its provider owner and service identifiers.
3. Confirm secrets use the configured connection and owner metadata.
4. Confirm no legacy deploy-hook metadata is created.

## Cleanup

1. Delete the temporary GitHub repository.
2. Delete the temporary Vercel project.
3. Delete the temporary Render service.
4. Revoke temporary provider connections.
5. Remove test rows when the environment policy requires it.
6. Confirm no smoke-prefix secrets, repositories, or provider resources remain.

## Evidence

Record project ID, repository, generated workflow list, provisioning result, provider IDs, workflow run URL, and cleanup confirmation. External execution is not proven by local static checks.
