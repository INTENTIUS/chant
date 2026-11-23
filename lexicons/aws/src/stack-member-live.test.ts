/**
 * The live read of a cloudformation member that names deployed stacks
 * (#5504). The member's build reads its stacks from `cloudformation-stacks.json`
 * and draws `<member>/<LogicalId>` nodes; `--live` must read those nodes from
 * the same stacks, in the region the file names, by their logical ids, and not
 * from a stack named after the environment. Recorded CloudFormation Query
 * responses (`testdata/recorded-cfn/`); no AWS call is made.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { awsPlugin } = await import("./plugin");
const { setStackReadOptions } = await import("./workspace-member");
const { setLastMemberReport } = await import("./member-report");
const { normalizeObservation } = await import("@intentius/chant/observation");

const here = dirname(fileURLToPath(import.meta.url));
const member = join(here, "testdata", "stacks-member");
const recorded = (name: string) => readFileSync(join(here, "testdata", "recorded-cfn", name), "utf-8");

interface Call {
  action: string;
  stack: string;
  url: string;
}

/** CloudFormation as the account holds it: `shared-network` exists, every other stack does not. */
function stubCloud(): Call[] {
  const calls: Call[] = [];
  const answer = (url: string, body: string, target?: string) => {
    if (target) return { status: 200, text: "{}" };
    const q = new URLSearchParams(body);
    const action = q.get("Action") ?? "";
    const stack = q.get("StackName") ?? "";
    calls.push({ action, stack, url });
    const file = { DescribeStacks: "describe-stacks", GetTemplate: "get-template", DescribeStackResources: "describe-stack-resources" }[action];
    if (stack === "shared-network" && file) return { status: 200, text: recorded(`${file}.${stack}.xml`) };
    return {
      status: 400,
      text: `<ErrorResponse><Error><Code>ValidationError</Code><Message>Stack with id ${stack} does not exist</Message></Error></ErrorResponse>`,
    };
  };
  setStackReadOptions({ http: async (url, init) => answer(url, init.body), env: {} });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const res = answer(url, init.body, init.headers?.["x-amz-target"]);
    return { status: res.status, text: () => Promise.resolve(res.text) };
  }) as unknown as typeof fetch);
  return calls;
}

beforeEach(() => {
  spawnMock.mockReset();
  // The per-kind own-property reads: answered, with nothing to add.
  spawnMock.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  setStackReadOptions({});
  setLastMemberReport(undefined);
});

const NODES = ["net/FlowLog", "net/LogBucket", "net/PrivateSubnet", "net/Vpc"];

async function buildMember() {
  const built = await awsPlugin.buildRoots!({ config: { aws: { member: { dir: member, label: "net" } } } } as never);
  expect([...built.entities.keys()].sort()).toEqual(NODES);
  return built;
}

describe("a member's named stacks, read live (#5504)", () => {
  test("each node the stack lists complete is present, read from that stack and its region", async () => {
    const calls = stubCloud();
    const built = await buildMember();
    calls.length = 0;

    const result = normalizeObservation(
      await awsPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: NODES,
        entities: new Map([...built.entities].map(([n, e]) => [n, { entityType: e.entityType, props: ((e as unknown as { props?: Record<string, unknown> }).props ?? {}) }])),
        owned: true,
      }),
    );

    expect(Object.keys(result.resources).sort()).toEqual(NODES);
    expect(result.unobserved).toEqual({});
    expect(result.resources["net/Vpc"]).toMatchObject({ type: "AWS::EC2::VPC", physicalId: "vpc-0a1b2c3d4e5f60718", status: "CREATE_COMPLETE" });
    expect(result.resources["net/FlowLog"]).toMatchObject({ physicalId: "fl-0123456789abcdef0", status: "UPDATE_COMPLETE" });

    // The stack the file names, in its region; never a stack named after the environment.
    const listed = calls.filter((c) => c.action === "DescribeStackResources");
    expect(listed.map((c) => c.stack)).toEqual(["shared-network"]);
    expect(listed[0]!.url).toContain("eu-west-1");
    expect(calls.some((c) => c.stack === "prod")).toBe(false);
    expect(result.stackExports?.["shared-network"]).toMatchObject({ VpcId: "vpc-0a1b2c3d4e5f60718" });
  });

  test("a stack named by the project is read as before, by entity name", async () => {
    const calls = stubCloud();
    await buildMember();
    calls.length = 0;

    const result = normalizeObservation(
      await awsPlugin.describeResources!({ environment: "prod", buildOutput: "", entityNames: ["Vpc"], entities: new Map(), stack: "shared-network", region: "eu-west-1" }),
    );
    expect(Object.keys(result.resources)).toEqual(["Vpc"]);
  });

  test("a report that names none of the entities asked about leaves the read as it was", async () => {
    const calls = stubCloud();
    await buildMember();
    calls.length = 0;

    await awsPlugin.describeResources!({ environment: "prod", buildOutput: "", entityNames: ["other/Bucket"], entities: new Map() });
    expect(calls.filter((c) => c.action === "DescribeStackResources").map((c) => c.stack)).toEqual(["prod"]);
  });
});
