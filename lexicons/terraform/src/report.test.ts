/**
 * `chant terraform report`, against a hand-built composed plan in the shape of
 * choudoufu's `show -json`: three module calls (network, app, edge), a subnet
 * whose id the plan cannot know, a security group placed in it, an in-place
 * update, and a sensitive value. The post-apply plan carries the state.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import { describe, expect, test } from "vitest";
import { verifyChangeSetDigest } from "@intentius/chant/change-set";
import { addToIndex, atmosOutputReads, atmosStackReads, dirStore, estateOfDir, httpStore, moduleEstates, runFactsFromEnv, slicePlan, terraformReport, topModule, writeReport } from "./report";
import { parseReportArgs } from "./commands";
import { generateReportFixture } from "./__fixtures__/report/generate";
import { readdirSync } from "node:fs";

const rc = (address: string, module: string, type: string, name: string, actions: string[], change: Record<string, unknown>) => ({
  address, module_address: module, mode: "managed", type, name, provider_name: "registry.terraform.io/hashicorp/aws", change: { actions, ...change },
});

const PLAN = {
  format_version: "1.2",
  resource_changes: [
    rc("module.network.aws_subnet.new", "module.network", "aws_subnet", "new", ["create"], {
      before: null, after: { cidr_block: "10.0.9.0/24", tags: { Name: "new" } }, after_unknown: { id: true, arn: true }, after_sensitive: {},
    }),
    rc("module.network.aws_vpc.main", "module.network", "aws_vpc", "main", ["update"], {
      before: { cidr_block: "10.0.0.0/16", enable_dns_support: true }, after: { cidr_block: "10.0.0.0/16", enable_dns_support: false }, after_unknown: {}, before_sensitive: {}, after_sensitive: {},
    }),
    rc("module.app.aws_security_group.sg", "module.app", "aws_security_group", "sg", ["create"], {
      before: null, after: { name: "tgc-sg" }, after_unknown: { id: true, vpc_id: true }, after_sensitive: { password: true },
    }),
    rc("module.edge.aws_route_table.rt", "module.edge", "aws_route_table", "rt", ["delete", "create"], {
      before: { vpc_id: "vpc-1" }, after: { vpc_id: "vpc-2" }, after_unknown: {}, replace_paths: [["vpc_id"]], before_sensitive: {}, after_sensitive: {},
    }),
    rc("module.edge.aws_route.keep", "module.edge", "aws_route", "keep", ["no-op"], { before: { x: 1 }, after: { x: 1 }, after_unknown: {} }),
  ],
};

const AFTER = {
  format_version: "1.2",
  resource_changes: [],
  prior_state: {
    values: {
      root_module: {
        child_modules: [
          { address: "module.network", resources: [{ address: "module.network.aws_subnet.new", values: { id: "subnet-123", arn: "arn:aws:ec2:::subnet-123" }, sensitive_values: {} }] },
          { address: "module.app", resources: [{ address: "module.app.aws_security_group.sg", values: { id: "sg-9", vpc_id: "vpc-2" }, sensitive_values: { vpc_id: true } }] },
        ],
      },
    },
  },
};

const RUN = { project: "forgejo:3000/admin/demo-terragrunt-choudoufu", commit: "abc123", job_url: "http://forgejo:3000/admin/x/actions/runs/7", pull_request: "4" };
const FINISHED = "2026-10-24T10:00:00Z";
const base = { plan: PLAN, run: RUN, binary: "choudoufu", rootDir: "estates", finished: FINISHED };

const changeOf = (report: any, root: string, address: string) => report.roots.find((r: any) => r.path === root).changes.find((c: any) => c.address === address);

describe("slicing the composed plan", () => {
  test("a module is taken off the addresses", () => {
    expect(topModule("module.network.aws_subnet.new")).toBe("network");
    expect(topModule("module.net[0].module.inner")).toBe("net");
    expect(topModule("aws_vpc.main")).toBeUndefined();
    const s = slicePlan(PLAN, "network") as any;
    expect(s.resource_changes.map((r: any) => r.address)).toEqual(["aws_subnet.new", "aws_vpc.main"]);
    expect(s.resource_changes[0].module_address).toBeUndefined();
  });
});

describe("terraformReport, tf-plan", () => {
  const { report, path, row } = terraformReport({ ...base, stage: "tf-plan" });
  const r = report as any;

  test("one root per module, in the roots' directory, as one composed wave", () => {
    expect(r.schema).toBe("terragucci.report/v1");
    expect(r.roots.map((x: any) => x.path)).toEqual(["estates/app", "estates/edge", "estates/network"]);
    expect(r.roots.every((x: any) => x.status === "planned" && x.composed.wave === 1)).toBe(true);
    expect(r.roots.find((x: any) => x.path === "estates/network").composed.module).toBe("module.network");
    expect(r.waves).toHaveLength(1);
    expect(r.waves[0].roots).toEqual(["estates/app", "estates/edge", "estates/network"]);
    expect(r.waves[0].state).toBe("planned");
    expect(r.waves[0].composed.members.map((m: any) => m.module)).toEqual(["module.app", "module.edge", "module.network"]);
    expect(r.compose).toEqual({ roots: ["estates/app", "estates/edge", "estates/network"], max: 3, wave: 1, estate: true });
  });

  test("a value the plan cannot know is unknown, with no after", () => {
    const c = changeOf(r, "estates/network", "aws_subnet.new");
    expect(c.action).toBe("create");
    const id = c.attributes.find((a: any) => a.path === "id");
    expect(id.unknown).toBe(true);
    expect(id.after).toBeUndefined();
    expect(c.attributes.find((a: any) => a.path === "cidr_block").after).toBe("10.0.9.0/24");
  });

  test("an update carries before and after; a no-op is counted but not listed", () => {
    const c = changeOf(r, "estates/network", "aws_vpc.main");
    expect(c.attributes).toEqual([{ path: "enable_dns_support", before: true, after: false }]);
    expect(r.roots.find((x: any) => x.path === "estates/edge").counts).toEqual({ replace: 1, "no-op": 1 });
    expect(changeOf(r, "estates/edge", "aws_route.keep")).toBeUndefined();
  });

  test("totals, named replacements and the index row agree", () => {
    expect(r.totals).toMatchObject({ create: 2, update: 1, replace: 1, delete: 0 });
    expect(r.totals_roots).toBe(3);
    expect(r.named).toEqual([expect.objectContaining({ root: "estates/edge", address: "aws_route_table.rt", action: "replace" })]);
    expect(path).toBe("2026/10/abc123/tf-plan");
    expect(row).toMatchObject({ project: RUN.project, stage: "tf-plan", path, roots: 3, changed: 3, totals: { create: 2, update: 1, replace: 1, delete: 0 }, pull_request: "4", destroys: ["estates/edge: aws_route_table.rt"] });
    expect(row.applied).toBeUndefined();
    expect(r.change_set).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
  });

  test("the same plan gives the same report", () => {
    expect(terraformReport({ ...base, stage: "tf-plan" }).report).toEqual(report);
  });
});

describe("terraformReport, tf-apply", () => {
  const { report, row } = terraformReport({ ...base, stage: "tf-apply", applied: AFTER, finished: "2026-10-24T10:05:00Z" });
  const r = report as any;

  test("the values the plan left unknown are read from the state", () => {
    const id = changeOf(r, "estates/network", "aws_subnet.new").attributes.find((a: any) => a.path === "id");
    expect(id).toEqual({ path: "id", after: "subnet-123" });
    const arn = changeOf(r, "estates/network", "aws_subnet.new").attributes.find((a: any) => a.path === "arn");
    expect(arn.after).toBe("arn:aws:ec2:::subnet-123");
  });

  test("a sensitive value stays unwritten, one the state lacks stays unknown", () => {
    const sg = changeOf(r, "estates/app", "aws_security_group.sg").attributes;
    expect(sg.find((a: any) => a.path === "vpc_id")).toEqual({ path: "vpc_id", sensitive: true });
    expect(sg.find((a: any) => a.path === "id").after).toBe("sg-9");
  });

  test("the wave is applied, with each member's changes done, and the row says when", () => {
    expect(r.waves[0].state).toBe("applied");
    expect(r.waves[0].composed.members.find((m: any) => m.root === "estates/network")).toMatchObject({ apply: "applied", changes: { done: 2, planned: 2 }, state: "written" });
    expect(row.applied).toBe("2026-10-24T10:05:00Z");
    expect(row.path).toBe("2026/10/abc123/tf-apply");
  });

  test("an apply report without the post-apply plan is refused", () => {
    expect(() => terraformReport({ ...base, stage: "tf-apply" })).toThrow(/post-apply plan/);
  });
});

describe("reads between the composed modules", () => {
  const data = (name: string, estate: string, names: string[]) => ({ mode: "data", type: "terraform_estate_outputs", name, expressions: { estate: { constant_value: estate }, names: { constant_value: names } } });
  const CONFIG = {
    root_module: {
      module_calls: {
        network: { module: { outputs: { subnet_id: { expression: { references: ["aws_subnet.new.id", "aws_subnet.new"] } }, cidr: { expression: { references: ["aws_vpc.main.cidr_block", "aws_vpc.main"] } } } } },
        app: {
          module: {
            resources: [data("net", "tgc-network", ["subnet_id", "cidr"]), { mode: "managed", type: "aws_security_group", name: "sg", expressions: { vpc_id: { references: ["data.terraform_estate_outputs.net.values.subnet_id", "data.terraform_estate_outputs.net.values", "data.terraform_estate_outputs.net"] } } }],
            outputs: { sg: { expression: { references: ["aws_security_group.sg.id", "aws_security_group.sg"] } } },
          },
        },
        edge: { module: { resources: [data("app", "tgc-app", ["sg"]), data("elsewhere", "tgc-other", ["x"])] } },
      },
    },
  };
  const ESTATES = { network: "tgc-network", app: "tgc-app", edge: "tgc-edge" };
  const withReads = { ...base, plan: { ...PLAN, configuration: CONFIG }, estates: ESTATES, stage: "tf-plan" as const };
  const r = terraformReport(withReads).report as any;
  const rootReads = (root: string) => r.roots.find((x: any) => x.path === root).reads;

  test("a read of another module's estate is an edge to that module's root, planned and composed", () => {
    expect(rootReads("estates/app")).toEqual([{ upstream: "estates/network", data: "net", outputs: "planned", unknown: ["subnet_id"], composed: true }]);
  });

  test("only the outputs the reader uses count as unknown, and a read of an estate nobody owns is left out", () => {
    expect(rootReads("estates/edge")).toEqual([{ upstream: "estates/app", data: "app", outputs: "planned", unknown: ["sg"], composed: true }]);
    expect(rootReads("estates/network")).toBeUndefined();
  });

  test("an output known at plan time is not listed as unknown", () => {
    const known = terraformReport({ ...withReads, plan: { ...withReads.plan, output_changes: {} } }).report as any;
    expect(known.roots.find((x: any) => x.path === "estates/app").reads[0].unknown).toEqual(["subnet_id"]);
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.root_module.module_calls.app.module.resources[1].expressions.vpc_id.references = ["data.terraform_estate_outputs.net.values.cidr", "data.terraform_estate_outputs.net.values"];
    const only = terraformReport({ ...withReads, plan: { ...PLAN, configuration: cfg } }).report as any;
    expect(only.roots.find((x: any) => x.path === "estates/app").reads[0].unknown).toBeUndefined();
  });

  test("the composed root's planned outputs name unknowns too", () => {
    const plan = { ...PLAN, configuration: { root_module: { module_calls: { app: CONFIG.root_module.module_calls.app } } }, output_changes: { network__vpc_id: { actions: ["create"], after_unknown: true } } };
    const cfg = JSON.parse(JSON.stringify(plan.configuration));
    cfg.root_module.module_calls.app.module.resources[1].expressions.vpc_id.references = ["data.terraform_estate_outputs.net.values.vpc_id", "data.terraform_estate_outputs.net.values"];
    const out = terraformReport({ ...withReads, plan: { ...plan, configuration: cfg } }).report as any;
    expect(out.roots.find((x: any) => x.path === "estates/app").reads[0].unknown).toEqual(["vpc_id"]);
  });

  test("with no estates, or a plan without configuration, no root has reads", () => {
    const none = terraformReport({ ...base, stage: "tf-plan" }).report as any;
    expect(none.roots.some((x: any) => "reads" in x)).toBe(false);
    const bare = terraformReport({ ...base, stage: "tf-plan", estates: ESTATES }).report as any;
    expect(bare.roots.some((x: any) => "reads" in x)).toBe(false);
  });

  test("the estates come from each module's live block", () => {
    const repo = mkdtempSync(join(tmpdir(), "tf-estates-"));
    for (const [m, body] of Object.entries({
      network: 'terraform {\n  live {\n    estate = "tgc-network"\n    record_store "s3" { bucket = "b" }\n  }\n}\n',
      app: '# live { estate = "wrong" }\nterraform {\n  live {\n    estate = "tgc-app"\n  }\n}\n',
      edge: "resource \"x\" \"y\" {}\n",
    })) {
      mkdirSync(join(repo, "estates", m), { recursive: true });
      writeFileSync(join(repo, "estates", m, "main.tf"), body);
    }
    expect(moduleEstates(repo, "estates", ["network", "app", "edge", "gone"])).toEqual({ network: "tgc-network", app: "tgc-app" });
    expect(estateOfDir(join(repo, "nowhere"))).toBeUndefined();
  });
});

describe("reads from an Atmos stack's !terraform.output", () => {
  const STACK = [
    "# One stack, three components.",
    "vars:",
    "  stage: dev",
    "components:",
    "  terraform:",
    "    network:",
    "      vars:",
    "        subnet_a_cidr: 10.0.1.0/24",
    "    app:",
    "      settings:",
    "        depends_on:",
    "          1:",
    "            component: network",
    "      vars:",
    "        vpc_id: !terraform.output network vpc_id",
    "        subnet_id: !terraform.output network dev '.subnet_id' # with a stack",
    "    edge:",
    "      vars:",
    "        listener_port: !terraform.output app listener_port",
    "        cidr: !terraform.output network subnet_a_cidr",
    "        ports:",
    "          - !terraform.output app admin_port",
    "    edge-blue:",
    "      metadata:",
    "        component: edge",
    "      vars:",
    "        extra: !terraform.output network vpc_id",
    "",
  ].join("\n");

  test("each component's reads, by the component directory, outputs sorted", () => {
    expect(atmosOutputReads(STACK)).toEqual({
      app: { network: ["subnet_id", "vpc_id"] },
      edge: { app: ["admin_port", "listener_port"], network: ["subnet_a_cidr", "vpc_id"] },
    });
    expect(atmosOutputReads("components:\n  terraform:\n    a:\n      vars:\n        x: 1\n")).toEqual({});
  });

  test("the stack manifests under atmos.yaml's stacks.base_path, and none without atmos.yaml", () => {
    const repo = mkdtempSync(join(tmpdir(), "tf-atmos-"));
    expect(atmosStackReads(repo)).toEqual({});
    writeFileSync(join(repo, "atmos.yaml"), "base_path: .\ncomponents:\n  terraform:\n    base_path: components/terraform\nstacks:\n  base_path: my-stacks\n  name_template: '{{ .vars.stage }}'\n");
    mkdirSync(join(repo, "my-stacks", "deploy"), { recursive: true });
    writeFileSync(join(repo, "my-stacks", "deploy", "dev.yaml"), STACK);
    expect(atmosStackReads(repo).app).toEqual({ network: ["subnet_id", "vpc_id"] });
  });

  test("a read is an edge to the upstream's root, planned and composed, with the unknown outputs it reads", () => {
    const plan = {
      ...PLAN,
      output_changes: { network__vpc_id: { actions: ["no-op"], after: "vpc-1", after_unknown: false }, network__subnet_id: { actions: ["create"], after_unknown: true } },
    };
    const r = terraformReport({ ...base, rootDir: "components/terraform", plan, stage: "tf-plan", componentReads: atmosOutputReads(STACK) }).report as any;
    const reads = (root: string) => r.roots.find((x: any) => x.path === root).reads;
    expect(reads("components/terraform/app")).toEqual([
      { upstream: "components/terraform/network", data: "network", outputs: "planned", unknown: ["subnet_id"], why: "!terraform.output network: subnet_id, vpc_id", composed: true },
    ]);
    expect(reads("components/terraform/edge").map((x: any) => x.upstream)).toEqual(["components/terraform/app", "components/terraform/network"]);
    expect(reads("components/terraform/network")).toBeUndefined();
  });

  test("an upstream that is no module of the run has no edge", () => {
    const r = terraformReport({ ...base, stage: "tf-plan", componentReads: { app: { vault: ["x"] } } }).report as any;
    expect(r.roots.some((x: any) => "reads" in x)).toBe(false);
  });
});

describe("writing", () => {
  test("report.json, the project's index and the prefix's, merged with an earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-report-"));
    const store = dirStore(dir);
    const plan = terraformReport({ ...base, stage: "tf-plan" });
    const apply = terraformReport({ ...base, stage: "tf-apply", applied: AFTER, finished: "2026-10-24T10:05:00Z" });
    expect(await writeReport(store, plan)).toEqual([`${RUN.project}/2026/10/abc123/tf-plan/report.json`, `${RUN.project}/2026/10/abc123/tf-plan/change-set.json`, `${RUN.project}/index.json`, "index.json"]);
    await writeReport(store, apply);
    await writeReport(store, apply);
    const project = JSON.parse(readFileSync(join(dir, RUN.project, "index.json"), "utf8"));
    expect(project.schema).toBe("terragucci.report-index/v1");
    expect(project.reports.map((x: any) => [x.stage, x.path])).toEqual([["tf-apply", "2026/10/abc123/tf-apply"], ["tf-plan", "2026/10/abc123/tf-plan"]]);
    const top = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(top.reports[1].path).toBe(`${RUN.project}/2026/10/abc123/tf-plan`);
    const stored = JSON.parse(readFileSync(join(dir, RUN.project, "2026/10/abc123/tf-apply/report.json"), "utf8"));
    expect(stored.run.stage).toBe("tf-apply");
  });

  test("an unreadable index starts again from the row", () => {
    expect(addToIndex("{nope", terraformReport({ ...base, stage: "tf-plan" }).row).reports).toHaveLength(1);
  });

  test("the http store reads a 404 as no object and puts unsigned", async () => {
    const seen: string[] = [];
    const objects = new Map<string, string>();
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PUT") {
        objects.set(url, String(init.body));
        return new Response("", { status: 200 });
      }
      return objects.has(url) ? new Response(objects.get(url)!) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const store = httpStore("http://floci:4566/demo-reports/demo/", fake);
    await writeReport(store, terraformReport({ ...base, stage: "tf-plan" }));
    expect(seen[0]).toBe("PUT http://floci:4566/demo-reports/demo/forgejo%3A3000/admin/demo-terragrunt-choudoufu/2026/10/abc123/tf-plan/report.json");
    expect(seen).toContain("GET http://floci:4566/demo-reports/demo/index.json");
    expect(JSON.parse(objects.get("http://floci:4566/demo-reports/demo/index.json")!).reports).toHaveLength(1);
  });
});

const SCHEMA_PATH = join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "workspace", "change-set.schema.json");
const { validate: validateChangeSet } = contract(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__", "report");

/** The change set must validate against chant's schema and be the document the report's digest names. */
function expectChangeSet(doc: any, report: any): void {
  expect(validateChangeSet(doc), JSON.stringify(validateChangeSet.errors, null, 2)).toBe(true);
  expect(verifyChangeSetDigest(doc)).toBe(true);
  expect(report.change_set).toBe(doc.digest);
}

