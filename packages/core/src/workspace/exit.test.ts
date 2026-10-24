/**
 * The exit drill (#3177) against fixtures: the reference workspace, the
 * getting-started infra example wrapped in a workspace, and small trees for
 * the per-kind cases. No chant is spawned and no cloud is called, so this is
 * a unit test CI runs on every commit. The stock deploy itself (`kubectl
 * apply`, `tofu plan`) is not run, needs the maintainer.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { describeDrill, exitInDir, linearCommands, planExit, runExitDrill, verifyExit, type ExitBuildRunner } from "./exit";

const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-exit-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes what a build would: JSON for .json, YAML text otherwise. */
const stubBuild: ExitBuildRunner = async (_command, _cwd, args) => {
  const out = args[args.indexOf("--output") + 1]!;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, out.endsWith(".json") ? '{"Resources":{"Bucket":{"Type":"AWS::S3::Bucket"}}}\n' : "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n");
  return { exitCode: 0, output: "" };
};

const CONFIG = (lexicons: string[]) => `export default { lexicons: [${lexicons.map((l) => `"${l}"`).join(", ")}] };\n`;
const PKG = JSON.stringify({
  name: "m",
  scripts: { build: "chant build src -o out.yaml", test: "vitest" },
  dependencies: { "@intentius/chant": "*", "@intentius/chant-lexicon-k8s": "*", yaml: "2" },
});
const CI = "name: deploy\njobs:\n  deploy:\n    steps:\n      - run: npx chant build . --lexicon k8s\n      - run: echo done\n";

const workspace = (members: unknown[]) => JSON.stringify({ name: "acme", schema: 1, members }, null, 2);

