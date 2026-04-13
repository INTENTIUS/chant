import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Context } from "@temporalio/activity";

const execAsync = promisify(exec);

export interface HelmInstallArgs {
  /** Helm release name. */
  name: string;
  /** Chart reference (local path or `repo/chart`). */
  chart: string;
  /** Path to a values file. */
  values?: string;
  /** Kubernetes namespace. */
  namespace?: string;
  /** Additional --set arguments. */
  set?: Record<string, string>;
}

/**
 * Run `helm upgrade --install <name> <chart>`.
 * Uses longInfra profile — 20m timeout, heartbeat every 60s.
 */
export async function helmInstall(args: HelmInstallArgs): Promise<void> {
  const parts = ["helm", "upgrade", "--install", "--wait", args.name, args.chart];
  if (args.namespace) parts.push("--namespace", args.namespace, "--create-namespace");
  if (args.values) parts.push("-f", args.values);
  for (const [k, v] of Object.entries(args.set ?? {})) parts.push("--set", `${k}=${v}`);

  const heartbeatInterval = setInterval(() => {
    Context.current().heartbeat({ step: "helm install", release: args.name });
  }, 15_000);

  try {
    const { stdout, stderr } = await execAsync(parts.join(" "));
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    clearInterval(heartbeatInterval);
  }
}
