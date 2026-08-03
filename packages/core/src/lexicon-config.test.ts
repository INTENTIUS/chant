import { describe, test, expect } from "vitest";
import { z } from "zod";
import { validateLexiconConfig, formatLexiconConfigProblems } from "./lexicon-config";
import type { ChantConfig } from "./config";

const forgejo = {
  name: "forgejo",
  configSchema: z.strictObject({
    runnerLabels: z.record(z.string(), z.string()).optional(),
    actionsRoot: z.string().optional(),
  }),
};

const undeclared = { name: "docker" };

const cfg = (extra: Record<string, unknown>): ChantConfig =>
  ({ lexicons: ["forgejo"], ...extra }) as unknown as ChantConfig;

describe("validateLexiconConfig (#1344)", () => {
  test("accepts a namespace matching the declared shape", () => {
    const problems = validateLexiconConfig(
      [forgejo],
      cfg({ forgejo: { runnerLabels: { "ubuntu-latest": "docker" }, actionsRoot: "https://x" } }),
    );
    expect(problems).toEqual([]);
  });

  test("rejects an unknown key — the typo that used to be silently ignored", () => {
    const problems = validateLexiconConfig([forgejo], cfg({ forgejo: { runnerLabel: {} } }));
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe("forgejo");
    expect(problems[0].message).toContain("runnerLabel");
  });

  test("names the dotted path of a bad value, not just the namespace", () => {
    const problems = validateLexiconConfig([forgejo], cfg({ forgejo: { actionsRoot: 42 } }));
    expect(problems[0].path).toBe("forgejo.actionsRoot");
  });

  test("an absent namespace is fine — every one of them is optional", () => {
    expect(validateLexiconConfig([forgejo], cfg({}))).toEqual([]);
  });

  test("an empty namespace is fine", () => {
    expect(validateLexiconConfig([forgejo], cfg({ forgejo: {} }))).toEqual([]);
  });

  test("a lexicon that declares nothing keeps passthrough", () => {
    // Tightening a namespace nobody described would fail configs that work.
    expect(validateLexiconConfig([undeclared], cfg({ docker: { anything: true } }))).toEqual([]);
  });

  test("another lexicon's namespace is not this lexicon's to reject", () => {
    expect(validateLexiconConfig([forgejo], cfg({ somethingElse: { a: 1 } }))).toEqual([]);
  });

  test("core's own keys are untouched", () => {
    expect(validateLexiconConfig([forgejo], cfg({ sourceDir: "src", build: { fold: true } }))).toEqual([]);
  });

  test("reports every problem, not just the first", () => {
    const problems = validateLexiconConfig(
      [forgejo],
      cfg({ forgejo: { runnerLabel: {}, actionsRoot: 42 } }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  test("validates each declaring lexicon independently", () => {
    const temporal = {
      name: "temporal",
      configSchema: z.strictObject({ defaultProfile: z.string().optional() }),
    };
    const problems = validateLexiconConfig(
      [forgejo, temporal],
      cfg({ forgejo: { actionsRoot: "https://x" }, temporal: { defaultProfil: "local" } }),
    );
    expect(problems.map((p) => p.lexicon)).toEqual(["temporal"]);
  });

  test("no config at all is not a problem", () => {
    expect(validateLexiconConfig([forgejo], undefined)).toEqual([]);
  });

  test("a nested strictObject catches a typo one level down", () => {
    const k8s = {
      name: "k8s",
      configSchema: z.strictObject({
        profiles: z.record(z.string(), z.strictObject({ context: z.string() })).optional(),
      }),
    };
    const problems = validateLexiconConfig(
      [k8s],
      cfg({ k8s: { profiles: { prod: { contxt: "prod-eks" } } } }),
    );
    // Two, and both are right: the key it does not recognize, and the required
    // one that is now missing because of the typo.
    expect(problems.map((p) => p.path).sort()).toEqual(["k8s.profiles.prod", "k8s.profiles.prod.context"]);
  });
});

describe("formatLexiconConfigProblems", () => {
  test("one indented line per problem", () => {
    const problems = validateLexiconConfig([forgejo], cfg({ forgejo: { actionsRoot: 42 } }));
    expect(formatLexiconConfigProblems(problems)).toMatch(/^ {2}forgejo\.actionsRoot: /);
  });

  test("empty for no problems", () => {
    expect(formatLexiconConfigProblems([])).toBe("");
  });
});
