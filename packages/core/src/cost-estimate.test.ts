/**
 * The plan's cost estimate (#5334): `ci.cost` read at base, the command run
 * over each member's plan document, the record the note shows and the
 * policy reads as `input.cost`, and the only effect it has on a gate: an
 * approval it adds. The estimator is a fake; nothing reaches a network.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { composeChangeSet, type ChangeSetPart } from "./change-set";
import { parseDeclaration, WorkspaceReadError } from "./workspace/declaration";
import { costEstimateLines, costEstimateOf, estimateCosts, policyCost, readCostEstimate, type CostEstimate, type CostEstimateExec } from "./cost-estimate";
import { estimatePrSet, prCostRuns, prLoopCostAt } from "./components/pr-cost";
import { prLoopPolicyAt, runPrPolicy, type PrPolicyInput } from "./components/pr-policy";
import { memberCounts, PR_REPORT_SCHEMA_ID, renderPrNote, type PrReport } from "./pr-loop";
import { renderPlanNote, type PrPlanNote } from "./pr-plan-note";
import { assertProductWords } from "./ci-product-words";
import { PLYWOOD, TERRAGUCCI, TERRAGUCCI_NOTE } from "./__fixtures__/product-words";
import * as ciProduct from "./ci-product";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cost-estimate-")));
  scratch.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const hex = (n: number) => n.toString(16).padStart(64, "0");

const declaration = (ci: Record<string, unknown> | undefined) => ({
  name: "acme",
  schema: 1,
  members: [{ name: "infra", dir: "infra", kind: "other", because: "test" }],
  ...(ci ? { ci } : {}),
});

const part = (member: string, lexicon: "terraform" | "pulumi", action: "create" | "no-op"): ChangeSetPart => ({
  member: { member, lexicon, planner: lexicon, status: "planned", planDigest: `jcs1-sha256:${hex(member.length)}`, holes: [] },
  entries: action === "no-op" ? [] : [{ member, lexicon, planner: lexicon, address: `${member}.thing`, type: "thing", action, attributes: [] } as unknown as ChangeSetPart["entries"][number]],
});

/** A planned set as pr-plan builds it: a terraform root and a pulumi stack whose plans name their documents, and a root that changes nothing. */
function plannedSet(dir: string) {
  const tfJson = join(dir, "network.tfplan.json");
  const previewJson = join(dir, "shop-dev.preview.json");
  writeFileSync(tfJson, JSON.stringify({ resource_changes: [] }));
  writeFileSync(previewJson, JSON.stringify({ steps: [] }));
  const doc = composeChangeSet([part("network", "terraform", "create"), part("shop-dev", "pulumi", "create"), part("dns", "terraform", "no-op")]);
  const members = ["network", "shop-dev", "dns"].map((member) => ({ member, component: member === "shop-dev" ? "shop" : member, planDigest: `jcs1-sha256:${hex(member.length)}`, status: "planned" as const, counts: memberCounts(doc, member) }));
  const plans = {
    network: { network: { planFile: join(dir, "network.tfplan"), planDigest: "d1", planJson: tfJson } },
    shop: { "shop-dev": { kind: "pulumi-up", stack: "dev", planJson: previewJson } },
    dns: { dns: { planFile: join(dir, "dns.tfplan"), planDigest: "d3", planJson: join(dir, "dns.tfplan.json") } },
  };
  return { doc, members, plans, tfJson, previewJson };
}

/** An estimator that prices by the document it is handed. */
const fakeEstimator = (prices: Record<string, unknown>, seen: string[][] = []): CostEstimateExec => (argv) => {
  seen.push(argv);
  const file = argv.find((a) => a.endsWith(".json"))!;
  const out = prices[file.split("/").pop()!];
  return out === undefined ? { status: 2, stdout: "", stderr: "no price for it" } : { status: 0, stdout: JSON.stringify(out), stderr: "" };
};

describe("ci.cost in the declaration (#5334)", () => {
  const read = (cost: unknown) => parseDeclaration(JSON.stringify(declaration({ cost })), "chant.workspace.json", "0.124.200");

  test("parses the hold's fields, with approveAbove optional", () => {
    expect(read({ command: ["infracost", "breakdown", "--path", "{planJson}"] }).ci?.cost).toEqual({ command: ["infracost", "breakdown", "--path", "{planJson}"] });
    expect(read({ command: ["price", "{planJson}"], format: "chant", currency: "EUR", approveAbove: 100 }).ci?.cost).toEqual({ command: ["price", "{planJson}"], format: "chant", currency: "EUR", approveAbove: 100 });
  });

  test("refuses what no job could run", () => {
    expect(() => read({ command: [] })).toThrow(WorkspaceReadError);
    expect(() => read({ command: ["x"], approveAbove: -1 })).toThrow(/approveAbove/);
    expect(() => read({ command: ["x"], format: "csv" })).toThrow(/format/);
    expect(() => read({ command: ["x"], allowUnattended: true })).toThrow();
  });

  test("is read at base: the change's edits do not run", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "infra"));
    writeFileSync(join(repo, "infra", ".keep"), "");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ cost: { command: ["price", "{planJson}"], format: "chant", approveAbove: 50 } })));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ cost: { command: ["price", "{planJson}"], format: "chant", approveAbove: 1e9 } })));
    expect(prLoopCostAt(join(repo, "infra"), base).settings).toEqual({ command: ["price", "{planJson}"], format: "chant", approveAbove: 50 });
  });

  test("a base with no ci.cost runs no estimate, and is off by default", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration(undefined)));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const read = prLoopCostAt(repo, git(repo, "rev-parse", "HEAD"));
    expect(read.settings).toBeUndefined();
    expect(estimatePrSet(read, plannedSet(tmp()), repo)).toBeUndefined();
  });
});