describe("change-set.json beside the report", () => {
  const apply = { ...base, stage: "tf-apply" as const, applied: AFTER, finished: "2026-10-24T10:05:00Z" };

  test.each([["tf-plan", { ...base, stage: "tf-plan" as const }], ["tf-apply", apply]])("%s: the document validates and its digest is the report's", (_stage, input) => {
    const r = terraformReport(input);
    expectChangeSet(r.changeSet, r.report);
  });

  test("--out writes it next to report.json for both stages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-report-cs-"));
    const store = dirStore(dir);
    for (const input of [{ ...base, stage: "tf-plan" as const }, apply]) {
      const r = terraformReport(input);
      await writeReport(store, r);
      const at = join(dir, RUN.project, r.path);
      expect(readdirSync(at).sort()).toEqual(["change-set.json", "report.json"]);
      expectChangeSet(JSON.parse(readFileSync(join(at, "change-set.json"), "utf8")), JSON.parse(readFileSync(join(at, "report.json"), "utf8")));
    }
  });

  test("--to puts it next to report.json for both stages", async () => {
    const objects = new Map<string, string>();
    const fake = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        objects.set(url, String(init.body));
        return new Response("", { status: 200 });
      }
      return objects.has(url) ? new Response(objects.get(url)!) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const store = httpStore("http://floci:4566/demo-reports/demo", fake);
    for (const input of [{ ...base, stage: "tf-plan" as const }, apply]) {
      const r = terraformReport(input);
      await writeReport(store, r);
      const at = `http://floci:4566/demo-reports/demo/${encodeURIComponent("forgejo:3000").replace(/%3A/g, "%3A")}/admin/demo-terragrunt-choudoufu/${r.path}`;
      expectChangeSet(JSON.parse(objects.get(`${at}/change-set.json`)!), JSON.parse(objects.get(`${at}/report.json`)!));
    }
  });
});

