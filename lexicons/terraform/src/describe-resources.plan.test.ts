/**
 * The plan depth (#4358): a stock root read from a saved plan.
 *
 * The declared side is real: `renderTerraformRoots` parses
 * `src/__fixtures__/plan-read-drift/` exactly as `buildRoots()` does. The
 * plan side is `src/__fixtures__/show-plan.json`, recorded from that root by
 * Terraform v1.15.8 (`plan-read-drift/README.md` is the log): one drifted
 * object, two replaces, three updates, a sensitive value nested in a map.
 *
 * Nothing here runs terraform: the activities are injected. The real binary
 * is `plan-read.acceptance.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import { buildLiveGraphIr, sourceOverlayGraphs, type GraphIR } from "@intentius/chant/graph-ir";
import { carryAnnotations } from "@intentius/chant/lifecycle/observe";
import { buildChangeSet } from "@intentius/chant/lifecycle/change-set";
import { __searchInternals } from "@intentius/chant/cli/handlers/search";
import {
  describeResources,
  planFailureIsCredentials,
  TERRAFORM_OBSERVE_ENV,
  type TerraformReadDeps,
} from "./describe-resources";
import { TerraformPlanReadError } from "./op/activities/terraform";
import { diffChange, indexPlan, KNOWN_AFTER_APPLY, PLAN_ATTRIBUTE_NAMES, plannedAttributesFor, SENSITIVE_VALUE } from "./plan-observation";
import { renderTerraformRoots } from "./hcl/roots";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const PLAN: unknown = JSON.parse(readFileSync(join(fixtures, "show-plan.json"), "utf-8"));
const ROOT_DIR = join(fixtures, "plan-read-drift");
/** `var.token`'s value in the fixture. It must never appear in an observation. */
const SECRET = "hunter2";

async function declaredEntities(): Promise<Map<string, { entityType: string; props: Record<string, unknown> }>> {
  const { entities } = await renderTerraformRoots({ projectRoot: fixtures, roots: { app: { dir: "./plan-read-drift" } } });
  const out = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [key, entity] of entities) {
    out.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
  }
  return out;
}

async function options(depth: "plan" | "state" | undefined = "plan") {
  const entities = await declaredEntities();
  return { environment: "prod", buildOutput: "", entityNames: [...entities.keys()].sort(), entities, ...(depth ? { depth } : {}) };
}

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

/** The state a fallback reads: the plan's own prior state, which is what state held. */
const STATE_FROM_PLAN = { values: (PLAN as { prior_state: { values: unknown } }).prior_state.values };

function deps(overrides?: Partial<TerraformReadDeps>): TerraformReadDeps {
  return {
    init: never,
    show: (async () => ({ source: "state" as const, json: STATE_FROM_PLAN, text: "", dir: ROOT_DIR, adds: 0, changes: 0, destroys: 0 })) as TerraformReadDeps["show"],
    livePlan: never,
    liveLs: never,
    planRead: (async () => ({
      json: PLAN,
      dir: ROOT_DIR,
      planDir: "/tmp/chant-terraform-plan-x",
      command: "terraform plan -input=false -lock=false -var-file=next.tfvars -out=/tmp/chant-terraform-plan-x/plan.tfplan",
    })) as TerraformReadDeps["planRead"],
    ...overrides,
  };
}

const planFails = (err: Error): TerraformReadDeps["planRead"] =>
  (async () => {
    throw err;
  }) as TerraformReadDeps["planRead"];

afterEach(() => {
  delete process.env[TERRAFORM_OBSERVE_ENV];
});

