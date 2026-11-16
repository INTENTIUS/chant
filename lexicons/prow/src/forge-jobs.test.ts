/**
 * #5170: `ci: prow` beside `forge: github` writes the jobs keyed by the
 * GitHub repository's owner/name, through the same emitter as the
 * serializer.
 */
import { describe, expect, test } from "vitest";
import { forgeJobConfig, prowForgeProblem } from "./forge-jobs";
import { emitJobConfig } from "./serializer";
import { parseJobConfig } from "./job-config";

const spec = { containers: [{ image: "alpine", command: ["true"] }] };

describe("forgeJobConfig", () => {
  test("keys the presubmits and postsubmits by owner/name, and writes the periodics as given", () => {
    const text = forgeJobConfig(
      { forge: "github", repo: "acme/infra" },
      { presubmits: [{ name: "plan", always_run: true, spec }], postsubmits: [{ name: "apply", spec }], periodics: [{ name: "drift", interval: "24h", spec }] },
      { header: "written by a product" },
    );
    expect(text.startsWith("# written by a product\n\n")).toBe(true);
    const doc = parseJobConfig(text)!;
    expect(Object.keys(doc.presubmits as object)).toEqual(["acme/infra"]);
    expect(Object.keys(doc.postsubmits as object)).toEqual(["acme/infra"]);
    expect((doc.periodics as unknown[]).length).toBe(1);
    expect(text).toBe(
      emitJobConfig(
        { presubmits: { "acme/infra": [{ name: "plan", always_run: true, spec }] }, postsubmits: { "acme/infra": [{ name: "apply", spec }] }, periodics: [{ name: "drift", interval: "24h", spec }] },
        { header: "written by a product" },
      ),
    );
  });

  test("leaves out a kind with no jobs", () => {
    expect(parseJobConfig(forgeJobConfig({ forge: "github", repo: "acme/infra" }, { presubmits: [{ name: "plan", spec }] }))).toEqual({ presubmits: { "acme/infra": [{ name: "plan", spec }] } });
  });

  test("refuses another forge and a repository that is not owner/name", () => {
    expect(prowForgeProblem({ forge: "github", repo: "acme/infra" })).toBeUndefined();
    expect(() => forgeJobConfig({ forge: "gitlab", repo: "acme/infra" }, {})).toThrow(/ci: prow runs jobs for a repository on github, and this forge is gitlab/);
    expect(() => forgeJobConfig({ forge: "github", repo: "acme" }, {})).toThrow(/owner\/name/);
  });
});
