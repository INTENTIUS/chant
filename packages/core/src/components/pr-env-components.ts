/**
 * A pull request's environment made of separately planned components
 * (#4762): the adapter and teardown `prEnvUp`, `prEnvDown` and `prEnvSweep`
 * (./pr-env-run.ts) take, built from one function that plans a component.
 *
 * Engine-neutral. An engine supplies {@link PrEnvComponentPlan}s: a
 * component's plan, what it changes, where its copy lives, and how to apply
 * that plan. The terraform lexicon plans each root's copy under a suffixed
 * state key (`@intentius/chant-lexicon-terraform/pr-env`); a Pulumi review
 * stack, or a database branch per pull request, plans the same way. The
 * rules they share live here:
 *
 * - every component plans before anything applies, and one that does not
 *   plan stops the whole environment;
 * - the digest an approval binds is the set digest over each component's
 *   plan digest, as a wave's is;
 * - the plans apply in order, and the first that fails stops the rest, with
 *   what applied kept on the record so the teardown finds it;
 * - the teardown takes only the components whose recorded location the
 *   engine says is the environment's own (`owns`), and destroys them in the
 *   reverse of the order they applied in, since a later one may read an
 *   earlier one's outputs.
 */
import { waveSetDigest } from "../gated-waves";
import type { TeardownOutcome } from "../lexicon";
import { NEXT_RELEASE } from "../release-floors";
import type { PrEnvAdapter, PrEnvPlanned, PrEnvTarget } from "./pr-env-run";
import type { LivePrEnvironment, PrEnvReportRow, PrEnvTeardownAdapter } from "./pr-environment";

/** The first chant with the component adapter and teardown, and the terraform lexicon's copies on them (#4762). */
export const PR_ENV_COMPONENTS_FLOOR = NEXT_RELEASE;

/** One component's plan, as an engine answers it. */
export interface PrEnvComponentPlan {
  component: string;
  /** The plan's digest, which the environment's set digest covers. Empty when it did not plan. */
  planDigest: string;
  create: number;
  update: number;
  replace: number;
  delete: number;
  /** Where its copy lives, kept on the record for the teardown, such as a suffixed state key. */
  location?: string;
  /** Why it did not plan. */
  error?: string;
  /** Apply exactly this plan. Throws when it fails. */
  apply(): Promise<void>;
}

const changes = (p: PrEnvComponentPlan): number => p.create + p.update + p.replace + p.delete;

const rowOf = (p: PrEnvComponentPlan, status: string): PrEnvReportRow => ({
  component: p.component,
  status,
  create: p.create,
  update: p.update,
  replace: p.replace,
  delete: p.delete,
  ...(p.location ? { location: p.location } : {}),
});

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface PrEnvComponentsInput {
  /** The components of this environment, in apply order. None: the change reaches nothing, and the environment gets nothing. */
  components(target: PrEnvTarget): Promise<string[]>;
  /** Plan one component. An error it answers is a plan that failed; a throw refuses the environment and is kept in `refused`. */
  plan(component: string, index: number, target: PrEnvTarget): Promise<PrEnvComponentPlan>;
  /** What an environment with no components says. */
  nothing?: (target: PrEnvTarget) => string;
  log?: (line: string) => void;
}

/**
 * The adapter `prEnvUp` takes, over a component planner. `refused` holds an
 * error `components` or `plan` threw, which `prEnvUp` reports as a failed
 * plan, so a caller that treats it as a config error can raise it.
 */
