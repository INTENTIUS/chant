/**
 * A cloudformation member that names deployed stacks (#5455), against recorded
 * CloudFormation Query responses (`testdata/recorded-cfn/`). No AWS call is
 * made: every request goes to a fake `http`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { GraphIR } from "@intentius/chant/graph-ir";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { readPackageKinds, substituteGraphConfig } from "../../../packages/core/src/workspace/kinds";
import type { AwsReadHttp } from "./api/read-client";
import { awsPlugin } from "./plugin";
import { readDeployedStacks, readStacksFile, setStackReadOptions, type AwsMemberReport } from "./workspace-member";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const member = join(here, "testdata", "stacks-member");
const recorded = (name: string) => readFileSync(join(here, "testdata", "recorded-cfn", name), "utf-8");

interface Call {
  action: string;
  stack: string;
  url: string;
  stage?: string;
}

/** Answers each Action for each stack from the recorded files, and keeps what was asked. */
function recordedHttp(overrides: Record<string, { status: number; text: string }> = {}): { http: AwsReadHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: AwsReadHttp = async (url, init) => {
    const q = new URLSearchParams(init.body);
    const action = q.get("Action") ?? "";
    const stack = q.get("StackName") ?? "";
    calls.push({ action, stack, url, ...(q.get("TemplateStage") ? { stage: q.get("TemplateStage")! } : {}) });
    const forced = overrides[`${action}:${stack}`];
    if (forced) return forced;
    if (stack === "gone-stack") return { status: 400, text: recorded("validation-error.gone-stack.xml") };
    const file = { DescribeStacks: "describe-stacks", GetTemplate: "get-template", DescribeStackResources: "describe-stack-resources" }[action];
    return file ? { status: 200, text: recorded(`${file}.${stack}.xml`) } : { status: 400, text: "<Error><Code>InvalidAction</Code></Error>" };
  };
  return { http, calls };
}

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  setStackReadOptions({});
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function graphOf(dir: string): Promise<{ ir: GraphIR; err: string[]; exit: number }> {
  const graph = readPackageKinds(packageDir).kinds.find((k) => k.name === "cloudformation")!.graph!;
  const config = substituteGraphConfig(graph.config, { member: "net", dir, workspace: dirname(dir) });
  const project = await mkdtemp(join(tmpdir(), "chant-cfn-stacks-"));
  scratch.push(project);
  await writeFile(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["aws"], aws: config, graph: { lint: "report" } }));
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const exit = await runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [awsPlugin], serializers: [] });
    return { ir: exit === 0 ? (JSON.parse(out.join("\n")) as GraphIR) : { nodes: [], edges: [], groups: {} }, err, exit };
  } finally {
    process.chdir(cwd);
  }
}

describe("the cloudformation kind", () => {
  test("a directory with only cloudformation-stacks.json is claimed by its probe", () => {
    const kind = readPackageKinds(packageDir).kinds.find((k) => k.name === "cloudformation")!;
    expect(kind.probe).toMatchObject({ anyFile: ["cloudformation-stacks.json"] });
    expect(kind.description).toMatch(/deployed stacks/);
  });
});

describe("cloudformation-stacks.json", () => {
  test("names stacks and a region", () => {
    expect(readStacksFile(member)).toEqual({ stacks: ["shared-network", "gone-stack"], region: "eu-west-1" });
  });

  test("a directory without one has no deployed stacks", () => {
    expect(readStacksFile(join(here, "testdata", "cfn-member"))).toBeUndefined();
  });
});

describe("deployed stacks as a member graph (#5455)", () => {
  test("the deployed template draws resources and edges, and the report carries what CloudFormation says", async () => {
    const { http, calls } = recordedHttp();
    setStackReadOptions({ http, env: {} });
    const { ir, exit, err } = await graphOf(member);
    expect(exit, err.join("\n")).toBe(0);

    expect(ir.nodes.map((n) => [n.id, n.kind]).sort()).toEqual([
      ["net/FlowLog", "AWS::EC2::FlowLog"],
      ["net/LogBucket", "AWS::S3::Bucket"],
      ["net/PrivateSubnet", "AWS::EC2::Subnet"],
      ["net/Vpc", "AWS::EC2::VPC"],
    ]);
    expect(ir.edges.map((e) => `${e.from} -> ${e.to} via ${e.viaAttr}${e.toAttr ? ` (${e.toAttr})` : ""}`).sort()).toEqual([
      "net/FlowLog -> net/LogBucket via DependsOn",
      "net/FlowLog -> net/LogBucket via LogDestination (Arn)",
      "net/FlowLog -> net/Vpc via ResourceId",
      "net/PrivateSubnet -> net/Vpc via VpcId",
    ]);

    const report = ir.meta?.awsMember as AwsMemberReport;
    expect(report.templates).toEqual([]);
    expect(report.objects).toBe(4);
    const [shared, gone] = report.stacks!;
    expect(shared).toMatchObject({
      name: "shared-network",
      region: "eu-west-1",
      read: true,
      status: "UPDATE_COMPLETE",
      outputs: { VpcId: "vpc-0a1b2c3d4e5f60718", LogBucket: "shared-network-logs-eu-west-1" },
    });
    expect(shared!.resources.find((r) => r.node === "net/Vpc")).toEqual({
      node: "net/Vpc",
      logicalId: "Vpc",
      type: "AWS::EC2::VPC",
      physicalId: "vpc-0a1b2c3d4e5f60718",
      status: "CREATE_COMPLETE",
    });
    expect(shared!.resources).toHaveLength(4);
    // Where the state lives (#5456): the stack and its region, reachable when it was read.
    expect(ir.meta?.stateLocations).toEqual([
      {
        environment: null,
        unit: "shared-network",
        substrate: "aws",
        backend: { kind: "cloudformation-stack", location: { stack: "shared-network", region: "eu-west-1" } },
        lock: { mechanism: "cloudformation-stack-update" },
        reach: { status: "reachable" },
      },
      {
        environment: null,
        unit: "gone-stack",
        substrate: "aws",
        backend: { kind: "cloudformation-stack", location: { stack: "gone-stack", region: "eu-west-1" } },
        lock: { mechanism: "cloudformation-stack-update" },
        reach: { status: "unreachable", reason: "no stack named gone-stack in eu-west-1" },
      },
    ]);
    expect(gone).toMatchObject({ name: "gone-stack", read: false, reason: "no stack named gone-stack in eu-west-1", resources: [] });
    expect(err.join("\n")).toMatch(/stack "gone-stack" in eu-west-1 was not read: no stack named gone-stack in eu-west-1/);

    // Three read calls per stack that exists, against the stack's region, and nothing that writes.
    const shown = calls.filter((c) => c.stack === "shared-network");
    expect(shown.map((c) => c.action).sort()).toEqual(["DescribeStackResources", "DescribeStacks", "GetTemplate"]);
    expect(calls.every((c) => c.url.includes("eu-west-1"))).toBe(true);
    expect(calls.find((c) => c.action === "GetTemplate")?.stage).toBe("Processed");
    expect(calls.map((c) => c.action).every((a) => /^(Describe|Get)/.test(a))).toBe(true);
  });
});

