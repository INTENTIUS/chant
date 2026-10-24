import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/parse-args";
import { fetchSpacelift, fetchTfc, type Fetcher } from "./import-fetch";
import { runImportInit } from "./import-init";
import { proposeFromBackstage, proposeFromSpacelift, proposeFromTfc, readInputFile, type SpaceliftInput, type TfcInput } from "./import-source";

const FIX = join(__dirname, "__fixtures__", "import");
const tfc = (): TfcInput => readInputFile("tfc", join(FIX, "tfc.json")) as TfcInput;
const spacelift = (): SpaceliftInput => readInputFile("spacelift", join(FIX, "spacelift.json")) as SpaceliftInput;
const noNetwork = vi.fn(() => {
  throw new Error("a test reached the network");
});

describe("workspace init --from tfc (#3178)", () => {
  test("workspaces become members, run triggers become links, tags become environments", () => {
    const p = proposeFromTfc(tfc());
    expect(p.declaration.members.map((m) => [m.name, m.kind, m.dir])).toEqual([
      ["network-prod", "terraform", "infra/network"],
      ["app-prod", "terraform", "infra/app"],
    ]);
    expect(p.declaration.members[0].outputs).toEqual(["applied"]);
    expect(p.declaration.members[1].links).toEqual([{ member: "network-prod", output: "applied" }]);
    expect(p.environments).toEqual([
      { name: "dev", members: ["app-prod"] },
      { name: "prod", members: ["network-prod", "app-prod"] },
    ]);
  });

  test("policy sets become constraint records and the left-out list names what was not carried", () => {
    const p = proposeFromTfc(tfc());
    expect(p.records.map((r) => [r.title, r.kind, r.appliesTo])).toEqual([
      ["no-public-s3", "constraint", ["app-prod"]],
      ["tags-required", "constraint", []],
    ]);
    const out = Object.fromEntries(p.leftOut.map((l) => [l.what, l.count]));
    expect(out.variables).toBe(2);
    expect(out["run triggers"]).toBe(1);
    expect(out["VCS connections"]).toBe(1);
    expect(out["workspaces sharing a directory"]).toBe(1);
    expect(p.notes.join(" ")).toContain("chant-lexicon-terraform");
  });

  test("the API reader builds the same input from fixture responses, with no network", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      const u = new URL(url);
      const body = (data: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data }) });
      if (u.pathname.endsWith("/projects")) return body([{ id: "prj-1", attributes: { name: "platform" } }]);
      if (u.pathname.endsWith("/policy-sets")) return body([{ id: "pol-1", attributes: { name: "p", global: true } }]);
      if (u.pathname.endsWith("/organizations/acme/workspaces"))
        return body([
          { id: "ws-a", attributes: { name: "a", "working-directory": "a", "tag-names": ["env:x"] } },
          { id: "ws-b", attributes: { name: "b" } },
        ]);
      if (u.pathname.endsWith("/workspaces/ws-b/run-triggers")) return body([{ id: "rt", relationships: { sourceable: { data: { id: "ws-a" } } } }]);
      if (u.pathname.endsWith("/vars")) return body([{ id: "v", attributes: { key: "k", sensitive: true } }]);
      return body([]);
    };
    const input = await fetchTfc({ organization: "acme", token: "t", fetcher });
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    const p = proposeFromTfc(input);
    expect(p.declaration.members[1].links).toEqual([{ member: "a", output: "applied" }]);
    expect(p.records[0].appliesTo).toEqual([]);
  });

  test("a bad status is an error that names the path", async () => {
    const fetcher: Fetcher = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchTfc({ organization: "acme", token: "t", fetcher })).rejects.toThrow(/401/);
  });
});