export function componentsPrEnvAdapter(input: PrEnvComponentsInput): PrEnvAdapter & { refused?: Error } {
  const log = input.log ?? (() => {});
  let plans: PrEnvComponentPlan[] = [];
  const adapter: PrEnvAdapter & { refused?: Error } = {
    async plan(target): Promise<PrEnvPlanned> {
      try {
        const names = await input.components(target);
        if (names.length === 0) {
          const message = input.nothing?.(target) ?? `nothing in this change has a copy in ${target.env}`;
          log(message);
          return { digest: "", empty: true, rows: [], message };
        }
        plans = [];
        for (const [i, name] of names.entries()) {
          const p = await input.plan(name, i, target);
          plans.push(p);
          log(p.error ? `${p.component}: ${p.error}` : `${p.component}: ${changes(p)} to change${p.location ? ` at ${p.location}` : ""}`);
        }
        const failed = plans.filter((p) => p.error);
        if (failed.length > 0) {
          const message = `${failed.map((p) => p.component).join(", ")} did not plan, so nothing of ${target.env} applies`;
          return { digest: "", empty: false, failed: true, rows: plans.map((p) => rowOf(p, p.error ? "plan-failed" : "planned")), message };
        }
        const digest = waveSetDigest(plans.map((p) => ({ member: p.component, planDigest: p.planDigest })));
        return { digest, empty: plans.every((p) => changes(p) === 0), rows: plans.map((p) => rowOf(p, "planned")) };
      } catch (e) {
        adapter.refused = e instanceof Error ? e : new Error(String(e));
        throw e;
      }
    },
    async apply() {
      const rows: PrEnvReportRow[] = [];
      let failed: string | undefined;
      for (const p of plans) {
        if (failed) {
          rows.push(rowOf(p, "not applied"));
          continue;
        }
        try {
          await p.apply();
          rows.push(rowOf(p, "applied"));
          log(`applied ${p.component}${p.location ? ` at ${p.location}` : ""}`);
        } catch (e) {
          failed = `${p.component} did not apply: ${messageOf(e)}`;
          rows.push(rowOf(p, "failed"));
          log(`FAILED ${failed}`);
        }
      }
      const locations = Object.fromEntries(plans.filter((p) => p.location).map((p) => [p.component, p.location!]));
      return { status: failed ? "failed" : "applied", rows, ...(Object.keys(locations).length ? { locations } : {}), ...(failed ? { message: failed } : {}) };
    },
  };
  return adapter;
}

/** What a teardown plans the destroys with: the code the environment applied from, prepared, and released after. */
export interface PrEnvTeardownCheckout {
  /** Plan one component's destroy. An error it answers, or a throw, fails that component alone. */
  plan(component: string, index: number): Promise<PrEnvComponentPlan>;
  /** Release what the checkout holds, after every destroy. */
  done?(): void;
}

export interface PrEnvComponentsTeardownInput {
  /** The name outcomes are attributed to. */
  name: string;
  /** The lexicons this teardown stands in for. */
  lexicons?: string[];
  /** The candidates' resource type, such as `terraform_root`. */
  type: string;
  /** Whether a component's recorded location is this environment's own copy and not the component's own state. */
  owns(location: string, env: string): boolean;
  /** Prepare the code the environment last applied from (`live.commit`). */
  checkout(live: LivePrEnvironment): Promise<PrEnvTeardownCheckout>;
  log?: (line: string) => void;
}

/**
 * The teardown `prEnvDown` and `prEnvSweep` take, over a component planner.
 * A component whose recorded location the engine does not own, or that has
 * no location recorded, is a hole, so nothing at a component's own state is
 * destroyed.
 */
export function componentsPrEnvTeardown(input: PrEnvComponentsTeardownInput): PrEnvTeardownAdapter {
  const log = input.log ?? (() => {});
  return {
    name: input.name,
    ...(input.lexicons ? { lexicons: input.lexicons } : {}),
    async owned({ live, marker }) {
      const candidates = [];
      const holes = [];
      for (const name of live.components) {
        const location = live.locations?.[name] ?? "";
        if (location && input.owns(location, live.env)) candidates.push({ name, type: input.type, physicalId: location, marker: { stack: marker.stack, env: live.env } });
        else holes.push({ name, type: input.type, reason: "read-failed" as const, detail: location ? `its recorded location ${location} is not ${live.env}'s own copy` : `the location of its copy in ${live.env} is not recorded` });
      }
      return { candidates, holes };
    },
    async teardown({ candidates, live }) {
      const outcomes: TeardownOutcome[] = [];
      const order = [...live.components].reverse();
      const rank = (name: string): number => (order.includes(name) ? order.indexOf(name) : order.length);
      const checkout = await input.checkout(live);
      try {
        for (const [i, c] of [...candidates].sort((a, b) => rank(a.name) - rank(b.name)).entries()) {
          const failed = (detail: string): void => {
            log(`FAILED ${c.name}: ${detail}`);
            outcomes.push({ name: c.name, type: input.type, outcome: "failed", detail });
          };
          let p: PrEnvComponentPlan;
          try {
            p = await checkout.plan(c.name, i);
          } catch (e) {
            failed(messageOf(e));
            continue;
          }
          if (p.error) {
            failed(p.error);
            continue;
          }
          try {
            await p.apply();
          } catch (e) {
            failed(`the destroy did not apply: ${messageOf(e)}`);
            continue;
          }
          log(`destroyed ${c.name}'s copy${p.location ? ` at ${p.location}` : ""}`);
          outcomes.push({ name: c.name, type: input.type, outcome: "deleted", detail: `destroyed${p.location ? ` at ${p.location}` : ""}, plan ${p.planDigest}` });
        }
      } finally {
        checkout.done?.();
      }
      return { outcomes };
    },
  };
}
