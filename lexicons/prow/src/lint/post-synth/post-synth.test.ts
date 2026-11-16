/**
 * Each PROW post-synth check against its positive and negative fixture
 * (fixtures/PROW1xx/), and against the job configs terragucci writes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { PostSynthCheck, PostSynthContext } from "@intentius/chant/lint/post-synth";
import { postSynthChecks } from "./index";
import { prow101 } from "./prow101";
import { prow102 } from "./prow102";
import { prow103 } from "./prow103";
import { prow104 } from "./prow104";
import { prow105 } from "./prow105";
import { prow106 } from "./prow106";

const FIXTURES = join(import.meta.dirname, "fixtures");
const TERRAGUCCI = join(import.meta.dirname, "..", "..", "testdata", "terragucci");

function ctx(yaml: string): PostSynthContext {
  const outputs = new Map<string, string>([["prow", yaml]]);
  return { outputs, entities: new Map(), buildResult: { outputs, entities: new Map(), warnings: [] } } as unknown as PostSynthContext;
}

const read = (id: string, which: "positive" | "negative") => readFileSync(join(FIXTURES, id, `${which}.yaml`), "utf-8");

const CASES: Array<[PostSynthCheck, "error" | "warning", number, string]> = [
  [prow101, "error", 1, "named pull-app-unit"],
  [prow102, "error", 1, "has no schedule"],
  [prow103, "error", 1, "has no spec"],
  [prow104, "warning", 2, "from Secret github-token"],
  [prow105, "warning", 1, "on build cluster trusted, where postsubmit post-infra-apply (service account tf-apply)"],
  [prow106, "error", 1, "sets always_run and skip_if_only_changed"],
];

describe("PROW post-synth checks", () => {
  test("the barrel lists every check", () => {
    expect(postSynthChecks.map((c) => c.id)).toEqual(["PROW101", "PROW102", "PROW103", "PROW104", "PROW105", "PROW106"]);
  });

  for (const [check, severity, count, needle] of CASES) {
    test(`${check.id}: the positive fixture is flagged`, () => {
      const diags = check.check(ctx(read(check.id, "positive")));
      expect(diags).toHaveLength(count);
      for (const d of diags) {
        expect(d.checkId).toBe(check.id);
        expect(d.severity).toBe(severity);
      }
      expect(diags.map((d) => d.message).join("\n")).toContain(needle);
    });

    test(`${check.id}: the negative fixture is not`, () => {
      expect(check.check(ctx(read(check.id, "negative")))).toEqual([]);
    });
  }

  test("PROW102 flags a periodic with two schedules", () => {
    const yaml = "periodics:\n  - name: p\n    interval: 1h\n    cron: 0 * * * *\n    spec:\n      containers:\n        - name: c\n          image: i\n";
    expect(prow102.check(ctx(yaml))[0].message).toContain("sets interval and cron");
  });

  test("PROW103 flags a pod spec with no container, and leaves a jenkins job alone", () => {
    expect(prow103.check(ctx("presubmits:\n  a/b:\n    - name: x\n      spec:\n        containers: []\n"))[0].message).toContain("has no container");
    expect(prow103.check(ctx("presubmits:\n  a/b:\n    - name: x\n      agent: jenkins\n"))).toEqual([]);
  });

  test("an output that is not a job config is left alone", () => {
    for (const c of postSynthChecks) expect(c.check(ctx("apiVersion: v1\nkind: ConfigMap\n"))).toEqual([]);
  });

  test("terragucci's default jobs pass every check: the presubmit holds nothing and runs where nothing is held", () => {
    const yaml = readFileSync(join(TERRAGUCCI, "default.yaml"), "utf-8");
    for (const c of postSynthChecks) expect({ id: c.id, diags: c.check(ctx(yaml)) }).toEqual({ id: c.id, diags: [] });
  });

  test("terragucci's plan presubmit, opted into with plan_before_merge, is the one PROW104 and PROW105 report", () => {
    const yaml = readFileSync(join(TERRAGUCCI, "full.yaml"), "utf-8");
    for (const c of [prow104, prow105]) {
      const diags = c.check(ctx(yaml));
      expect(diags.map((d) => d.entity)).toEqual(["terragucci-plan"]);
    }
    for (const c of [prow101, prow102, prow103, prow106]) expect(c.check(ctx(yaml))).toEqual([]);
  });
});
