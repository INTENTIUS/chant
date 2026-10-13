import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  mergeResourceAttributes,
  RELEASE_ATTRIBUTES_VARIABLE,
  releaseAttributesSuffix,
  releaseEnvironment,
  resolveTelemetryAttribution,
  TELEMETRY_ATTRIBUTES,
  telemetryEnvironment,
} from "./telemetry-attribution";

const scratch = mkdtempSync(join(tmpdir(), "chant-2558-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A directory tree under the scratch directory, files keyed by relative path. */
function tree(files: Record<string, string>): string {
  const root = join(scratch, `t${n++}`);
  // The git root ends the search for a declaration, as in a real checkout.
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const declaration = JSON.stringify({
  name: "acme",
  schema: 1,
  members: [
    { name: "delivery", dir: "delivery", kind: "chant" },
    { name: "docs", dir: "docs", kind: "other", because: "prose" },
  ],
});

describe("resolveTelemetryAttribution", () => {
  test("is nothing for a project with no workspace declaration above it", async () => {
    const root = tree({ "app/chant.config.ts": "export default {};\n" });
    expect(await resolveTelemetryAttribution(join(root, "app"), {}, "prod")).toBeUndefined();
  });

  test("is on for a project that opts in outside a workspace, with no workspace or member", async () => {
    const root = tree({ "app/chant.config.ts": "export default {};\n" });
    expect(await resolveTelemetryAttribution(join(root, "app"), { telemetry: { attribution: true } }, "prod")).toEqual({ environment: "prod" });
    expect(await resolveTelemetryAttribution(join(root, "app"), { telemetry: { attribution: true } })).toEqual({});
  });

  test("names the workspace and the member inside a workspace", async () => {
    const root = tree({ "chant.workspace.json": declaration, "delivery/chant.config.ts": "export default {};\n", "delivery/src/a.ts": "" });
    expect(await resolveTelemetryAttribution(join(root, "delivery"), {})).toEqual({ workspace: "acme", member: "delivery" });
    expect(await resolveTelemetryAttribution(join(root, "delivery", "src"), {}, "staging")).toEqual({ workspace: "acme", member: "delivery", environment: "staging" });
  });

  test("names no member for a directory no member owns", async () => {
    const root = tree({ "chant.workspace.json": declaration, "scripts/x.ts": "" });
    expect(await resolveTelemetryAttribution(join(root, "scripts"), {})).toEqual({ workspace: "acme" });
  });

  test("telemetry.attribution false turns it off inside a workspace", async () => {
    const root = tree({ "chant.workspace.json": declaration, "delivery/x.ts": "" });
    expect(await resolveTelemetryAttribution(join(root, "delivery"), { telemetry: { attribution: false } })).toBeUndefined();
  });

  test("a declaration that can't be read stamps the workspace-free attributes and does not throw", async () => {
    const root = tree({ "chant.workspace.json": "{ not json", "delivery/x.ts": "" });
    expect(await resolveTelemetryAttribution(join(root, "delivery"), {}, "prod")).toEqual({ environment: "prod" });
  });
});

describe("telemetryEnvironment", () => {
  test("lists the attributes in the table's order, percent-encoding values", () => {
    const env = telemetryEnvironment({ workspace: "acme", member: "delivery", environment: "pr 12" }, { service: "api", decl: "apiService", version: "sha256:ab" });
    expect(env).toEqual({
      OTEL_SERVICE_NAME: "api",
      OTEL_RESOURCE_ATTRIBUTES: "chant.workspace=acme,chant.member=delivery,chant.decl=apiService,deployment.environment.name=pr%2012,service.version=sha256%3Aab",
    });
  });

  test("leaves out what it doesn't know", () => {
    expect(telemetryEnvironment({}, { service: "api", decl: "api" }).OTEL_RESOURCE_ATTRIBUTES).toBe("chant.decl=api");
  });

  test("the table names every attribute the environment can carry, and marks release-time ones", () => {
    const keys = TELEMETRY_ATTRIBUTES.map((a) => a.key);
    expect(keys).toEqual(["service.name", "service.version", "deployment.environment.name", "vcs.ref.head.revision", "chant.workspace", "chant.member", "chant.decl"]);
    expect(TELEMETRY_ATTRIBUTES.filter((a) => !a.stampedAtBuild).map((a) => a.key)).toEqual(["service.version", "vcs.ref.head.revision"]);
  });
});

describe("mergeResourceAttributes", () => {
  test("keeps keys already set and appends the rest", () => {
    expect(mergeResourceAttributes("a=1,chant.member=mine", "chant.workspace=w,chant.member=m")).toBe("a=1,chant.member=mine,chant.workspace=w");
    expect(mergeResourceAttributes("", "a=1")).toBe("a=1");
  });
});

describe("release attributes (#3061, ws-081)", () => {
  test("the suffix starts with a comma, percent-encodes, and is empty when the release knows nothing", () => {
    expect(releaseAttributesSuffix({ version: "sha256:abc", revision: "0123abc" })).toBe(",service.version=sha256%3Aabc,vcs.ref.head.revision=0123abc");
    expect(releaseAttributesSuffix({ revision: "0123abc" })).toBe(",vcs.ref.head.revision=0123abc");
    expect(releaseAttributesSuffix({})).toBe("");
    expect(releaseAttributesSuffix(undefined)).toBe("");
  });

  test("the environment carries the suffix under CHANT_RELEASE_ATTRIBUTES, or nothing", () => {
    expect(releaseEnvironment({ revision: "r" })).toEqual({ [RELEASE_ATTRIBUTES_VARIABLE]: ",vcs.ref.head.revision=r" });
    expect(releaseEnvironment({})).toEqual({});
  });
});
