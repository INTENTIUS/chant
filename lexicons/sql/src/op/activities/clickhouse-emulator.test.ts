import { describe, expect, test } from "vitest";
import { emulatorLifecycle, emulatorsOf, endpointEnvVars } from "@intentius/chant/op";
import { CLICKHOUSE_EMULATOR } from "./clickhouse-emulator";
import { sqlPlugin } from "../../plugin";
import { clickhouseImage } from "../../spec/pin";

describe("the ClickHouse emulator capability (#3208)", () => {
  test("is declared on the plugin, so chant emulator up boots it", () => {
    expect(emulatorsOf(sqlPlugin.emulator)[0]).toEqual(CLICKHOUSE_EMULATOR);
  });

  test("runs the pinned image by digest, and names CLICKHOUSE_URL as its endpoint", () => {
    expect(CLICKHOUSE_EMULATOR.spec.image).toBe(clickhouseImage());
    expect(CLICKHOUSE_EMULATOR.spec.image).toMatch(/:26\.8\.15\.10@sha256:/);
    expect(endpointEnvVars(CLICKHOUSE_EMULATOR)).toEqual(["CLICKHOUSE_URL"]);
  });

  test("starts the server reachable as the default user", () => {
    expect(emulatorLifecycle(CLICKHOUSE_EMULATOR.spec).runCommand()).toBe(
      `docker run -d --rm --name chant-clickhouse -p 8123:8123 -e CLICKHOUSE_SKIP_USER_SETUP=1 ${clickhouseImage()}`,
    );
  });
});
