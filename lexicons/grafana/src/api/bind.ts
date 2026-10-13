/**
 * Binding a client for one environment: the config lookup, the target, the
 * transport. Shared by observe, export and (#2948) apply, so all three read
 * and write the same Grafana.
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { UnobservedReason } from "@intentius/chant/observation";
import { GrafanaApiError, GrafanaClient, grafanaHttp, type GrafanaHttp } from "./client";
import { isUnresolvedTarget, resolveGrafanaTarget, type UnresolvedTarget } from "../config";

/** What callers may inject: tests pass `http` (and usually `config`), the CLI passes nothing. */
export interface BindOptions {
  environment?: string;
  /** The project's config. Loaded from `cwd` (default: the working directory) when omitted. */
  config?: Pick<ChantConfig, "grafana">;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Transport override. The target is still resolved, so a test exercises the binding too. */
  http?: GrafanaHttp;
}

/** A target that could not be resolved, thrown by {@link bindGrafana} and classified by {@link classifyGrafanaFailure}. */
export class GrafanaBindingError extends Error {
  constructor(readonly unresolved: UnresolvedTarget) {
    super(unresolved.detail);
    this.name = "GrafanaBindingError";
  }
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "grafana"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    // No project config (an ad-hoc export): the environment variables still bind.
    return undefined;
  }
}

/** Resolve the environment's target and return a client for it. Throws {@link GrafanaBindingError} when there is none. */
export async function bindGrafana(options: BindOptions = {}): Promise<GrafanaClient> {
  const config = options.config ?? (await loadConfig(options.cwd ?? process.cwd()));
  const target = resolveGrafanaTarget({ environment: options.environment, config, env: options.env });
  if (isUnresolvedTarget(target)) throw new GrafanaBindingError(target);
  return new GrafanaClient(options.http ?? grafanaHttp(target), target);
}

/** What a failed bind or read means, in the observation vocabulary. */
export function classifyGrafanaFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  if (err instanceof GrafanaBindingError) return { reason: err.unresolved.reason, detail: err.unresolved.detail };
  if (err instanceof GrafanaApiError) {
    return err.verdict === "refused"
      ? { reason: "no-credentials", detail: `${err.message} (the credentials were refused)` }
      : { reason: "read-failed", detail: err.message };
  }
  return { reason: "read-failed", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) };
}
