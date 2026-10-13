import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { blocksToEntities, parseTerraformRootDir } from "../../hcl/parse";
import { tf040 } from "./tf040";
import { terraformPlugin } from "../../plugin";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tf040-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const MAIN = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n';

async function ctxOf(dir: string): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(dir, "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF040: root has no committed .terraform.lock.hcl", () => {
  test("flags a root with providers and no lock file, once", async () => {
    const diags = tf040.check(await ctxOf(root({ "main.tf": MAIN + MAIN.replace('"b"', '"c"') })));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: "TF040", severity: "warning", lexicon: "terraform" });
    expect(diags[0].message).toContain('"aws"');
  });

  test("passes a root with the lock file beside its .tf files", async () => {
    expect(tf040.check(await ctxOf(root({ "main.tf": MAIN, ".terraform.lock.hcl": "# lock\n" })))).toEqual([]);
  });

  test("skips a root that implies no provider", async () => {
    expect(tf040.check(await ctxOf(root({ "main.tf": 'variable "x" {}\n' })))).toEqual([]);
  });

  test("reports nothing when the parse had no directory (not determined)", async () => {
    const entities = await blocksToEntities([{ name: "main.tf", source: MAIN }], "app");
    expect(tf040.check({ outputs: new Map(), entities } as unknown as PostSynthContext)).toEqual([]);
  });

  test("is off by default: in the all preset, not in recommended", () => {
    const presets = terraformPlugin.lintPresets!();
    expect(presets.all).toContain("TF040");
    expect(presets.recommended).not.toContain("TF040");
  });
});
