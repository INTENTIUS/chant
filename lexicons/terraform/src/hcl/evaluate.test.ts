/**
 * Arguments evaluated from the files a plan reads (chant #5117).
 *
 * `src/__fixtures__/resolved-arguments/` holds trimmed copies of two cases
 * from kubernetes/k8s.io (Apache-2.0): a Workload Identity service account
 * made through a `for_each` module call over a local map, whose project id
 * comes through another module's output, and a GKE cluster named through a
 * local and a module variable. `build-trusted/extras.tf` is not from that
 * repository; it holds arguments that must stay unresolved.
 */

import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGraphIr, withInstanceNodes, type GraphIR, type IRNode } from "@intentius/chant/graph-ir";
import type { Declarable } from "@intentius/chant/declarable";
import { renderTerraformRoots } from "./roots";
import { RootEvaluator, evaluateArguments, firstUnknown, isUnknown } from "./evaluate";
import { terraformDeclaredNode } from "../behaviour/reference-catalog";
import { terraformEntity, RESOURCE_TYPE, VARIABLE_TYPE, LOCALS_TYPE, MODULE_TYPE, OUTPUT_TYPE } from "./parse";

const TREE = join(import.meta.dirname, "..", "__fixtures__", "resolved-arguments");
const SA_BLOCK = "bt/module.workload_identity_service_accounts/google_service_account.serviceaccount";
const SA = (key: string) => `bt/module.workload_identity_service_accounts["${key}"]/google_service_account.serviceaccount`;
const CLUSTER = "bt/module.prow_build_cluster/google_container_cluster.prod_cluster";

let ir: GraphIR;
let byId: Map<string, IRNode>;
const view = (id: string) => {
  const n = byId.get(id);
  expect(n, id).toBeDefined();
  return terraformDeclaredNode(n!, n!.instanceOf ? byId.get(n!.instanceOf) : undefined);
};
const evaluatedOf = (id: string) => (byId.get(id)!.attrs as { evaluated?: Record<string, unknown> }).evaluated;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({ projectRoot: TREE, roots: { bt: { dir: "./build-trusted" } } });
  expect(rendered.warnings).toEqual([]);
  const entities: Map<string, Declarable> = rendered.entities;
  ir = withInstanceNodes(buildGraphIr(entities), entities);
  byId = new Map(ir.nodes.map((n) => [n.id, n]));
});

describe("the Workload Identity service account", () => {
  it("expands the module call over a local map whose values interpolate another local", () => {
    expect(ir.nodes.filter((n) => n.instanceOf === SA_BLOCK).map((n) => n.id).sort()).toEqual([
      SA("gcb-builder"),
      SA("kubernetes-external-secrets"),
      SA("prow-build-trusted"),
    ]);
  });

  it("resolves account_id from each.key and project through the gke-project module's output", () => {
    expect(view(SA("prow-build-trusted"))).toEqual({
      kind: "google_service_account",
      attrs: { account_id: "prow-build-trusted", project: "k8s-infra-prow-build-trusted" },
      nonLiteral: 1,
    });
    expect(view(SA("gcb-builder"))?.attrs).toEqual({ account_id: "gcb-builder", project: "k8s-infra-prow-build-trusted" });
  });

  it("reads no arguments on the block node, so a value is matched once, on its instance", () => {
    expect(view(SA_BLOCK)).toEqual({ kind: "google_service_account", attrs: {}, nonLiteral: 0 });
  });

  it("names what stopped display_name: a comparison this reader does not evaluate", () => {
    const at = (evaluatedOf(SA_BLOCK)!.instances as Record<string, { stopped?: Record<string, string> }>)[
      'module.workload_identity_service_accounts["prow-build-trusted"].google_service_account.serviceaccount'
    ];
    expect(at?.stopped?.display_name).toMatch(/^module\.workload_identity_service_accounts\["prow-build-trusted"\]\.var\.description != ""/);
  });
});

describe("the GKE cluster", () => {
  it("resolves name from a local through the gke-cluster module's variable", () => {
    expect(view(CLUSTER)).toEqual({
      kind: "google_container_cluster",
      attrs: { name: "prow-build-trusted", location: "us-central1", project: "k8s-infra-prow-build-trusted" },
      nonLiteral: 1,
    });
  });
});

describe("arguments that stay not literal", () => {
  it("names a data source", () => {
    expect(view("bt/google_storage_bucket.from_data")).toEqual({ kind: "google_storage_bucket", attrs: { location: "US" }, nonLiteral: 1 });
    expect(evaluatedOf("bt/google_storage_bucket.from_data")).toEqual({ stopped: { name: "data.google_organization.org.org_id" } });
  });

  it("names timestamp()", () => {
    expect(evaluatedOf("bt/google_storage_bucket.dated")).toEqual({ stopped: { name: "timestamp()" } });
  });

  it("names an attribute the provider computes, inside the module that has it", () => {
    expect(evaluatedOf("bt/google_project_iam_member.computed")).toEqual({
      arguments: { project: "k8s-infra-prow-build-trusted" },
      stopped: { member: 'module.workload_identity_service_accounts["gcb-builder"].google_service_account.serviceaccount.email' },
    });
    expect(view("bt/google_project_iam_member.computed")?.nonLiteral).toBe(1);
  });

  it("names a data source in a child module with the module path in front", () => {
    expect((evaluatedOf("bt/module.project/google_project.project")!.stopped as Record<string, string>).org_id).toBe(
      "module.project.data.google_organization.org.org_id",
    );
  });
});

