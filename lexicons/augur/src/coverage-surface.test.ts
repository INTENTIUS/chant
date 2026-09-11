/**
 * The coverage table against the real entity-type surface (#2357).
 *
 * `mapping.test.ts` checks the table's internal shape — no type in both
 * halves, every kind from the closed set, every reason saying something. All
 * of that is true of a table covering nothing, which is roughly what the first
 * version was: a sweep over every chant project in this repository found
 * **107 entity types** resolving to `unknown-type`, the verdict whose detail
 * tells a reader to file a gap. Most were gcp, azure, fly, fountain, helm,
 * github and gitlab types — substrates augur states plainly it does not model
 * — so the message was wrong about ninety times over, and the handful of real
 * gaps (`AWS::EKS::Nodegroup`, the thing an EKS estate actually costs;
 * `K8s::Rbac::ClusterRole`, the cluster-scoped twin of a row that *was*
 * declared) were buried in them.
 *
 * This file is the gate that keeps that from coming back. It builds every
 * chant project in the repository, collects every `entityType` that reaches a
 * build, and requires each one to resolve to a **stated** verdict. A type from
 * a modelled substrate with no row fails here, named, so the next example
 * cannot quietly reintroduce one.
 *
 * It is deliberately the real projects rather than the lexicons' generated
 * registries. Requiring a row for all 1500-odd CloudFormation types would be
 * a table nobody could keep true; requiring one for every type somebody
 * actually declares is a bar that means something and stays reachable.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "@intentius/chant/build";
import { loadPlugins, resolveProjectLexicons } from "@intentius/chant/cli";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { coverageFor, coverageLabel } from "./mapping";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every directory holding a `chant.config.*` and a `src/`, across the repository. */
function chantProjects(): string[] {
  const roots: string[] = [];
  const parents = [
    join(repoRoot, "examples"),
    ...readdirSync(join(repoRoot, "lexicons"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(repoRoot, "lexicons", e.name, "examples")),
  ];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(parent, entry.name);
      if (!existsSync(join(root, "src"))) continue;
      if (!readdirSync(root).some((f) => f.startsWith("chant.config"))) continue;
      roots.push(root);
    }
  }
  return roots.sort();
}

/** One entity type a project declared, with the props the verdict may need (a terraform block's `type`). */
interface DeclaredType {
  entityType: string;
  props: Record<string, unknown>;
  /** What the gap is reported as: the entity type, or `aws_vpc (Terraform::Resource)` for a terraform block. */
  label: string;
}

/**
 * Build one project and return the entity types it produced, or `undefined`
 * when it does not build.
 *
 * A project that fails to build is skipped rather than failed: whether every
 * shipped example builds is `examples/root-examples-gate.test.ts`'s question
 * and `chant dev check-lexicon`'s, and answering it a third time here would
 * make an unrelated breakage look like a coverage-table defect.
 */
async function typesIn(root: string): Promise<DeclaredType[] | undefined> {
  try {
    const lexicons = (await resolveProjectLexicons(root)) as string[];
    const plugins = (await loadPlugins(lexicons)) as LexiconPlugin[];
    const result = await build(join(root, "src"), plugins.map((p) => p.serializer));
    if (result.errors.length > 0) return undefined;
    const types = new Map<string, DeclaredType>();
    for (const [, entity] of result.entities) {
      const { entityType, props } = entity as { entityType?: string; props?: Record<string, unknown> };
      if (!entityType) continue;
      // A terraform `resource` block is one entity type for every provider
      // type, and the verdict is per provider type (#2360), so each is its own
      // entry here rather than one `Terraform::Resource` standing for all.
      const label = coverageLabel(entityType, props);
      if (!types.has(label)) types.set(label, { entityType, props: props ?? {}, label });
    }
    return [...types.values()];
  } catch {
    return undefined;
  }
}

const projects = chantProjects();