describe("a stack that cannot be read", () => {
  test("a refusal for credentials names the credentials, the calls and the region", async () => {
    const { http } = recordedHttp({
      "DescribeStacks:shared-network": { status: 403, text: recorded("access-denied.xml") },
    });
    const read = await readDeployedStacks({ dir: member, label: "net" }, { http, env: {} });
    const [shared] = read!.reports;
    expect(shared!.read).toBe(false);
    expect(shared!.reason).toContain("cloudformation:DescribeStacks");
    expect(shared!.reason).toContain("cloudformation:GetTemplate");
    expect(shared!.reason).toContain("AWS credentials");
    expect(shared!.reason).toContain("region");
    expect(read!.deployed).toEqual([]);
    expect(read!.warnings[0]).toMatch(/was not read/);
  });

  test("with no region in the file or the environment nothing is called", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-cfn-noregion-"));
    scratch.push(dir);
    await writeFile(join(dir, "cloudformation-stacks.json"), JSON.stringify({ stacks: ["shared-network"] }));
    const { http, calls } = recordedHttp();
    const read = await readDeployedStacks({ dir, label: "net" }, { http, env: {} });
    expect(calls).toEqual([]);
    expect(read!.reports[0]!.reason).toMatch(/no region.*AWS_REGION/);
  });

  test("AWS_REGION fills in a missing region", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-cfn-envregion-"));
    scratch.push(dir);
    await writeFile(join(dir, "cloudformation-stacks.json"), JSON.stringify({ stacks: ["shared-network"] }));
    const { http, calls } = recordedHttp();
    const read = await readDeployedStacks({ dir, label: "net" }, { http, env: { AWS_REGION: "eu-west-1" } });
    expect(read!.reports[0]!.read).toBe(true);
    expect(calls.length).toBe(3);
  });

  test("a file that is not the shape says so, and the member is not read as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-cfn-badfile-"));
    scratch.push(dir);
    await writeFile(join(dir, "cloudformation-stacks.json"), JSON.stringify({ stack: "x" }));
    await expect(readDeployedStacks({ dir, label: "net" }, { env: {} })).rejects.toThrow(/at least one stack name/);
    const { exit, err } = await graphOf(dir);
    expect(exit).toBe(0);
    expect(err.join("\n")).toMatch(/was not read: .*at least one stack name/);
  });

  test("a member that only names stacks is not also told it has no template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-cfn-onlystacks-"));
    scratch.push(dir);
    await writeFile(join(dir, "cloudformation-stacks.json"), JSON.stringify({ stacks: ["prod"] }));
    const { http, calls } = recordedHttp();
    setStackReadOptions({ http, env: {} });
    const { exit, err } = await graphOf(dir);
    expect(exit).toBe(0);
    expect(calls).toEqual([]);
    const text = err.join("\n");
    expect(text).toMatch(/stack "prod" was not read: no region/);
    expect(text).not.toMatch(/no CloudFormation template/);
  });

  test("a member with neither a template nor a stacks file is told it has no template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-cfn-empty-"));
    scratch.push(dir);
    const { exit, err } = await graphOf(dir);
    expect(exit).toBe(0);
    expect(err.join("\n")).toMatch(/has no CloudFormation template directly in/);
  });

  test("a credentials refusal ending in a full stop reads as one sentence before the needs", async () => {
    const invalid = `<ErrorResponse><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>`;
    const { http } = recordedHttp({ "DescribeStacks:shared-network": { status: 403, text: invalid } });
    const read = await readDeployedStacks({ dir: member, label: "net" }, { http, env: {} });
    const reason = read!.reports[0]!.reason!;
    expect(reason).toMatch(/^The security token included in the request is invalid; the read needs AWS credentials/);
    expect(read!.warnings.join("\n")).not.toContain(".;");
  });
});

describe("state locations of a member with a template file (#5456)", () => {
  test("names no stack, and says what to add", async () => {
    const { ir, exit } = await graphOf(join(here, "testdata", "cfn-member"));
    expect(exit).toBe(0);
    expect(ir.meta?.stateLocations).toEqual([
      {
        environment: null,
        substrate: "aws",
        backend: { kind: "cloudformation-stack", location: { stack: null, region: null } },
        lock: null,
        reach: { status: "unchecked", reason: expect.stringContaining("cloudformation-stacks.json") },
      },
    ]);
  });
});
