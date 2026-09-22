import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import ts from "typescript";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { FOUNTAIN_SPEC_VERSION, fetchSchemas, readSnapshot } from "./fetch";

// No network here, so fetchSchemas always takes the snapshot fallback.
vi.mock("@intentius/chant/codegen/fetch", () => ({
  fetchWithCache: () => Promise.reject(new Error("offline (test)")),
}));
import { parseFountainOpenAPI, type ParsedProperty } from "./parse";

const snapshotFile = join(dirname(fileURLToPath(import.meta.url)), "fountain-openapi.snapshot.json");
const snapshot = readFileSync(snapshotFile, "utf-8");

const scratch = mkdtempSync(join(tmpdir(), "fountain-spec-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a spec whose info.version is `version` and return its path. */
function specAt(version: unknown): string {
  const file = join(scratch, `spec-${String(version)}.json`);
  writeFileSync(file, JSON.stringify({ openapi: "3.0.0", info: { title: "fountain", version } }));
  return file;
}

describe("snapshot fallback (#2389)", () => {
  it("is the pinned release", () => {
    // The committed snapshot is what an offline generate reads. If it lags
    // the pin, every other assertion in this file is about the wrong spec.
    expect(() => readSnapshot()).not.toThrow();
    expect(`v${JSON.parse(snapshot).info.version}`).toBe(FOUNTAIN_SPEC_VERSION);
  });

  it("refuses a snapshot from another release, naming both versions", () => {
    expect(() => readSnapshot(specAt("0.16.0"), "v0.21.0")).toThrow(/0\.16\.0.*v0\.21\.0/);
  });

  it("is what fetchSchemas falls back through when the pinned release cannot be fetched", async () => {
    await expect(fetchSchemas({ snapshotFile: specAt("0.16.0") })).rejects.toThrow(
      new RegExp(`fountain 0\\.16\\.0, but the pin is ${FOUNTAIN_SPEC_VERSION.replace(/\./g, "\\.")}`),
    );
    const served = await fetchSchemas();
    expect(JSON.parse(served.get("fountain-openapi.json")!.toString("utf-8")).info.version).toBe("0.21.0");
  });

  it("refuses a snapshot with no info.version", () => {
    expect(() => readSnapshot(specAt(undefined), "v0.21.0")).toThrow(/no info\.version.*v0\.21\.0/);
  });

  it("accepts the tag and the bare version as the same release", () => {
    expect(readSnapshot(specAt("0.21.0"), "v0.21.0").length).toBeGreaterThan(0);
    expect(readSnapshot(specAt("v0.21.0"), "v0.21.0").length).toBeGreaterThan(0);
  });
});

describe("the generated surface at v0.21.0", () => {
  const parsed = parseFountainOpenAPI(snapshot);
  const propsOf = (kind: string): Map<string, ParsedProperty> => {
    const result = parsed.find((r) => r.resource.typeName === `Fountain::V1::${kind}`);
    if (!result) throw new Error(`no ${kind} in the parse`);
    return new Map(result.resource.properties.map((p) => [p.name, p]));
  };

  it("gives Environment setup_timeout_seconds, with upstream's bounds", () => {
    const timeout = propsOf("Environment").get("setup_timeout_seconds");
    expect(timeout?.tsType).toBe("number");
    expect(timeout?.required).toBe(false);
    expect(timeout?.constraints).toMatchObject({ minimum: 1, maximum: 900 });
  });

  it.each(["Environment", "Vault"])("types %s secrets as the authored key/value list", (kind) => {
    const secrets = propsOf(kind).get("secrets");
    expect(secrets?.tsType).toBe("{ key: string; value: string }[]");
    expect(secrets?.required).toBe(false);
    expect(secrets?.description).toContain("FTN001");
  });

  it("takes the acp runtime and runtime_command from the spec, with model optional", () => {
    const agent = propsOf("Agent");
    expect(agent.get("runtime")?.tsType).toBe('"acp" | "claude" | "codex" | "gemini" | "opencode"');
    expect(agent.get("runtime")?.required).toBe(true);
    // Upstream's own description, not chant's extension note.
    expect(agent.get("runtime_command")?.description).toContain("Required when runtime is acp");
    expect(agent.get("runtime_command")?.description).not.toContain("extension");
    expect(agent.get("model")?.required).toBe(false);
  });

  it("keeps permission_policy a map, with ask_timeout's number in the value union", () => {
    // v0.21.0 moved the policy behind a PermissionPolicy $ref that has one
    // named property and a typed additionalProperties. Emitted as a class it
    // would have only ask_timeout, and { default: "auto_allow" } would stop
    // compiling.
    expect(propsOf("Agent").get("permission_policy")?.tsType).toBe(
      'Record<string, "ask" | "auto_allow" | "auto_deny" | number>',
    );
    expect(parsed.some((r) => r.resource.typeName === "Fountain::V1::PermissionPolicy")).toBe(false);
  });

  it("refuses an extension once upstream declares the prop itself", () => {
    const spec = JSON.parse(snapshot);
    spec.components.schemas.VaultRequest.properties.secrets = { type: "object" };
    expect(() => parseFountainOpenAPI(JSON.stringify(spec))).toThrow(/VaultRequest now declares "secrets"/);
  });
});

describe("the generated declarations accept what the skill tells an author to write", () => {
  // The .d.ts is what a consumer of the published package compiles against.
  // In-repo, "../generated/index" resolves to the untyped runtime barrel, so a
  // plain import would check nothing. This compiles a probe against a copy of
  // the declaration instead. Every accepted line needed a cast at v0.16.0.
  const dts = join(dirname(snapshotFile), "..", "generated", "index.d.ts");

  function compile(body: string): string[] {
    const dir = mkdtempSync(join(scratch, "dts-"));
    writeFileSync(join(dir, "decl.d.ts"), readFileSync(dts, "utf-8"));
    writeFileSync(
      join(dir, "probe.ts"),
      `import type { Agent, Environment, Vault } from "./decl";\n` +
        `type EnvProps = ConstructorParameters<typeof Environment>[0];\n` +
        `type VaultProps = ConstructorParameters<typeof Vault>[0];\n` +
        `type AgentProps = ConstructorParameters<typeof Agent>[0];\n` +
        body,
    );
    const program = ts.createProgram([join(dir, "probe.ts")], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }

  it.skipIf(!existsSync(dts))("with no cast", () => {
    const errors = compile(`
      export const env: EnvProps = {
        name: "box",
        setup_timeout_seconds: 900,
        secrets: [{ key: "GITHUB_TOKEN", value: "infisical:///dev/GITHUB_TOKEN" }],
      };
      export const vault: VaultProps = { name: "creds", secrets: [{ key: "NPM_TOKEN", value: "infisical:///dev/NPM_TOKEN" }] };
      // No model: v0.21.0 stopped requiring one, and an acp agent has none.
      export const agent: AgentProps = {
        name: "steward",
        runtime: "acp",
        runtime_command: "chant acp",
        permission_policy: { default: "auto_allow", ask_timeout: 600 },
      };
    `);
    expect(errors).toEqual([]);
  });

  it.skipIf(!existsSync(dts))("and refuse the wire map in place of the authored list", () => {
    // The probe has to be able to fail, or the case above proves nothing.
    const errors = compile(`export const vault: VaultProps = { name: "creds", secrets: { NPM_TOKEN: "x" } };`);
    expect(errors.join("\n")).toMatch(/NPM_TOKEN.*\{ key: string; value: string; \}\[\]/);
  });
});
