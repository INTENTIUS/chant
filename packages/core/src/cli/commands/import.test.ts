import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  detectTemplateLexicon,
  importCommand,
  parseTemplateDocuments,
  printImportResult,
  type ImportOptions,
} from "./import";
import { listInstalledLexicons } from "../plugins";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("importCommand", () => {
  let testDir: string;
  let templateDir: string;
  let outputDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-import-test-${Date.now()}-${Math.random()}`);
    templateDir = join(testDir, "templates");
    outputDir = join(testDir, "output");
    await mkdir(templateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("imports CloudFormation template", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Description: "Test CloudFormation template",
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "my-bucket",
            VersioningConfiguration: {
              Status: "Enabled",
            },
          },
        },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const options: ImportOptions = {
      templatePath,
      output: outputDir,
    };

    const result = await importCommand(options);

    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("aws");
    expect(result.generatedFiles.length).toBeGreaterThan(0);
    expect(existsSync(outputDir)).toBe(true);
  }, 15000);

  test("imports CloudFormation template with multiple resources", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        MyQueue: {
          Type: "AWS::SQS::Queue",
          Properties: {
            QueueName: "my-queue",
          },
        },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const options: ImportOptions = {
      templatePath,
      output: outputDir,
    };

    const result = await importCommand(options);

    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("aws");
    expect(result.generatedFiles.length).toBeGreaterThan(0);
  });

  test("auto-detects AWS lexicon with AWSTemplateFormatVersion", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Parameters: { Env: { Type: "String" } },
      Resources: {},
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.lexicon).toBe("aws");
  });

  test("auto-detects AWS lexicon with AWS:: resource types", async () => {
    const template = {
      Resources: {
        Bucket: {
          Type: "AWS::S3::Bucket",
        },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.lexicon).toBe("aws");
  });

  test("fails for unknown lexicon", async () => {
    const template = {
      version: "1.0",
      unknownField: {},
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not detect");
  });

  test("fails for non-existent template", async () => {
    const result = await importCommand({
      templatePath: "/nonexistent/template.json",
      output: outputDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("uses default output directory", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Bucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    // Change to test dir so default ./infra/ is relative to it
    const originalCwd = process.cwd();
    process.chdir(testDir);

    try {
      const result = await importCommand({ templatePath });

      expect(result.success).toBe(true);
      expect(existsSync(join(testDir, "infra"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("generates TypeScript with correct syntax", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        DataBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: "data-bucket",
            VersioningConfiguration: {
              Status: "Enabled",
            },
          },
        },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(true);

    // Find a generated file and check content
    const mainFile = result.generatedFiles.find((f) => f.endsWith(".ts"));
    expect(mainFile).toBeDefined();

    const content = readFileSync(join(outputDir, mainFile!), "utf-8");
    expect(content).toContain("import {");
    expect(content).toContain("export const");
    expect(content).toContain("Bucket");
  });

  test("warns about non-empty output directory", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Bucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    // Create output dir with existing file
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "existing.ts"), "// existing");

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes("not empty"))).toBe(true);
  });

  test("force overwrites existing files", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Bucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    // Create output dir with existing file
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "main.ts"), "// old content");

    const result = await importCommand({
      templatePath,
      output: outputDir,
      force: true,
    });

    expect(result.success).toBe(true);

    // Check that main.ts was overwritten
    const content = readFileSync(join(outputDir, "main.ts"), "utf-8");
    expect(content).not.toContain("old content");
    expect(content).toContain("Bucket");
  });

  test("organizes resources by category for large templates", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Bucket1: { Type: "AWS::S3::Bucket", Properties: {} },
        Bucket2: { Type: "AWS::S3::Bucket", Properties: {} },
        Queue1: { Type: "AWS::SQS::Queue", Properties: {} },
        LB1: { Type: "AWS::ElasticLoadBalancingV2::LoadBalancer", Properties: {} },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(true);
    // With 4 resources, should create separate files
    expect(result.generatedFiles.length).toBeGreaterThan(1);
  });

  test("creates index.ts for organized imports", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Bucket1: { Type: "AWS::S3::Bucket", Properties: {} },
        Bucket2: { Type: "AWS::S3::Bucket", Properties: {} },
        Lambda1: { Type: "AWS::Lambda::Function", Properties: {} },
        LB1: { Type: "AWS::ElasticLoadBalancingV2::LoadBalancer", Properties: {} },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(true);

    if (result.generatedFiles.includes("index.ts")) {
      const indexContent = readFileSync(join(outputDir, "index.ts"), "utf-8");
      expect(indexContent).toContain("export {");
    }
  });

  test("handles template with parameters", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Parameters: {
        Environment: { Type: "String" },
        BucketName: { Type: "String" },
      },
      Resources: {
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            BucketName: { Ref: "BucketName" },
          },
        },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(true);

    // Find main file and check for Parameter imports
    const files = result.generatedFiles.filter((f) => f.endsWith(".ts"));
    let hasParameter = false;
    for (const file of files) {
      const content = readFileSync(join(outputDir, file), "utf-8");
      if (content.includes("Parameter")) {
        hasParameter = true;
        break;
      }
    }
    expect(hasParameter).toBe(true);
  });

  test("prints generated files on success", async () => {
    const template = {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: {
        Bucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    };

    const templatePath = join(templateDir, "template.json");
    await writeFile(templatePath, JSON.stringify(template));

    const result = await importCommand({
      templatePath,
      output: outputDir,
    });

    expect(result.success).toBe(true);
    expect(result.generatedFiles.length).toBeGreaterThan(0);
    // Each file should be a .ts file
    for (const file of result.generatedFiles) {
      expect(file.endsWith(".ts")).toBe(true);
    }
  });
});

// #2935 — YAML templates reach detection and the plugin's parser instead of
// failing JSON.parse, and `--lexicon` skips detection.
describe("importCommand with YAML templates", () => {
  let testDir: string;
  let outputDir: string;

  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
`;

  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
`;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-import-yaml-test-${Date.now()}-${Math.random()}`);
    outputDir = join(testDir, "output");
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** A project that declares the k8s lexicon, so detection can find it. */
  async function k8sProject(): Promise<void> {
    await writeFile(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["k8s"] }));
  }

  function generated(files: string[]): string {
    return files.map((f) => readFileSync(join(outputDir, f), "utf-8")).join("\n");
  }

  test("detects and imports a single-document k8s manifest", async () => {
    await k8sProject();
    const templatePath = join(testDir, "manifest.yaml");
    await writeFile(templatePath, configMap);

    const result = await importCommand({ templatePath, output: outputDir });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("k8s");
    expect(generated(result.generatedFiles)).toContain("ConfigMap");
  }, 30000);

  test("detects and imports a multi-document k8s manifest", async () => {
    await k8sProject();
    const templatePath = join(testDir, "manifests.yaml");
    await writeFile(templatePath, `# app manifests\n---\n${configMap}---\n${deployment}`);

    const result = await importCommand({ templatePath, output: outputDir });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("k8s");
    const code = generated(result.generatedFiles);
    expect(code).toContain("ConfigMap");
    expect(code).toContain("Deployment");
  }, 30000);

  test("--lexicon imports without detection", async () => {
    const templatePath = join(testDir, "manifest.yaml");
    await writeFile(templatePath, configMap);

    const result = await importCommand({ templatePath, output: outputDir, lexicon: "k8s" });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("k8s");
    expect(result.detected).toBeFalsy();
    expect(generated(result.generatedFiles)).toContain("ConfigMap");
  }, 30000);

  // #2965 — with no chant.config and no source imports, every installed
  // lexicon is tried, not only aws.
  test("detects a k8s manifest outside a project from the installed lexicons", async () => {
    const templatePath = join(testDir, "manifest.yaml");
    await writeFile(templatePath, `--- # config\n${configMap}...\n`);

    const result = await importCommand({ templatePath, output: outputDir });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("k8s");
    expect(result.detected).toBe(true);
    expect(generated(result.generatedFiles)).toContain("ConfigMap");
  }, 60000);

  test("--lexicon with an unknown lexicon fails", async () => {
    const templatePath = join(testDir, "manifest.yaml");
    await writeFile(templatePath, configMap);

    const result = await importCommand({ templatePath, output: outputDir, lexicon: "no-such-lexicon" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no-such-lexicon");
  });

  // #2991 — a blank or whitespace-only line after `spec:` (Helm renders one
  // for an empty conditional) no longer ends the pod template's spec.
  test("a blank line after a key keeps its block nested", async () => {
    const templatePath = join(testDir, "manifest.yaml");
    await writeFile(templatePath, deployment.replace("    spec:\n", "    spec:\n      \n"));

    const result = await importCommand({ templatePath, output: outputDir, lexicon: "k8s" });

    expect(result.error).toBeUndefined();
    // The containers stay under template.spec, not hoisted beside `replicas`.
    expect(generated(result.generatedFiles)).toMatch(/template: \{[\s\S]*spec: \{\s*containers: \[/);
  }, 30000);

  // #2991 — a document the YAML reader cannot place fails the import with
  // its line, where it used to import a different manifest.
  test("a mis-indented document fails the import and names the line", async () => {
    const templatePath = join(testDir, "manifests.yaml");
    await writeFile(templatePath, `${configMap}---\n${deployment.replace("  replicas: 2\n", "  replicas: 2\n     paused: true\n")}`);

    const result = await importCommand({ templatePath, output: outputDir });

    expect(result.success).toBe(false);
    expect(result.error).toContain("YAML line 7");
  }, 30000);

  test("content that is neither JSON nor YAML names both formats", async () => {
    const templatePath = join(testDir, "notes.txt");
    await writeFile(templatePath, "this is not a template\n{ nor is this");

    const result = await importCommand({ templatePath, output: outputDir });

    expect(result.success).toBe(false);
    expect(result.error).toContain("JSON");
    expect(result.error).toContain("YAML");
  });
});

// #2965 — detection outside a project, and inside one when the project's
// lexicons don't match.
describe("detectTemplateLexicon", () => {
  let testDir: string;

  const collector = {
    receivers: { otlp: { protocols: { grpc: {} } } },
    exporters: { debug: {} },
    service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] } } },
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-import-detect-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("an empty directory detects an otel collector config from the installed lexicons", async () => {
    const detection = await detectTemplateLexicon([collector], testDir);
    expect(detection?.plugin.name).toBe("otel");
    expect(detection?.source).toBe("installed");
  }, 60000);

  test("a project lexicon that matches decides", async () => {
    await writeFile(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    const detection = await detectTemplateLexicon([{ AWSTemplateFormatVersion: "2010-09-09", Resources: {} }], testDir);
    expect(detection?.plugin.name).toBe("aws");
    expect(detection?.source).toBe("project");
  }, 60000);

  test("inside a project, installed lexicons are tried when the project's don't match", async () => {
    await writeFile(join(testDir, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    const detection = await detectTemplateLexicon([collector], testDir);
    expect(detection?.plugin.name).toBe("otel");
    expect(detection?.source).toBe("installed");
  }, 60000);

  test("names the other installed lexicons that also recognized the template", async () => {
    // github and forgejo both read a GitHub-Actions-shaped workflow.
    const workflow = { on: { push: {} }, jobs: { build: { "runs-on": "ubuntu-latest", steps: [] } } };
    const detection = await detectTemplateLexicon([workflow], testDir);
    expect(detection).toBeDefined();
    // github has a template parser and forgejo does not, so github is chosen.
    expect(detection!.plugin.name).toBe("github");
    expect(detection!.alsoMatched).toContain("forgejo");
  }, 60000);

  test("returns undefined when no installed lexicon recognizes the template", async () => {
    expect(await detectTemplateLexicon([{ version: "1.0", unknownField: {} }], testDir)).toBeUndefined();
  }, 60000);
});

describe("listInstalledLexicons", () => {
  test("lists the @intentius/chant-lexicon-* packages installed alongside chant", () => {
    const names = listInstalledLexicons(tmpdir());
    expect(names).toContain("aws");
    expect(names).toContain("k8s");
    expect(names).toContain("otel");
    expect(names).toEqual([...names].sort());
  });
});

describe("printImportResult", () => {
  function printed(result: Parameters<typeof printImportResult>[0]): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printImportResult(result);
      return log.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
  }

  test("says Detected lexicon when the lexicon was detected", () => {
    expect(printed({ success: true, generatedFiles: [], warnings: [], lexicon: "k8s", detected: true })).toContain(
      "Detected lexicon: k8s",
    );
  });

  test("says Lexicon when the lexicon was named", () => {
    const out = printed({ success: true, generatedFiles: [], warnings: [], lexicon: "k8s" });
    expect(out).toContain("Lexicon: k8s");
    expect(out).not.toContain("Detected");
  });
});

describe("parseTemplateDocuments", () => {
  test("JSON yields the parsed value as one document", () => {
    expect(parseTemplateDocuments('{"a": 1}')).toEqual([{ a: 1 }]);
    expect(parseTemplateDocuments("[1, 2]")).toEqual([[1, 2]]);
  });

  test("YAML splits on document separators and skips empty or comment-only documents", () => {
    const docs = parseTemplateDocuments("---\n# only a comment\n---\na: 1\n---\nb: two\n---\n");
    expect(docs).toEqual([{ a: 1 }, { b: "two" }]);
  });

  test("a top-level YAML list parses as a list (#2965)", () => {
    expect(parseTemplateDocuments("- name: one\n  expr: up\n- name: two\n")).toEqual([
      [{ name: "one", expr: "up" }, { name: "two" }],
    ]);
  });

  test("commented separators and document ends split documents (#2965)", () => {
    expect(parseTemplateDocuments("--- # first\na: 1\n...\n--- # second\nb: two\n...\n")).toEqual([
      { a: 1 },
      { b: "two" },
    ]);
  });

  test("returns undefined for content that is neither", () => {
    expect(parseTemplateDocuments("")).toBeUndefined();
    expect(parseTemplateDocuments("just some words")).toBeUndefined();
    expect(parseTemplateDocuments("{ broken json")).toBeUndefined();
  });
});
