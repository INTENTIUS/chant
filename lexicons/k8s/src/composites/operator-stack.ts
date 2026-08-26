/**
 * OperatorStack composite (#1940, epic #1487) — the operating loop
 * materialized in-cluster as a declared estate on gitops principles: one
 * Namespace, one CronJob per hosted `ConvergeOp` tick, and RBAC scoped to
 * what that tick can actually do. chant declares the loop that runs chant
 * with its own k8s lexicon — the same estate discipline as any other app.
 *
 * ## Why a CronJob, not the operator daemon
 *
 * Issue #1485 ("chant operator: native durable ticks without Temporal")
 * names cron, a systemd timer, a k8s CronJob, a CI schedule, and the
 * `chant operator` daemon as interchangeable safe invokers of the same
 * thing: one converge tick. A k8s CronJob invoking `chant run <name>` per
 * tick is that issue's own "cron … invokes the tick" case, not a dependency
 * on the daemon it proposes — #1485 is a separate, still-unmerged runtime
 * (lease fencing, `chant operator status`, durable gate-as-fact semantics).
 * `OperatorStack`'s container command is deliberately `chant run <name>`,
 * the one-shot local tick `ConvergeOp` (#1484) already ships and tests
 * against (`lexicons/temporal/src/composites/converge-op.ts`'s own doc:
 * "one-shot runnable locally for a single tick"). When #1485 lands, a
 * caller can override `command` to shell out to `chant operator tick`
 * instead — this composite doesn't need to change for that; only the
 * command a caller passes does.
 *
 * `concurrencyPolicy: "Forbid"` is the k8s-native analogue of
 * `ConvergeOp`'s own Temporal schedule `overlap: "Skip"` policy — never
 * queue a second tick behind one still running.
 *
 * ## RBAC derivation
 *
 * `ConvergeOp` adds no authority an environment did not already grant
 * (#1484's Autonomy table). `OperatorStack` re-derives the same bound at the
 * k8s RBAC layer, independently of the temporal lexicon (this module has no
 * dependency on it — see the layering note below): for each hosted
 * ConvergeOp, walk its `dispatchTargets` (the OpConfigs its rule table's
 * `run()` actions may name) through `classifyOpVerbClass`
 * (`packages/core/src/op/op-verb-class.ts`, #1954), then keep only the
 * highest verb class this host's `dial` could ever actually free-run —
 * exactly `convergeTick`'s own `verbClassAllowedToDispatch` gate and
 * `TMP014`'s build-time refusal, restated as an RBAC ceiling:
 *
 * - `dial: "observe"` never dispatches (report-only) → read-only RBAC,
 *   regardless of what the rule table's targets could otherwise do.
 * - `dial: "reconcile"` only free-runs a read-only target (TMP014 refuses a
 *   mutating dispatch under reconcile in v1) → read-only RBAC.
 * - `dial: "apply"` free-runs read-only and mutating targets → RBAC gains
 *   create/update/patch, never delete.
 * - A `dispatchTargets` entry that itself classifies `destructive` is
 *   refused outright, at construction — TMP014 already refuses a
 *   destructive `run()` target under any dial in v1 (the local dispatch
 *   executor can't honor its required gate), so a `destructive` target
 *   reaching this composite is either a config bypassing that build check
 *   or a target `OperatorStack` should never grant permission toward.
 *   `never delete`, unconditionally, in v1 — no verb class here ever grants
 *   `delete`/`deletecollection`, and no rule ever uses `"*"`.
 *
 * Each hosted ConvergeOp gets its own ServiceAccount + Role + RoleBinding
 * (never one shared identity across differently-scoped loops) — a read-only
 * loop and a mutating loop sharing a Namespace get RBAC as different as
 * their own dials allow, never the union.
 *
 * ## Layering
 *
 * `lexicons/k8s` has no workspace dependency on `lexicons/temporal` (nor
 * the reverse — see both packages' `package.json`), so this module doesn't
 * import `ConvergeOpConfig`/`ConvergeRule` types. `OperatorStackConvergeHost`
 * restates the handful of `ConvergeOp` fields this composite actually needs
 * (`name`, `schedule`, `env`, `dial`) structurally; `dispatchTargets` takes
 * plain `OpConfig`-shaped values from `@intentius/chant/op` (a dependency
 * this lexicon already has via the `@intentius/chant` peer dependency),
 * the same type `classifyOpVerbClass` itself takes.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { classifyOpVerbClass } from "@intentius/chant/op";
import type { OpConfig, OpVerbClass } from "@intentius/chant/op";
import { Namespace, CronJob, ServiceAccount, Role, RoleBinding } from "../generated";

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Mirrors `ConvergeOp`'s own `ConvergeDial`
 * (`lexicons/temporal/src/composites/converge-op.ts`) structurally — see
 * this module's Layering doc for why it's restated rather than imported.
 */
