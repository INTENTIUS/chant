/**
 * `chant kube wait` (chant #1079) — the issue names this one explicitly:
 * "`wait` should use the existing readiness-spec registry in
 * `op/activities/wait-for-ready.ts`, which already handles the Argo case
 * where health and sync replace a `Ready` condition — something `kubectl
 * wait --for` cannot express without jsonpath gymnastics." This verb is a
 * thin CLI shell around that exact registry (`readinessFor`/`isReady`/
 * `firstTerminal`/`waitForReady`) — not a second implementation of it.
 *
 * `--for=condition=<Type>[=<Status>]` overrides the registry with a single
 * condition check, matching kubectl's own flag. `--for=delete` polls for
 * absence instead. Neither given falls back to the registry: the generic
 * `Ready` condition, or a resource-specific override (Argo's `Application`
 * today).
 */

import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import {
  waitForReady,
  readinessFor,
  ReadinessFailedError,
  type ReadinessSpec,
  type ResourceFetcher,
} from "../op/activities/wait-for-ready";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom, parseDurationMs } from "./flags";
import { loadKubeProjectContext, type KubeProjectContext } from "./project";
import { resolveKubeTarget, isTargetError, type KubeTarget } from "./target";

export interface WaitDeps {
  connect?: K8sConnector;
  loadProject?: (cwd?: string) => Promise<KubeProjectContext | undefined>;
}

type ForSpec = { kind: "delete" } | { kind: "spec"; spec: ReadinessSpec };

function parseFor(value: string | undefined): ForSpec | undefined {
  if (value === undefined) return undefined;
  if (value === "delete") return { kind: "delete" };
  const match = /^condition=([^=]+)(?:=(.+))?$/.exec(value);
  if (!match) {
    throw new Error(`--for expects "condition=<Type>[=<Status>]" or "delete", got "${value}"`);
  }
  return { kind: "spec", spec: { ready: [{ conditionType: match[1], status: match[2] ?? "True" }] } };
}

function targetLabel(target: KubeTarget): string {
  return "apiVersion" in target.selector ? target.selector.kind : target.selector.resource;
}

export async function runWait(rawArgs: string[], deps: WaitDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const loadProject = deps.loadProject ?? loadKubeProjectContext;

  let flags;
  let forSpec: ForSpec | undefined;
  let timeoutMs: number;
  try {
    flags = parseKubeFlags(rawArgs, { value: { "--for": "for", "--timeout": "timeout" } });
    forSpec = parseFor(flags.values.for);
    timeoutMs = flags.values.timeout !== undefined ? parseDurationMs(flags.values.timeout) : 30_000;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const project = await loadProject();
  const target = resolveKubeTarget(flags.positional, flags.values.namespace, project);
  if (isTargetError(target)) {
    console.error(`error: ${target.error}`);
    return 1;
  }
  if (!target.name) {
    console.error("error: chant kube wait requires a single named resource, e.g. `chant kube wait deployment web`");
    return 1;
  }

  const connected = await kubeConnect(connectOptionsFrom(flags.values), connect);
  if (connected.kind === "unobserved") {
    console.error(formatUnobserved(targetLabel(target), { reason: connected.reason, detail: connected.detail }));
    return 1;
  }
  const { client } = connected;

  let info;
  try {
    info = await client.resolve(target.selector);
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(targetLabel(target), {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }
  if (!info) {
    console.error(`error: the server doesn't have a resource type "${targetLabel(target)}"`);
    return 1;
  }

  const namespace = target.namespace ?? client.defaultNamespace;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (forSpec?.kind === "delete") {
      await waitForDeletion(client, { apiVersion: info.apiVersion, kind: info.kind, name: target.name, namespace }, controller.signal);
      console.log(`${info.kind}/${target.name} deleted`);
      return 0;
    }

    const spec = forSpec?.kind === "spec" ? forSpec.spec : readinessFor(info.group, info.kind);
    const fetcher: ResourceFetcher = async (args, signal) =>
      (await client.read(
        { apiVersion: info.apiVersion, kind: info.kind, name: args.name, ...(args.namespace ? { namespace: args.namespace } : {}) },
        { signal },
      )) as Record<string, unknown>;

    await waitForReady({ kind: info.kind, name: target.name, namespace, group: info.group, spec }, controller.signal, fetcher);
    console.log(`${info.kind}/${target.name} condition met`);
    return 0;
  } catch (err) {
    if (err instanceof ReadinessFailedError) {
      console.error(err.message);
      return 1;
    }
    if (controller.signal.aborted) {
      console.error(`error: timed out after ${timeoutMs}ms waiting for ${info.kind}/${target.name}`);
      return 1;
    }
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(`${info.kind}/${target.name}`, {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDeletion(
  client: { readIfPresent: (ref: { apiVersion: string; kind: string; name: string; namespace?: string }, opts: { signal?: AbortSignal }) => Promise<unknown> },
  ref: { apiVersion: string; kind: string; name: string; namespace?: string },
  signal: AbortSignal,
  intervalMs = 5_000,
): Promise<void> {
  while (true) {
    if (signal.aborted) throw new Error("wait --for=delete aborted");
    const obj = await client.readIfPresent(ref, { signal });
    if (!obj) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
