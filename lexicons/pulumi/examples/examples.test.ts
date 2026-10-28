/**
 * The shipped pulumi examples read their member (#4468, #4510): `chant dev
 * check-lexicon` builds each, and this asserts what the build read, the two
 * resources of `infra/stack-export.json` with the edge between them, that
 * no post-synth check reports anything, and what the two watch Ops run.
 */
import { join } from "node:path";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { ActivityStep, OpConfig } from "@intentius/chant/op";
import { describe, expect, it } from "vitest";
import { pulumiPlugin } from "../src/plugin";
import { pulumiMemberEngine } from "../src/run";
import { lastMemberReport } from "../src/workspace-member";

const example = join(import.meta.dirname, "workspace-member");

describe("pulumi examples", () => {
  it("workspace-member reads infra/ relative to the project root", async () => {
    const roots = await pulumiPlugin.buildRoots!({
      projectRoot: example,
      config: { pulumi: { member: { dir: "./infra", label: "infra" } } },
    } as never);
    expect([...roots.entities.keys()].sort()).toEqual([
      "infra/aws:s3/bucketV2:BucketV2::assets",
      "infra/aws:s3/bucketVersioningV2:BucketVersioningV2::assetsVersioning",
    ]);
    const versioning = roots.entities.get("infra/aws:s3/bucketVersioningV2:BucketVersioningV2::assetsVersioning") as unknown as {
      references: { to: string }[];
    };
    expect(versioning.references.map((r) => r.to)).toEqual(["infra/aws:s3/bucketV2:BucketV2::assets"]);
    expect(lastMemberReport()).toEqual({ export: "stack-export.json", exportSource: "file", objects: 2, exported: true });
  });

  for (const name of ["workspace-member", "scheduled-watch", "plunge-member"]) {
    it(`${name} reads its member with no post-synth finding`, async () => {
      const dir = join(import.meta.dirname, name);
      const roots = await pulumiPlugin.buildRoots!({
        projectRoot: dir,
        config: { pulumi: { member: { dir: "./infra", label: "infra" } } },
      } as never);
      expect(roots.entities.size).toBe(2);
      const ctx = { outputs: new Map(), entities: new Map() } as unknown as PostSynthContext;
      for (const check of pulumiPlugin.postSynthChecks!()) expect(check.check(ctx), check.id).toEqual([]);
    });
  }

  it("plunge-member is on plunge by its backend URL, and the others are not", () => {
    expect(pulumiMemberEngine(join(import.meta.dirname, "plunge-member", "infra")).engine).toBe("plunge");
    expect(pulumiMemberEngine(join(import.meta.dirname, "scheduled-watch", "infra")).engine).toBe("pulumi");
  });

  for (const [name, opName] of [
    ["scheduled-watch", "infra-watch"],
    ["plunge-member", "infra-plunge-watch"],
  ] as const) {
    it(`${name}'s watch Op previews, then reads drift, on a cron`, async () => {
      const mod = (await import(`./${name}/src/watch.op.ts`)) as { op: { props: OpConfig } };
      const op = mod.op.props;
      expect(op.name).toBe(opName);
      expect(op.schedule).toEqual({ cron: "0 6 * * *", overlap: "skip" });
      expect(op.phases.map((p) => (p.steps[0] as ActivityStep).fn)).toEqual(["pulumiPreview", "pulumiDrift"]);
      expect((op.phases[0].steps[0] as ActivityStep).args).not.toHaveProperty("engine");
    });
  }
});