describe("the plan depth puts the plan on the IR (#4358)", () => {
  it("planned actions, replace_paths, action_reason, after_unknown and resource_drift ride each block", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const attrs = (name: string) => result.resources[`app/${name}`]!.attributes as Record<string, unknown>;

    expect(attrs("terraform_data.replaced")).toMatchObject({
      planAction: "replace",
      planActions: { "terraform_data.replaced": ["delete", "create"] },
      planActionReason: "replace_because_cannot_update",
      planReplacePaths: ["triggers_replace"],
      planRelevantAttributes: ["id"],
    });
    expect(attrs("terraform_data.downstream")).toMatchObject({ planAction: "update", planAfterUnknown: ["input", "output"] });
    expect(attrs("terraform_data.reader").planAfterUnknown).toEqual(["input", "output"]);

    const conf = attrs("shell_script.conf");
    expect(conf).toMatchObject({
      planAction: "replace",
      planReplacePaths: ["dirty"],
      planActionReason: "replace_because_cannot_update",
      planDriftAction: "update",
      planRelevantAttributes: ["output.port"],
    });
    expect(conf.planDrift).toEqual(
      expect.arrayContaining([
        { path: "dirty", before: false, after: true },
        { path: "read_error", before: null, after: "" },
      ]),
    );
    // The drift touched `dirty` and `read_error`; the plan reads `output.port`,
    // which did not move, so no drift entry is marked relevant.
    expect((conf.planDrift as Array<{ relevant?: boolean }>).some((c) => c.relevant)).toBe(false);
  });

  it("an update carries its attribute-level changes, the unknown side spelled as terraform spells it", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const updated = result.resources["app/terraform_data.updated"]!.attributes as Record<string, unknown>;
    expect(updated.planChanges).toEqual(
      expect.arrayContaining([
        { path: "input.name", before: "app-1", after: "app-2" },
        { path: "output.name", before: "app-1", after: KNOWN_AFTER_APPLY },
      ]),
    );
  });

  it("presence and ownership come from prior_state, by the state read's own rule", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const replaced = result.resources["app/terraform_data.replaced"]!;
    expect(replaced.ownership).toBe("owned");
    expect(replaced.physicalId).toMatch(/^[0-9a-f-]{36}$/);
    // Not a row in state, and not a block the plan touches.
    expect(result.unobserved["app/var.generation"]?.reason).toBe("unsupported-kind");
  });

  it("every attribute name it sets is one PLAN_ATTRIBUTE_NAMES lists", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const listed = new Set<string>(PLAN_ATTRIBUTE_NAMES);
    for (const meta of Object.values(result.resources)) {
      for (const key of Object.keys(meta.attributes ?? {})) {
        if (key.startsWith("plan")) expect(listed.has(key), key).toBe(true);
      }
    }
  });

  it("chant search matches the plan attributes", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources: result.resources }]);
    const { parseQuery, matchTerm } = __searchInternals;
    const search = (query: string) =>
      ir.nodes
        .filter((n) => parseQuery(query).every((t) => matchTerm(n, t, ir)))
        .map((n) => n.id)
        .sort();

    expect(search("attr:planAction=replace")).toEqual(["app/shell_script.conf", "app/terraform_data.replaced"]);
    expect(search("attr:planReplacePaths=triggers_replace")).toEqual(["app/terraform_data.replaced"]);
    expect(search("attr:planActionReason=replace_because_cannot_update")).toHaveLength(2);
    expect(search("attr:planAfterUnknown=input")).toEqual(["app/terraform_data.downstream", "app/terraform_data.reader"]);
    expect(search("attr:planDrift")).toEqual(["app/shell_script.conf"]);
    expect(search(SECRET)).toEqual([]);
  });
});

/**
 * The recorded plan with `terraform_data.downstream` turned into a planned
 * create (#4372): no row in `prior_state`, `actions: ["create"]`, no before,
 * and `id`, `input` and `output` unknown until apply, which is what a real
 * plan says about a new `terraform_data` reading another block's new id.
 */
function planWithCreate(): unknown {
  const plan = structuredClone(PLAN) as {
    prior_state: { values: { root_module: { resources: Array<{ address: string }> } } };
    resource_changes: Array<{ address: string; change: Record<string, unknown> }>;
  };
  const module = plan.prior_state.values.root_module;
  module.resources = module.resources.filter((r) => r.address !== "terraform_data.downstream");
  const entry = plan.resource_changes.find((r) => r.address === "terraform_data.downstream")!;
  entry.change = {
    actions: ["create"],
    before: null,
    after: { triggers_replace: null },
    after_unknown: { id: true, input: true, output: true },
    before_sensitive: false,
    after_sensitive: {},
  };
  return plan;
}

