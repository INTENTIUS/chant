/**
 * The pulumi lexicon plugin (#4453): a LexiconPlugin with no declarable
 * kinds, whose job is the `pulumi` member kind's graph read. Nothing here
 * runs Pulumi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { pulumiConfigSchema } from "./config";
import { pulumiPlugin } from "./plugin";
import { lastMemberRead } from "./workspace-member";

const member = join(import.meta.dirname, "testdata", "pulumi-member");

describe("pulumiPlugin", () => {
  test("is a LexiconPlugin named pulumi", () => {
    expect(isLexiconPlugin(pulumiPlugin)).toBe(true);
    expect(pulumiPlugin.name).toBe("pulumi");
    expect(pulumiPlugin.serializer.name).toBe("pulumi");
  });

  test("the config namespace takes a member and nothing else", () => {
    expect(pulumiConfigSchema.parse({ member: { dir: member, label: "infra" } })).toEqual({ member: { dir: member, label: "infra" } });
    expect(() => pulumiConfigSchema.parse({ member: { dir: "" } })).toThrow();
    expect(() => pulumiConfigSchema.parse({ pulumiMember: { dir: member } })).toThrow();
  });

  test("buildRoots reads the member's export and graphMeta reports it", async () => {
    const roots = await pulumiPlugin.buildRoots!({ config: { pulumi: { member: { dir: member, label: "infra" } } } } as never);
    expect([...roots.entities.keys()]).toContain("infra/aws:s3/bucket:Bucket::assets");
    expect(pulumiPlugin.graphMeta!(roots.entities)).toEqual({ pulumiMember: { export: "stack-export.json", objects: 5, exported: true } });
  });

  test("with no member in the config, no entities and no report", async () => {
    const roots = await pulumiPlugin.buildRoots!({ config: {} } as never);
    expect(roots.entities.size).toBe(0);
    expect(pulumiPlugin.graphMeta!(roots.entities)).toBeUndefined();
  });

  test("a relative member dir resolves against the project root (#4468)", async () => {
    const roots = await pulumiPlugin.buildRoots!({
      projectRoot: import.meta.dirname,
      config: { pulumi: { member: { dir: "testdata/pulumi-member", label: "infra" } } },
    } as never);
    expect([...roots.entities.keys()]).toContain("infra/aws:s3/bucket:Bucket::assets");
  });

  test("meets the tier-1 lexicon surface: lint, post-synth, completion, hover, docs (#4468)", () => {
    expect(pulumiPlugin.lintRules!().map((r) => r.id)).toEqual(["PUL101"]);
    expect(pulumiPlugin.postSynthChecks!().map((c) => c.id)).toHaveLength(15);
    expect(typeof pulumiPlugin.completionProvider).toBe("function");
    expect(typeof pulumiPlugin.hoverProvider).toBe("function");
    expect(typeof pulumiPlugin.docs).toBe("function");
  });

  test("buildRoots leaves the member read for PUL003 to PUL015, and clears it with no member (#4510)", async () => {
    await pulumiPlugin.buildRoots!({ config: { pulumi: { member: { dir: member, label: "infra", stack: "dev" } } } } as never);
    expect(lastMemberRead()).toMatchObject({ dir: member, label: "infra", stack: "dev" });
    expect(lastMemberRead()?.doc).toMatchObject({ deployment: {} });
    await pulumiPlugin.buildRoots!({ config: {} } as never);
    expect(lastMemberRead()).toBeUndefined();
  });

  test("detectTemplate recognises a stack export and a Pulumi.yaml, and nothing else (#4510)", () => {
    const detect = pulumiPlugin.detectTemplate!;
    const exported = JSON.parse(readFileSync(join(member, "stack-export.json"), "utf-8"));
    expect(detect(exported)).toBe(true);
    expect(detect({ version: 3, deployment: { manifest: {}, resources: [] } })).toBe(true);
    expect(detect({ name: "app", runtime: "nodejs" })).toBe(true);
    expect(detect({ name: "app", runtime: { name: "python", options: { toolchain: "uv" } } })).toBe(true);

    expect(detect({ name: "app", runtime: "node" })).toBe(false);
    expect(detect({ AWSTemplateFormatVersion: "2010-09-09", Resources: {} })).toBe(false);
    expect(detect({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x" } })).toBe(false);
    expect(detect({ services: { web: { image: "nginx" } } })).toBe(false);
    expect(detect({ version: 3 })).toBe(false);
    expect(detect("name: app\nruntime: nodejs\n")).toBe(false);
    expect(detect(null)).toBe(false);
    expect(detect([])).toBe(false);
  });

  test("initTemplates: member by default, watch and plunge by name (#4510)", () => {
    const init = pulumiPlugin.initTemplates!;
    expect(init()).toEqual(init("member"));
    expect(Object.keys(init().src)).toEqual(["infra.ts"]);
    expect(init().root?.["chant.config.ts"]).toContain(`member: { dir: "./infra", label: "infra" }`);

    expect(Object.keys(init("watch").src).sort()).toEqual(["infra.ts", "watch.op.ts"]);
    expect(init("watch").src["watch.op.ts"]).toContain("PulumiWatchOp({");
    expect(init("watch").src["watch.op.ts"]).not.toContain("engine");

    expect(init("plunge").src["watch.op.ts"]).toContain(`engine: "plunge"`);
    expect(init("plunge").root?.["chant.config.ts"]).toContain(`engine: "plunge"`);
  });
});
