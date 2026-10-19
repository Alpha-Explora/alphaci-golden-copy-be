---
type: "Runbook"
title: "Workspace member notifications"
description: "Enable and verify durable, recipient-scoped live notifications when a member is added to a workspace."
tags: [notifications, workspaces, operations]
status: draft
sources:
  - id: notification-controller
    resource: "src/modules/platform-ops/notifications/api/notifications.controller.ts"
    title: "Notification API and authenticated stream"
  - id: notification-relay
    resource: "src/modules/platform-ops/application/notification-relay.worker.ts"
    title: "Notification relay timer"
---

# Workspace member notifications

Adding a member grants access immediately and queues `hierarchy.group.member_added` for that recipient in the membership transaction. The notification Inbox keeps deliveries made while the recipient is offline. Active clients receive updates through `GET /api/v1/notifications/stream`, authenticated with their session cookie. The frontend falls back to periodic reads when streaming is unavailable.

## Enable

1. The schema comes from `supabase/migrations/platform-ops/20261019110735_workspace_member_live_notifications.sql`, applied with the rest of the tree ([database migrations](../runbooks/runbook-database-migrations.md)).
2. Set `NOTIFICATIONS_ENABLED=true` on the backend. It defaults to false. On the self-hosted appliance, add it to `alphaci.env` and run `docker compose up -d`. Confirm `/api/v1/capabilities` reports notifications enabled.
3. Leave the relay timers on. `NOTIFICATION_RELAY_INTERVAL_MS` (default 1000, clamped to 250–60000) runs a pass that claims only notification events; `0` turns that pass off. `OUTBOX_RELAY_INTERVAL_MS=0` turns off both automatic workers. See the [outbox relay runbook](../runbooks/runbook-outbox-relay.md).
4. The ingress must pass `text/event-stream` responses through without buffering. The appliance's Caddy does. Use the same allowed origins and credentialed cookies as the deployment-log streams.

Delivery targets three seconds with a healthy database and no backlog. The `platform.notifications` capability and the recipient's `inAppEnabled` preference apply. Data is scoped to the signed-in user. Each backend instance allows five streams per recipient, shares one one-second reader per recipient, checks the session and sends a keep-alive every 15 seconds, and ends a stream after five minutes so it reconnects through the authentication guards.

## Verification

1. Open separate lead and member sessions. Add the member and check that one notification appears with the workspace name and an Open workspace link.
2. Check that the Inbox, unread badge, and workspace picker update without a reload, and that the member's current workspace selection stays.
3. Disconnect and reconnect the member, and retry the delivery handler. The Inbox keeps the notification, and the source-event ID prevents a duplicate.
4. Confirm another account cannot read or mark the notification. End the recipient's session and check that the stream ends.
5. Confirm opt-out and capability-disabled behavior. With several backend instances, test a stream on a different instance from the worker that delivered the event.

Watch notification outbox retries and quarantines, and database and stream load. Do not shorten the GitHub provisioning interval to diagnose notification latency.