describe("the coverage table against every entity type this repository declares (#2357)", () => {
  it("finds projects to check", () => {
    // A glob that silently matches nothing is a gate that silently passes.
    expect(projects.length).toBeGreaterThan(30);
  });

  it("has a stated verdict for every entity type any project declares", async () => {
    const gaps = new Map<string, string[]>();
    let built = 0;
    for (const root of projects) {
      const types = await typesIn(root);
      if (!types) continue;
      built++;
      for (const { entityType, props, label } of types) {
        if (coverageFor(entityType, props).status !== "unknown-type") continue;
        const where = gaps.get(label) ?? [];
        where.push(root.slice(repoRoot.length + 1));
        gaps.set(label, where);
      }
    }
    expect(built).toBeGreaterThan(20);
    expect(
      [...gaps].map(([type, where]) => `${type} (${where.length}: ${where[0]})`).sort(),
      "entity types with no row in lexicons/augur/src/mapping.ts (or, for a terraform block, " +
        "mapping-terraform.ts) — add each to the mapped table or to the declared-unmapped one with a reason",
    ).toEqual([]);
  }, 300_000);
});

describe("the three not-sent verdicts say different things", () => {
  it("names the substrate for a type augur does not model", () => {
    const verdict = coverageFor("GCP::Sql::Instance");
    expect(verdict.status).toBe("provider-not-modelled");
    if (verdict.status !== "provider-not-modelled") return;
    expect(verdict.substrate).toContain("Google Cloud");
  });

  it("treats chant's own pseudo-entities as chant's, not as a missing row", () => {
    // `packages/core/src/stack-output.ts` gives every declared stack output
    // `entityType: "chant:output"`, so before this any project with an output
    // told its user to go and add a row for a substrate that does not exist.
    for (const type of ["chant:output", "chant:aws:defaultTags", "chant:gcp:defaultAnnotations"]) {
      const verdict = coverageFor(type);
      expect(verdict.status, type).toBe("declared-unmapped");
      if (verdict.status !== "declared-unmapped") continue;
      expect(verdict.reason).toContain("chant's own build-time entities");
    }
  });

  it("treats a CloudFormation property type as part of the resource above it", () => {
    const verdict = coverageFor("AWS::S3::Bucket.VersioningConfiguration");
    expect(verdict.status).toBe("declared-unmapped");
    if (verdict.status !== "declared-unmapped") return;
    expect(verdict.reason).toContain("nested block of the resource above it");
  });

  it("checks a terraform block on its provider type, not on Terraform::Resource (#2360)", () => {
    // Every resource block is `Terraform::Resource`, so a verdict on the entity
    // type alone would be one verdict for a VPC and an instance alike.
    const block = (type: string) => ({ address: `${type}.block`, body: {} });
    expect(coverageFor("Terraform::Resource", block("aws_instance")).status).toBe("mapped");
    expect(coverageFor("Terraform::Resource", block("aws_vpc")).status).toBe("declared-unmapped");
    const gcp = coverageFor("Terraform::Resource", block("google_compute_instance"));
    expect(gcp.status).toBe("provider-not-modelled");
    if (gcp.status === "provider-not-modelled") expect(gcp.substrate).toContain("Google Cloud");
    expect(coverageFor("Terraform::Resource", block("null_resource")).status).toBe("provider-not-modelled");
    expect(coverageFor("Terraform::Resource", block("aws_imaginary_thing")).status).toBe("unknown-type");
    // A block naming no provider type has nothing to look up.
    expect(coverageFor("Terraform::Resource").status).toBe("unknown-type");
    // The other block kinds are entity types of their own, and decided.
    expect(coverageFor("Terraform::Variable").status).toBe("declared-unmapped");
    expect(coverageFor("Terraform::Live").status).toBe("declared-unmapped");
  });

  it("still calls a modelled provider's unrowed type a gap, and names this file", () => {
    // The one verdict that is a defect. Narrowing it to modelled providers is
    // what makes it actionable — before, it meant either "augur has a gap" or
    // "you use a substrate augur does not cover", and nothing said which.
    const verdict = coverageFor("AWS::Imaginary::Thing");
    expect(verdict.status).toBe("unknown-type");
    expect(coverageFor("K8s::Imaginary::Thing").status).toBe("unknown-type");
  });
});
