/**
 * The pulumi lexicon plugin (#4453): a LexiconPlugin with no declarable
 * kinds, whose job is the `pulumi` member kind's graph read. Nothing here
 * runs Pulumi.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { pulumiConfigSchema } from "./config";
import { pulumiPlugin } from "./plugin";

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
});
