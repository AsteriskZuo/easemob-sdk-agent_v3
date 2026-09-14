# Jira Event Forwarding Webhook Format

This document describes the JSON format sent to user-subscribed webhook endpoints.

## Delivery

For every non-self-check Jira issue event, the service sends one HTTP request per active webhook subscription.

```http
POST <subscriber webhook URL>
Content-Type: application/json
```

The request body is generated from the normalized Jira event used by WeCom notifications. It does not include the original Jira raw webhook JSON, raw comment body, Jira user emails, bot secrets, or subscription metadata.

Any `2xx` response is treated as success. Non-`2xx` responses and network errors are treated as delivery failures.

## JSON Schema

```json
{
  "event": "updated",
  "event_label": "更新",
  "event_type": "jira:issue_updated",
  "issue_key": "PROJECT-123",
  "issue_type": "Task",
  "title": "Anonymized issue title",
  "actor": "Actor User",
  "assignee": "Assignee User",
  "reporter": "Reporter User",
  "time": "2026-07-07T10:00:00+08:00",
  "url": "https://jira.example.com/browse/PROJECT-123",
  "changes": [
    "Fix Version: 已修改"
  ]
}
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | string | yes | Compact event name. One of `created`, `updated`, `deleted`, or `event` for unknown Jira event types. |
| `event_label` | string | yes | Chinese display label: `创建`, `更新`, `删除`, or `事件`. |
| `event_type` | string | yes | Normalized Jira event type, such as `jira:issue_created`, `jira:issue_updated`, or `jira:issue_deleted`. |
| `issue_key` | string | yes | Jira issue key. |
| `issue_type` | string | yes | Jira issue type display name. Falls back to issue type id, then `unknown`. |
| `title` | string | yes | Jira issue summary. |
| `actor` | string | yes | User who triggered the Jira event. Uses display name when available, then account/name, then `unknown`. |
| `assignee` | string | yes | Current assignee display name. Uses `unassigned` when the issue is unassigned. |
| `reporter` | string | yes | Reporter display name. Uses `unknown` when unavailable. |
| `time` | string | yes | Event time in RFC3339 format. Uses Jira timestamp when present, otherwise local receive time. |
| `url` | string | no | Jira browse URL when available. This field is omitted when empty. |
| `changes` | array of string | yes | Compact update summaries. Empty for create/delete events unless a future normalizer produces summaries. |

## Event Mapping

| Jira event type | `event` | `event_label` |
| --- | --- | --- |
| `jira:issue_created` | `created` | `创建` |
| `jira:issue_updated` | `updated` | `更新` |
| `jira:issue_deleted` | `deleted` | `删除` |
| other value | `event` | `事件` |

## Change Summaries

`changes` contains short, rendered strings only. It is intended for display and lightweight filtering, not full diff reconstruction.

Current examples:

```json
[
  "Assignee: Alice Example -> Bob Example",
  "Fix Version: 已修改",
  "Comment: Charlie Example新增了评论"
]
```

For comment updates, the service reports who added or modified the comment when Jira provides that user, but it does not include the comment text.

## Examples

### Created Issue

```json
{
  "event": "created",
  "event_label": "创建",
  "event_type": "jira:issue_created",
  "issue_key": "PROJECT-100",
  "issue_type": "New Feature",
  "title": "Add export option to dashboard",
  "actor": "Alice Example",
  "assignee": "unassigned",
  "reporter": "Alice Example",
  "time": "2026-07-07T09:30:00+08:00",
  "url": "https://jira.example.com/browse/PROJECT-100",
  "changes": []
}
```

### Updated Issue

```json
{
  "event": "updated",
  "event_label": "更新",
  "event_type": "jira:issue_updated",
  "issue_key": "PROJECT-101",
  "issue_type": "Task",
  "title": "Improve retry behavior",
  "actor": "Bob Example",
  "assignee": "Bob Example",
  "reporter": "Alice Example",
  "time": "2026-07-07T10:15:30+08:00",
  "url": "https://jira.example.com/browse/PROJECT-101",
  "changes": [
    "Assignee: Alice Example -> Bob Example",
    "Fix Version: 已修改"
  ]
}
```

### Comment Added

```json
{
  "event": "updated",
  "event_label": "更新",
  "event_type": "jira:issue_updated",
  "issue_key": "PROJECT-102",
  "issue_type": "Bug",
  "title": "Login page returns stale session",
  "actor": "Charlie Example",
  "assignee": "Dana Example",
  "reporter": "Alice Example",
  "time": "2026-07-07T11:00:00+08:00",
  "url": "https://jira.example.com/browse/PROJECT-102",
  "changes": [
    "Comment: Charlie Example新增了评论"
  ]
}
```

### Deleted Issue

```json
{
  "event": "deleted",
  "event_label": "删除",
  "event_type": "jira:issue_deleted",
  "issue_key": "PROJECT-103",
  "issue_type": "Improvement",
  "title": "Remove deprecated setting",
  "actor": "Admin Example",
  "assignee": "unassigned",
  "reporter": "Alice Example",
  "time": "2026-07-07T12:20:00+08:00",
  "url": "https://jira.example.com/browse/PROJECT-103",
  "changes": []
}
```

## Compatibility Notes

- Consumers should ignore unknown fields if future versions add fields.
- Consumers should not depend on the order of `changes`.
- Consumers should treat `changes` as human-readable summaries, not stable machine field identifiers.
- Consumers should use `event`, `event_type`, and `issue_key` for routing decisions.
