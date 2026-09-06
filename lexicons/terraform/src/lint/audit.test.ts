import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { auditFiles, type ChecksProvider, type EntitiesProvider } from "@intentius/chant/audit/core";
import { collectCandidates, discoverByDetection, type DetectPlugin } from "@intentius/chant/audit/discover";
import { auditTerraformState } from "@intentius/chant/audit/terraform-state";
import { terraformPlugin } from "../plugin";
import { postSynthChecks } from "./post-synth";

/**
 * End-to-end audit test (#2085 acceptance): `chant audit` (`auditFiles` on top
 * of real filesystem discovery, `discoverByDetection`) against the #2083
 * fixture root modules. Real terraform plugin methods are wired in directly
 * as `checksProvider`/`entitiesProvider` (the same seam `packages/core/src/
 * audit/core.test.ts` uses) rather than through `loadPlugin`'s package-name
 * resolution, so this runs against source, not a built `dist/`.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");

const terraformDetectPlugin: DetectPlugin = { name: "terraform" };

const checksProvider: ChecksProvider = async (lexicon) =>
  lexicon === "terraform" ? (terraformPlugin.postSynthChecks?.() ?? []) : [];

const entitiesProvider: EntitiesProvider = async (lexicon) =>
  lexicon === "terraform" ? terraformPlugin.auditEntities?.bind(terraformPlugin) : undefined;

describe("chant audit against a discovered terraform root module", () => {
  test("reports TF001 once for the no-backend root", async () => {
    const inputs = discoverByDetection(join(fixtures, "no-backend"), [terraformDetectPlugin]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.lexicon).toBe("terraform");

    const findings = await auditFiles(inputs, { checksProvider, entitiesProvider });
    const tf001 = findings.filter((f) => f.checkId === "TF001");
    expect(tf001).toHaveLength(1);
    expect(tf001[0]!.lexicon).toBe("terraform");
  });

  test("reports nothing for the with-backend root", async () => {
    const inputs = discoverByDetection(join(fixtures, "with-backend"), [terraformDetectPlugin]);
    expect(inputs).toHaveLength(1);

    const findings = await auditFiles(inputs, { checksProvider, entitiesProvider });
    expect(findings.filter((f) => f.checkId === "TF001")).toHaveLength(0);
  });
});

/**
 * TF023 (#2110) is audit-only: it reads the file list `chant audit` discovers,
 * never a parsed root module, so it lives in core
 * (`packages/core/src/audit/terraform-state.ts`) beside the other
 * lexicon-independent families. These run the two halves it depends on, the
 * real walk and the real check, over the committed fixture roots.
 */
describe("TF023: Terraform state committed to the repository", () => {
  const tf023 = join(dirname(fileURLToPath(import.meta.url)), "post-synth", "fixtures", "TF023");

  test("fires on a root whose state file is committed beside it", () => {
    // The fixture ships its state as `state.json`: a tracked `terraform.tfstate`
    // is exactly what this rule reports, and the repository's own push rules
    // refuse the name. The test materialises the root the rule is written for.
    const root = mkdtempSync(join(tmpdir(), "chant-tf023-"));
    copyFileSync(join(tf023, "positive", "main.tf"), join(root, "main.tf"));
    copyFileSync(join(tf023, "positive", "state.json"), join(root, "terraform.tfstate"));
    const findings = auditTerraformState(collectCandidates(root));
    rmSync(root, { recursive: true, force: true });
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe("TF023");
    expect(findings[0].file).toBe("terraform.tfstate");
    expect(findings[0].lexicon).toBe("terraform");
  });

  test("says nothing about a root that keeps its state remote", () => {
    expect(auditTerraformState(collectCandidates(join(tf023, "negative")))).toEqual([]);
  });

  test("never runs during a build: it is not one of this lexicon's post-synth checks", () => {
    expect(postSynthChecks.map((c) => c.id)).not.toContain("TF023");
    expect(terraformPlugin.auditCatalog?.()).not.toHaveProperty("TF023");
  });
});