export type OperatorDial = "observe" | "reconcile" | "apply";

/** One resource-kind grant: an API group plus the resource names within it. Verbs are never specified here — they come from the derived verb class, never authored per-rule (the one place a rule table could smuggle in `delete`). */
export interface OperatorRbacResourceRule {
  /** `""` is the core API group. */
  apiGroups: string[];
  resources: string[];
}

export interface OperatorStackConvergeHost {
  /** ConvergeOp's own name (`ConvergeOpConfig.name`) — the CronJob, ServiceAccount, Role, and RoleBinding name stem for this host. */
  name: string;
  /** Cron expression driving the tick — the same string passed to `ConvergeOp`'s own `schedule`. */
  schedule: string;
  /** Environment this ConvergeOp converges (`ConvergeOpConfig.env`) — carried onto the container as `CHANT_CONVERGE_ENV`, for log/estate readability only (`chant run <name>` needs no `--env`: the target op already carries it). */
  env: string;
  /** Authority dial (`ConvergeOpConfig.dial`). @default "observe" */
  dial?: OperatorDial;
  /**
   * OpConfigs for every op this ConvergeOp's rule table may `run()` — the
   * sibling `*.op.ts` declarations its `run()` actions name. Used to derive
   * least-privilege RBAC the same way `TMP014` derives its build-time
   * refusals. Omit or leave empty when every rule only `report()`s; the
   * host still gets read-only RBAC for its own observation.
   */
  dispatchTargets?: Pick<OpConfig, "phases" | "onFailure">[];
  /** RBAC resource kinds this host's ServiceAccount may act on (the estate being converged — there's no way to derive this generically from an OpConfig). @default DEFAULT_RESOURCE_RULES */
  resources?: OperatorRbacResourceRule[];
  /** Container command. @default `["chant", "run", <name>]` — see this module's doc on why, and #1485 for the future `chant operator`-shaped alternative. */
  command?: string[];
}

export interface OperatorStackConfig {
  /** Stack name — also the Namespace name unless `namespace` is given. */
  name: string;
  /** Namespace hosting every CronJob. @default config.name */
  namespace?: string;
  /** Container image running the chant CLI. */
  image: string;
  /** ConvergeOps to host — one CronJob (+ ServiceAccount + Role + RoleBinding) per entry. Non-empty; host names must be unique. */
  converge: OperatorStackConvergeHost[];
  /** RBAC resource kinds granted by default when a host doesn't name its own `resources`. @default DEFAULT_RESOURCE_RULES */
  defaultResources?: OperatorRbacResourceRule[];
  /** @default 3 */
  successfulJobsHistoryLimit?: number;
  /** @default 1 */
  failedJobsHistoryLimit?: number;
  /** Additional labels applied to every resource. */
  labels?: Record<string, string>;
  /** Per-member-kind defaults for fine-grained overrides, applied to every host's member of that kind. */
  defaults?: {
    namespace?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    role?: Partial<Record<string, unknown>>;
    roleBinding?: Partial<Record<string, unknown>>;
    cronJob?: Partial<Record<string, unknown>>;
  };
}

/**
 * Flat member shape: `namespace`, plus `serviceAccount_<host>`,
 * `role_<host>`, `roleBinding_<host>`, `cronJob_<host>` for every entry in
 * `converge` — a `Composite` member must itself be a `Declarable`
 * (`packages/core/src/composite.ts`), so per-host resources are flat, keyed
 * members rather than grouped under a nested `Record` (a plain object isn't
 * a `Declarable`, so it can't itself be a composite member). A host named
 * `"fountain-converge"` reads back as
 * `result["cronJob_fountain-converge"]` (bracket notation — the key isn't a
 * valid bare identifier).
 */
