import { describe, test, expect } from "vitest";
import { FlyGenerator } from "./generator";

const generator = new FlyGenerator();

function makeIR(resources: any[]) {
  return { resources, parameters: [] };
}

function content(ir: ReturnType<typeof makeIR>): string {
  return generator.generate(ir)[0].content;
}

describe("FlyGenerator", () => {
  test("generates chant TypeScript from IR", () => {
    const ir = makeIR([
      { logicalId: "my-app", type: "Fly::Machines::App", properties: { name: "my-app", org_slug: "personal" } },
    ]);
    const result = content(ir);
    expect(result).toContain('import { App } from "@intentius/chant-lexicon-fly";');
    expect(result).toContain("export const myApp = new App({");
    expect(result).toContain('name: "my-app"');
  });

  test("import source is @intentius/chant-lexicon-fly", () => {
    const ir = makeIR([
      { logicalId: "web", type: "Fly::Machines::Machine", properties: { name: "web" } },
    ]);
    expect(content(ir)).toContain('from "@intentius/chant-lexicon-fly"');
  });

  test("App and Machine produce two exports", () => {
    const ir = makeIR([
      { logicalId: "my-app", type: "Fly::Machines::App", properties: { name: "my-app" } },
      { logicalId: "web", type: "Fly::Machines::Machine", properties: { name: "web", region: "iad" } },
    ]);
    const result = content(ir);
    expect(result).toContain("export const myApp = new App(");
    expect(result).toContain("export const web = new Machine(");
  });

  test("camelCase variable names from kebab-case logical names", () => {
    const ir = makeIR([
      { logicalId: "my-web-app", type: "Fly::Machines::App", properties: { name: "my-web-app" } },
    ]);
    expect(content(ir)).toContain("export const myWebApp");
  });

  test("config is wrapped in new MachineConfig(...) so it typechecks", () => {
    const ir = makeIR([
      {
        logicalId: "web",
        type: "Fly::Machines::Machine",
        properties: { name: "web", config: { image: "nginx:1" } },
      },
    ]);
    const result = content(ir);
    expect(result).toContain("config: new MachineConfig({");
    expect(result).toContain("MachineConfig");
    // MachineConfig is imported alongside the resource classes.
    expect(result).toMatch(/import \{[^}]*MachineConfig[^}]*\}/);
  });

  test("nested declarables (guest, services, ports) get their own constructors", () => {
    const ir = makeIR([
      {
        logicalId: "web",
        type: "Fly::Machines::Machine",
        properties: {
          name: "web",
          config: {
            image: "nginx:1",
            guest: { cpu_kind: "shared", cpus: 1 },
            services: [
              { protocol: "tcp", internal_port: 8080, ports: [{ port: 443, handlers: ["tls"] }] },
            ],
          },
        },
      },
    ]);
    const result = content(ir);
    expect(result).toContain("guest: new MachineGuest({");
    expect(result).toContain("new MachineService({");
    expect(result).toContain("new MachinePort({");
    // Every wrapped class appears in the import.
    const importLine = result.split("\n").find((l) => l.startsWith("import"))!;
    for (const cls of ["App", "Machine", "MachineConfig", "MachineGuest", "MachineService", "MachinePort"]) {
      // App is not used here; only imports for classes actually emitted.
      if (cls === "App") continue;
      expect(importLine).toContain(cls);
    }
  });

  test("scalar maps (metadata, env) stay plain object literals", () => {
    const ir = makeIR([
      {
        logicalId: "web",
        type: "Fly::Machines::Machine",
        properties: { name: "web", config: { metadata: { "managed-by": "chant" }, env: { PORT: "8080" } } },
      },
    ]);
    const result = content(ir);
    expect(result).toContain("metadata: {");
    expect(result).toContain('"managed-by": "chant"');
    expect(result).toContain("env: {");
    expect(result).toContain("PORT: ");
  });

  test("imports are sorted alphabetically", () => {
    const ir = makeIR([
      { logicalId: "web", type: "Fly::Machines::Machine", properties: { name: "web", config: { image: "x" } } },
      { logicalId: "my-app", type: "Fly::Machines::App", properties: { name: "my-app" } },
    ]);
    const importLine = content(ir).split("\n").find((l) => l.startsWith("import"))!;
    expect(importLine.indexOf("App")).toBeLessThan(importLine.indexOf("Machine"));
  });

  test("empty IR still produces a single file", () => {
    const files = generator.generate(makeIR([]));
    expect(files).toHaveLength(1);
    expect(typeof files[0].content).toBe("string");
  });
});