describe("RootEvaluator", () => {
  const entity = (key: string, type: string, address: string, body: Record<string, unknown>) =>
    [key, terraformEntity(type, address, body, "main.tf", "r")] as [string, Declarable];

  it("reads tfvars over a default, leaves a sensitive variable unknown, and stops on a cycle", () => {
    const entities = new Map<string, Declarable>([
      entity("r/var.region", VARIABLE_TYPE, "var.region", { default: "us-east1" }),
      entity("r/var.token", VARIABLE_TYPE, "var.token", { default: "(sensitive)", sensitive: true }),
      entity("r/locals", LOCALS_TYPE, "locals", { a: "${local.b}", b: "${local.a}", m: { x: 1 } }),
    ]);
    const ev = new RootEvaluator(entities, "r", new Map([["region", "eu-west1"]]));
    const place = ev.rootPlace();
    expect(ev.value("${var.region}-${local.m.x}", { place })).toBe("eu-west1-1");
    expect((ev.value("${var.token}", { place }) as { ref: string }).ref).toBe("var.token");
    expect(isUnknown(ev.value("${local.a}", { place }))).toBe(true);
  });

  it("evaluates lookup with a default, a bool conditional, toset, length and an index step", () => {
    const entities = new Map<string, Declarable>([
      entity("r/var.on", VARIABLE_TYPE, "var.on", { default: true }),
      entity("r/locals", LOCALS_TYPE, "locals", { m: { a: { n: "x" } }, l: ["b", "a", "b"] }),
    ]);
    const ev = new RootEvaluator(entities, "r");
    const place = ev.rootPlace();
    expect(ev.value('${lookup(local.m.a, "n", "d")}', { place })).toBe("x");
    expect(ev.value('${lookup(local.m.a, "z", "d")}', { place })).toBe("d");
    expect(ev.value("${var.on ? 1 : 0}", { place })).toBe(1);
    expect(ev.value("${toset(local.l)}", { place })).toEqual(["a", "b"]);
    expect(ev.value("${length(local.l)}", { place })).toBe(3);
    expect(ev.value('${local.m["a"].n}', { place })).toBe("x");
    expect(ev.value("a $${literal} b", { place })).toBe("a ${literal} b");
    expect((ev.value("${merge(local.m, {})}", { place }) as { ref: string }).ref).toBe("merge()");
  });

  it("follows a module output to the child's resource argument, and a sensitive output stays unknown", () => {
    const entities = new Map<string, Declarable>([
      entity("r/module.c", MODULE_TYPE, "module.c", { source: "./c", n: "from-root" }),
      entity("r/module.c/var.n", VARIABLE_TYPE, "var.n", {}),
      entity("r/module.c/aws_s3_bucket.b", RESOURCE_TYPE, "aws_s3_bucket.b", { bucket: "${var.n}-bucket" }),
      entity("r/module.c/output.name", OUTPUT_TYPE, "output.name", { value: "${aws_s3_bucket.b.bucket}" }),
      entity("r/module.c/output.secret", OUTPUT_TYPE, "output.secret", { value: "${var.n}", sensitive: true }),
    ]);
    const ev = new RootEvaluator(entities, "r");
    const place = ev.rootPlace();
    expect(ev.value("${module.c.name}", { place })).toBe("from-root-bucket");
    expect((ev.value("${module.c.secret}", { place }) as { ref: string }).ref).toBe("module.c.output.secret");
  });

  it("gives a variable the value its call passes, per count and for_each instance and through a nested call (#5094)", () => {
    const entities = new Map<string, Declarable>([
      entity("r/locals", LOCALS_TYPE, "locals", { envs: { prod: { zone: "a" }, test: { zone: "b" } } }),
      entity("r/module.n", MODULE_TYPE, "module.n", { source: "./n", count: 2, name: "pool-${count.index}" }),
      entity("r/module.n/var.name", VARIABLE_TYPE, "var.name", {}),
      entity("r/module.e", MODULE_TYPE, "module.e", { source: "./e", for_each: "${local.envs}", cluster_name: "${each.key}-${each.value.zone}" }),
      entity("r/module.e/var.cluster_name", VARIABLE_TYPE, "var.cluster_name", {}),
      entity("r/module.e/module.inner", MODULE_TYPE, "module.inner", { source: "./inner", name: "${var.cluster_name}" }),
      entity("r/module.e/module.inner/var.name", VARIABLE_TYPE, "var.name", { default: "unused" }),
    ]);
    const ev = new RootEvaluator(entities, "r");
    const at = (scope: string) => {
      const place = ev.placeOfInstanceScope(scope);
      expect(place, scope).toBeDefined();
      return place!;
    };
    expect(ev.value("${var.name}", { place: at("module.n[0]") })).toBe("pool-0");
    expect(ev.value("${var.name}", { place: at("module.n[1]") })).toBe("pool-1");
    expect(ev.value("${var.cluster_name}", { place: at('module.e["prod"]') })).toBe("prod-a");
    expect(ev.value("${var.name}", { place: at('module.e["test"].module.inner') })).toBe("test-b");
    // A block-level read stands for every instance, so the key stays unknown and is named.
    expect((ev.value("${var.cluster_name}", { place: ev.placeOfScope("r/module.e")! }) as { ref: string }).ref).toBe("each.key");
  });

  it("keeps a map's known entries beside an unknown one, and reports the first unknown", () => {
    const ev = new RootEvaluator(new Map(), "r");
    const out = evaluateArguments({ tags: { a: "x", b: "${data.d.e.f}" }, plain: "${var.nope}" }, (raw) => ev.value(raw, { place: ev.rootPlace() }));
    expect(out).toEqual({ stopped: { "tags.b": "data.d.e.f", plain: "var.nope" } });
    expect(firstUnknown({ a: [1, ev.value("${data.x.y.z}", { place: ev.rootPlace() })] })?.ref).toBe("data.x.y.z");
  });
});