export interface OperatorStackResult {
  namespace: InstanceType<typeof Namespace>;
  [member: string]:
    | InstanceType<typeof Namespace>
    | InstanceType<typeof ServiceAccount>
    | InstanceType<typeof Role>
    | InstanceType<typeof RoleBinding>
    | InstanceType<typeof CronJob>;
}

// ── RBAC derivation ──────────────────────────────────────────────────────

/** Default RBAC resource kinds — the common workload surface a converge tick observes/acts on. Deliberately excludes `secrets`: a host that needs secret access opts in explicitly via its own `resources`. */
export const DEFAULT_RESOURCE_RULES: OperatorRbacResourceRule[] = [
  { apiGroups: [""], resources: ["pods", "services", "configmaps", "persistentvolumeclaims", "events"] },
  { apiGroups: ["apps"], resources: ["deployments", "statefulsets", "daemonsets", "replicasets"] },
  { apiGroups: ["batch"], resources: ["jobs", "cronjobs"] },
];

const READ_VERBS = ["get", "list", "watch"];
const MUTATE_VERBS = [...READ_VERBS, "create", "update", "patch"];

/** RBAC verbs for a derived class. Never returns `delete`/`deletecollection`/`"*"` — v1 has no path to a destructive dispatch (see this module's RBAC derivation doc). */
function rbacVerbsFor(verbClass: OpVerbClass): string[] {
  return verbClass === "mutating" ? MUTATE_VERBS : READ_VERBS;
}

/**
 * Whether `dial` ever actually free-runs a dispatch classified `verbClass` —
 * restates `convergeTick`'s own `verbClassAllowedToDispatch`
 * (`lexicons/temporal/src/op/activities/converge.ts`) so the RBAC ceiling
 * this composite grants matches the ceiling the tick itself enforces at
 * runtime, without importing across the lexicon boundary (see this module's
 * Layering doc).
 */
function dialAllowsVerbClass(dial: OperatorDial, verbClass: OpVerbClass): boolean {
  if (verbClass === "read-only") return true;
  if (verbClass === "mutating") return dial === "apply";
  return false; // destructive: never free-run under any dial in v1.
}

/**
 * Derive the highest verb class a host's ServiceAccount actually needs:
 * the max, across `dispatchTargets`, of each target's own class — but only
 * counting a target `dial` could ever actually dispatch (one it can't just
 * gets reported, per `TMP014`/`convergeTick`, and needs no elevated grant).
 * A `dispatchTargets` entry that classifies `destructive` is refused
 * outright rather than silently ignored — see this module's RBAC
 * derivation doc on why a destructive target reaching this composite is
 * itself a refusal, not a no-op.
 */
export function deriveHostVerbClass(hostName: string, dial: OperatorDial, dispatchTargets: Pick<OpConfig, "phases" | "onFailure">[]): OpVerbClass {
  let effective: OpVerbClass = "read-only";
  for (const target of dispatchTargets) {
    const verbClass = classifyOpVerbClass(target);
    if (verbClass === "destructive") {
      throw new Error(
        `OperatorStack host "${hostName}": a dispatchTargets entry classifies as destructive — ConvergeOp v1 refuses a destructive run() target under any dial ` +
          `(TMP014; the local dispatch executor can't honor its required gate). Remove it from dispatchTargets, or remediate manually via a gated op.`,
      );
    }
    if (!dialAllowsVerbClass(dial, verbClass)) continue; // dial refuses this dispatch — reported, not run; needs no elevated RBAC
    if (verbClass === "mutating") effective = "mutating";
  }
  return effective;
}

// ── Composite ────────────────────────────────────────────────────────────

/**
 * Create an OperatorStack composite — a Namespace hosting one CronJob (+
 * least-privilege ServiceAccount/Role/RoleBinding) per ConvergeOp, the
 * in-cluster declared estate for the operating loop.
 *
 * @example
 * ```ts
 * import { OperatorStack } from "@intentius/chant-lexicon-k8s";
 *
 * const stack = OperatorStack({
 *   name: "chant-operator",
 *   image: "ghcr.io/intentius/chant:0.49.0",
 *   converge: [
 *     { name: "fountain-observe", schedule: "*\/10 * * * *", env: "staging", dial: "observe" },
 *     { name: "fountain-converge", schedule: "*\/10 * * * *", env: "staging", dial: "apply", dispatchTargets: [fountainApplyOp] },
 *   ],
 * });
 * ```
 */
