/**
 * Member links (#2539): declared links resolved in source, inferred joins
 * labelled by the core joinKey(), ambiguity rows, and the WSP091 to WSP097
 * checks.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "./checks";
import { parseDeclaration, WorkspaceReadError } from "./declaration";
import { declaredMemberLinks, graphLinks, resolveLinks, type LinkTableRow, type MemberHandles } from "./links";
import { builtinKindRegistry } from "./kinds";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-links-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const declaration = (members: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "acme", schema: 1, members, ...extra }, null, 2);

const producerSource = (outputs: Record<string, string>) =>
  [
    `import { output } from "@intentius/chant-lexicon-aws";`,
    `import { cluster, listener } from "./alb";`,
    ...Object.entries(outputs).map(([binding, name]) => `export const ${binding} = output(cluster.Arn, ${JSON.stringify(name)});`),
    `void listener;`,
  ].join("\n");

const consumerSource = (params: string[]) =>
  [`import { Parameter } from "@intentius/chant-lexicon-aws";`, ...params.map((p) => `export const ${p} = new Parameter("String");`)].join("\n");

/** A producer and two consumers, the shape the issue asks for. */
function threeMembers(opts: { outputs?: Record<string, string>; webLinks?: unknown[]; jobsLinks?: unknown[] } = {}) {
  return repo({
    "chant.workspace.json": declaration([
      { name: "shared", dir: "infra/shared", kind: "chant" },
      { name: "web", dir: "services/web", kind: "chant", ...(opts.webLinks ? { links: opts.webLinks } : {}) },
      { name: "jobs", dir: "services/jobs", kind: "chant", ...(opts.jobsLinks ? { links: opts.jobsLinks } : {}) },
    ]),
    "infra/shared/chant.config.ts": "",
    "infra/shared/src/outputs.ts": producerSource(opts.outputs ?? { clusterArn: "ClusterArn", listenerArn: "ListenerArn" }),
    "services/web/chant.config.ts": "",
    "services/web/src/params.ts": consumerSource(["clusterArn", "listenerArn"]),
    "services/jobs/chant.config.ts": "",
    "services/jobs/src/params.ts": consumerSource(["clusterArn"]),
  });
}

const ids = async (root: string) => (await runDeclarationChecks(root)).diagnostics.map((d) => `${d.ruleId}:${d.entity ?? ""}`);
const summary = (rows: LinkTableRow[]) =>
  rows.map((r) =>
    r.status === "ambiguous"
      ? `${r.consumer}.${r.input} ambiguous ${r.candidates.map((c) => `${c.producer}.${c.output}`).join("|")}`
      : `${r.consumer}${r.input ? `.${r.input}` : ""} -> ${r.producer}.${r.output} ${r.origin} ${r.label} ${r.status}`,
  );

