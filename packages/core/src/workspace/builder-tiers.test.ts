/**
 * #3152, ws-094: the factory declares which builder agent builds at which
 * tier, per member kind, replacing studio's studio/role and studio/tier Agent
 * metadata. The declaration read refuses an ambiguous tier, tiers without a
 * builders member and a session no agent declares; status --json and
 * graph --json print the tiers and builderFor, the agent for each built
 * member and tier, so a slice-tier answer resolves without studio.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo } from "./__fixtures__/contract-repo";
import { builderTable } from "./box-factory";
import { parseDeclaration, WorkspaceReadError, type Declaration } from "./declaration";
import { workspaceGraph } from "./graph-cli";
import graphSchema from "./graph.schema.json";
import { workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";

afterAll(cleanScratch);

type Json = Record<string, unknown>;

const TIERS = [
  { tier: "small", agent: "builder-small" },
  { tier: "medium", agent: "builder-medium" },
  { tier: "large", agent: "builder-large" },
  { tier: "small", agent: "infra-small", kinds: ["terraform"], session: "infra" },
];

function declaration(factory: Json = {}, agents: Json[] = [{ name: "infra", member: "network" }]): Json {
  return {
    name: "acme",
    schema: 1,
    members: [
      { name: "app", dir: "app", kind: "other", because: "the app" },
      { name: "network", dir: "network", kind: "other", because: "an estate" },
      { name: "delivery", dir: "delivery", kind: "other", because: "declares the agents" },
      {
        name: "box",
        dir: "box",
        kind: "other",
        because: "the box",
        box: { services: [{ name: "app", cmd: "node app.mjs" }], factory: { builds: ["app", "network"], builders: "delivery", tiers: TIERS, ...factory } },
      },
    ],
    agents,
  };
}

const parse = (doc: Json): Declaration => parseDeclaration(JSON.stringify(doc, null, 2), "chant.workspace.json");

function readFailure(doc: Json): { code: string; message: string } {
  try {
    parse(doc);
  } catch (err) {
    if (err instanceof WorkspaceReadError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("the declaration read");
}

describe("the factory's tiers (#3152)", () => {
  test("read in file order, kinds and session null when not declared", () => {
    const f = parse(declaration()).members[3].box!.factory!;
    expect(f.tiers).toEqual([
      { tier: "small", agent: "builder-small", kinds: null, session: null },
      { tier: "medium", agent: "builder-medium", kinds: null, session: null },
      { tier: "large", agent: "builder-large", kinds: null, session: null },
      { tier: "small", agent: "infra-small", kinds: ["terraform"], session: "infra" },
    ]);
  });

  test("a factory without tiers reads as before, with none", () => {
    expect(parse(declaration({ tiers: undefined })).members[3].box!.factory!.tiers).toEqual([]);
  });

  test("two entries for one tier and kind, or two defaults for one tier, can't be read", () => {
    const twice = readFailure(declaration({ tiers: [...TIERS, { tier: "small", agent: "other-small" }] }));
    expect(twice.code).toBe("declaration-invalid");
    expect(twice.message).toMatch(/tiers\/0 and tiers\/4 both name a builder at tier small with no kinds/);
    const kind = readFailure(declaration({ tiers: [...TIERS, { tier: "small", agent: "x", kinds: ["helm", "terraform"] }] }));
    expect(kind.message).toMatch(/tiers\/3 and tiers\/4 both name a builder at tier small for kind terraform/);
  });

  test("tiers need the builders member, a session must be declared, and an entry needs a tier and an agent", () => {
    expect(readFailure(declaration({ builders: undefined })).message).toMatch(/declares tiers and no builders/);
    expect(readFailure(declaration({}, [])).message).toMatch(/tiers\/3 names the session "infra", which is not a declared agent session/);
    expect(readFailure(declaration({ tiers: [{ tier: "small" }] })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ tiers: [{ tier: "Small!", agent: "a" }] })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ tiers: [] })).code).toBe("declaration-invalid");
  });

  test("builderFor picks the entry for the member's kind, else the tier's default, and leaves out a tier with neither", () => {
    const f = parse(declaration({ tiers: [{ tier: "small", agent: "builder-small" }, { tier: "large", agent: "infra-large", kinds: ["terraform"] }] })).members[3].box!.factory!;
    expect(builderTable(f, [{ name: "app", kind: "app" }, { name: "network", kind: "terraform" }])).toEqual({
      app: { small: { agent: "builder-small", session: null } },
      network: { small: { agent: "builder-small", session: null }, large: { agent: "infra-large", session: null } },
    });
  });
});

describe("the read contract (#3152)", () => {
  const status = contract(statusSchema);
  const graph = contract(graphSchema);
  let root: string;

  beforeAll(() => {
    const doc = declaration();
    // The estate member is a Terraform root by its kind: give it the terraform kind through a local plugin.
    (doc.members as Json[])[1] = { name: "network", dir: "network", kind: "terraform" };
    doc.pins = [{ path: "plugins/kinds" }];
    root = repo({
      "chant.workspace.json": `${JSON.stringify(doc, null, 2)}\n`,
      "plugins/kinds/package.json": JSON.stringify({ name: "kinds", version: "1.0.0", exports: { "./workspace-kinds": "./k.json" } }),
      "plugins/kinds/k.json": JSON.stringify({ schema: 1, kinds: [{ name: "terraform", description: "a Terraform root", precedence: 400, probe: { anyFile: ["main.tf"] } }] }),
      "app/README.md": "the app\n",
      "network/main.tf": "\n",
      "delivery/README.md": "the agents\n",
      "box/README.md": "the box\n",
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "the workspace");
  });

  const expected = {
    app: { small: { agent: "builder-small", session: null }, medium: { agent: "builder-medium", session: null }, large: { agent: "builder-large", session: null } },
    network: { small: { agent: "infra-small", session: "infra" }, medium: { agent: "builder-medium", session: null }, large: { agent: "builder-large", session: null } },
  };

  test("status --json prints the tiers and builderFor under the box's factory", async () => {
    const out = await workspaceStatus({ cwd: root, env: "prod" });
    status.expectValid(out);
    if ("error" in out) throw new Error(out.error.message);
    const factory = out.members.find((m) => m.name === "box")!.box!.factory!;
    expect(factory.tiers).toHaveLength(4);
    expect(factory.builderFor).toEqual(expected);
  });

  test("graph --json prints the same on the box member", async () => {
    const { doc: out } = await workspaceGraph({ cwd: root });
    graph.expectValid(out);
    if ("error" in out) throw new Error(out.error.message);
    const box = out.members.find((m) => m.name === "box")!.box!;
    expect(box.factory?.builderFor).toEqual(expected);
  });
});
