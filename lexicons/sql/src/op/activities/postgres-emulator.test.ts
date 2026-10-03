import { describe, expect, test } from "vitest";
import { emulatorLifecycle, emulatorsOf, endpointEnvVars } from "@intentius/chant/op";
import { POSTGRES_EMULATOR } from "./postgres-emulator";
import { CLICKHOUSE_EMULATOR } from "./clickhouse-emulator";
import { sqlPlugin } from "../../plugin";
import { POSTGRES_LATEST_MAJOR, postgresImage } from "../../spec/postgres-pin";

describe("the Postgres emulator capability (#3280)", () => {
  test("is declared on the plugin beside ClickHouse's, so chant emulator up boots it", () => {
    expect(emulatorsOf(sqlPlugin.emulator)).toEqual([CLICKHOUSE_EMULATOR, POSTGRES_EMULATOR]);
  });

  test("runs the newest pinned image by digest, and names POSTGRES_URL as its endpoint", () => {
    expect(POSTGRES_EMULATOR.spec.image).toBe(postgresImage(POSTGRES_LATEST_MAJOR));
    expect(POSTGRES_EMULATOR.spec.image).toMatch(/^postgres:18\.6@sha256:/);
    expect(endpointEnvVars(POSTGRES_EMULATOR)).toEqual(["POSTGRES_URL"]);
    expect(POSTGRES_EMULATOR.env("postgres://localhost:5432/postgres")).toMatchObject({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "chant" });
  });

  test("is ready when pg_isready answers over TCP, and is reached at a postgres:// URL", () => {
    const lc = emulatorLifecycle(POSTGRES_EMULATOR.spec);
    expect(lc.runCommand()).toBe(`docker run -d --rm --name chant-postgres -p 5432:5432 -e POSTGRES_PASSWORD=chant ${postgresImage(POSTGRES_LATEST_MAJOR)}`);
    expect(lc.readyExecCommand("chant-postgres")).toBe("docker exec chant-postgres pg_isready -h 127.0.0.1 -U postgres");
    expect(lc.endpoint(5432)).toBe("postgres://localhost:5432/postgres");
  });
});