describe("the report fixture behold renders", () => {
  const read = (name: string): any => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));

  test("is what the generator writes now; regenerate with `npx tsx lexicons/terraform/src/__fixtures__/report/generate.ts`", async () => {
    const files = await generateReportFixture();
    expect(Object.keys(files).sort()).toEqual(["tf-apply/change-set.json", "tf-apply/report.json", "tf-plan/change-set.json", "tf-plan/report.json"]);
    for (const [name, body] of Object.entries(files)) expect(readFileSync(join(FIXTURE_DIR, name), "utf8"), `${name} is stale`).toBe(body);
  });

  test("both stages validate, and each digest is its report's", () => {
    for (const stage of ["tf-plan", "tf-apply"]) expectChangeSet(read(`${stage}/change-set.json`), read(`${stage}/report.json`));
  });

  test("three members, two composed reads", () => {
    const plan = read("tf-plan/report.json");
    expect(read("tf-plan/change-set.json").members.map((m: any) => m.member)).toEqual(["estates/app", "estates/edge", "estates/network"]);
    const reads = plan.roots.flatMap((r: any) => r.reads ?? []);
    expect(reads.filter((r: any) => r.composed === true).length).toBeGreaterThanOrEqual(2);
  });

  test("an attribute unknown at plan has its value after the apply", () => {
    const attr = (stage: string) => read(`${stage}/report.json`).roots.find((r: any) => r.path === "estates/network").changes.find((c: any) => c.address === "aws_subnet.new").attributes.find((a: any) => a.path === "id");
    expect(attr("tf-plan")).toEqual({ path: "id", unknown: true });
    expect(attr("tf-apply")).toEqual({ path: "id", after: "subnet-0a1b" });
  });
});

