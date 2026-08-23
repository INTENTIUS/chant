import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExamplesBuild } from "./check-lexicon-examples";

/**
 * chant #1067 — proof that "every shipped example builds" actually builds
 * one, rather than counting example directories the way every prior
 * check-lexicon.ts check did. The fixture reproduces the exact defect
 * found in `lexicons/aws/examples/core-concepts`: two files in the same
 * example independently exporting a top-level binding of the same name,
 * which is fine on its own but a "Duplicate export name" discovery error
 * the moment the whole `src/` directory is built as one project — which is
 * exactly what each example's own `npm run build` does.
 *
 * These fixtures import the real, already-installed `@intentius/chant-lexicon-aws`
 * package (workspace-linked), so no lexicon plugin needs to be faked.
 */

function writeLexiconDirWithExample(
  lexiconDir: string,
  exampleName: string,
  files: Record<string, string>,
): void {
  const srcDir = join(lexiconDir, "examples", exampleName, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(srcDir, name), content);
  }
}

describe("checkExamplesBuild", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-examples-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A bucket that satisfies the aws lexicon's error-severity checks (#1400):
  // public access blocked (WAW018) and a TLS-only bucket policy (WAW042).
  const cleanBucketSource = `import { Bucket, PublicAccessBlockConfiguration, S3BucketPolicy, Ref } from "@intentius/chant-lexicon-aws";

export const appBucket = new Bucket({
  BucketName: "my-app-bucket",
  PublicAccessBlockConfiguration: new PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
});

export const appBucketPolicy = new S3BucketPolicy({
  Bucket: Ref(appBucket),
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [appBucket.Arn],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  },
});
`;

  test("a clean example builds", async () => {
    writeLexiconDirWithExample(dir, "clean", { "bucket.ts": cleanBucketSource });

    const results = await checkExamplesBuild(dir);
    const clean = results.find((r) => r.example === "clean");
    expect(clean).toMatchObject({ ok: true });
  });

  test("two files independently exporting the same top-level name fails to build (the core-concepts defect)", async () => {
    writeLexiconDirWithExample(dir, "broken", {
      "a.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const dataBucket = new Bucket({
  BucketName: "a-bucket",
});
`,
      "b.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const dataBucket = new Bucket({
  BucketName: "b-bucket",
});
`,
    });

    const results = await checkExamplesBuild(dir);
    const broken = results.find((r) => r.example === "broken");
    expect(broken?.ok).toBe(false);
    expect(broken?.detail).toMatch(/Duplicate export name "dataBucket" found/);
  });

  // chant #1400 — a bare bucket serializes fine, which is all #1067 asked,
  // but fails the aws lexicon's own WAW018/WAW042 at error severity. This is
  // the exact shape lambda-api and lambda-s3 shipped in.
  test("an example that fails its own lexicon's post-synth checks at error severity fails (#1400)", async () => {
    writeLexiconDirWithExample(dir, "insecure", {
      "bucket.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const plainBucket = new Bucket({
  BucketName: "plain-bucket",
});
`,
    });

    const results = await checkExamplesBuild(dir);
    const insecure = results.find((r) => r.example === "insecure");
    expect(insecure?.ok).toBe(false);
    expect(insecure?.detail).toMatch(/post-synth error\(s\) from the lexicon's own checks/);
    expect(insecure?.detail).toMatch(/WAW042: \[plainBucket\]/);
  });

  test("an example's own lint.rules severity config applies to post-synth checks (#1400)", async () => {
    writeLexiconDirWithExample(dir, "suppressed", {
      "bucket.ts": `import { Bucket } from "@intentius/chant-lexicon-aws";

export const plainBucket = new Bucket({
  BucketName: "plain-bucket",
});
`,
    });
    writeFileSync(
      join(dir, "examples", "suppressed", "chant.config.json"),
      JSON.stringify({ lint: { rules: { WAW018: "warning", WAW042: "off" } } }),
    );

    const results = await checkExamplesBuild(dir);
    expect(results.find((r) => r.example === "suppressed")).toMatchObject({ ok: true });
  });

  test("an empty src/ directory is skipped, not reported as a failure", async () => {
    writeLexiconDirWithExample(dir, "empty", {});
    const results = await checkExamplesBuild(dir);
    expect(results.find((r) => r.example === "empty")).toBeUndefined();
  });

  test("returns [] when there is no examples/ directory at all", async () => {
    const noExamplesDir = mkdtempSync(join(tmpdir(), "chant-check-lexicon-examples-none-"));
    try {
      expect(await checkExamplesBuild(noExamplesDir)).toEqual([]);
    } finally {
      rmSync(noExamplesDir, { recursive: true, force: true });
    }
  });
});