const withCreate = (): TerraformReadDeps =>
  deps({
    planRead: (async () => ({
      json: planWithCreate(),
      dir: ROOT_DIR,
      planDir: "/tmp/chant-terraform-plan-x",
      command: "terraform plan -input=false -lock=false -out=/tmp/chant-terraform-plan-x/plan.tfplan",
    })) as TerraformReadDeps["planRead"],
  });

describe("a planned create carries its plan attributes and stays absent (#4372)", () => {
  const CREATED = "app/terraform_data.downstream";

  it("is in neither map, and its plan attributes are annotations", async () => {
    const raw = await describeResources(await options(), withCreate());
    const result = normalizeObservation(raw);
    expect(result.resources[CREATED]).toBeUndefined();
    expect(result.unobserved[CREATED]).toBeUndefined();
    expect(result.sources[CREATED]).toBe("plan");
    expect(result.annotations?.[CREATED]).toEqual({
      planAction: "create",
      planActions: { "terraform_data.downstream": ["create"] },
      planAfterUnknown: ["id", "input", "output"],
    });
    // Only the planned create is annotated: a present block keeps its
    // attributes on its row, and nothing else is absent.
    expect(Object.keys(result.annotations ?? {})).toEqual([CREATED]);
    expect(result.resources["app/terraform_data.replaced"]!.attributes).toMatchObject({ planAction: "replace" });
  });

  it("every annotation name is one PLAN_ATTRIBUTE_NAMES lists", async () => {
    const result = normalizeObservation(await describeResources(await options(), withCreate()));
    const listed = new Set<string>(PLAN_ATTRIBUTE_NAMES);
    for (const key of Object.keys(result.annotations?.[CREATED] ?? {})) expect(listed.has(key), key).toBe(true);
  });

  it("a block the plan does not mention has no annotations", () => {
    const index = indexPlan(planWithCreate());
    expect(plannedAttributesFor("terraform_data.nowhere", index)).toBeUndefined();
    expect(plannedAttributesFor("terraform_data.downstream", index)).toMatchObject({ planAction: "create" });
  });

  it("the state read never annotates", async () => {
    const result = normalizeObservation(await describeResources(await options("state"), withCreate()));
    expect(result.annotations).toBeUndefined();
  });

  it("lifecycle plan still proposes the create", async () => {
    const opts = await options();
    const result = normalizeObservation(await describeResources(opts, withCreate()));
    const set = buildChangeSet("prod", {
      declared: new Set(opts.entityNames),
      observedNow: result.resources,
      observedThen: undefined,
      unobserved: result.unobserved,
    });
    expect(set.entries.find((e) => e.name === CREATED)?.action).toBe("create");
    expect(set.entries.find((e) => e.name === "app/terraform_data.replaced")?.action).not.toBe("create");
  });

  it("chant search matches it on the overlay, which still paints it pending", async () => {
    const opts = await options();
    const result = normalizeObservation(await describeResources(opts, withCreate()));
    const live = buildLiveGraphIr([{ lexicon: "terraform", resources: result.resources }]);
    const declared: GraphIR = {
      ...live,
      nodes: opts.entityNames.map((id) => ({ id, kind: opts.entities.get(id)!.entityType, lexicon: "terraform", attrs: {} })),
      edges: [],
    };
    const overlaid = sourceOverlayGraphs(declared, live, {});
    const ir = { ...overlaid, nodes: carryAnnotations(overlaid.nodes, result.annotations) };
    const node = ir.nodes.find((n) => n.id === CREATED)!;
    expect(node.attrs._status).toBe("accent");
    expect(node.physicalId).toBeUndefined();

    const { parseQuery, matchTerm } = __searchInternals;
    const search = (query: string) =>
      ir.nodes
        .filter((n) => parseQuery(query).every((t) => matchTerm(n, t, ir)))
        .map((n) => n.id)
        .sort();
    expect(search("attr:planAction=create")).toEqual([CREATED]);
    // A replace's new id is unknown too, so the create is one of three.
    expect(search("attr:planAfterUnknown=id")).toEqual(["app/shell_script.conf", CREATED, "app/terraform_data.replaced"]);
  });
});

