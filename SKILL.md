# Inter-Agent Task System (IAT) Skill

Manages durable, inspectable multi-agent workflows. Provides typed tasks, worker routing, dependency tracking, approval gates, retries, and a push-notification wakeup system.

All tools use the `iat_` prefix. State is persisted to the filesystem under `workspace/projects/nb-proj/system/`.

---

## Architecture

IAT is the **coordination plane** — it routes work between agents. It does not enforce policy or inject context (that is harness-core's role).

Two distinct roles use different tool subsets:

| Role | Agents | Tools |
|------|--------|-------|
| **Orchestrator** | `main`, `orchestrator` | `iat_workflow_*`, `iat_task_create`, `iat_task_list`, `iat_task_get`, `iat_task_events`, `iat_approval_*`, `iat_worker_*` |
| **Worker** | `netbox`, `browser-use` | `iat_task_list`, `iat_task_get`, `iat_task_claim`, `iat_task_complete`, `iat_task_fail`, `iat_task_block`, `iat_task_events`, `iat_workflow_get` |

---

## Workflow lifecycle

```
iat_workflow_create   →  received
                            ↓
iat_workflow_update   →  planning → in_progress → synthesizing
                            ↓
                       awaiting_human_approval
                            ↓
                       completed / failed / cancelled
```

A workflow is the top-level coordination unit for a user request. Create one per request, then attach tasks to it.

---

## Task lifecycle

```
iat_task_create     →  open
                          ↓
iat_task_claim      →  in_progress
                          ↓
iat_task_complete   →  completed
iat_task_fail       →  failed  (retryable → back to open if attempts remain)
iat_task_block      →  blocked
iat_task_cancel     →  cancelled
```

If a task is failed with `retryable: true` and attempts remain (`attempt_count < max_attempts`), it resets to `open` automatically.

---

## Tool reference

### Workflow tools

#### `iat_workflow_create`
Create a workflow for a user request. Call once per top-level request before creating any tasks.

```json
{
  "title": "Audit rack density at ny01",
  "description": "Collect device inventory and flag racks over 80% capacity",
  "user_request": "Can you check the rack density at our New York site?",
  "created_by": "orchestrator"
}
```

Returns `{ workflow_id, title, status, created_at }`. Store `workflow_id` — all tasks reference it.

---

#### `iat_workflow_update`
Advance a workflow's status.

```json
{
  "workflow_id": "wf_abc123",
  "status": "in_progress"
}
```

```json
{
  "workflow_id": "wf_abc123",
  "status": "completed",
  "outcome_summary": "Identified 3 racks over 80% capacity. Report written to workspace.",
  "artifact_refs": ["workspace/reports/rack-density-ny01.md"]
}
```

Valid statuses: `received`, `planning`, `in_progress`, `synthesizing`, `awaiting_human_approval`, `completed`, `failed`, `cancelled`.

---

#### `iat_workflow_get`
Get full workflow details including all tasks and status breakdown.

```json
{ "workflow_id": "wf_abc123" }
```

Use to poll progress, check which tasks are blocking, or synthesize final results.

---

#### `iat_workflow_list`
List workflows, optionally filtered by status.

```json
{ "status": "in_progress" }
```

```json
{}
```

---

### Task tools

#### `iat_task_create`
Create a task within a workflow and assign it to a worker. This is how orchestrators delegate domain work.

```json
{
  "workflow_id": "wf_abc123",
  "task_type": "netbox.rack_density_audit",
  "title": "Get rack inventory for ny01",
  "description": "Query all racks at site ny01 and return device counts per rack",
  "assigned_worker": "netbox-agent",
  "payload": {
    "site": "ny01",
    "include_empty_units": true
  },
  "priority": "normal",
  "risk_level": "read_only"
}
```

**Key fields:**

| Field | Purpose |
|-------|---------|
| `task_type` | Dot-namespaced type contract: `netbox.analyze_device`, `browser.find_skus`, `tickets.create_issue` |
| `assigned_worker` | Worker ID from the registry: `netbox-agent`, `browser-agent`, `orchestrator` |
| `risk_level` | `read_only`, `advisory`, `external_write`, `infrastructure_change` |
| `depends_on` | Array of `task_id`s that must be completed first |
| `approval_required` | If true, task pauses at `awaiting_approval` before a worker can claim it |
| `max_attempts` | Retry limit (default: 3) |
| `idempotency_key` | Prevents duplicate execution on retries |

Creating a task automatically fires a push notification to wake the assigned worker's cron job (if registered with a `wake_job_id`).

---

#### `iat_task_list`
List tasks with optional filters.

```json
{ "workflow_id": "wf_abc123" }
```

```json
{ "assigned_worker": "netbox-agent", "status": "open" }
```

```json
{ "status": "blocked" }
```

Workers should call this on startup to find open tasks assigned to them.

---

#### `iat_task_get`
Get full details of a single task: status, payload, result, error, attempt count.

```json
{ "task_id": "task_xyz789" }
```

---

#### `iat_task_claim`
Claim an open task for execution. Sets status to `in_progress`. Fails if dependencies are not yet completed.

```json
{
  "task_id": "task_xyz789",
  "worker_id": "netbox-agent"
}
```

Always call this before doing any work — it prevents two workers from claiming the same task.

---

#### `iat_task_complete`
Mark a task as completed with structured results.

```json
{
  "task_id": "task_xyz789",
  "result": {
    "racks_audited": 12,
    "over_80_pct": ["rack-a3", "rack-b1", "rack-c7"],
    "max_density_rack": "rack-a3",
    "max_density_pct": 94
  },
  "completion_summary": "Audited 12 racks at ny01. 3 racks are over 80% capacity.",
  "artifact_refs": ["workspace/data/ny01-rack-audit.json"]
}
```

Completing a task fires a push notification to the orchestrator.

---

#### `iat_task_fail`
Mark a task as failed.

```json
{
  "task_id": "task_xyz789",
  "error_code": "NETBOX_UNAVAILABLE",
  "error_message": "NetBox returned 503 after 3 retries",
  "retryable": true
}
```

If `retryable: true` and `attempt_count < max_attempts`, the task resets to `open` for retry. Otherwise it fails terminally. Always fires a push notification to the orchestrator.

---

#### `iat_task_block`
Mark a task as blocked due to missing data or external conditions.

```json
{
  "task_id": "task_xyz789",
  "blocking_reason": "Site 'ny01' does not exist in NetBox — cannot proceed without a valid site slug"
}
```

Use when the task cannot proceed but is not a permanent failure. The orchestrator is notified automatically.

---

#### `iat_task_cancel`
Cancel a task that is no longer needed.

```json
{
  "task_id": "task_xyz789",
  "reason": "Superseded by updated workflow scope",
  "cancelled_by": "orchestrator"
}
```

---

#### `iat_task_events`
Get the full audit event log for a task.

```json
{ "task_id": "task_xyz789" }
```

Shows every status transition, who triggered it, and when. Useful for debugging stuck or failed tasks.

---

### Approval tools

#### `iat_approval_request`
Pause a task and request human approval before proceeding. Use for `infrastructure_change` risk-level tasks or any action with external effects.

```json
{
  "task_id": "task_xyz789",
  "rationale": "This will update the status of 47 devices in NetBox to 'decommissioned'",
  "proposed_action": "PATCH dcim.devices status=decommissioned for all devices in rack-a3",
  "requested_by": "netbox-agent"
}
```

Sets task status to `awaiting_approval`. Returns an `approval_id` the operator uses to resolve.

---

#### `iat_approval_resolve`
Approve or deny a pending approval request.

```json
{
  "approval_id": "appr_def456",
  "decision": "approved",
  "resolved_by": "marteclaw",
  "resolution_note": "Confirmed with site team — proceed"
}
```

`approved` → task returns to `open` for claiming. `denied` → task fails terminally.

---

### Worker registry tools

#### `iat_worker_register`
Register or update a worker in the registry. Call when bringing a new agent online or updating its capabilities.

```json
{
  "worker_id": "netbox-agent",
  "display_name": "NetBox Operational Copilot",
  "worker_type": "service-agent",
  "supported_task_types": ["netbox.", "infra."],
  "enabled": true,
  "max_concurrency": 1,
  "wake_job_id": "cron_job_id_here"
}
```

`wake_job_id` is the OpenClaw cron job ID to fire when this worker has new tasks (IAT push notification). If set, workers are woken automatically when tasks are assigned to them.

---

#### `iat_worker_list`
List all registered workers and their capabilities.

```json
{}
```

---

## Common workflows

### Orchestrator: handle a new user request

```
1. iat_workflow_create          → get workflow_id
2. iat_workflow_update          → status: planning
3. iat_task_create              → assign work to workers
4. iat_workflow_update          → status: in_progress
5. [wait / poll]
6. iat_workflow_get             → check task statuses
7. iat_task_get                 → inspect specific task results
8. iat_workflow_update          → status: synthesizing / completed
```

### Worker: process assigned tasks on startup

```
1. iat_task_list  assigned_worker=<self>, status=open   → find pending work
2. iat_task_claim task_id=<id>, worker_id=<self>        → lock the task
3. [do the work]
4. iat_task_complete / iat_task_fail / iat_task_block   → report outcome
```

### Orchestrator: monitor a workflow in progress

```
1. iat_workflow_get workflow_id=<id>      → overview with task breakdown
2. iat_task_list    workflow_id=<id>      → full task list
3. iat_task_get     task_id=<blocked>     → inspect a blocked task
4. iat_task_events  task_id=<failed>      → read failure history
```

### Worker: request approval before a destructive action

```
1. iat_approval_request  task_id=<id>, rationale=..., proposed_action=...
2. [wait for operator to resolve]
3. iat_task_list  status=open   → task reappears here after approval
4. iat_task_claim               → re-claim and proceed
```

---

## Task type naming convention

Use dot-namespaced types matching the responsible worker's domain:

| Pattern | Examples |
|---------|---------|
| `netbox.<action>` | `netbox.rack_density_audit`, `netbox.device_create`, `netbox.prefix_allocate` |
| `browser.<action>` | `browser.find_skus`, `browser.scrape_vendor_pricing`, `browser.submit_form` |
| `infra.<action>` | `infra.config_push`, `infra.validate_connectivity` |
| `tickets.<action>` | `tickets.create_issue`, `tickets.update_status` |

Workers filter their task queue by `task_type` prefix using `iat_task_list`.

---

## Tips

- Always create a workflow before tasks — the `workflow_id` is the coordination anchor for the entire request.
- Workers should call `iat_task_list` on startup and after being woken by the push notification system to catch any queued tasks.
- Use `depends_on` to express sequencing — a dependent task stays `open` but cannot be claimed until its dependencies are `completed`.
- Set `idempotency_key` on tasks that could be created more than once (e.g. retried orchestration logic) to prevent duplicate execution.
- Use `risk_level: "infrastructure_change"` + `approval_required: true` for any task that modifies production infrastructure.
- `iat_task_events` is the primary debugging tool — it shows the full history of what happened to a task and when.
