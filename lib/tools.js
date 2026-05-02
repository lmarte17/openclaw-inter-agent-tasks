import { notifyWorker } from "./notify.js";

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function taskSummaryLine(t) {
  return `${t.task_id}  [${t.status.padEnd(18)}]  ${t.task_type.padEnd(32)}  → ${(t.assigned_worker || "unassigned").padEnd(16)}  "${t.title}"`;
}

async function getWakeJobId(store, workerId) {
  if (!workerId) return null;
  try {
    const registry = await store.getWorkerRegistry();
    const worker = registry.workers.find((w) => w.worker_id === workerId);
    return worker?.wake_job_id || null;
  } catch {
    return null;
  }
}

function fireNotify(store, workerId, debug) {
  // Fire-and-forget: does not delay tool response, never throws
  getWakeJobId(store, workerId)
    .then((jobId) => jobId && notifyWorker(jobId, { debug }))
    .catch(() => {});
}

export function registerTools(api, taskApi, store, { debug = false } = {}) {
  // ── Workflow tools ─────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "iat_workflow_create",
      label: "IAT: Create Workflow",
      description:
        "Create a new inter-agent task workflow. Call this once per user request to establish the top-level coordination unit. Returns a workflow_id that all subsequent tasks should reference.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Short human-readable title for the workflow" },
          description: { type: "string", description: "What this workflow is trying to accomplish" },
          user_request: { type: "string", description: "The original user request, verbatim or normalized" },
          normalized_input: {
            type: "object",
            description: "Structured normalized inputs derived from the user request"
          },
          created_by: { type: "string", description: "Agent ID creating the workflow (default: orchestrator)" }
        },
        required: ["title"]
      },
      async execute(_id, params) {
        const wf = await taskApi.createWorkflow(params);
        return textResult(`Created workflow ${wf.workflow_id}: "${wf.title}"`, wf);
      }
    },
    { name: "iat_workflow_create" }
  );

  api.registerTool(
    {
      name: "iat_workflow_update",
      label: "IAT: Update Workflow",
      description:
        "Update workflow status. Use to move the workflow through its lifecycle. Valid statuses: received, planning, in_progress, synthesizing, awaiting_human_approval, completed, failed, cancelled.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          workflow_id: { type: "string" },
          status: { type: "string" },
          outcome_summary: { type: "string", description: "Final summary when completing or failing" },
          artifact_refs: {
            type: "array",
            items: { type: "string" },
            description: "Paths to output artifacts produced by this workflow"
          }
        },
        required: ["workflow_id", "status"]
      },
      async execute(_id, params) {
        const wf = await taskApi.updateWorkflowStatus(params.workflow_id, params.status, params);
        return textResult(`Workflow ${wf.workflow_id} status → "${wf.status}"`, wf);
      }
    },
    { name: "iat_workflow_update" }
  );

  api.registerTool(
    {
      name: "iat_workflow_get",
      label: "IAT: Get Workflow",
      description:
        "Get workflow details including all tasks and a status breakdown. Use to check progress, synthesize results, or decide next steps.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          workflow_id: { type: "string" }
        },
        required: ["workflow_id"]
      },
      async execute(_id, params) {
        const result = await taskApi.getWorkflowStatus(params.workflow_id);
        const lines = [
          `Workflow: ${result.workflow.workflow_id}`,
          `  Title:   ${result.workflow.title}`,
          `  Status:  ${result.workflow.status}`,
          `  Created: ${result.workflow.created_at.slice(0, 19)}`,
          `  Tasks:   ${result.task_count} total`
        ];
        if (Object.keys(result.tasks_by_status).length) {
          for (const [status, count] of Object.entries(result.tasks_by_status)) {
            lines.push(`    ${status}: ${count}`);
          }
        }
        if (result.tasks.length) {
          lines.push("", "Tasks:");
          for (const t of result.tasks) {
            lines.push(`  ${taskSummaryLine(t)}`);
          }
        }
        return textResult(lines.join("\n"), result);
      }
    },
    { name: "iat_workflow_get" }
  );

  api.registerTool(
    {
      name: "iat_workflow_list",
      label: "IAT: List Workflows",
      description: "List all workflows, optionally filtered by status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            description:
              "Filter by status: received, planning, in_progress, synthesizing, awaiting_human_approval, completed, failed, cancelled"
          }
        }
      },
      async execute(_id, params) {
        const workflows = await store.listWorkflows(params.status ? { status: params.status } : {});
        const lines = workflows.map(
          (wf) =>
            `${wf.workflow_id}  [${wf.status.padEnd(24)}]  ${wf.created_at.slice(0, 10)}  "${wf.title}"`
        );
        const text = lines.length ? lines.join("\n") : "No workflows found.";
        return textResult(text, { workflows, count: workflows.length });
      }
    },
    { name: "iat_workflow_list" }
  );

  // ── Task tools ─────────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "iat_task_create",
      label: "IAT: Create Task",
      description:
        "Create a task within a workflow and assign it to a service agent worker. This is how the orchestrator delegates domain work.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          workflow_id: { type: "string" },
          task_type: {
            type: "string",
            description:
              "Dot-namespaced type: netbox.analyze_device, browser.find_skus, tickets.create_issue, etc."
          },
          title: { type: "string" },
          description: { type: "string" },
          payload: {
            type: "object",
            description: "Structured input matching the task type contract"
          },
          assigned_worker: {
            type: "string",
            description: "Worker ID: orchestrator, netbox-agent, browser-agent, tickets-agent"
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "critical"],
            description: "Default: normal"
          },
          parent_task_id: {
            type: "string",
            description: "Parent task ID for sub-task hierarchies"
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs that must be completed before this task can be claimed"
          },
          approval_required: {
            type: "boolean",
            description: "Whether this task requires human approval before execution"
          },
          risk_level: {
            type: "string",
            enum: ["read_only", "advisory", "external_write", "infrastructure_change"],
            description: "Default: read_only"
          },
          max_attempts: {
            type: "number",
            description: "Maximum retry attempts. Default: 3"
          },
          idempotency_key: {
            type: "string",
            description: "Optional key to prevent duplicate execution"
          },
          created_by: { type: "string" }
        },
        required: ["workflow_id", "task_type", "title"]
      },
      async execute(_id, params) {
        const task = await taskApi.createTask(params);
        if (task.assigned_worker) fireNotify(store, task.assigned_worker, debug);
        return textResult(
          `Created task ${task.task_id}\n  type:   ${task.task_type}\n  worker: ${task.assigned_worker || "unassigned"}\n  risk:   ${task.risk_level}`,
          task
        );
      }
    },
    { name: "iat_task_create" }
  );

  api.registerTool(
    {
      name: "iat_task_claim",
      label: "IAT: Claim Task",
      description:
        "Claim an open task for execution. Sets status to in_progress and records the worker. Will fail if dependencies are not yet completed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          worker_id: { type: "string", description: "ID of the worker claiming this task" }
        },
        required: ["task_id", "worker_id"]
      },
      async execute(_id, params) {
        const task = await taskApi.claimTask(params.task_id, params.worker_id);
        return textResult(
          `Task ${task.task_id} claimed by ${params.worker_id} (attempt ${task.attempt_count}/${task.max_attempts})`,
          task
        );
      }
    },
    { name: "iat_task_claim" }
  );

  api.registerTool(
    {
      name: "iat_task_complete",
      label: "IAT: Complete Task",
      description:
        "Mark a task as completed with a structured result. The result should match the task type's output contract.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          result: {
            type: "object",
            description: "Structured output matching the task type contract (e.g. NetBox findings, vendor candidates)"
          },
          completion_summary: {
            type: "string",
            description: "Human-readable summary of what was done and found"
          },
          artifact_refs: {
            type: "array",
            items: { type: "string" },
            description: "Paths to artifacts produced (JSON outputs, diffs, reports)"
          }
        },
        required: ["task_id"]
      },
      async execute(_id, params) {
        const task = await taskApi.completeTask(params.task_id, params);
        fireNotify(store, "orchestrator", debug);
        return textResult(`Task ${task.task_id} completed.`, task);
      }
    },
    { name: "iat_task_complete" }
  );

  api.registerTool(
    {
      name: "iat_task_fail",
      label: "IAT: Fail Task",
      description:
        "Mark a task as failed. If retryable=true and attempts remain, the task resets to open for retry. Otherwise it becomes terminally failed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          error_code: { type: "string", description: "Machine-readable error code, e.g. NETBOX_UNAVAILABLE" },
          error_message: { type: "string", description: "Human-readable description of the failure" },
          retryable: {
            type: "boolean",
            description: "Whether the failure is transient and safe to retry. Default: false"
          }
        },
        required: ["task_id", "error_message"]
      },
      async execute(_id, params) {
        const task = await taskApi.failTask(params.task_id, params);
        fireNotify(store, "orchestrator", debug);
        const msg =
          task.status === "open"
            ? `Task ${task.task_id} failed (attempt ${task.attempt_count}/${task.max_attempts}) — reset to open for retry.`
            : `Task ${task.task_id} failed terminally after ${task.attempt_count} attempt(s).`;
        return textResult(msg, task);
      }
    },
    { name: "iat_task_fail" }
  );

  api.registerTool(
    {
      name: "iat_task_block",
      label: "IAT: Block Task",
      description:
        "Mark a task as blocked due to missing data, credentials, or external conditions. Use when a task cannot proceed but is not a permanent failure.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          blocking_reason: {
            type: "string",
            description: "Specific explanation of what is missing or preventing progress"
          }
        },
        required: ["task_id", "blocking_reason"]
      },
      async execute(_id, params) {
        const task = await taskApi.blockTask(params.task_id, params);
        fireNotify(store, "orchestrator", debug);
        return textResult(`Task ${task.task_id} blocked: ${params.blocking_reason}`, task);
      }
    },
    { name: "iat_task_block" }
  );

  api.registerTool(
    {
      name: "iat_task_cancel",
      label: "IAT: Cancel Task",
      description: "Cancel a task. Use when a task is no longer needed due to workflow changes or superseding decisions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          reason: { type: "string" },
          cancelled_by: { type: "string" }
        },
        required: ["task_id"]
      },
      async execute(_id, params) {
        const task = await taskApi.cancelTask(params.task_id, params);
        return textResult(`Task ${task.task_id} cancelled.`, task);
      }
    },
    { name: "iat_task_cancel" }
  );

  api.registerTool(
    {
      name: "iat_task_get",
      label: "IAT: Get Task",
      description: "Get full task details: status, payload, result, error, and metadata.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" }
        },
        required: ["task_id"]
      },
      async execute(_id, params) {
        const task = await store.getTask(params.task_id);
        if (!task) return textResult(`Task not found: ${params.task_id}`, {});
        const lines = [
          `Task: ${task.task_id}`,
          `  Title:    ${task.title}`,
          `  Type:     ${task.task_type}`,
          `  Status:   ${task.status}`,
          `  Worker:   ${task.assigned_worker || "unassigned"}`,
          `  Attempts: ${task.attempt_count}/${task.max_attempts}`,
          `  Risk:     ${task.risk_level}`
        ];
        if (task.blocking_reason) lines.push(`  Blocked:  ${task.blocking_reason}`);
        if (task.error_message) lines.push(`  Error:    [${task.error_code}] ${task.error_message}`);
        if (task.completion_summary) lines.push(`  Summary:  ${task.completion_summary}`);
        return textResult(lines.join("\n"), task);
      }
    },
    { name: "iat_task_get" }
  );

  api.registerTool(
    {
      name: "iat_task_list",
      label: "IAT: List Tasks",
      description:
        "List tasks with optional filters. Useful for checking workflow progress or finding tasks assigned to a specific worker.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          workflow_id: { type: "string" },
          status: {
            type: "string",
            description: "open, in_progress, blocked, awaiting_approval, completed, failed, cancelled"
          },
          assigned_worker: { type: "string" },
          task_type: { type: "string" }
        }
      },
      async execute(_id, params) {
        const filter = {};
        if (params.workflow_id) filter.workflow_id = params.workflow_id;
        if (params.status) filter.status = params.status;
        if (params.assigned_worker) filter.assigned_worker = params.assigned_worker;
        if (params.task_type) filter.task_type = params.task_type;
        const tasks = await store.listTasks(filter);
        const lines = tasks.map(taskSummaryLine);
        const text = lines.length ? lines.join("\n") : "No tasks found.";
        return textResult(text, { tasks, count: tasks.length });
      }
    },
    { name: "iat_task_list" }
  );

  api.registerTool(
    {
      name: "iat_task_events",
      label: "IAT: Task Events",
      description: "Get the audit event log for a task. Shows the full lifecycle history.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" }
        },
        required: ["task_id"]
      },
      async execute(_id, params) {
        const events = await store.getEvents(params.task_id);
        const lines = events.map(
          (e) =>
            `${e.timestamp.slice(0, 19)}  ${e.event_type.padEnd(20)}  ${e.actor_type}:${e.actor_id}`
        );
        const text = lines.length ? lines.join("\n") : "No events found.";
        return textResult(text, { events, count: events.length });
      }
    },
    { name: "iat_task_events" }
  );

  // ── Approval tools ────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "iat_approval_request",
      label: "IAT: Request Approval",
      description:
        "Pause a task and request human approval before proceeding. Use for infrastructure changes or any action with external effects.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string" },
          rationale: {
            type: "string",
            description: "Why approval is needed — what risk or consequence is involved"
          },
          proposed_action: {
            type: "string",
            description: "Exactly what will happen if approved"
          },
          requested_by: { type: "string" }
        },
        required: ["task_id", "rationale", "proposed_action"]
      },
      async execute(_id, params) {
        const { task, approval } = await taskApi.requestApproval(params.task_id, params);
        return textResult(
          [
            `Task ${task.task_id} paused — awaiting approval.`,
            `Approval ID: ${approval.approval_id}`,
            `Proposed:    ${params.proposed_action}`,
            `Rationale:   ${params.rationale}`
          ].join("\n"),
          { task, approval }
        );
      }
    },
    { name: "iat_approval_request" }
  );

  api.registerTool(
    {
      name: "iat_approval_resolve",
      label: "IAT: Resolve Approval",
      description:
        'Approve or deny a pending approval request. "approved" resumes the task; "denied" fails it.',
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          approval_id: { type: "string" },
          decision: { type: "string", enum: ["approved", "denied"] },
          resolved_by: { type: "string", description: "Who made the decision (e.g. human operator name)" },
          resolution_note: { type: "string", description: "Optional explanation or conditions" }
        },
        required: ["approval_id", "decision"]
      },
      async execute(_id, params) {
        const { task, approval } = await taskApi.resolveApproval(params.approval_id, params);
        const taskNote = task ? ` Task ${task.task_id} is now ${task.status}.` : "";
        return textResult(
          `Approval ${approval.approval_id} resolved: ${approval.status}.${taskNote}`,
          { task, approval }
        );
      }
    },
    { name: "iat_approval_resolve" }
  );

  // ── Worker tools ──────────────────────────────────────────────────────────

  api.registerTool(
    {
      name: "iat_worker_list",
      label: "IAT: List Workers",
      description: "List all registered workers and their capabilities.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      async execute() {
        const registry = await store.getWorkerRegistry();
        const lines = registry.workers.map(
          (w) =>
            `${w.worker_id.padEnd(20)}  [${w.enabled ? "enabled " : "disabled"}]  ${w.display_name}`
        );
        return textResult(
          `${registry.workers.length} workers registered:\n${lines.join("\n")}`,
          registry
        );
      }
    },
    { name: "iat_worker_list" }
  );

  api.registerTool(
    {
      name: "iat_worker_register",
      label: "IAT: Register Worker",
      description: "Register or update a worker in the registry. Use when bringing a new service agent online.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          worker_id: { type: "string" },
          display_name: { type: "string" },
          worker_type: { type: "string", description: "e.g. service-agent, orchestrator" },
          supported_task_types: {
            type: "array",
            items: { type: "string" },
            description: "Task type prefixes this worker handles, e.g. [netbox., infra.]"
          },
          enabled: { type: "boolean" },
          max_concurrency: { type: "number" },
          default_timeout_sec: { type: "number" },
          wake_job_id: {
            type: "string",
            description: "OpenClaw cron job ID to fire when this worker has new tasks (IAT push notification)"
          },
          notes: { type: "string" }
        },
        required: ["worker_id", "display_name"]
      },
      async execute(_id, params) {
        const registry = await store.getWorkerRegistry();
        const others = registry.workers.filter((w) => w.worker_id !== params.worker_id);
        const existing = registry.workers.find((w) => w.worker_id === params.worker_id);
        const worker = {
          worker_id: params.worker_id,
          display_name: params.display_name,
          worker_type: params.worker_type || "service-agent",
          supported_task_types: params.supported_task_types || [],
          enabled: params.enabled !== false,
          max_concurrency: params.max_concurrency || 1,
          default_timeout_sec: params.default_timeout_sec || 300,
          // Preserve wake_job_id from existing record unless explicitly overridden
          ...(params.wake_job_id != null
            ? { wake_job_id: params.wake_job_id }
            : existing?.wake_job_id
            ? { wake_job_id: existing.wake_job_id }
            : {}),
          ...(params.notes ? { notes: params.notes } : {})
        };
        await store.saveWorkerRegistry({ ...registry, workers: [...others, worker] });
        return textResult(`Worker "${params.worker_id}" registered.`, worker);
      }
    },
    { name: "iat_worker_register" }
  );
}