describe("declared links, resolved in source", () => {
  test("a link to an output the producer's source declares resolves, and suppresses the inferred edge", async () => {
    const root = threeMembers({ webLinks: [{ member: "shared", output: "ClusterArn" }] });
    const report = await runDeclarationChecks(root);
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toEqual([]);
    expect(summary(report.links)).toEqual([
      "web -> shared.ClusterArn declared exact resolved",
      "jobs.clusterArn -> shared.ClusterArn inferred:joinKey folded resolved",
      "web.listenerArn -> shared.ListenerArn inferred:joinKey folded resolved",
    ]);
    expect(report.links[0]).toMatchObject({ resolves: "source", kind: "output", pointer: "/members/1/links/0" });
  });

  test("a renamed producer output fails check for every declared consumer", async () => {
    const link = [{ member: "shared", output: "ClusterArn" }];
    const root = threeMembers({ outputs: { clusterArn: "EcsClusterArn", listenerArn: "ListenerArn" }, webLinks: link, jobsLinks: link });
    const report = await runDeclarationChecks(root);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.entity}`)).toEqual(["WSP093:web", "WSP093:jobs"]);
    expect(report.diagnostics[0].message).toBe(
      "web's link to shared output ClusterArn does not resolve: shared has no output ClusterArn; its outputs: EcsClusterArn, ListenerArn",
    );
    // The finding points at the link's output in the file.
    expect(report.diagnostics[0]).toMatchObject({ file: "chant.workspace.json", line: 17, column: 21 });
  });

  test("a near miss in case is named, since declared links match exactly", async () => {
    const root = threeMembers({ webLinks: [{ member: "shared", output: "clusterArn" }] });
    const [d] = (await runDeclarationChecks(root)).diagnostics;
    expect(d.ruleId).toBe("WSP093");
    expect(d.message).toMatch(/did you mean ClusterArn\? Links match exactly/);
  });

  test("an output name that can't be read without running code keeps the link unresolved, as info", async () => {
    const root = threeMembers({ webLinks: [{ member: "shared", output: "Missing" }] });
    writeFileSync(join(root, "infra/shared/src/more.ts"), `import { output } from "@intentius/chant-lexicon-aws";\nexport const x = output(1, process.env.NAME!);\n`);
    const report = await runDeclarationChecks(root);
    expect(report.ok).toBe(true);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.severity}`)).toEqual(["WSP094:info"]);
    expect(report.diagnostics[0].message).toMatch(/kept unresolved: Missing was not found in shared.*infra\/shared\/src\/more\.ts:2: an output whose name is not a string literal/);
    expect(report.links[0]).toMatchObject({ status: "unresolved" });
  });

  test("other members expose what the entry lists, and a nested workspace exposes nothing", async () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "legacy", dir: "legacy", kind: "other", because: "a hand-run stack", outputs: ["QueueUrl"], suppress: [{ check: "WSP009", because: "known" }] },
        { name: "nested", dir: "nested", kind: "workspace" },
        {
          name: "app",
          dir: "app",
          kind: "chant",
          links: [
            { member: "legacy", output: "QueueUrl" },
            { member: "legacy", output: "TopicArn" },
            { member: "nested", output: "Anything" },
          ],
        },
      ]),
      "legacy/README": "",
      "nested/chant.workspace.json": declaration([]),
      "app/chant.config.ts": "",
    });
    const report = await runDeclarationChecks(root);
    expect(summary(report.links)).toEqual([
      "app -> legacy.QueueUrl declared exact resolved",
      "app -> legacy.TopicArn declared exact missing",
      "app -> nested.Anything declared exact missing",
    ]);
    expect(report.diagnostics.map((d) => d.message)).toEqual([
      "app's link to legacy output TopicArn does not resolve: legacy has no output TopicArn; its outputs: QueueUrl",
      "app's link to nested output Anything does not resolve: nested is kind workspace, which exposes no outputs as link targets",
    ]);
  });

  test("an unknown member, a group, the consumer itself, an unknown link kind and a repeat each fail", async () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "api", dir: "api", kind: "chant", outputs: ["Url"] },
        {
          name: "web",
          dir: "web",
          kind: "chant",
          links: [
            { member: "ghost", output: "Url" },
            { member: "examples", output: "Url" },
            { member: "web", output: "Url" },
            { member: "api", output: "Url", kind: "depends-on" },
            { member: "api", output: "Url" },
            { member: "api", output: "Url" },
          ],
        },
        { name: "examples", kind: "examples", glob: "examples/*" },
      ]),
      "api/chant.config.ts": "",
      "api/src/out.ts": `import * as aws from "@intentius/chant-lexicon-aws";\nconst NAME = "Url";\nexport const url = aws.output(1, NAME);\n`,
      "web/chant.config.ts": "",
      "examples/one/chant.config.ts": "",
    });
    expect(await ids(root)).toEqual(["WSP097:api", "WSP091:web", "WSP091:web", "WSP091:web", "WSP092:web", "WSP096:web"]);
    const messages = (await runDeclarationChecks(root)).diagnostics.map((d) => d.message);
    expect(messages).toContain("member web links to ghost, which is not a member of this workspace");
    expect(messages).toContain("member web links to examples, which is an example group; a group has no links");
    expect(messages).toContain("member web links to itself; a link joins two members");
    expect(messages).toContain("member api lists outputs, and kind chant reads a member's outputs from its source; remove the list");
  });

  test("WSP091 and WSP092 can't be suppressed, and WSP093 can", async () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "api", dir: "api", kind: "chant" },
        {
          name: "web",
          dir: "web",
          kind: "chant",
          links: [{ member: "api", output: "Gone" }],
          suppress: [{ check: "WSP093", because: "api is being rebuilt" }],
        },
      ]),
      "api/chant.config.ts": "",
      "web/chant.config.ts": "",
    });
    const report = await runDeclarationChecks(root);
    expect(report.ok).toBe(true);
    expect(report.suppressed.map((s) => `${s.ruleId}:${s.reason}`)).toEqual(["WSP093:api is being rebuilt"]);
  });
});

