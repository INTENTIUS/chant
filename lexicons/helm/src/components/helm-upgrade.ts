/**
 * `helm-upgrade` — the Helm release leaf for the component model
 * (#1495 piece 4).
 *
 * The closest analogue of `cfn-deploy` anywhere in chant: a Helm release has
 * a name, a presence, and a native status, and `helm upgrade --install` is
 * the one idempotent verb that creates or converges it. `release` doubles as
 * both the thing Helm manages and the deploy unit the status walk reads
 * (core `components/deploy-units.ts` — `{ kind: "helm-upgrade", field:
 * "release", lexicon: "helm" }` was registered in #1499, waiting for this
 * capability to exist).
 *
 * Unlike `kubectl-apply`, rollback is native: Helm retains previous release
 * revisions, and `helm rollback <release>` restores the last one. So this
 * capability carries a real `rollback` method and COMP003 treats it as
 * `"native"` — no opt-out reason required on the step.
 *
 * The cluster is selected the same way the k8s lexicon's reads select it
 * (#1488): the environment's declared binding (`k8s.profiles.<env>.context`)
 * is passed as `--kube-context` when present; ambient otherwise. Helm rides
 * the same binding rather than inventing a parallel one — a Helm release
 * lives on the same cluster the k8s half observes.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Capability, DeployContext } from "@intentius/chant/components/capability";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { resolveClusterTarget } from "@intentius/chant/kubectl-context";

// `-o json` returns the WHOLE release — manifest and hooks included, which
// for a chart like cert-manager is several megabytes — so node's default 1MiB
// exec buffer truncates and rejects ("stdout maxBuffer length exceeded", hit
// live on kubemicrovm-ops' first component-path install).
const execP = promisify(exec);
const execAsync = (command: string): Promise<{ stdout: string }> =>
  execP(command, { maxBuffer: 64 * 1024 * 1024 });

export interface HelmUpgradeInput {
  /**
   * The release name — the deploy unit. `helm upgrade --install` converges
   * it; `describeStackStatus` reads it back; `components status --live`
   * reports it. Required: an unnamed release is invisible to every one of
   * those.
   */
  release: string;
  /** Chart reference: a local path, a `repo/chart` name, or an OCI ref. */
  chart: string;
  /** Target namespace. Omitted uses the kube context's default. */
  namespace?: string;
  /** Create the namespace if it does not exist (`--create-namespace`). */
  createNamespace?: boolean;
  /** Values files, passed as `-f` in order (later files win, Helm's rule). */
  values?: string[];
  /**
   * Inline value overrides, passed as `--set key=value` in sorted-key order
   * (deterministic argv for the same input). Helm applies these after every
   * values file — its own precedence, unchanged.
   */
  set?: Record<string, string>;
  /**
   * Chart repository URL (`--repo`), for a chart named bare rather than as a
   * local path or OCI ref — `{ chart: "cert-manager", repo:
   * "https://charts.jetstack.io" }` needs no prior `helm repo add`.
   */
  repo?: string;
  /** Chart version constraint (`--version`). Omitted takes the latest. */
  version?: string;
  /** Wait for resources to become ready before returning (`--wait`). */
  wait?: boolean;
  /** Wait ceiling (`--timeout`), Helm duration syntax (`6m`). Helm's default is 5m. */
  timeout?: string;
  /** Explicit kube context, overriding the environment's declared binding. */
  context?: string;
}

/** What the upgrade did — Helm's own release facts, from `-o json`. */
export interface HelmUpgradeOutcome {
  release: string;
  namespace?: string;
  /** Helm's release revision after this upgrade (1 on first install). */
  revision?: number;
  /** Helm's native status, e.g. "deployed". */
  status?: string;
}

/** Injectable command runner, so tests assert the exact argv without a cluster or a helm binary. */
export type HelmRunner = (command: string) => Promise<{ stdout: string }>;

/** Shell-quote one argv element (paths and chart refs may carry spaces). */
function q(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The environment's kube context: the explicit input, else the declared
 * binding (#1488 — used, never policed), else undefined (ambient).
 */
async function resolveContext(input: HelmUpgradeInput, env: string | undefined): Promise<string | undefined> {
  if (input.context) return input.context;
  if (!env) return undefined;
  const { config } = await loadChantConfigUpward(process.cwd()).catch(() => ({ config: {} }));
  const target = await resolveClusterTarget(config as Record<string, unknown>, env, "helm");
  return target.context;
}

function upgradeCommand(input: HelmUpgradeInput, context: string | undefined): string {
  const parts = ["helm", "upgrade", "--install", q(input.release), q(input.chart), "-o", "json"];
  if (input.namespace) parts.push("-n", q(input.namespace));
  if (input.createNamespace) parts.push("--create-namespace");
  if (input.repo) parts.push("--repo", q(input.repo));
  for (const f of input.values ?? []) parts.push("-f", q(f));
  for (const key of Object.keys(input.set ?? {}).sort()) parts.push("--set", q(`${key}=${input.set![key]}`));
  if (input.version) parts.push("--version", q(input.version));
  if (input.wait) parts.push("--wait");
  if (input.timeout) parts.push("--timeout", q(input.timeout));
  if (context) parts.push("--kube-context", q(context));
  return parts.join(" ");
}

/** Factory with an injectable runner — the same seam `createKubectlApplyCapability` uses. */
export function createHelmUpgradeCapability(
  run: HelmRunner = execAsync,
): Capability<HelmUpgradeInput, HelmUpgradeOutcome> {
  return {
    kind: "helm-upgrade",
    async run(ctx: DeployContext, input: HelmUpgradeInput): Promise<HelmUpgradeOutcome> {
      const context = await resolveContext(input, ctx.env);
      const { stdout } = await run(upgradeCommand(input, context));
      let parsed: { name?: string; namespace?: string; version?: number; info?: { status?: string } } = {};
      try {
        parsed = JSON.parse(stdout) as typeof parsed;
      } catch {
        // Helm printed something non-JSON (older helm, or a plugin banner) —
        // the upgrade still succeeded (a failure rejects the exec), so report
        // the release without the extras rather than failing a done deploy.
      }
      return {
        release: input.release,
        ...(parsed.namespace ?? input.namespace ? { namespace: parsed.namespace ?? input.namespace } : {}),
        ...(typeof parsed.version === "number" ? { revision: parsed.version } : {}),
        ...(parsed.info?.status ? { status: parsed.info.status } : {}),
      };
    },
    // Native compensation: restore the previous retained revision. Helm's
    // bare `rollback <release>` targets exactly that.
    async rollback(ctx: DeployContext, input: HelmUpgradeInput): Promise<void> {
      const context = await resolveContext(input, ctx.env);
      const parts = ["helm", "rollback", q(input.release)];
      if (input.namespace) parts.push("-n", q(input.namespace));
      if (context) parts.push("--kube-context", q(context));
      await run(parts.join(" "));
    },
  };
}

export const helmUpgradeCapability = createHelmUpgradeCapability();