describe("which read answered is on the wire: \"plan\" (#2267, #4358)", () => {
  it("every entity of a plan-depth root reads \"plan\", whatever its verdict", async () => {
    const opts = await options();
    const result = normalizeObservation(await describeResources(opts, deps()));
    expect(Object.keys(result.sources).sort()).toEqual([...opts.entityNames].sort());
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["plan"]));
    expect(result.notes.join("\n")).toMatch(/app: the plan read answered \(`terraform plan -input=false -lock=false .*-out=<tmp>\/plan\.tfplan`\)/);
  });

  it("the default depth is still the state read, and never calls the plan read", async () => {
    const result = normalizeObservation(
      await describeResources(await options(undefined), deps({ init: (async () => ({ dir: ROOT_DIR })) as TerraformReadDeps["init"], planRead: never })),
    );
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["state"]));
    const replaced = result.resources["app/terraform_data.replaced"]!.attributes as Record<string, unknown>;
    expect(replaced.planAction).toBeUndefined();
  });

  it(`${TERRAFORM_OBSERVE_ENV}=plan selects the plan depth for one run`, async () => {
    process.env[TERRAFORM_OBSERVE_ENV] = "plan";
    const result = normalizeObservation(await describeResources(await options(undefined), deps()));
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["plan"]));
    expect(result.rootReads).toEqual({ "terraform.roots.app": { depth: "plan" } });
  });
});

describe("the plan depth falls back by depth, and says which read answered (#4358)", () => {
  it("an uninitialised root is refused with the init line, and nothing else is read", async () => {
    const initLine = `terraform -chdir=${ROOT_DIR} init -input=false`;
    const err = new TerraformPlanReadError(
      "not-initialised",
      `terraform.roots.app (${ROOT_DIR}) has never been initialised: run \`${initLine}\` first. chant never runs init on a read, since init writes into the root.`,
      ROOT_DIR,
      initLine,
    );
    const result = normalizeObservation(await describeResources(await options(), deps({ planRead: planFails(err), show: never, init: never })));
    expect(Object.keys(result.resources)).toEqual([]);
    const replaced = result.unobserved["app/terraform_data.replaced"]!;
    expect(replaced.reason).toBe("no-binding");
    expect(replaced.detail).toContain(initLine);
    expect(replaced.detail).toContain("declared only");
    expect(result.sources["app/terraform_data.replaced"]).toBe("plan");
    expect(result.notes.join("\n")).toMatch(/no read answered, declared only \(the root needs init/);
    expect(result.rootReads).toEqual({ "terraform.roots.app": { depth: "plan", fellBackTo: "declared", reason: "needs-init" } });
  });

  it("missing provider credentials fall back to the state read, which answers without plan attributes", async () => {
    const err = new TerraformPlanReadError(
      "plan",
      "terraform plan failed in /x: Error: No valid credential sources found",
      ROOT_DIR,
    );
    const result = normalizeObservation(await describeResources(await options(), deps({ planRead: planFails(err) })));
    const replaced = result.resources["app/terraform_data.replaced"]!;
    expect(replaced.ownership).toBe("owned");
    expect((replaced.attributes as Record<string, unknown>).planAction).toBeUndefined();
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["state"]));
    expect(result.notes.join("\n")).toMatch(/the plan read failed \(no provider credentials: .*\), so the state read answered/);
    expect(result.rootReads).toEqual({ "terraform.roots.app": { depth: "plan", fellBackTo: "state", reason: "no-credentials" } });
  });

  it("missing backend access falls back to declared only, and the state read is never tried", async () => {
    const err = new TerraformPlanReadError(
      "backend",
      "terraform plan failed in /x: Error: Failed to get existing workspaces: AccessDenied",
      ROOT_DIR,
    );
    const result = normalizeObservation(await describeResources(await options(), deps({ planRead: planFails(err), show: never })));
    expect(Object.keys(result.resources)).toEqual([]);
    const replaced = result.unobserved["app/terraform_data.replaced"]!;
    expect(replaced.detail).toMatch(/declared only\. .*Failed to get existing workspaces.*The state read needs the same backend/);
    expect(result.notes.join("\n")).toMatch(/no read answered, declared only \(the plan read could not reach the backend\)/);
    expect(result.rootReads).toEqual({ "terraform.roots.app": { depth: "plan", fellBackTo: "declared", reason: "backend-unreachable" } });
  });

  it("a state read that fails after the plan read is declared only too, never absent", async () => {
    const err = new TerraformPlanReadError("plan", "terraform plan failed in /x: Error: Invalid provider configuration", ROOT_DIR);
    const show = (async () => {
      throw new Error("Error: error loading state");
    }) as TerraformReadDeps["show"];
    const result = normalizeObservation(await describeResources(await options(), deps({ planRead: planFails(err), show })));
    expect(Object.keys(result.resources)).toEqual([]);
    expect(result.unobserved["app/terraform_data.replaced"]!.reason).toBe("read-failed");
    expect(result.unobserved["app/terraform_data.replaced"]!.detail).toMatch(/The plan read failed .* and the state read after it failed too/);
  });

  it("names a credentials failure as one", () => {
    expect(planFailureIsCredentials("Error: No valid credential sources found")).toBe(true);
    expect(planFailureIsCredentials("Error: Invalid reference")).toBe(false);
  });
});