describe("inferred joins", () => {
  function twoProducers(webLinks?: unknown[]) {
    return repo({
      "chant.workspace.json": declaration([
        { name: "net-a", dir: "net-a", kind: "chant" },
        { name: "net-b", dir: "net-b", kind: "chant" },
        { name: "web", dir: "web", kind: "chant", ...(webLinks ? { links: webLinks } : {}) },
      ]),
      "net-a/chant.config.ts": "",
      "net-a/src/o.ts": producerSource({ vpc: "VpcId" }),
      "net-b/chant.config.ts": "",
      "net-b/src/o.ts": producerSource({ vpc: "vpc_id" }),
      "web/chant.config.ts": "",
      "web/src/p.ts": consumerSource(["vpcId"]),
    });
  }

  test("two producers of one handle is an ambiguity row and a warning", async () => {
    const report = await runDeclarationChecks(twoProducers());
    expect(summary(report.links)).toEqual(["web.vpcId ambiguous net-a.VpcId|net-b.vpc_id"]);
    expect(report.ok).toBe(true);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.severity}:${d.entity}`)).toEqual(["WSP095:warning:web"]);
    expect(report.diagnostics[0].message).toBe(
      'parameter vpcId of web matches outputs of net-a and net-b: net-a output VpcId (folded), net-b output vpc_id (folded). Declare the one it reads, such as { "member": "net-a", "output": "VpcId" } in web\'s links',
    );
  });

  test("declaring one of the matches settles the ambiguity", async () => {
    const report = await runDeclarationChecks(twoProducers([{ member: "net-b", output: "vpc_id" }]));
    expect(report.diagnostics).toEqual([]);
    expect(summary(report.links)).toEqual(["web -> net-b.vpc_id declared exact resolved"]);
  });

  test("equal names are labelled exact, and a member never joins itself", async () => {
    const decl = parseDeclaration(declaration([{ name: "a", dir: "a", kind: "chant" }, { name: "b", dir: "b", kind: "chant" }]), "chant.workspace.json");
    const h = (member: string, outputs: string[], inputs: string[]): MemberHandles => ({
      member,
      outputs: outputs.map((name) => ({ name })),
      inputs: inputs.map((name) => ({ name })),
      complete: true,
      why: null,
      exposesNone: false,
    });
    const rows = resolveLinks(decl, new Map([["a", h("a", ["Url"], ["Url"])], ["b", h("b", [], ["Url"])]]));
    expect(summary(rows)).toEqual(["b.Url -> a.Url inferred:joinKey exact resolved"]);
  });
});

describe("the graph's links section", () => {
  const decl = parseDeclaration(
    declaration([
      { name: "shared", dir: "shared", kind: "chant" },
      { name: "web", dir: "web", kind: "chant", links: [{ member: "shared", output: "ClusterArn" }] },
      { name: "legacy", dir: "legacy", kind: "other", because: "x", outputs: ["QueueUrl"] },
    ]),
    "chant.workspace.json",
  );
  const graph = {
    composed: ["shared", "web"],
    exports: [
      { member: "shared", name: "ClusterArn", node: "shared/Cluster" },
      { member: "shared", name: "ListenerArn", node: "shared/Listener" },
    ],
    imports: [
      { member: "web", name: "clusterArn", node: "web/clusterArn" },
      { member: "web", name: "listenerArn", node: "web/listenerArn" },
      { member: "web", name: "queueUrl", node: "web/queueUrl" },
    ],
  };

  test("inferred joins carry their label and composed node ids, and a declared link suppresses its inferred edge", async () => {
    const rows = graphLinks(decl, graph, builtinKindRegistry());
    expect(rows).toEqual([
      { consumer: "web", producer: "shared", output: "ClusterArn", kind: "output", origin: "declared", label: "exact", input: null, resolves: "source", status: "resolved", reason: null, to: "shared/Cluster" },
      {
        consumer: "web",
        producer: "shared",
        output: "ListenerArn",
        kind: "output",
        origin: "inferred:joinKey",
        label: "folded",
        input: "listenerArn",
        resolves: "source",
        status: "resolved",
        reason: null,
        from: "web/listenerArn",
        to: "shared/Listener",
      },
      {
        consumer: "web",
        producer: "legacy",
        output: "QueueUrl",
        kind: "output",
        origin: "inferred:joinKey",
        label: "folded",
        input: "queueUrl",
        resolves: "source",
        status: "resolved",
        reason: null,
        from: "web/queueUrl",
      },
    ]);
  });

  test("without kinds, only composed members are link targets", async () => {
    expect(graphLinks(decl, graph).map((r) => r.status === "ambiguous" ? "" : r.producer)).toEqual(["shared", "shared"]);
  });

  test("the linked member pairs, for the pipeline checks' environment rule", async () => {
    expect(declaredMemberLinks(decl)).toEqual([{ consumer: "web", producer: "shared" }]);
  });
});

describe("the declaration's link fields", () => {
  const read = (members: unknown[]) => parseDeclaration(declaration(members), "chant.workspace.json");

  test("links and outputs are read in file order, with pointers", async () => {
    const d = read([
      { name: "a", dir: "a", kind: "other", because: "x", outputs: ["One", "Two"] },
      { name: "b", dir: "b", kind: "chant", links: [{ member: "a", output: "One" }, { member: "a", output: "Two", kind: "output" }] },
    ]);
    expect(d.members[0].outputs).toEqual(["One", "Two"]);
    expect(d.members[1].outputs).toBeNull();
    expect(d.members[1].links).toEqual([
      { member: "a", output: "One", kind: null, pointer: "/members/1/links/0" },
      { member: "a", output: "Two", kind: "output", pointer: "/members/1/links/1" },
    ]);
  });

  test("a group has no links, and a link has only member, output, kind and x- fields", async () => {
    expect(() => read([{ name: "ex", kind: "examples", glob: "examples/*", links: [] }])).toThrow(WorkspaceReadError);
    expect(() => read([{ name: "b", dir: "b", kind: "chant", links: [{ member: "a", output: "One", hash: "x" }] }])).toThrow(/unknown field "hash"/);
    expect(() => read([{ name: "b", dir: "b", kind: "chant", links: [{ member: "a" }] }])).toThrow(/missing required field "output"/);
    expect(() => read([{ name: "b", dir: "b", kind: "chant", links: [{ member: "a", output: "" }] }])).toThrow(WorkspaceReadError);
    expect(read([{ name: "b", dir: "b", kind: "chant", links: [{ member: "a", output: "One", "x-note": "hi" }] }]).members[0].links).toHaveLength(1);
  });
});

describe("the chant repository's own declaration (#2557)", () => {
  test("has no link finding", async () => {
    const report = await runDeclarationChecks(resolve(import.meta.dirname, "../../../.."));
    expect(report.diagnostics.filter((d) => /^WSP09\d$/.test(d.ruleId))).toEqual([]);
    expect(report.links.filter((r) => r.status !== "resolved")).toEqual([]);
  });
});
