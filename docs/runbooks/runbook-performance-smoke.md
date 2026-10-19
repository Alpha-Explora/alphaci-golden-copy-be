---
type: "Playbook"
title: "Performance smoke"
description: "Optional k6 smoke check of the backend health endpoint."
tags: [runbook, performance, k6]
status: stable
sources:
  - id: performance-tests
    resource: "tests/performance/smoke.js"
    title: "k6 performance smoke script"
---
# Performance smoke

## Purpose

`tests/performance/smoke.js` sends one `GET /api/v1/health` request (1 virtual user, 1 iteration) and checks for HTTP 200. Use it against an approved environment to catch an unavailable or badly slow backend. It is not a load or capacity test, and CI does not run it.

## Run

The script defaults to `http://localhost:3000`. The backend listens on 4000 by default, so set the base URL:

```bash
K6_BASE_URL=http://localhost:4000 k6 run tests/performance/smoke.js
BASE_URL=https://service.example k6 run tests/performance/smoke.js
```

`BASE_URL` wins when both are set. On the self-hosted appliance, use its public origin; Caddy routes `/api/*` to the backend.

## Preconditions

- Confirm the target environment and its rate limits.
- Change `options` in the script, in a reviewed change, before using more virtual users, iterations, or thresholds.

## Evidence

Record the target, script revision, k6 version, summary output, and result. One smoke run is not a capacity or reliability guarantee.
