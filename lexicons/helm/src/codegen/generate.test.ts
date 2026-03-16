import { describe, test, expect } from "bun:test";
import { generate } from "./generate";

describe("Helm generate pipeline", () => {
  test("generate module is importable", async () => {
    const mod = await import("./generate");
    expect(mod.generate).toBeFunction();
    expect(mod.writeGeneratedFiles).toBeFunction();
  });

  test("generates lexicon JSON, types, and index", async () => {
    const result = await generate();
    expect(result.lexiconJSON).toBeTruthy();
    expect(result.typesDTS).toBeTruthy();
    expect(result.indexTS).toBeTruthy();
  });

  test("lexicon JSON contains known resource types", async () => {
    const result = await generate();
    const registry = JSON.parse(result.lexiconJSON);
    expect(registry.Chart).toBeDefined();
    expect(registry.Chart.resourceType).toBe("Helm::Chart");
    expect(registry.Chart.kind).toBe("resource");
    expect(registry.Values).toBeDefined();
    expect(registry.HelmHook).toBeDefined();
    expect(registry.HelmHook.kind).toBe("property");
  });

  test("types DTS contains class declarations", async () => {
    const result = await generate();
    expect(result.typesDTS).toContain("export interface ChartProps");
    expect(result.typesDTS).toContain("export declare const Chart");
    expect(result.typesDTS).toContain("export interface ValuesProps");
    expect(result.typesDTS).toContain("export declare const Values");
  });

  test("runtime index contains createResource calls", async () => {
    const result = await generate();
    expect(result.indexTS).toContain('createResource("Helm::Chart"');
    expect(result.indexTS).toContain('createResource("Helm::Values"');
    expect(result.indexTS).toContain('createProperty("Helm::Hook"');
  });

  test("resource and property counts are correct", async () => {
    const result = await generate();
    expect(result.resources).toBeGreaterThan(0);
    expect(result.properties).toBeGreaterThan(0);
    expect(result.enums).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("lexicon JSON contains all Helm types", async () => {
    const result = await generate();
    const registry = JSON.parse(result.lexiconJSON);
    expect(registry.HelmTest).toBeDefined();
    expect(registry.HelmNotes).toBeDefined();
    expect(registry.HelmDependency).toBeDefined();
    expect(registry.HelmMaintainer).toBeDefined();
    expect(registry.HelmCRD).toBeDefined();
  });

  test("Chart props include required fields", async () => {
    const result = await generate();
    const registry = JSON.parse(result.lexiconJSON);
    const chartProps = registry.Chart.props;
    expect(chartProps.apiVersion).toBeDefined();
    expect(chartProps.apiVersion.required).toBe(true);
    expect(chartProps.name.required).toBe(true);
    expect(chartProps.version.required).toBe(true);
  });
});