describe("the run's facts and the verb's flags", () => {
  test("a Forgejo environment names the project as terragucci does", () => {
    const f = runFactsFromEnv({ GITHUB_REPOSITORY: "admin/demo", GITHUB_SERVER_URL: "http://forgejo:3000", GITHUB_SHA: "deadbeef", GITHUB_RUN_ID: "9", FORGEJO_ACTIONS: "true" }, { pullRequest: "12" });
    expect(f).toEqual({
      project: "forgejo:3000/admin/demo", commit: "deadbeef", job_url: "http://forgejo:3000/admin/demo/actions/runs/9",
      commit_url: "http://forgejo:3000/admin/demo/commit/deadbeef", pull_request: "12", pull_request_url: "http://forgejo:3000/admin/demo/pulls/12",
    });
    expect(() => runFactsFromEnv({})).toThrow(/--project and --commit/);
  });

  test("flags", () => {
    expect(parseReportArgs(["--stage", "tf-plan", "--plan", "p.json", "--out", "d"]).values.get("--out")).toBe("d");
    expect(() => parseReportArgs(["--stage", "tf-apply", "--plan", "p.json", "--out", "d"])).toThrow(/--applied/);
    expect(() => parseReportArgs(["--stage", "tf-plan", "--plan", "p.json"])).toThrow(/--out/);
    expect(() => parseReportArgs(["--stage", "tf-plan", "--plan", "p.json", "--out", "d", "--to", "u"])).toThrow(/--out/);
    expect(() => parseReportArgs(["--bogus"])).toThrow();
  });
});
