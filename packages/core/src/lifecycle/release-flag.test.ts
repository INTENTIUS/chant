/**
 * A flag change is a commit, so it is gated like any change (#4024, ws-104):
 * the release cut from it carries the flag's new value as a param whose
 * source names the flag record, keeps the previous release's artifact
 * digests when no artifact source changed, and its change set for the
 * environment whose value moved shows the difference while the others are
 * empty. On the fixture in `../workspace/__fixtures__/flag-workspace.ts`,
 * with a compiler that resolves each environment's parameters as a build
 * does and compiles them into the template.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cutRelease } from "./release-cut";
import type { ReleaseArtifact, Release } from "./release-store";
import type { ReleaseRecord } from "./release-ledger";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { chantComponentPart } from "../components/release-gate";
import type { DriverComponent } from "../components/driver";
import { composeChangeSet, isEmptyChangeSet } from "../change-set";
import type { BuildParamsConfig } from "../build-params";
import { resolveFlaggedBuildParams } from "../flag-params";
import { cleanScratch, commitAll, git } from "../workspace/__fixtures__/contract-repo";
import { flagRecord, flagWorkspace } from "../workspace/__fixtures__/flag-workspace";

afterAll(cleanScratch);

const SHOP: BuildParamsConfig = { newCheckout: { type: "boolean", default: false } };
const IMAGE = `sha256:${"a".repeat(64)}`;

/** Compiles each environment with the parameters a build resolves there, flags included, into the shop's template. */
function flagCompiler(memberDir: string): TargetCompiler & { built: string[][] } {
  const built: string[][] = [];
  return {
    built,
    async compile(env): Promise<CompiledTarget> {
      const resolved = await resolveFlaggedBuildParams(memberDir, SHOP, { echo: false }, env);
      if (!resolved.success) throw new Error(resolved.errors.join("\n"));
      const params = resolved.provenance.map(({ name, value, source }) => ({ name, value, source }));
      return {
        env,
        params,
        components: ["shop"],
        buildSteps: { shop: [{ kind: "docker-build", context: "app", into: "shop.tar" }] },
        buildInputs: { shop: ["app", "app/Dockerfile"] },
        componentFiles: { shop: "shop.component.ts" },
        templates: [{ component: "shop", path: "dist/shop.json", content: JSON.stringify({ env, params: Object.fromEntries(params.map((p) => [p.name, p.value])) }) + "\n" }],
      };
    },
    async buildArtifacts(env, components): Promise<ReleaseArtifact[]> {
      built.push([env, ...components]);
      return components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: IMAGE }));
    },
  };
}

const shop: DriverComponent = { name: "shop", deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply", template: "dist/shop.json" }] }] };

const deployed = (release: Release, env: string): ReleaseRecord => ({
  version: 1,
  component: "shop",
  env,
  digest: IMAGE,
  gitSha: release.commit,
  runId: "run-1",
  timestamp: "2026-10-16T00:00:00.000Z",
  actor: "ci",
  releaseDigest: release.releaseDigest,
});

describe("a flag change is a release of its own (#4024)", () => {
  test("it carries the new value with source flag:<id>, the previous artifact digests, and a change set only where the value moved", async () => {
    const root = flagWorkspace({ "shop/app/Dockerfile": "FROM scratch\n" });
    const member = join(root, "shop");
    const compiler = flagCompiler(member);
    const cut = (label: string) => cutRelease({ cwd: member, compiler, label, actor: "alice", env: {}, now: () => new Date("2026-10-17T10:00:00.000Z") });

    const first = git(root, "rev-parse", "HEAD");
    git(root, "tag", `ci/green/${first}`, first);
    const v1 = (await cut("v1")).release;
    expect(compiler.built).toEqual([["dev", "shop"]]);
    expect(v1.targets.find((t) => t.env === "prod")!.params).toEqual([{ name: "newCheckout", value: false, source: "flag:new-checkout" }]);

    // Turning the flag on in prod is a commit to the flag record, and nothing else.
    const flagFile = join(root, "flags", "new-checkout.flag.md");
    writeFileSync(flagFile, flagRecord("new-checkout", { work: "W-002", member: "shop", param: "newCheckout", values: { dev: true, prod: true } }));
    expect(readFileSync(flagFile, "utf-8")).toMatch(/"prod": true/);
    const second = commitAll(root, "turn new-checkout on in prod");
    git(root, "tag", `ci/green/${second}`, second);
    const result = await cut("v2");
    const v2 = result.release;

    // A config-only release: no artifact was built again, and the digests are the previous release's.
    expect(compiler.built).toEqual([["dev", "shop"]]);
    expect(result.reused).toEqual([{ component: "shop", from: v1.releaseDigest }]);
    expect(v2.artifactDigests).toEqual(v1.artifactDigests);
    expect(v2.commit).toBe(second);
    expect(v2.releaseDigest).not.toBe(v1.releaseDigest);
    expect(v2.targets.find((t) => t.env === "prod")!.params).toEqual([{ name: "newCheckout", value: true, source: "flag:new-checkout" }]);

    // The flag change alters prod's change set, and leaves dev's and staging's empty.
    const part = (env: string) => chantComponentPart({ component: shop, release: v2, env, digest: IMAGE, current: { record: deployed(v1, env), release: v1 } });
    const prod = part("prod");
    expect(prod.entries).toHaveLength(1);
    expect(prod.entries[0]).toMatchObject({ address: "shop", action: "update", scope: "prod" });
    expect(prod.entries[0].attributes.map((a) => a.path)).toEqual(["template:dist/shop.json", "param:newCheckout"]);
    expect(prod.entries[0].attributes.find((a) => a.path === "param:newCheckout")).toEqual({ path: "param:newCheckout", before: "false", after: "true" });
    expect(isEmptyChangeSet(composeChangeSet([prod]))).toBe(false);
    for (const env of ["dev", "staging"]) expect(isEmptyChangeSet(composeChangeSet([part(env)]))).toBe(true);
  });
});
