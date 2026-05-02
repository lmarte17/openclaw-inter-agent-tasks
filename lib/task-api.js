import { generateId, nowIso } from "./store.js";

const TASK_STATES = new Set(["open", "in_progress", "blocked", "awaiting_approval", "completed", "failed", "cancelled"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled"]);
const WORKFLOW_STATES = new Set([
  "received", "planning", "in_progress", "synthesizing",
  "awaiting_human_approval", "completed", "failed", "cancelled"
]);
const TERMINAL_WORKFLOW_STATES = new Set(["completed", "failed", "cancelled"]);

export class TaskApi {
  constructor(store) {
    this.store = store;
  }

  // ── Workflow ──────────────────────────────────────────────────────────────

  async createWorkflow({ title, description, created_by, user_request, normalized_input } = {}) {
    if (!title) throw new Error("title is required");
    const workflow = {
      schema_version: "1.0",
      workflow_id: generateId("wf"),
      title,
      description: description || "",
      status: "received",
      created_by: created_by || "orchestrator",
      user_request: user_request || "",
      normalized_input: normalized_input || {},
      task_ids: [],
      created_at: nowIso(),
      updated_at: nowIso(),
      completed_at: null,
      outcome_summary: null,
      artifact_refs: []
    };
    await this.store.saveWorkflow(workflow);
    await this._emitWorkflowEvent(workflow, "created", { title: workflow.title });
    return workflow;
  }

  async updateWorkflowStatus(workflowId, status, { outcome_summary, artifact_refs } = {}) {
    if (!WORKFLOW_STATES.has(status)) {
      throw new Error(`Invalid workflow status: "${status}". Valid: ${[...WORKFLOW_STATES].join(", ")}`);
    }
    const workflow = await this.store.getWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    const isTerminal = TERMINAL_WORKFLOW_STATES.has(status);
    const next = {
      ...workflow,
      status,
      updated_at: nowIso(),
      ...(outcome_summary !== undefined ? { outcome_summary } : {}),
      ...(artifact_refs !== undefined ? { artifact_refs } : {}),
      ...(isTerminal ? { completed_at: nowIso() } : {})
    };
    await this.store.saveWorkflow(next);
    await this._emitWorkflowEvent(next, "status_changed", { from: workflow.status, to: status });
    return next;
  }

  async getWorkflowStatus(workflowId) {
    const workflow = await this.store.getWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    const tasks = await this.store.listTasks({ workflow_id: workflowId });
    const tasksByStatus = {};
    for (const task of tasks) {
      tasksByStatus[task.status] = (tasksByStatus[task.status] || 0) + 1;
    }
    return {
      workflow,
      task_count: tasks.length,
      tasks_by_status: tasksByStatus,
      tasks: tasks.map((t) => ({
        task_id: t.task_id,
        task_type: t.task_type,
        title: t.title,
        status: t.status,
        assigned_worker: t.assigned_worker,
        attempt_count: t.attempt_count,
        created_at: t.created_at,
        updated_at: t.updated_at
      }))
    };
  }

  // ── Task ──────────────────────────────────────────────────────────────────

  async createTask({
    workflow_id,
    task_type,
    title,
    description,
    payload,
    assigned_worker,
    priority = "normal",
    parent_task_id = null,
    depends_on = [],
    approval_required = false,
    risk_level = "read_only",
    max_attempts = 3,
    idempotency_key = null,
    created_by = "orchestrator"
  } = {}) {
    if (!workflow_id) throw new Error("workflow_id is required");
    if (!task_type) throw new Error("task_type is required");
    if (!title) throw new Error("title is required");

    // Resolve root_task_id from parent chain
    let root_task_id = null;
    if (parent_task_id) {
      const parent = await this.store.getTask(parent_task_id);
      if (!parent) throw new Error(`parent_task_id not found: ${parent_task_id}`);
      root_task_id = parent.root_task_id || parent_task_id;
    }

    const task = {
      schema_version: "1.0",
      task_id: generateId("task"),
      workflow_id,
      task_type,
      title,
      description: description || "",
      payload: payload || {},
      status: "open",
      priority: priority || "normal",
      parent_task_id,
      root_task_id,
      assigned_worker: assigned_worker || null,
      approval_required: Boolean(approval_required),
      approval_state: null,
      risk_level: risk_level || "read_only",
      idempotency_key: idempotency_key || null,
      attempt_count: 0,
      max_attempts: max_attempts || 3,
      created_by: created_by || "orchestrator",
      created_at: nowIso(),
      updated_at: nowIso(),
      claimed_at: null,
      claimed_by: null,
      started_at: null,
      completed_at: null,
      depends_on: Array.isArray(depends_on) ? depends_on : [],
      result: null,
      error_code: null,
      error_message: null,
      artifact_refs: [],
      completion_summary: null,
      blocking_reason: null
    };

    await this.store.saveTask(task);

    // Register task_id in workflow
    const workflow = await this.store.getWorkflow(workflow_id);
    if (workflow) {
      await this.store.saveWorkflow({
        ...workflow,
        task_ids: [...(workflow.task_ids || []), task.task_id],
        updated_at: nowIso()
      });
    }

    await this._emitTaskEvent(task, "created", "system", created_by, {
      task_type,
      assigned_worker
    });
    return task;
  }

  async claimTask(taskId, workerId) {
    if (!workerId) throw new Error("workerId is required");
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== "open") {
      throw new Error(`Task ${taskId} is not claimable (status: ${task.status})`);
    }

    // Check dependencies are satisfied
    const blockers = await this._findUnmetDependencies(task);
    if (blockers.length > 0) {
      throw new Error(`Task ${taskId} has unmet dependencies: ${blockers.join(", ")}`);
    }

    const next = {
      ...task,
      status: "in_progress",
      assigned_worker: workerId,
      claimed_at: nowIso(),
      claimed_by: workerId,
      started_at: nowIso(),
      attempt_count: task.attempt_count + 1,
      error_code: null,
      error_message: null,
      blocking_reason: null,
      updated_at: nowIso()
    };
    await this.store.saveTask(next);
    await this._emitTaskEvent(next, "claimed", "worker", workerId, { attempt: next.attempt_count });
    return next;
  }

  async completeTask(taskId, { result, completion_summary, artifact_refs = [] } = {}) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!["in_progress", "awaiting_approval"].includes(task.status)) {
      throw new Error(`Task ${taskId} cannot be completed from status: ${task.status}`);
    }

    const next = {
      ...task,
      status: "completed",
      result: result || null,
      completion_summary: completion_summary || null,
      artifact_refs: artifact_refs || [],
      completed_at: nowIso(),
      updated_at: nowIso(),
      error_code: null,
      error_message: null,
      blocking_reason: null
    };
    await this.store.saveTask(next);
    await this._emitTaskEvent(next, "completed", "worker", task.claimed_by, {
      has_result: Boolean(result),
      artifact_count: (artifact_refs || []).length
    });
    return next;
  }

  async failTask(taskId, { error_code, error_message, retryable = false } = {}) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (TERMINAL_TASK_STATES.has(task.status)) {
      throw new Error(`Task ${taskId} is already terminal (status: ${task.status})`);
    }

    const attemptsRemaining = task.attempt_count < task.max_attempts;
    const willRetry = retryable && attemptsRemaining;

    const next = {
      ...task,
      status: willRetry ? "open" : "failed",
      error_code: error_code || "UNKNOWN",
      error_message: error_message || "An unknown error occurred",
      updated_at: nowIso(),
      ...(willRetry
        ? { claimed_at: null, claimed_by: null, started_at: null }
        : { completed_at: nowIso() })
    };
    await this.store.saveTask(next);
    await this._emitTaskEvent(next, willRetry ? "retrying" : "failed", "worker", task.claimed_by, {
      error_code,
      retryable,
      attempt_count: task.attempt_count,
      max_attempts: task.max_attempts,
      will_retry: willRetry
    });
    return next;
  }

  async blockTask(taskId, { blocking_reason } = {}) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (TERMINAL_TASK_STATES.has(task.status)) {
      throw new Error(`Task ${taskId} is terminal (status: ${task.status})`);
    }

    const next = {
      ...task,
      status: "blocked",
      blocking_reason: blocking_reason || "Blocked — reason not specified",
      updated_at: nowIso()
    };
    await this.store.saveTask(next);
    await this._emitTaskEvent(next, "blocked", "worker", task.claimed_by, { blocking_reason });
    return next;
  }

  async cancelTask(taskId, { reason, cancelled_by = "orchestrator" } = {}) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (TERMINAL_TASK_STATES.has(task.status)) {
      throw new Error(`Task ${taskId} is already terminal (status: ${task.status})`);
    }

    const next = {
      ...task,
      status: "cancelled",
      blocking_reason: reason || "Cancelled",
      completed_at: nowIso(),
      updated_at: nowIso()
    };
    await this.store.saveTask(next);
    await this._emitTaskEvent(next, "cancelled", "orchestrator", cancelled_by, { reason });
    return next;
  }

  async requestApproval(taskId, { rationale, proposed_action, requested_by = "orchestrator" } = {}) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!["open", "in_progress"].includes(task.status)) {
      throw new Error(`Task ${taskId} cannot request approval from status: ${task.status}`);
    }

    const approval = {
      schema_version: "1.0",
      approval_id: generateId("appr"),
      task_id: taskId,
      workflow_id: task.workflow_id,
      status: "pending",
      rationale: rationale || "",
      proposed_action: proposed_action || "",
      requested_by: requested_by || "orchestrator",
      requested_at: nowIso(),
      resolved_at: null,
      resolved_by: null,
      resolution_note: null
    };
    await this.store.saveApproval(approval);

    const next = {
      ...task,
      status: "awaiting_approval",
      approval_state: "pending",
      updated_at: nowIso()
    };
    await this.store.saveTask(next);
    await this._emitTaskEvent(next, "approval_requested", "orchestrator", requested_by, {
      approval_id: approval.approval_id,
      proposed_action
    });
    return { task: next, approval };
  }

  async resolveApproval(approvalId, { decision, resolved_by, resolution_note } = {}) {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);
    if (approval.status !== "pending") {
      throw new Error(`Approval ${approvalId} is already resolved (status: ${approval.status})`);
    }
    if (!["approved", "denied"].includes(decision)) {
      throw new Error(`Decision must be "approved" or "denied", got: "${decision}"`);
    }

    const updatedApproval = {
      ...approval,
      status: decision,
      resolved_by: resolved_by || "human",
      resolved_at: nowIso(),
      resolution_note: resolution_note || null
    };
    await this.store.saveApproval(updatedApproval);

    const task = await this.store.getTask(approval.task_id);
    let updatedTask = null;
    if (task) {
      updatedTask = {
        ...task,
        approval_state: decision,
        status: decision === "approved" ? "in_progress" : "failed",
        ...(decision === "denied"
          ? {
              error_code: "APPROVAL_DENIED",
              error_message: resolution_note || "Approval denied",
              completed_at: nowIso()
            }
          : {}),
        updated_at: nowIso()
      };
      await this.store.saveTask(updatedTask);
      await this._emitTaskEvent(
        updatedTask,
        decision === "approved" ? "approved" : "denied",
        "human",
        resolved_by,
        { approval_id: approvalId, resolution_note }
      );
    }

    return { task: updatedTask, approval: updatedApproval };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async _findUnmetDependencies(task) {
    const blockers = [];
    for (const depId of task.depends_on || []) {
      const dep = await this.store.getTask(depId);
      if (!dep || dep.status !== "completed") {
        blockers.push(depId);
      }
    }
    return blockers;
  }

  async _emitTaskEvent(task, event_type, actor_type, actor_id, data = {}) {
    const event = {
      event_id: generateId("evt"),
      task_id: task.task_id,
      workflow_id: task.workflow_id,
      event_type,
      timestamp: nowIso(),
      actor_type,
      actor_id: actor_id || "system",
      data
    };
    await this.store.appendEvent(task.task_id, event);
    return event;
  }

  async _emitWorkflowEvent(workflow, event_type, data = {}) {
    const event = {
      event_id: generateId("evt"),
      workflow_id: workflow.workflow_id,
      event_type,
      timestamp: nowIso(),
      actor_type: "system",
      actor_id: workflow.created_by || "system",
      data
    };
    await this.store.appendEvent(`wf_${workflow.workflow_id}`, event);
    return event;
  }
}