export const OperatorStack = Composite((props: OperatorStackConfig) => {
  const {
    name,
    namespace: namespaceName = name,
    image,
    converge,
    defaultResources = DEFAULT_RESOURCE_RULES,
    successfulJobsHistoryLimit = 3,
    failedJobsHistoryLimit = 1,
    labels: extraLabels = {},
    defaults: defs,
  } = props;

  if (converge.length === 0) {
    throw new Error(`OperatorStack "${name}": at least one ConvergeOp to host is required — a namespace with no CronJob has nothing to converge.`);
  }
  const seen = new Set<string>();
  for (const host of converge) {
    if (!host.name || host.name.trim().length === 0) {
      throw new Error(`OperatorStack "${name}": every hosted ConvergeOp needs a non-empty name.`);
    }
    if (seen.has(host.name)) {
      throw new Error(`OperatorStack "${name}": duplicate hosted ConvergeOp name "${host.name}" — CronJob/ServiceAccount names would collide.`);
    }
    seen.add(host.name);
    if (!host.schedule || host.schedule.trim().length === 0) {
      throw new Error(`OperatorStack "${name}", host "${host.name}": schedule is required — an operator CronJob with no schedule never ticks.`);
    }
  }
  if (!image || image.trim().length === 0) {
    throw new Error(`OperatorStack "${name}": image is required — the CronJob has nothing to run.`);
  }

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    "app.kubernetes.io/component": "operator",
    ...extraLabels,
  };

  const namespace = new Namespace(mergeDefaults({
    metadata: {
      name: namespaceName,
      labels: { ...commonLabels, "app.kubernetes.io/component": "namespace" },
    },
  }, defs?.namespace));

  const result: Record<string, any> = { namespace };

  for (const host of converge) {
    const dial = host.dial ?? "observe";
    const verbClass = deriveHostVerbClass(host.name, dial, host.dispatchTargets ?? []);
    const resourceRules = host.resources ?? defaultResources;
    const verbs = rbacVerbsFor(verbClass);

    const saName = `${host.name}-sa`;
    const roleName = `${host.name}-role`;
    const bindingName = `${host.name}-binding`;

    const hostLabels: Record<string, string> = {
      ...commonLabels,
      "app.kubernetes.io/instance": host.name,
    };

    const serviceAccount = new ServiceAccount(mergeDefaults({
      metadata: {
        name: saName,
        namespace: namespaceName,
        labels: hostLabels,
      },
    }, defs?.serviceAccount));
    result[`serviceAccount_${host.name}`] = serviceAccount;

    const role = new Role(mergeDefaults({
      metadata: {
        name: roleName,
        namespace: namespaceName,
        labels: { ...hostLabels, "app.kubernetes.io/component": "rbac" },
      },
      rules: resourceRules.map((r) => ({ apiGroups: r.apiGroups, resources: r.resources, verbs })),
    }, defs?.role));
    result[`role_${host.name}`] = role;

    const roleBinding = new RoleBinding(mergeDefaults({
      metadata: {
        name: bindingName,
        namespace: namespaceName,
        labels: { ...hostLabels, "app.kubernetes.io/component": "rbac" },
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: roleName,
      },
      subjects: [
        { kind: "ServiceAccount", name: saName, namespace: namespaceName },
      ],
    }, defs?.roleBinding));
    result[`roleBinding_${host.name}`] = roleBinding;

    const command = host.command ?? ["chant", "run", host.name];

    const cronJob = new CronJob(mergeDefaults({
      metadata: {
        name: host.name,
        namespace: namespaceName,
        labels: { ...hostLabels, "app.kubernetes.io/component": "converge-tick" },
      },
      spec: {
        schedule: host.schedule,
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit,
        failedJobsHistoryLimit,
        jobTemplate: {
          spec: {
            template: {
              metadata: { labels: { ...hostLabels, "app.kubernetes.io/component": "converge-tick" } },
              spec: {
                serviceAccountName: saName,
                restartPolicy: "OnFailure",
                containers: [
                  {
                    name: host.name,
                    image,
                    command,
                    env: [
                      { name: "CHANT_CONVERGE_ENV", value: host.env },
                      { name: "CHANT_CONVERGE_DIAL", value: dial },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    }, defs?.cronJob));
    result[`cronJob_${host.name}`] = cronJob;
  }

  return result;
}, "OperatorStack");
