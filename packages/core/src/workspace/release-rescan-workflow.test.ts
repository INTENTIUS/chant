/**
 * #5466: the scheduled rescan workflow `chant release workflow` writes for
 * `release.scan.schedule`, byte for byte on each forge.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { ChantConfigSchema } from "../config";
import { registryEnvOf, renderRescanWorkflow, RELEASE_RESCAN_WORKFLOW_FILES } from "./release-rescan-workflow";
import { RELEASE_WORKFLOW_FORGES } from "./release-workflow";

const base = { schedule: "0 5 * * 1", chant: "npx chant", install: "npm ci", root: null, pipeline: {}, registryEnv: ["OCI_USERNAME", "OCI_PASSWORD"] };

describe("the rescan workflow", () => {
  for (const forge of RELEASE_WORKFLOW_FORGES) {
    test(`${forge}: a scheduled job runs release scan --deployed`, async () => {
      const text = renderRescanWorkflow({ ...base, forge });
      await expect(text).toMatchFileSnapshot(join(__dirname, "__snapshots__", "release-workflow", `rescan-${forge}.yml.snap`));
      expect(text).toContain("chant release scan --deployed");
      expect(text).toContain("chant/lifecycle");
    });
  }

  test("a member's directory, the registry secrets and the scanner install appear where each forge takes them", () => {
    const github = renderRescanWorkflow({ ...base, forge: "github", root: "packages/app" });
    expect(github).toContain("working-directory: packages/app");
    expect(github).toContain("OCI_PASSWORD: ${{ secrets.OCI_PASSWORD }}");
    expect(github).toContain("CHANT_GRYPE");
    expect(github).toContain('cron: "0 5 * * 1"');
    const gitlab = renderRescanWorkflow({ ...base, forge: "gitlab", root: "packages/app" });
    expect(gitlab).toContain("cd packages/app");
    expect(gitlab).toContain('$CI_PIPELINE_SOURCE == "schedule"');
    expect(gitlab).toContain("CHANT_RELEASE_TOKEN");
    expect(() => renderRescanWorkflow({ ...base, forge: "github", registryEnv: ["bad name"] })).toThrow(/not a variable name/);
  });

  test("the registry's variables come from the oci targets, once each, and a target that names its own keeps them", () => {
    expect(registryEnvOf([{ type: "oci" }, { type: "npm" }, { type: "oci" }])).toEqual(["OCI_USERNAME", "OCI_PASSWORD"]);
    expect(registryEnvOf([{ type: "oci", usernameEnv: "GHCR_USER", passwordEnv: "GHCR_TOKEN" }])).toEqual(["GHCR_USER", "GHCR_TOKEN"]);
    expect(registryEnvOf([{ type: "npm" }])).toEqual([]);
    expect(RELEASE_RESCAN_WORKFLOW_FILES.gitlab).toBe(".gitlab/chant-release-scan.yml");
  });

  test("release.scan.schedule is a cron expression of five fields", () => {
    const parse = (schedule: string) => ChantConfigSchema.safeParse({ release: { scan: { schedule } } }).success;
    expect(parse("0 5 * * 1")).toBe(true);
    expect(parse("weekly")).toBe(false);
    expect(parse("0 5 * *")).toBe(false);
  });
});
