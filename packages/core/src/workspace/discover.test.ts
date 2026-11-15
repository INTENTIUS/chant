/**
 * `chant workspace graph <dir> --discover` (#5095): the walk, the module rule,
 * ties, member names and the in-memory declaration. These read files only;
 * `discover.e2e.test.ts` reads a directory through the lexicons.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, repo, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { parseDeclaration } from "./declaration";
import { declares, discover, discoveredMemberNames, discoveredTree, discoveryKinds, kindPackagesBeside, localModuleSources, locateDiscovered, type DiscoveryKinds } from "./discover";
import { planGraph, workspaceGraph } from "./graph-cli";
import { createKindRegistry, type MemberKind } from "./kinds";
import { workingTree } from "./tree";

afterAll(cleanScratch);

const kind = (name: string, precedence: number, anyFile: string[]): MemberKind => ({
  name,
  description: name,
  probe: { anyFile },
  precedence,
  shape: "member",
  outputs: { from: "declared", names: [] },
  source: `@test/${name}`,
});

/** Kinds that need no package: terraform by `*.tf`, and two that tie on `*.sql`. */
const KINDS: DiscoveryKinds = {
  registry: createKindRegistry([kind("terraform", 400, ["*.tf"]), kind("migrate-a", 300, ["*.sql"]), kind("migrate-b", 300, ["*.sql"]), kind("charts", 330, ["Chart.yaml"])]),
  packages: [
    { package: "@test/charts", version: "2.0.0", dir: "/nowhere" },
    { package: "@test/terraform", version: "1.0.0", dir: "/nowhere" },
  ],
  problems: [],
};

/** Every path under `root` with its kind, mode, size and content hash. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const at = rel ? `${rel}/${name}` : name;
      const st = statSync(path);
      if (st.isDirectory()) {
        out.push(`d ${at} ${st.mode}`);
        walk(path, at);
      } else {
        out.push(`f ${at} ${st.mode} ${st.size} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(root, "");
  return out;
}

describe("localModuleSources", () => {
  test("reads local sources in module blocks only, past comments and nested blocks", () => {
    const text = [
      'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}',
      'module "vpc" {\n  # source = "./not-this"\n  source = "../modules/vpc"\n  tags = { a = "}" }\n}',
      'module "reg" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.0.0"\n}',
      'module "git" {\n  source = "git::https://example.com/m.git//sub"\n}',
      'module "here" {\n  dynamic "x" {\n    content {\n      source = "./inner"\n    }\n  }\n  source = "./here"\n}',
      '/* module "c" {\n  source = "./commented"\n} */',
      'resource "null_resource" "r" {\n  provisioner "file" {\n    source = "./files"\n  }\n}',
    ].join("\n\n");
    expect(localModuleSources(text)).toEqual(["../modules/vpc", "./here"]);
  });
});

describe("discoveredMemberNames", () => {
  test("names come from the path alone: / and other runs become -, . is root", () => {
    const names = discoveredMemberNames([".", "infra/net", "argo", "infra/gcp/terraform/k8s-infra-prow-build-trusted", "A/b", "a-b", "x.k8s.io"]);
    expect(names.get(".")).toBe("root");
    expect(names.get("infra/net")).toBe("infra-net");
    expect(names.get("argo")).toBe("argo");
    expect(names.get("x.k8s.io")).toBe("x-k8s-io");
    // Too long: the head of the name and a digest of the path.
    const long = names.get("infra/gcp/terraform/k8s-infra-prow-build-trusted")!;
    expect(long).toMatch(/^infra-gcp-terraform-k8s-infra-pro-[0-9a-f]{6}$/);
    expect(long.length).toBeLessThanOrEqual(40);
    // Shared after the rewrite: both carry a digest, so neither depends on the other being listed first.
    expect(names.get("A/b")).toMatch(/^a-b-[0-9a-f]{6}$/);
    expect(names.get("a-b")).toMatch(/^a-b-[0-9a-f]{6}$/);
    expect(names.get("A/b")).not.toBe(names.get("a-b"));
    for (const n of names.values()) expect(n).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    // The same path gets the same name on another walk.
    expect(discoveredMemberNames(["infra/gcp/terraform/k8s-infra-prow-build-trusted"]).get("infra/gcp/terraform/k8s-infra-prow-build-trusted")).toBe(long);
  });
});

