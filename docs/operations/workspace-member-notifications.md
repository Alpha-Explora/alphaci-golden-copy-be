---
type: "Runbook"
title: "Workspace member notifications"
description: "Deploy and verify durable, recipient-scoped live notifications when a member is added to a workspace."
tags: [notifications, workspaces, operations]
status: draft
sources:
  - id: notification-controller
    resource: "src/modules/platform-ops/notifications/api/notifications.controller.ts"
    title: "Notification API and authenticated stream"
---

# Workspace member notifications

Adding a member grants access immediately and queues `hierarchy.group.member_added` for that recipient in the membership transaction. The notification Inbox retains offline deliveries. Active clients receive updates through `GET /api/v1/notifications/stream` using their existing session cookie.

## Deployment

Apply `supabase/migrations/platform-ops/20261019110735_workspace_member_live_notifications.sql` before starting the new backend. It adds nullable workspace/source-event columns and recipient indexes. The migration is additive and idempotent; older backend code remains compatible.

Deploy the backend before the companion frontend. The frontend also supports the existing HTTP notification endpoint and falls back to periodic reads when streaming is unavailable.

Set `NOTIFICATIONS_ENABLED=true` in the target backend environment, and confirm `/api/v1/capabilities` reports notifications enabled. This existing capability flag defaults to false; a fast relay alone does not enable notifications.

`NOTIFICATION_RELAY_INTERVAL_MS` defaults to 1000. This faster pass claims only notification events; GitHub grant/revoke work retains its existing cadence. Setting this variable to 0 disables the fast pass. `OUTBOX_RELAY_INTERVAL_MS=0` disables both automatic workers. Normal notification delivery targets three seconds with a healthy database and no event backlog.

The `platform.notifications` deployment capability and the recipient's `inAppEnabled` preference apply. Notification data is scoped to the signed-in user, including when they do not yet have a selected workspace. Streams are limited to five per recipient per backend instance, share one one-second reader per recipient, validate the session every 15 seconds, and reconnect through the authentication guards after five minutes.

Configure the ingress to preserve `text/event-stream` responses without buffering. Use the same allowed origins and credentialed session cookies as the existing deployment-log streams. Verify keep-alives reach the browser through the actual deployment ingress.

## Verification

1. Open separate lead and member browser sessions. Add the member and verify one notification appears with the workspace name and an Open workspace link.
2. Verify the Inbox, unread badge, and workspace picker update without a reload. The current valid workspace selection should stay unchanged.
3. Disconnect/reconnect the member and retry the delivery handler. Verify the Inbox persists and the source-event ID prevents duplicate inserts.
4. Confirm another account cannot read or mark the notification. End the recipient session and verify the stream terminates at its next session check.
5. Confirm opt-out and capability-disabled behavior, then test a stream connected to a different backend instance from the event worker.

Observe notification outbox retry/quarantine records and database/stream load. Do not enable a shorter interval for GitHub provisioning to diagnose notification latency.
