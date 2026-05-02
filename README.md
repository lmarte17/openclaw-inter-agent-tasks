# OpenClaw Inter-Agent Task System

Durable, inspectable task and workflow coordination for multi-agent OpenClaw systems.

This extension is the coordination plane. It routes work between agents using typed tasks, worker assignment, dependencies, approval gates, retries, audit events, and optional worker wakeups.

## What it does

- Creates top-level workflows for user requests.
- Creates typed tasks inside workflows.
- Assigns tasks to named workers.
- Tracks task dependencies and retry state.
- Supports worker claim, completion, failure, blocking, and cancellation flows.
- Records task and workflow events for later inspection.
- Supports approval requests and worker registration.
- Can notify worker cron jobs when tasks are created or resolved.

## Tool groups

All tools use the `iat_` prefix.

- Workflows: `iat_workflow_create`, `iat_workflow_update`, `iat_workflow_get`, `iat_workflow_list`
- Tasks: `iat_task_create`, `iat_task_get`, `iat_task_list`, `iat_task_cancel`, `iat_task_events`
- Worker execution: `iat_task_claim`, `iat_task_complete`, `iat_task_fail`, `iat_task_block`
- Approvals: `iat_approval_request`, `iat_approval_resolve`
- Workers: `iat_worker_register`, `iat_worker_list`

See [SKILL.md](./SKILL.md) for full schemas and examples.

## Typical flow

```text
iat_workflow_create
  -> iat_task_create
  -> worker calls iat_task_claim
  -> worker performs domain work
  -> worker calls iat_task_complete, iat_task_fail, or iat_task_block
  -> orchestrator inspects workflow and closes it
```

## Configuration

The plugin accepts:

- `projectPath`: relative path from the OpenClaw home to the project root. Defaults to `workspace/projects/nb-proj`.
- `debug`: enables verbose logging.

The system root resolves to:

```text
<OPENCLAW_HOME>/<projectPath>/system
```

If `OPENCLAW_HOME` is not set, the plugin falls back to the OpenClaw runtime home or `~/.openclaw`.

## State

IAT writes durable workflow, task, approval, worker, and audit records under the resolved `system` directory. This makes the coordination layer inspectable outside a single agent session.