describe("the estimate over a planned set (#5334)", () => {
  test("a terraform root and a pulumi stack are priced from their plan documents; a member that changes nothing is not", () => {
    const dir = tmp();
    const set = plannedSet(dir);
    expect(prCostRuns(set)).toEqual([
      { member: "network", artifact: set.plans.network.network, empty: false },
      { member: "shop-dev", artifact: set.plans.shop["shop-dev"], empty: false },
      { member: "dns", artifact: set.plans.dns.dns, empty: true },
    ]);
    const seen: string[][] = [];
    const estimate = estimatePrSet(
      { base: "b", settings: { command: ["price", "{planJson}", "{target}"], format: "chant", approveAbove: 100 } },
      set,
      dir,
      fakeEstimator({ "network.tfplan.json": { monthlyDelta: 30, monthlyTotal: 130, pastMonthlyTotal: 100 }, "shop-dev.preview.json": { monthlyDelta: 12.5, monthlyTotal: 12.5, pastMonthlyTotal: 0 } }, seen),
    )!;
    // #5416: the estimator reads a redacted copy, which keeps the document's file name.
    expect(seen.map(([cmd, file, member]) => [cmd, basename(file!), member])).toEqual([
      ["price", basename(set.tfJson), "network"],
      ["price", basename(set.previewJson), "shop-dev"],
    ]);
    expect(seen.every(([, file]) => file !== set.tfJson && file !== set.previewJson)).toBe(true);
    expect(estimate).toEqual({
      estimator: "price",
      format: "chant",
      currency: "USD",
      monthlyDelta: 42.5,
      monthlyTotal: 142.5,
      pastMonthlyTotal: 100,
      members: [
        { member: "network", monthlyDelta: 30, monthlyTotal: 130, pastMonthlyTotal: 100 },
        { member: "shop-dev", monthlyDelta: 12.5, monthlyTotal: 12.5, pastMonthlyTotal: 0 },
      ],
      unestimated: [],
      approveAbove: 100,
      over: false,
    });
  });

  test("over approveAbove, or a member with no estimate, is over; without approveAbove it only informs", () => {
    const dir = tmp();
    const set = plannedSet(dir);
    const exec = fakeEstimator({ "network.tfplan.json": { monthlyDelta: 300 } });
    const capped = estimatePrSet({ base: "b", settings: { command: ["price", "{planJson}"], format: "chant", approveAbove: 1000 } }, set, dir, exec)!;
    expect(capped.unestimated).toEqual(["shop-dev"]);
    expect(capped.members[1]).toEqual({ member: "shop-dev", error: "price exited 2: no price for it" });
    expect(capped.over).toBe(true);
    const informs = estimatePrSet({ base: "b", settings: { command: ["price", "{planJson}"], format: "chant" } }, set, dir, exec)!;
    expect(informs).toMatchObject({ monthlyDelta: 300, approveAbove: null, over: false });
    const priced = costEstimateOf({ command: ["price"], approveAbove: 100 }, [{ member: "network", monthlyDelta: 300 }]);
    expect(priced.over).toBe(true);
  });

  test("a plan that names no plan document is not estimated, and the failure never throws", () => {
    const estimate = estimateCosts({ command: ["price", "{planJson}"] }, [{ member: "a", artifact: { planFile: "a.tfplan" }, empty: false }], tmp(), () => {
      throw new Error("not run");
    });
    expect(estimate.members).toEqual([{ member: "a", error: "its plan names no plan document to price" }]);
  });

  test("infracost's document gives the change and the totals", () => {
    expect(readCostEstimate("infracost", JSON.stringify({ currency: "EUR", totalMonthlyCost: "40", pastTotalMonthlyCost: "10", diffTotalMonthlyCost: "30" }))).toEqual({ monthlyDelta: 30, monthlyTotal: 40, pastMonthlyTotal: 10, currency: "EUR" });
  });
});

