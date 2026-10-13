/**
 * Binding the ruler and the Alertmanager for one environment: the config
 * lookup, the targets, the transports. Shared by observe, live export and
 * the ruler apply target (#3372), so all three reach the same endpoints.
 *
 * The two bind independently. A project that declares only rule groups has
 * no Alertmanager to bind, and that must not make its groups unobservable.
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { UnobservedReason } from "@intentius/chant/observation";
import { PromApiError, PromClient, promHttp, type PromHttp } from "./client";
import { AlertmanagerApi } from "./alertmanager";
import { RulerApi } from "./ruler";
import { isUnresolvedTarget, resolveAlertmanagerTarget, resolveRulerTarget, type UnresolvedTarget } from "../config";

/** What callers may inject: tests pass `http` or point the config at a fake server; the CLI passes nothing. */
export interface BindOptions {
  environment?: string;
  /** The project's config. Loaded from `cwd` (default: the working directory) when omitted. */
  config?: Pick<ChantConfig, "prometheus">;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Transport overrides, per endpoint. The targets are still resolved, so a test exercises the binding too. */
  http?: { ruler?: PromHttp; alertmanager?: PromHttp };
}

/** A target that could not be resolved. */
export class PromBindingError extends Error {
  constructor(readonly unresolved: UnresolvedTarget) {
    super(unresolved.detail);
    this.name = "PromBindingError";
  }
}

/** Both endpoints, each bound or the reason it is not. */
export interface BoundEndpoints {
  ruler: RulerApi | UnresolvedTarget;
  alertmanager: AlertmanagerApi | UnresolvedTarget;
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "prometheus"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    // No project config (an ad-hoc import): the environment variables still bind.
    return undefined;
  }
}

/** Resolve both endpoints for an environment. Never throws for a missing binding; each side says why it is unbound. */
export async function bindEndpoints(options: BindOptions = {}): Promise<BoundEndpoints> {
  const config = options.config ?? (await loadConfig(options.cwd ?? process.cwd()));
  const input = { environment: options.environment, config, env: options.env };
  const r = resolveRulerTarget(input);
  const a = resolveAlertmanagerTarget(input);
  return {
    ruler: isUnresolvedTarget(r) ? r : new RulerApi(new PromClient(options.http?.ruler ?? promHttp(r), r), r),
    alertmanager: isUnresolvedTarget(a) ? a : new AlertmanagerApi(new PromClient(options.http?.alertmanager ?? promHttp(a), a), a),
  };
}

/** The ruler alone, for a caller (the apply target) that needs it bound. Throws {@link PromBindingError} when there is none. */
export async function bindRuler(options: BindOptions = {}): Promise<RulerApi> {
  const { ruler } = await bindEndpoints(options);
  if (isUnresolvedTarget(ruler)) throw new PromBindingError(ruler);
  return ruler;
}

/** The Alertmanager alone. Throws {@link PromBindingError} when there is none. */
export async function bindAlertmanager(options: BindOptions = {}): Promise<AlertmanagerApi> {
  const { alertmanager } = await bindEndpoints(options);
  if (isUnresolvedTarget(alertmanager)) throw new PromBindingError(alertmanager);
  return alertmanager;
}

/** What a failed bind or read means, in the observation vocabulary. */
export function classifyPromFailure(err: unknown): { reason: UnobservedReason; detail: string } {
  if (err instanceof PromBindingError) return { reason: err.unresolved.reason, detail: err.unresolved.detail };
  if (err instanceof PromApiError) {
    return err.verdict === "refused"
      ? { reason: "no-credentials", detail: `${err.message} (the credentials were refused)` }
      : { reason: "read-failed", detail: err.message };
  }
  return { reason: "read-failed", detail: err instanceof Error ? err.message.split("\n")[0] : String(err) };
}
