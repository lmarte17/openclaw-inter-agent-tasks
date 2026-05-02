import { spawn } from "node:child_process";

/**
 * Fire a wake cron job via `openclaw gateway call cron.run`.
 *
 * This is the IAT push-notification transport. When a task is assigned to a
 * worker, or a task completes/fails/blocks, the relevant agent is woken by
 * running their pre-registered wake job on-demand.
 *
 * The call is fire-and-forget: the tool response is not delayed, and a
 * notification failure does not fail the task operation. The task record is
 * always written first — notifications are best-effort delivery.
 */
export async function notifyWorker(wakeJobId, { debug = false } = {}) {
  if (!wakeJobId) {
    if (debug) console.warn("[iat-notify] skipped — no wake_job_id");
    return { ok: false, reason: "no_wake_job_id" };
  }

  return new Promise((resolve) => {
    // Let openclaw resolve the gateway URL from its config — don't pass --url
    // unless a custom override is explicitly set (avoids the "url override requires
    // explicit credentials" error on local setups where config handles auth).
    const urlOverride = process.env.OPENCLAW_GATEWAY_URL;
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;

    const args = [
      "gateway", "call", "cron.run",
      "--params", JSON.stringify({ id: wakeJobId }),
      "--json",
    ];
    if (urlOverride) args.push("--url", urlOverride);
    if (token) args.push("--token", token);

    const proc = spawn("openclaw", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });

    proc.on("close", (code) => {
      if (code !== 0) {
        if (debug) console.warn(`[iat-notify] cron.run exited ${code} for job ${wakeJobId}`);
        resolve({ ok: false, exit_code: code });
        return;
      }
      try {
        // Strip ANSI codes, then extract the JSON block (everything from first { to last })
        const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        const result = start >= 0 && end > start
          ? JSON.parse(clean.slice(start, end + 1))
          : { ok: true };
        if (debug) console.log(`[iat-notify] notified job ${wakeJobId}:`, result);
        resolve({ ok: true, ...result });
      } catch {
        resolve({ ok: true });
      }
    });

    proc.on("error", (err) => {
      if (debug) console.warn(`[iat-notify] spawn error: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });
  });
}