describe("input.cost (#5334)", () => {
  const estimate: CostEstimate = costEstimateOf({ command: ["infracost"], approveAbove: 20 }, [
    { member: "network", monthlyDelta: 30 },
    { member: "dns", error: "infracost exited 1: no key" },
  ]);

  test("the policy reads the estimate, and per member that member's own", () => {
    expect(policyCost(estimate)).toEqual(estimate);
    expect(policyCost(estimate, "network").member).toEqual({ member: "network", monthlyDelta: 30 });
  });

  test("runPrPolicy hands it to the engine as input.cost", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "policy"));
    writeFileSync(join(repo, "policy", "main.rego"), "package main\n");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ policy: { engine: "opa" } })));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    let fed: { cost?: unknown } = {};
    const input: PrPolicyInput = { version: 1, stage: "plan", op: "pr-7", gate: "pr-apply", env: "prod", pr: 7, base, head: "h".repeat(40), changeSet: composeChangeSet([]), cost: policyCost(estimate) };
    const verdict = runPrPolicy(prLoopPolicyAt(repo, base), input, (argv) => {
      fed = JSON.parse(readFileSync(argv[argv.indexOf("--input") + 1]!, "utf-8"));
      return { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value: { hold: ["over budget"] } }] }] }), stderr: "" };
    })!;
    expect(fed.cost).toEqual(JSON.parse(JSON.stringify(estimate)));
    expect(verdict.result).toBe("held");
  });
});

describe("the note (#5334)", () => {
  const estimate = costEstimateOf({ command: ["infracost"], approveAbove: 20 }, [
    { member: "network", monthlyDelta: 30, monthlyTotal: 130, pastMonthlyTotal: 100 },
    { member: "dns", error: "infracost exited 1: <no key>" },
  ]);

  test("the lines name each member, the failure and the approval it adds", () => {
    expect(costEstimateLines(estimate, "root")).toEqual([
      "",
      "**Cost (`infracost`):** +30.00 USD a month, 130.00 USD a month once it applies.",
      "",
      "| Root | Monthly change | Monthly total |",
      "|---|---:|---:|",
      "| `network` | +30.00 USD | 130.00 USD |",
      "| `dns` | not estimated | |",
      "",
      "- `dns` was not estimated: infracost exited 1: &lt;no key&gt;",
      "",
      "The monthly change is over 20.00 USD, or cannot be known in full, so this plan needs an approval of its own digest.",
    ]);
    expect(costEstimateLines(costEstimateOf({ command: ["price"] }, [{ member: "a", monthlyDelta: -5 }]))).toContain("**Cost (`price`):** -5.00 USD a month.");
  });

  test("the pr loop's note carries it, in the product's words", () => {
    const doc = composeChangeSet([part("shop-dev", "pulumi", "create")]);
    const report: PrReport = {
      $schema: PR_REPORT_SCHEMA_ID,
      contract: 1,
      stage: "plan",
      pr: 12,
      env: "dev",
      base: "1".repeat(40),
      head: "2".repeat(40),
      op: "pr-12",
      gate: "up",
      digest: doc.digest,
      status: "planned",
      approval: { status: "pending" },
      selection: { changed: ["shop"], dependents: [], unclaimed: [], indeterminate: [], waves: [["shop"]] },
      members: [{ member: "shop-dev", component: "shop", planDigest: `jcs1-sha256:${hex(8)}`, status: "planned", counts: memberCounts(doc, "shop-dev") }],
      changeSet: doc,
    };
    const words = assertProductWords(PLYWOOD);
    expect(renderPrNote(report, { words })).not.toContain("**Cost");
    const priced = costEstimateOf({ command: ["price"], format: "chant" }, [{ member: "shop-dev", monthlyDelta: 12.5 }]);
    const note = renderPrNote({ ...report, cost: priced }, { words });
    expect(note).toContain("**Cost (`price`):** +12.50 USD a month.");
    expect(note).toContain("| Stack | Monthly change | Monthly total |");
    expect(note).toContain("| `shop-dev` | +12.50 USD |  |");
  });

  test("a product's own plan note carries the same lines, and values that are not numbers do not break it", () => {
    const note: PrPlanNote = { kind: "plan-note", contract: 1, stage: "tf-plan", head: "a".repeat(40), units: 1, named: [], waves: [], groups: [], cost: estimate };
    const tg = { words: assertProductWords(TERRAGUCCI), note: TERRAGUCCI_NOTE };
    const text = renderPlanNote(note, tg);
    expect(text).toContain("**Cost (`infracost`):** +30.00 USD a month, 130.00 USD a month once it applies.");
    expect(text).toContain("| `network` | +30.00 USD | 130.00 USD |");
    const bad = { ...note, cost: { ...estimate, monthlyDelta: "lots", members: [null, { member: "x", monthlyDelta: "1" }] } } as unknown as PrPlanNote;
    expect(renderPlanNote(bad, tg)).toContain("**Cost (`infracost`):** ? USD a month");
  });

  test("ci-product exports the record's builders and its floor", () => {
    expect(ciProduct.COST_ESTIMATE_FLOOR).toBeTypeOf("string");
    expect(ciProduct.estimateCosts).toBe(estimateCosts);
    expect(ciProduct.costEstimateLines).toBe(costEstimateLines);
    expect(ciProduct.prLoopCostAt).toBe(prLoopCostAt);
  });
});