describe("discover", () => {
  const FX = {
    "infra/net/main.tf": 'provider "aws" {}\n\nresource "aws_vpc" "main" {}\n\nmodule "vpc" {\n  source = "../modules/vpc"\n}\n',
    "infra/modules/vpc/main.tf": 'resource "aws_subnet" "a" {}\n',
    "infra/net/extra/main.tf": 'resource "aws_eip" "x" {}\n',
    "db/V1__init.sql": "create table t ();\n",
    "charts/web/Chart.yaml": "name: web\n",
    "node_modules/pkg/main.tf": 'resource "x" "y" {}\n',
    ".git-like/main.tf": 'resource "x" "y" {}\n',
  };

  test("members, modules, ties and nested roots, in the discovered list and the declaration", () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, FX);
    const found = discover(workingTree(root), KINDS, "fx");
    expect(found.entries.map((e) => [e.dir, e.outcome, e.member, e.kind, e.claims.map((c) => c.kind)])).toEqual([
      ["charts/web", "member", "charts-web", "charts", ["charts"]],
      ["db", "tie", null, null, ["migrate-a", "migrate-b"]],
      ["infra/modules/vpc", "module", null, "terraform", ["terraform"]],
      ["infra/net", "member", "infra-net", "terraform", ["terraform"]],
      ["infra/net/extra", "inside-member", null, "terraform", ["terraform"]],
    ]);
    const tie = found.entries.find((e) => e.dir === "db")!;
    expect(tie).toMatchObject({ source: null, probe: null });
    expect(tie.note).toContain("migrate-a and migrate-b");
    expect(found.entries.find((e) => e.dir === "infra/modules/vpc")!.note).toContain("infra/net");
    expect(found.entries.find((e) => e.dir === "infra/net")!.probe).toEqual({ anyFile: ["*.tf"] });

    // The declaration is a real one, and pins only the packages whose kinds it uses.
    const decl = parseDeclaration(found.declaration, "chant.workspace.json");
    expect(decl.name).toBe("fx");
    expect(decl.members.map((m) => [m.name, m.dir, m.kind])).toEqual([
      ["charts-web", "charts/web", "charts"],
      ["infra-net", "infra/net", "terraform"],
    ]);
    expect(decl.pins.map((p) => [p.package, p.version])).toEqual([
      ["@test/charts", "2.0.0"],
      ["@test/terraform", "1.0.0"],
    ]);
  });

  test("a root at <dir> itself is member . and may hold the others", () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, { "main.tf": 'resource "a" "b" {}\n', "sub/main.tf": 'resource "c" "d" {}\n' });
    const found = discover(workingTree(root), KINDS, "fx");
    expect(found.entries.map((e) => [e.dir, e.outcome, e.member])).toEqual([
      [".", "member", "root"],
      ["sub", "member", "sub"],
    ]);
  });

  test("a module source that leaves <dir> is not followed, and a symlinked directory is not walked", () => {
    const root = scratchDir("chant-discover-");
    const outside = scratchDir("chant-discover-outside-");
    writeFiles(outside, { "main.tf": 'resource "x" "y" {}\n' });
    writeFiles(root, { "net/main.tf": 'module "m" {\n  source = "../../elsewhere"\n}\n' });
    symlinkSync(outside, join(root, "linked"), "dir");
    const where = locateDiscovered(root);
    expect(discover(where.base, KINDS, "fx").entries.map((e) => [e.dir, e.outcome])).toEqual([["net", "member"]]);
  });

  test("the walk writes nothing", () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, FX);
    const before = snapshot(root);
    discover(locateDiscovered(root).base, discoveryKinds(), "fx");
    expect(snapshot(root)).toEqual(before);
  });
});

describe("the declaration laid over the tree", () => {
  test("shows chant.workspace.json at the root and reads everything else through", () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, { "a/main.tf": "x\n" });
    const tree = discoveredTree(workingTree(root), '{"name":"fx","schema":1,"members":[]}\n');
    expect(declares(workingTree(root))).toBe(false);
    expect(declares(tree)).toBe(true);
    expect(tree.list("")!.map((e) => e.name).sort()).toEqual(["a", "chant.workspace.json"]);
    expect(tree.read("a/main.tf")).toBe("x\n");
    expect(tree.list("a")).toEqual([{ name: "main.tf", type: "file" }]);
  });
});

describe("kinds beside the running chant", () => {
  test("come from the installed @intentius packages that publish workspace kinds", () => {
    const names = kindPackagesBeside().map((p) => p.package);
    expect(names).toContain("@intentius/chant-lexicon-terraform");
    expect(names).toContain("@intentius/chant-lexicon-k8s");
    const kinds = discoveryKinds();
    expect(kinds.registry.get("terraform")?.source).toBe("@intentius/chant-lexicon-terraform");
    expect(kinds.registry.get("argo-app")?.source).toBe("@intentius/chant-lexicon-k8s");
  });
});

describe("workspace graph without a declaration", () => {
  test("fails with declaration-missing unless --discover is given", async () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, { "infra/net/main.tf": 'resource "aws_vpc" "main" {}\n' });
    const { doc, failed } = await workspaceGraph({ cwd: root });
    expect(failed).toBe(true);
    expect("error" in doc && doc.error.code).toBe("declaration-missing");
  });

  test("--discover --dry-run plans the discovered members", () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, { "infra/net/main.tf": 'resource "aws_vpc" "main" {}\n', "argo/app.yaml": "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: web\n" });
    const plan = planGraph({ cwd: root, discover: true });
    expect(plan.groups.flatMap((g) => g.units.map((u) => [u.member, u.kind, u.dir]))).toEqual([
      ["argo", "argo-app", "argo"],
      ["infra-net", "terraform", "infra/net"],
    ]);
  });

  test("--discover --at discovers in the commit's tree under <dir>", () => {
    const top = repo({ "estate/infra/net/main.tf": 'resource "aws_vpc" "main" {}\n', "estate/argo/app.yaml": "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: web\n" }, true);
    rmSync(join(top, "estate", "argo"), { recursive: true });
    const root = join(top, "estate");
    expect(planGraph({ cwd: root, discover: true }).groups.flatMap((g) => g.units.map((u) => u.member))).toEqual(["infra-net"]);
    expect(planGraph({ cwd: root, discover: true, at: "HEAD" }).groups.flatMap((g) => g.units.map((u) => u.member))).toEqual(["argo", "infra-net"]);
    expect(locateDiscovered(root, "HEAD").root).toBe("estate");
  });

  test("with a declaration in <dir>, --discover reads it as declared", () => {
    const root = scratchDir("chant-discover-");
    writeFiles(root, { "chant.workspace.json": '{"name":"declared","schema":1,"members":[{"name":"docs","dir":"docs","kind":"other","because":"prose"}]}\n', "docs/main.tf": "x\n" });
    const plan = planGraph({ cwd: root, discover: true });
    expect(plan.workspace.name).toBe("declared");
    expect(plan.skipped.map((s) => s.name)).toEqual(["docs"]);
  });
});
