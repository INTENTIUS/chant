import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { importCommand, type ImportOptions } from "./import";
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
