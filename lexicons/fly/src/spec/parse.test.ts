import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { nameSchemas, parseFlyOpenAPI, schemaToClassName } from "./parse";
import { publishedSchemaNames } from "../codegen/naming";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * A flaps-shaped spec: CreateMachineRequest reaches `fly.MachineConfig`. With
 * `newcomers`, upstream has added a `flyio.MachineConfig` and a `fly.Volume`
 * that the request also reaches.
 */
const spec = (newcomers: boolean) =>
  JSON.stringify({
    components: {
      schemas: {
        CreateMachineRequest: {
          properties: {
            name: { type: "string" },
            config: ref("fly.MachineConfig"),
            ...(newcomers ? { next: ref("flyio.MachineConfig"), disk: ref("fly.Volume") } : {}),
          },
        },
        Machine: { properties: { id: { type: "string" } } },
        "fly.MachineConfig": { properties: { image: { type: "string" } } },
        "flyio.MachineConfig": { properties: { image: { type: "string" }, size: { type: "string" } } },
        "fly.Volume": { properties: { size_gb: { type: "integer" } } },
      },
    },
  });

const propertyTypes = (results: ReturnType<typeof parseFlyOpenAPI>) =>
  Object.fromEntries(results.filter((r) => r.isProperty).map((r) => [r.schema, r.resource.typeName]));

describe("published fly names stay with their schemas (#5551)", () => {
  test("the release before the newcomers names each schema by its short name", () => {
    expect(propertyTypes(parseFlyOpenAPI(spec(false)))).toEqual({
      "fly.MachineConfig": "Fly::Machines::MachineConfig",
    });
  });

  test("a newcomer sharing a published name keeps its dotted part and the published name stays", () => {
    const results = parseFlyOpenAPI(spec(true), { "fly.MachineConfig": "MachineConfig" });
    expect(propertyTypes(results)).toEqual({
      "fly.MachineConfig": "Fly::Machines::MachineConfig",
      "flyio.MachineConfig": "Fly::Machines::FlyioMachineConfig",
      // Volume is a published resource.
      "fly.Volume": "Fly::Machines::FlyVolume",
    });
    const machine = results.find((r) => r.resource.typeName === "Fly::Machines::Machine")!;
    expect(machine.resource.properties.find((p) => p.name === "config")?.tsType).toBe("MachineConfig");
    expect(machine.resource.properties.find((p) => p.name === "next")?.tsType).toBe("FlyioMachineConfig");
    expect(new Set(results.map((r) => r.resource.typeName)).size).toBe(results.length);
  });

  test("the published name stays whichever schema the spec lists first", () => {
    const published = { "fly.MachineConfig": "MachineConfig" };
    const names = nameSchemas(["flyio.MachineConfig", "fly.MachineConfig"], published);
    expect(Object.fromEntries(names)).toEqual({
      "flyio.MachineConfig": "FlyioMachineConfig",
      "fly.MachineConfig": "MachineConfig",
    });
  });

  test("without published names, two schemas sharing a short name both keep their dotted part", () => {
    expect(Object.fromEntries(nameSchemas(["fly.MachineConfig", "flyio.MachineConfig"]))).toEqual({
      "fly.MachineConfig": "FlyMachineConfig",
      "flyio.MachineConfig": "FlyioMachineConfig",
    });
  });

  test("a newcomer with no dotted part to keep is refused", () => {
    expect(() => nameSchemas(["fly.MachineConfig", "MachineConfig"], { "fly.MachineConfig": "MachineConfig" })).toThrow(
      /schema MachineConfig shares the name MachineConfig with fly\.MachineConfig/,
    );
  });

  test("schemaToClassName keeps the dotted part only when asked", () => {
    expect(schemaToClassName("fly.dnsOption")).toBe("DnsOption");
    expect(schemaToClassName("fly.dnsOption", true)).toBe("FlyDnsOption");
  });

  test("the committed snapshot records the schema each published property type came from", () => {
    const published = publishedSchemaNames();
    expect(published["fly.MachineConfig"]).toBe("MachineConfig");
    expect(published["fly.dnsOption"]).toBe("DnsOption");
    expect(publishedSchemaNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
  });
});