describe("workspace init --from spacelift (#3178)", () => {
  test("dependent stacks become members with links on the named outputs", () => {
    const p = proposeFromSpacelift(spacelift());
    expect(p.declaration.members.map((m) => [m.name, m.kind])).toEqual([
      ["vpc", "terraform"],
      ["database", "terraform"],
      ["ansible-config", "other"],
    ]);
    expect(p.declaration.members[0].outputs).toEqual(["subnet_ids"]);
    expect(p.declaration.members[1].links).toEqual([{ member: "vpc", output: "subnet_ids" }]);
    expect(p.declaration.members[2].links).toEqual([{ member: "database", output: "applied" }]);
    expect(p.environments).toEqual([{ name: "prod", members: ["vpc", "database"] }]);
    expect(p.records).toEqual([expect.objectContaining({ kind: "constraint", policyKind: "APPROVAL", appliesTo: ["database"] })]);
    expect(p.leftOut.map((l) => l.what)).toEqual(expect.arrayContaining(["context attachments", "stack dependencies"]));
  });

  test("the GraphQL reader only sends a query, and maps the response", async () => {
    let sent = "";
    const fetcher: Fetcher = async (_url, init) => {
      sent = init?.body ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { stacks: [{ id: "a", name: "a", dependsOn: [] }, { id: "b", name: "b", dependsOn: [{ stackId: "a", references: [] }] }], policies: [] } }),
      };
    };
    const input = await fetchSpacelift({ endpoint: "https://acme.app.spacelift.io/graphql", token: "t", fetcher });
    expect(sent).not.toContain("mutation");
    expect(input.account).toBe("acme");
    expect(proposeFromSpacelift(input).declaration.members[1].links).toEqual([{ member: "a", output: "applied" }]);
  });
});

describe("workspace init --from backstage (#3178)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  function catalog(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "chant-backstage-"));
    dirs.push(root);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), text);
    }
    return root;
  }

  test("components become members, dependsOn and consumesApis become links, lifecycle becomes an environment", () => {
    const root = catalog({
      "api/catalog-info.yaml": "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: api\nspec:\n  lifecycle: production\n  dependsOn: [resource:default/db]\n  consumesApis: [billing-api]\n---\napiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: team\n",
      "db/catalog-info.yaml": "apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: db\nspec:\n  lifecycle: production\n",
      "billing/catalog-info.yml": "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing\nspec:\n  lifecycle: experimental\n  providesApis: [billing-api]\n",
    });
    const p = proposeFromBackstage(root, { name: "shop" });
    expect(p.declaration.name).toBe("shop");
    expect(p.declaration.members.map((m) => [m.name, m.kind, m.dir])).toEqual([
      ["api", "other", "api"],
      ["billing", "other", "billing"],
      ["db", "other", "db"],
    ]);
    expect(p.declaration.members[0].links).toEqual([
      { member: "db", output: "catalog" },
      { member: "billing", output: "catalog" },
    ]);
    expect(p.environments.map((e) => e.name)).toEqual(["experimental", "production"]);
    expect(p.leftOut.map((l) => l.what)).toContain("Group");
  });
});

describe("the command writes nothing without confirmation (#3178)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });
  const run = async (extra: string[], deps: Parameters<typeof runImportInit>[3] = {}) => {
    const root = mkdtempSync(join(tmpdir(), "chant-import-"));
    dirs.push(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const args = parseArgs(["workspace", "init", root, "--from", "tfc", "--input", join(FIX, "tfc.json"), ...extra]);
    const code = await runImportInit("tfc", root, args, { fetcher: noNetwork as never, ...deps });
    return { code, root };
  };

  test("no terminal and no --yes: nothing written", async () => {
    const { code, root } = await run([], { isTTY: false });
    expect(code).toBe(0);
    expect(existsSync(join(root, "chant.workspace.json"))).toBe(false);
  });

  test("declining writes nothing; --yes writes the declaration and the sidecar", async () => {
    const declined = await run([], { isTTY: true, confirm: async () => false });
    expect(existsSync(join(declined.root, "chant.workspace.json"))).toBe(false);
    const { code, root } = await run(["--yes"]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8")).members).toHaveLength(2);
    const side = JSON.parse(readFileSync(join(root, "chant-import.tfc.json"), "utf-8"));
    expect(side.records).toHaveLength(2);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  test("without --input or a token it says what is missing and reaches nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const args = parseArgs(["workspace", "init", "--from", "tfc", "--org", "acme"]);
    expect(await runImportInit("tfc", tmpdir(), args, { env: {}, fetcher: noNetwork as never })).toBe(1);
    expect(err.mock.calls.join(" ")).toContain("TFE_TOKEN");
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