describe("sensitive values never reach the IR (#4358)", () => {
  it("not anywhere in the recorded plan's observation", async () => {
    const result = await describeResources(await options(), deps());
    expect(readFileSync(join(fixtures, "show-plan.json"), "utf-8")).toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const updated = normalizeObservation(result).resources["app/terraform_data.updated"]!.attributes as Record<string, unknown>;
    // `input.token` is flagged; `output.token` carries the same value
    // unflagged, and is redacted because it equals a flagged one.
    expect(JSON.stringify(updated.planChanges)).not.toContain(SECRET);
  });

  it("a sensitive value nested in a map is redacted on both sides, and its siblings are not", () => {
    const changes = diffChange(
      {
        before: { tags: { team: "core", password: "pw-old" }, name: "a" },
        after: { tags: { team: "edge", password: "pw-new" }, name: "a" },
        before_sensitive: { tags: { password: true } },
        after_sensitive: { tags: { password: true } },
        after_unknown: {},
      },
      new Set(),
    );
    expect(changes).toEqual([
      { path: "tags.password", before: SENSITIVE_VALUE, after: SENSITIVE_VALUE },
      { path: "tags.team", before: "core", after: "edge" },
    ]);
  });

  it("a whole map flagged sensitive is one redacted entry, never walked", () => {
    const changes = diffChange(
      { before: { env: { A: "1" } }, after: { env: { A: "2", B: "3" } }, before_sensitive: { env: true }, after_sensitive: { env: true } },
      new Set(),
    );
    expect(changes).toEqual([{ path: "env", before: SENSITIVE_VALUE, after: SENSITIVE_VALUE }]);
  });

  it("a sensitive leaf under a map that becomes unknown stays redacted", () => {
    const changes = diffChange(
      { before: { out: { user: "u", pass: "p4ss" } }, after: {}, before_sensitive: { out: { pass: true } }, after_unknown: { out: true } },
      new Set(),
    );
    expect(changes).toEqual([
      { path: "out.pass", before: SENSITIVE_VALUE, after: KNOWN_AFTER_APPLY },
      { path: "out.user", before: "u", after: KNOWN_AFTER_APPLY },
    ]);
  });

  it("a drift entry follows the same rule", () => {
    const index = indexPlan({
      resource_drift: [
        {
          address: "x.y",
          change: {
            actions: ["update"],
            before: { labels: { secret: "s-1", app: "web" } },
            after: { labels: { secret: "s-2", app: "api" } },
            before_sensitive: { labels: { secret: true } },
            after_sensitive: { labels: { secret: true } },
          },
        },
      ],
    });
    expect(JSON.stringify([...index.drift.values()])).not.toMatch(/s-1|s-2/);
  });
});
