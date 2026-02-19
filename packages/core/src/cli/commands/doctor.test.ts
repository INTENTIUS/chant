import { describe, test, expect } from "bun:test";
import { doctorCommand } from "./doctor";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

describe("doctorCommand", () => {
  test("config-exists fails when no config file present", async () => {
    await withTestDir(async (testDir) => {
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "config-exists");
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.message).toContain("No chant.config.json");
    });
  });

  test("config-exists passes with chant.config.json", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(
        join(testDir, "chant.config.json"),
        JSON.stringify({ lexicons: ["aws"] }),
      );
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "config-exists");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });

  test("config-exists passes with chant.config.ts", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(
        join(testDir, "chant.config.ts"),
        `export default { lexicons: ["aws"] };`,
      );
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "config-exists");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });

  test("config-exists fails on invalid JSON", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "not valid json{{{");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "config-exists");
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.message).toContain("Config parse error");
    });
  });

  test("core-types fails when .chant/types/core/ missing", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "core-types");
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.message).toContain("not found");
    });
  });

  test("core-types passes when .chant/types/core/ has files", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      const coreDir = join(testDir, ".chant", "types", "core");
      mkdirSync(coreDir, { recursive: true });
      writeFileSync(join(coreDir, "index.d.ts"), "export {};");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "core-types");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });

  test("core-types fails when .chant/types/core/ is empty", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      const coreDir = join(testDir, ".chant", "types", "core");
      mkdirSync(coreDir, { recursive: true });
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "core-types");
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.message).toContain("empty");
    });
  });

  test("detects stale/orphaned lexicon directories", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(
        join(testDir, "chant.config.json"),
        JSON.stringify({ lexicons: ["aws"] }),
      );
      const typesDir = join(testDir, ".chant", "types");
      mkdirSync(join(typesDir, "core"), { recursive: true });
      mkdirSync(join(typesDir, "lexicon-aws"), { recursive: true });
      mkdirSync(join(typesDir, "lexicon-gcp"), { recursive: true });
      writeFileSync(join(typesDir, "core", "index.d.ts"), "export {};");
      writeFileSync(join(typesDir, "lexicon-aws", "index.d.ts"), "export {};");
      writeFileSync(join(typesDir, "lexicon-gcp", "index.d.ts"), "export {};");

      const report = await doctorCommand(testDir);
      const staleCheck = report.checks.find((c) => c.name === "stale-lexicon-gcp");
      expect(staleCheck).toBeDefined();
      expect(staleCheck!.status).toBe("warn");
      expect(staleCheck!.message).toContain("Orphaned");
      expect(staleCheck!.message).toContain("gcp");
    });
  });

  test("does not flag configured lexicon directories as stale", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(
        join(testDir, "chant.config.json"),
        JSON.stringify({ lexicons: ["aws"] }),
      );
      const typesDir = join(testDir, ".chant", "types");
      mkdirSync(join(typesDir, "core"), { recursive: true });
      mkdirSync(join(typesDir, "lexicon-aws"), { recursive: true });
      writeFileSync(join(typesDir, "core", "index.d.ts"), "export {};");
      writeFileSync(join(typesDir, "lexicon-aws", "index.d.ts"), "export {};");

      const report = await doctorCommand(testDir);
      const staleChecks = report.checks.filter((c) => c.name.startsWith("stale-"));
      expect(staleChecks.length).toBe(0);
    });
  });

  test("src-directory fails when missing", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "src-directory");
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.message).toContain("not found");
    });
  });

  test("src-directory passes with .ts files", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "main.ts"), "export {};");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "src-directory");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });

  test("report success is false when any check fails", async () => {
    await withTestDir(async (testDir) => {
      // No config, no src, no .chant — everything fails
      const report = await doctorCommand(testDir);
      expect(report.success).toBe(false);
    });
  });

  test("report success is true when only warnings (no fails)", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "main.ts"), "export {};");
      const coreDir = join(testDir, ".chant", "types", "core");
      mkdirSync(coreDir, { recursive: true });
      writeFileSync(join(coreDir, "index.d.ts"), "export {};");
      // mcp-config will be a warn, but not a fail
      const report = await doctorCommand(testDir);
      expect(report.success).toBe(true);
    });
  });

  test("lexicon-docs passes when docs/ exists in a lexicon project", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "plugin.ts"), "export {};");
      mkdirSync(join(testDir, "docs"), { recursive: true });
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "lexicon-docs");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });

  test("lexicon-docs warns when docs/ is missing in a lexicon project", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "plugin.ts"), "export {};");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "lexicon-docs");
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.message).toContain("docs/");
    });
  });

  test("lexicon-docs check is skipped for non-lexicon projects", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "main.ts"), "export {};");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "lexicon-docs");
      expect(check).toBeUndefined();
    });
  });

  test("mcp-config warns when .mcp.json missing", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "mcp-config");
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.message).toContain("not found");
    });
  });

  test("mcp-config passes when .mcp.json has chant entry", async () => {
    await withTestDir(async (testDir) => {
      writeFileSync(join(testDir, "chant.config.json"), "{}");
      writeFileSync(
        join(testDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { chant: { command: "chant" } } }),
      );
      const report = await doctorCommand(testDir);
      const check = report.checks.find((c) => c.name === "mcp-config");
      expect(check).toBeDefined();
      expect(check!.status).toBe("pass");
    });
  });
});