describe("workspace exit drill", () => {
  test("a chant member leaves with native output, stock CI, no chant dependency and kind other", async () => {
    const root = tree({
      "chant.workspace.json": workspace([{ name: "api", dir: "api", kind: "chant", outputs: ["url"] }]),
      "api/chant.config.ts": CONFIG(["k8s"]),
      "api/package.json": PKG,
      "api/.github/workflows/deploy.yml": CI,
    });
    const report = await runExitDrill({ root, runBuild: stubBuild });
    expect(report.ok).toBe(true);
    expect(report.members[0]).toMatchObject({ name: "api", status: "passed", native: ["api/native/k8s.yaml"], deploy: ["kubectl apply -f native/k8s.yaml"] });
    // The drill works on a copy.
    expect(existsSync(join(root, "api/native"))).toBe(false);
    expect(readFileSync(join(root, "api/chant.config.ts"), "utf-8")).toContain("k8s");
  });

  test("exitInDir rewrites CI, package.json and the declaration", async () => {
    const root = tree({
      "chant.workspace.json": workspace([{ name: "api", dir: "api", kind: "chant", outputs: ["url"] }]),
      "api/chant.config.ts": CONFIG(["k8s"]),
      "api/package.json": PKG,
      "api/.github/workflows/deploy.yml": CI,
    });
    const result = await exitInDir(planExit(root), stubBuild);
    expect(result.members[0]!.status).toBe("exited");
    expect(readFileSync(join(root, "api/.github/workflows/deploy.yml"), "utf-8")).toBe(
      "name: deploy\njobs:\n  deploy:\n    steps:\n      - run: kubectl apply -f native/k8s.yaml\n      - run: echo done\n",
    );
    const pkg = JSON.parse(readFileSync(join(root, "api/package.json"), "utf-8"));
    expect(pkg.dependencies).toEqual({ yaml: "2" });
    expect(pkg.scripts).toEqual({ test: "vitest" });
    expect(existsSync(join(root, "api/chant.config.ts"))).toBe(false);
    const dec = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf-8"));
    expect(dec.members[0]).toMatchObject({ kind: "other", outputs: ["url"] });
    expect(dec.members[0].because).toContain("native/k8s.yaml");
  });

  test("the drill fails when chant is left behind", async () => {
    const root = tree({
      "chant.workspace.json": workspace([{ name: "api", dir: "api", kind: "chant" }]),
      "api/chant.config.ts": CONFIG(["k8s"]),
      "api/package.json": PKG,
      "api/.github/workflows/deploy.yml": CI.replace("echo done", "chant lint ."),
    });
    const report = await runExitDrill({ root, runBuild: stubBuild });
    expect(report.ok).toBe(false);
    expect(report.members[0]!.findings.map((f) => f.code)).toEqual(["chant-in-ci"]);
  });

  test("the drill fails when the build writes nothing", async () => {
    const root = tree({
      "chant.workspace.json": workspace([{ name: "api", dir: "api", kind: "chant" }]),
      "api/chant.config.ts": CONFIG(["k8s"]),
    });
    const report = await runExitDrill({ root, runBuild: async () => ({ exitCode: 0, output: "" }) });
    expect(report.ok).toBe(false);
    expect(report.members[0]!.findings[0]!.code).toBe("exit-failed");
  });

  test("a lexicon with no native target is refused, not guessed", async () => {
    const root = tree({
      "chant.workspace.json": workspace([{ name: "db", dir: "db", kind: "chant" }]),
      "db/chant.config.ts": CONFIG(["sql"]),
    });
    expect(planExit(root).members[0]!.refused?.code).toBe("lexicon-unsupported");
    const report = await runExitDrill({ root, runBuild: stubBuild });
    expect(report.ok).toBe(false);
  });

  test("an aws member deploys with aws cloudformation", async () => {
    const root = tree({
      "chant.workspace.json": workspace([{ name: "net", dir: "net", kind: "chant" }]),
      "net/chant.config.ts": CONFIG(["aws"]),
    });
    const report = await runExitDrill({ root, runBuild: stubBuild });
    expect(report.ok).toBe(true);
    expect(report.members[0]!.deploy[0]).toContain("aws cloudformation deploy --template-file native/template.json --stack-name net");
  });

  test("other members stay, and a choudoufu member lists its roundtrip and is not run", async () => {
    const root = tree({
      "chant.workspace.json": workspace([
        { name: "docs", dir: "docs", kind: "other", because: "markdown" },
        { name: "estate", dir: "estate", kind: "choudoufu", because: "stock tofu estate" },
      ]),
      "docs/README.md": "# docs\n",
      "estate/main.tf": "",
    });
    const result = await exitInDir(planExit(root, ["docs", "estate"]), stubBuild);
    expect(result.members.find((m) => m.name === "estate")!.steps).toContain("CHOUDOUFU_UNMIGRATE=estate tofu plan   # stock's first plan removes the two marker tags");
    const report = verifyExit(root, result);
    expect(report.ok).toBe(true);
    expect(report.members.map((m) => m.status)).toEqual(["kept", "not-run"]);
    expect(describeDrill(report).join("\n")).toContain("needs the maintainer");
  });

  test("a linear Op gets a plain job and keeps its op.json; a gated Op gets none", async () => {
    const linear = { name: "ship", phases: [{ name: "p", parallel: false, steps: [{ kind: "activity", fn: "shellCmd", args: { cmd: "make ship" } }] }], onFailure: [] };
    const gated = { name: "gate", phases: [{ name: "p", parallel: false, steps: [{ kind: "gate", gate: "ok" }] }], onFailure: [] };
    expect(linearCommands(linear)).toEqual(["make ship"]);
    expect(linearCommands(gated)).toBeUndefined();
    const root = tree({
      "chant.workspace.json": workspace([{ name: "api", dir: "api", kind: "chant" }]),
      "api/chant.config.ts": CONFIG(["k8s"]),
      "api/dist/ops/ship/op.json": JSON.stringify(linear),
      "api/dist/ops/gate/op.json": JSON.stringify(gated),
    });
    const result = await exitInDir(planExit(root), stubBuild);
    expect(result.members[0]!.ops).toEqual(["api/dist/ops/gate/op.json", "api/dist/ops/ship/op.json"]);
    expect(result.members[0]!.ci).toEqual(["api/dist/ops/ship/job.yml"]);
    expect(readFileSync(join(root, "api/dist/ops/ship/job.yml"), "utf-8")).toContain('run: "make ship"');
  });

  test("an unknown member name is an error", () => {
    const root = tree({ "chant.workspace.json": workspace([{ name: "api", dir: "api", kind: "chant" }]), "api/chant.config.ts": CONFIG(["k8s"]) });
    expect(() => planExit(root, ["nope"])).toThrow(/no member named "nope"/);
  });
});

describe("exit drill against the repository's own workspaces", () => {
  test("the reference workspace", async () => {
    const report = await runExitDrill({ root: join(REPO, "reference-workspace"), runBuild: stubBuild });
    expect(describeDrill(report).join("\n")).not.toMatch(/failed\n/);
    expect(report.ok).toBe(true);
    const delivery = report.members.find((m) => m.name === "delivery")!;
    expect(delivery.status).toBe("passed");
    expect(delivery.deploy).toContain("docker compose -f native/docker-compose.yml up -d");
  });

  test("the getting-started infra example in a workspace", async () => {
    const root = tree({ "chant.workspace.json": workspace([{ name: "infra", dir: "infra", kind: "chant" }]) });
    cpSync(join(REPO, "examples", "getting-started"), join(root, "infra"), { recursive: true, filter: (s) => !s.includes("node_modules") });
    const report = await runExitDrill({ root, runBuild: stubBuild });
    expect(report.ok).toBe(true);
    expect(report.members[0]!.deploy).toEqual(["kubectl apply -f native/k8s.yaml"]);
  });
});
