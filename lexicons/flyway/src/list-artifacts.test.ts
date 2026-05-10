import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    Promise.resolve(execMock(cmd)).then(
      (out) => cb(null, out),
      (err) => cb(err as Error, { stdout: "", stderr: "" }),
    );
  } };
});

const { listArtifacts } = await import("./list-artifacts");

function makeEntities(records: Array<{ name: string; entityType: string; props: Record<string, unknown> }>) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

describe("flyway listArtifacts", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test("queries flyway info per declared environment and maps migrations", async () => {
    let cmdsRun: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      cmdsRun.push(cmd);
      return {
        stdout: JSON.stringify({
          schemaName: "public",
          migrations: [
            { version: "1", description: "init", type: "SQL", state: "Success", installedRank: 1, installedOn: "2026-04-01T00:00:00Z" },
            { version: "2", description: "add users",  type: "SQL", state: "Success", installedRank: 2, installedOn: "2026-04-15T00:00:00Z" },
            { version: "3", description: "add orders", type: "SQL", state: "Pending" },
          ],
        }),
        stderr: "",
      };
    });

    const entities = makeEntities([
      { name: "prod", entityType: "Flyway::Environment", props: { name: "production" } },
    ]);

    const result = await listArtifacts({ environment: "prod", entities });

    expect(cmdsRun).toEqual(["flyway info -environments=production -outputType=json"]);
    expect(Object.keys(result).sort()).toEqual([
      "migration/production/1",
      "migration/production/2",
      "migration/production/3",
    ]);
    expect(result["migration/production/2"]).toEqual({
      type: "Flyway::Migration",
      physicalId: "production/2",
      status: "Success",
      lastUpdated: "2026-04-15T00:00:00Z",
      attributes: {
        environment: "production",
        description: "add users",
        migrationType: "SQL",
        installedRank: 2,
      },
    });
    expect(result["migration/production/3"].status).toBe("Pending");
  });

  test("multiple declared envs each get their own flyway info call", async () => {
    let cmdsRun: string[] = [];
    execMock.mockImplementation((cmd: string) => {
      cmdsRun.push(cmd);
      return { stdout: JSON.stringify({ migrations: [{ version: "1", state: "Success" }] }), stderr: "" };
    });

    const entities = makeEntities([
      { name: "prod",    entityType: "Flyway::Environment", props: { name: "production" } },
      { name: "staging", entityType: "Flyway::Environment", props: { name: "staging" } },
    ]);

    const result = await listArtifacts({ environment: "prod", entities });

    expect(cmdsRun.sort()).toEqual([
      "flyway info -environments=production -outputType=json",
      "flyway info -environments=staging -outputType=json",
    ]);
    expect(result["migration/production/1"]).toBeDefined();
    expect(result["migration/staging/1"]).toBeDefined();
  });

  test("missing flyway binary on one env warns and continues with others", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("environments=broken")) {
        throw new Error("flyway: command not found");
      }
      return { stdout: JSON.stringify({ migrations: [{ version: "1", state: "Success" }] }), stderr: "" };
    });

    const entities = makeEntities([
      { name: "broken", entityType: "Flyway::Environment", props: { name: "broken" } },
      { name: "ok",     entityType: "Flyway::Environment", props: { name: "ok" } },
    ]);

    const result = await listArtifacts({ environment: "prod", entities });

    expect(Object.keys(result).filter((k) => k.includes("/broken/"))).toEqual([]);
    expect(result["migration/ok/1"]).toBeDefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("Failed migration state surfaces correctly", async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({ migrations: [{ version: "5", description: "broken", state: "Failed" }] }),
      stderr: "",
    });
    const entities = makeEntities([
      { name: "prod", entityType: "Flyway::Environment", props: { name: "production" } },
    ]);
    const result = await listArtifacts({ environment: "prod", entities });
    expect(result["migration/production/5"].status).toBe("Failed");
  });

  test("no declared envs → returns {} without spawning flyway", async () => {
    const result = await listArtifacts({ environment: "prod", entities: makeEntities([]) });
    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });

  test("non-Flyway entity types are ignored", async () => {
    execMock.mockResolvedValue({ stdout: JSON.stringify({ migrations: [] }), stderr: "" });
    const entities = makeEntities([
      { name: "x", entityType: "AWS::S3::Bucket", props: { name: "x" } },
    ]);
    const result = await listArtifacts({ environment: "prod", entities });
    expect(result).toEqual({});
    expect(execMock).not.toHaveBeenCalled();
  });

  test("malformed JSON output → warn-skipped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    execMock.mockResolvedValue({ stdout: "not valid json", stderr: "" });
    const entities = makeEntities([
      { name: "prod", entityType: "Flyway::Environment", props: { name: "production" } },
    ]);
    const result = await listArtifacts({ environment: "prod", entities });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
    warnSpy.mockRestore();
  });
});
