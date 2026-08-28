---
type: "Playbook"
title: "Performance smoke"
description: "Optional k6 smoke procedure for the current backend deployment."
tags: [runbook, performance, k6]
status: stable
sources:
  - id: performance-tests
    resource: "tests/performance/smoke.js"
    title: "k6 performance smoke script"
  - id: workflow
    resource: ".github/workflows/ci.yml"
    title: "CI workflow"
---
# Performance smoke

## Purpose

Run the optional k6 smoke script against an approved environment to detect obvious latency or availability regressions. This is not a capacity test or a production load authorization.

## Run locally

```bash
k6 run tests/performance/smoke.js
```

Set a custom backend URL with either supported variable:

```bash
K6_BASE_URL=https://service.example k6 run tests/performance/smoke.js
BASE_URL=https://service.example k6 run tests/performance/smoke.js
```

## Preconditions

- Confirm the target environment and rate limits.
- Use non-destructive test credentials and data.
- Confirm the health and API endpoints used by the script are available.
- Agree on duration, virtual users, and pass thresholds before the run.

## Evidence

Record the target, script revision, k6 version, test parameters, summary output, thresholds, and any cleanup. Do not treat one smoke run as a capacity or provider reliability guarantee.
