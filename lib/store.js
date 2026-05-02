import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function generateId(prefix) {
  const rand = randomBytes(6).toString("hex");
  return `${prefix}_${rand}`;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_WORKERS = [
  {
    worker_id: "orchestrator",
    worker_type: "orchestrator",
    display_name: "Orchestrator (Orpheus)",
    supported_task_types: ["*"],
    enabled: true,
    max_concurrency: 1,
    default_timeout_sec: 3600,
    notes: "Main orchestration agent — owns decomposition, synthesis, and user-facing decisions"
  },
  {
    worker_id: "netbox-agent",
    worker_type: "service-agent",
    display_name: "NetBox Agent",
    supported_task_types: ["netbox.", "infra."],
    enabled: false,
    max_concurrency: 3,
    default_timeout_sec: 300,
    notes: "Not yet implemented — V1 placeholder. Owns: NetBox/NB-CLI interaction, device/interface interpretation, compatibility constraints"
  },
  {
    worker_id: "browser-agent",
    worker_type: "service-agent",
    display_name: "Browser / Research Agent",
    supported_task_types: ["browser.", "research.", "vendor."],
    enabled: false,
    max_concurrency: 2,
    default_timeout_sec: 600,
    notes: "Not yet implemented — V1 placeholder. Owns: TinyFish/browser execution, vendor research, market evidence gathering"
  },
  {
    worker_id: "tickets-agent",
    worker_type: "service-agent",
    display_name: "Tickets Agent (Jira)",
    supported_task_types: ["tickets.", "jira."],
    enabled: false,
    max_concurrency: 1,
    default_timeout_sec: 120,
    notes: "Not yet implemented — V1 placeholder. Owns: Jira interactions, issue creation/updates, workflow-tracking projections"
  }
];

export class IatStore {
  constructor(systemRoot) {
    this.root = systemRoot;
  }

  resolve(...parts) {
    return path.join(this.root, ...parts);
  }

  async ensureLayout() {
    for (const dir of ["workflows", "tasks", "events", "approvals", "workers"]) {
      await fs.mkdir(this.resolve(dir), { recursive: true });
    }
    const registryPath = this.resolve("workers", "registry.json");
    if (!(await pathExists(registryPath))) {
      await this._writeJson(registryPath, {
        schema_version: "1.0",
        updated_at: nowIso(),
        workers: DEFAULT_WORKERS
      });
    }
  }

  async _readJson(filePath, fallback = null) {
    if (!(await pathExists(filePath))) return fallback;
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  }

  async _writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
  }

  async _appendJsonl(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(value) + "\n", "utf8");
  }

  async _readJsonl(filePath) {
    if (!(await pathExists(filePath))) return [];
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async _listJsonFiles(dir) {
    if (!(await pathExists(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name))
      .sort();
  }

  // ── Workflow ──────────────────────────────────────────────────────────────

  workflowPath(id) {
    return this.resolve("workflows", `${id}.json`);
  }

  async saveWorkflow(workflow) {
    await this._writeJson(this.workflowPath(workflow.workflow_id), workflow);
    return workflow;
  }

  async getWorkflow(id) {
    return this._readJson(this.workflowPath(id), null);
  }

  async listWorkflows(filter = {}) {
    const files = await this._listJsonFiles(this.resolve("workflows"));
    const result = [];
    for (const f of files) {
      const wf = await this._readJson(f, null);
      if (!wf) continue;
      if (filter.status && wf.status !== filter.status) continue;
      if (filter.created_by && wf.created_by !== filter.created_by) continue;
      result.push(wf);
    }
    return result;
  }

  // ── Task ──────────────────────────────────────────────────────────────────

  taskPath(id) {
    return this.resolve("tasks", `${id}.json`);
  }

  async saveTask(task) {
    await this._writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async getTask(id) {
    return this._readJson(this.taskPath(id), null);
  }

  async listTasks(filter = {}) {
    const files = await this._listJsonFiles(this.resolve("tasks"));
    const result = [];
    for (const f of files) {
      const task = await this._readJson(f, null);
      if (!task) continue;
      if (filter.workflow_id && task.workflow_id !== filter.workflow_id) continue;
      if (filter.status && task.status !== filter.status) continue;
      if (filter.assigned_worker && task.assigned_worker !== filter.assigned_worker) continue;
      if (filter.task_type && task.task_type !== filter.task_type) continue;
      if (filter.parent_task_id !== undefined && task.parent_task_id !== filter.parent_task_id) continue;
      result.push(task);
    }
    return result;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  eventsPath(scopeId) {
    return this.resolve("events", `${scopeId}.jsonl`);
  }

  async appendEvent(scopeId, event) {
    await this._appendJsonl(this.eventsPath(scopeId), event);
  }

  async getEvents(scopeId) {
    return this._readJsonl(this.eventsPath(scopeId));
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  approvalPath(id) {
    return this.resolve("approvals", `${id}.json`);
  }

  async saveApproval(approval) {
    await this._writeJson(this.approvalPath(approval.approval_id), approval);
    return approval;
  }

  async getApproval(id) {
    return this._readJson(this.approvalPath(id), null);
  }

  async findPendingApprovalByTaskId(taskId) {
    const files = (await this._listJsonFiles(this.resolve("approvals"))).reverse();
    for (const f of files) {
      const appr = await this._readJson(f, null);
      if (appr && appr.task_id === taskId && appr.status === "pending") return appr;
    }
    return null;
  }

  // ── Worker Registry ───────────────────────────────────────────────────────

  async getWorkerRegistry() {
    const registry = await this._readJson(this.resolve("workers", "registry.json"), null);
    return registry || { schema_version: "1.0", updated_at: nowIso(), workers: DEFAULT_WORKERS };
  }

  async saveWorkerRegistry(registry) {
    await this._writeJson(this.resolve("workers", "registry.json"), {
      ...registry,
      updated_at: nowIso()
    });
    return registry;
  }
}
