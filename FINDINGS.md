# OpenClaw Inter-Agent Task System Analysis

## 1. Overview & Purpose
The `openclaw-inter-agent-tasks` (IAT) extension is the modern, authoritative architecture for OpenClaw's workflow coordination. It provides durable, inspectable task routing between multiple agents using typed tasks, dependency tracking, worker routing, and approval gates. 

It registers a full suite of `iat_*` tools, including:
- **Orchestration**: `iat_workflow_create`, `iat_workflow_update`, `iat_workflow_get`, `iat_workflow_list`
- **Task Management**: `iat_task_create`, `iat_task_get`, `iat_task_list`, `iat_task_cancel`, `iat_task_events`
- **Worker Execution**: `iat_task_claim`, `iat_task_complete`, `iat_task_fail`, `iat_task_block`
- **Approvals & Registration**: `iat_approval_request`, `iat_approval_resolve`, `iat_worker_register`, `iat_worker_list`

## 2. How It Works
Unlike the legacy `harness` system, IAT is decoupled from the core filesystem bootstrap logic.
- It calculates its own system root (defaulting to `workspace/projects/nb-proj/system`).
- It manages its own datastore (`IatStore`) and API (`TaskApi`) for managing state independent of generic file/directory context packing.
- It does **not** call `runtime.init()`, meaning it avoids the duplicated index-building overhead seen in the splinter packages.

## 3. Agent Implementation Check (Misconfigurations Found)
While the extension itself is well-designed and serves as the primary workflow engine, there are **critical misconfigurations in how the agents are currently implementing its tools** in `.openclaw/openclaw.json`.

- **`browser-use` Agent**: Correctly configured as a worker. It has `iat_task_claim`, `iat_task_complete`, `iat_task_fail`, `iat_task_block`, etc.
- **`orchestrator` Agent**: Correctly configured as an orchestrator (`iat_workflow_create`, `iat_task_create`, `iat_workflow_update`). However, it lacks `iat_task_list`, `iat_workflow_list`, `iat_task_get`, and `iat_task_events`, which it needs to monitor progress, inspect task details, and read audit history.
- **`main` Agent**: Also set up as an orchestrator, mirroring the `orchestrator` agent's tools with the same gaps.
- **`netbox` Agent (Critical Bug)**: The `netbox` agent is intended to be a specialized **worker** (the "NetBox operational copilot"). However, its tool allowlist in `openclaw.json` is a direct copy-paste of the `main`/`orchestrator` tools (`iat_workflow_create`, `iat_task_create`).
  - **The Issue**: It completely lacks the tools required to actually execute tasks (`iat_task_claim`, `iat_task_complete`, `iat_task_fail`). It literally cannot claim or finish the tasks assigned to it.

## 4. Architectural Findings
- This extension is the **correct, non-redundant coordination plane** alongside `openclaw-harness-core`. IAT handles cross-agent task routing and worker assignment; harness-core handles per-call safety, context injection, and audit. They serve different layers.
- It is properly structured and efficiently scoped.
- A **push-notification system** (`lib/notify.js`) was added after this analysis was originally written. `iat_task_create` fires `notifyWorker` to wake the assigned worker's cron job, and `iat_task_complete`/`fail`/`block` notify the orchestrator back. The `iat_worker_register` tool accepts a `wake_job_id` field to wire this up per worker.

## 5. Resolution
All agent tool allow lists have been updated in `openclaw.json`:
- `netbox`: replaced orchestrator copy-paste with worker tools (`iat_task_list`, `iat_task_get`, `iat_task_claim`, `iat_task_complete`, `iat_task_fail`, `iat_task_block`, `iat_task_events`, `iat_workflow_get`)
- `orchestrator` / `main`: added `iat_task_list`, `iat_workflow_list`, `iat_task_get`, `iat_task_events`, plus approval and worker registry tools (`iat_approval_request`, `iat_approval_resolve`, `iat_worker_register`, `iat_worker_list`)