import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { auditFiles, type ChecksProvider, type EntitiesProvider } from "@intentius/chant/audit/core";
import { discoverByDetection, type DetectPlugin } from "@intentius/chant/audit/discover";
import { terraformPlugin } from "../plugin";

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
