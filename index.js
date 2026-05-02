import os from "node:os";
import path from "node:path";

import { IatStore } from "./lib/store.js";
import { TaskApi } from "./lib/task-api.js";
import { registerTools } from "./lib/tools.js";

function resolveSystemRoot(api, config) {
  const homeDir =
    api?.openclawHome ||
    api?.homeDir ||
    process.env.OPENCLAW_HOME ||
    path.join(os.homedir(), ".openclaw");

  const projectPath =
    config?.projectPath ||
    process.env.IAT_PROJECT_PATH ||
    "workspace/projects/nb-proj";

  return path.resolve(homeDir, projectPath, "system");
}

export default {
  id: "openclaw-inter-agent-tasks",
  name: "OpenClaw Inter-Agent Task System",
  description:
    "Durable, inspectable inter-agent task and workflow coordination. Provides typed tasks, worker routing, dependency tracking, approval gates, retries, and audit events for the multi-agent network engineering system.",
  kind: "runtime",

  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      projectPath: {
        type: "string",
        minLength: 1,
        description: "Relative path from OPENCLAW_HOME to the project root (default: workspace/projects/nb-proj)"
      },
      debug: { type: "boolean" }
    }
  },

  register(api) {
    const config = api.pluginConfig || {};
    const systemRoot = resolveSystemRoot(api, config);
    const debug = config.debug === true;

    const store = new IatStore(systemRoot);
    const taskApi = new TaskApi(store);

    if (debug) {
      console.log(`[openclaw-inter-agent-tasks] system root: ${systemRoot}`);
    }

    registerTools(api, taskApi, store, { debug });

    api.registerService({
      id: "openclaw-inter-agent-tasks",
      start: async () => {
        await store.ensureLayout();
        if (debug) {
          console.log("[openclaw-inter-agent-tasks] layout ensured, ready.");
        }
      },
      stop: () => {
        if (debug) {
          console.log("[openclaw-inter-agent-tasks] stopped.");
        }
      }
    });
  }
};
