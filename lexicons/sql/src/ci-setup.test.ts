/** #4572: the sql lexicon's CI setup lines and replay services. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { declaresReplay, NODE_CHECK_LINE, PACKAGES_INSTALL_LINE, replayService, sqlCiServices, sqlCiSetup, sqlDialectsOf } from "./ci-setup";
import { sqlPlugin } from "./plugin";
import { clickhouseImage } from "./spec/pin";
import { POSTGRES_LATEST_MAJOR, postgresImage } from "./spec/postgres-pin";

function project(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sql-ci-setup-"));
  if (config !== undefined) writeFileSync(join(dir, "chant.config.ts"), config);
  return dir;
}

describe("sqlDialectsOf", () => {
  test("ClickHouse by default, the named dialect, or each of a list", () => {
    expect(sqlDialectsOf("export default { sql: {} }")).toEqual(["clickhouse"]);
    expect(sqlDialectsOf('export default { sql: { dialect: "postgres" } }')).toEqual(["postgres"]);
    expect(sqlDialectsOf("export default { sql: { dialect: ['postgres', 'clickhouse'] } }")).toEqual(["clickhouse", "postgres"]);
  });
});

describe("declaresReplay", () => {
  test("a replay profile, quoted or not", () => {
    expect(declaresReplay("profiles: { replay: { url: 'x' } }")).toBe(true);
    expect(declaresReplay('profiles: { "replay": { url: "x" } }')).toBe(true);
    expect(declaresReplay("profiles: { prod: { url: 'x' } }")).toBe(false);
    expect(declaresReplay("profiles: { noreplay: { url: 'x' } }")).toBe(false);
  });
});

describe("sqlCiSetup", () => {
  test("the Node check and the guarded install, for a project with a config", () => {
    expect(sqlCiSetup({ dir: project("export default { sql: {} }") })).toEqual([NODE_CHECK_LINE, PACKAGES_INSTALL_LINE]);
    expect(sqlCiSetup({ dir: project() })).toEqual([]);
  });

  test("the install skips when the lexicon is installed, and puts the bins on PATH on every forge", () => {
    expect(PACKAGES_INSTALL_LINE).toContain("[ -d node_modules/@intentius/chant-lexicon-sql ] || npm ci");
    expect(PACKAGES_INSTALL_LINE).toContain('export PATH="$PWD/node_modules/.bin:$PATH"');
    expect(PACKAGES_INSTALL_LINE).toContain('>> "$GITHUB_PATH"');
  });

  test("the plugin gives them", () => {
    const dir = project("export default { sql: {} }");
    expect(sqlPlugin.ciSetup?.({ dir })).toEqual(sqlCiSetup({ dir }));
  });
});

describe("sqlCiServices", () => {
  test("the replay server per dialect at the emulator's pins, only with a replay profile", () => {
    const dir = project('export default { sql: { dialect: "postgres", profiles: { replay: { url: "postgres://replay-postgres:5432/postgres" } } } }');
    expect(sqlCiServices({ dir })).toEqual([replayService("postgres")]);
    expect(replayService("postgres").image).toBe(postgresImage(POSTGRES_LATEST_MAJOR));
    expect(replayService("clickhouse").image).toBe(clickhouseImage());
    expect(sqlCiServices({ dir: project("export default { sql: { profiles: { prod: {} } } }") })).toEqual([]);
    expect(sqlPlugin.ciServices?.({ dir })).toEqual([replayService("postgres")]);
  });

  test("the job reaches each server by its name, with the variables sql-yodeler's replay profile reads", () => {
    expect(replayService("clickhouse").jobEnv).toEqual({ REPLAY_CLICKHOUSE_URL: "http://replay-clickhouse:8123" });
    expect(replayService("postgres").jobEnv).toMatchObject({ REPLAY_POSTGRES_URL: "postgres://replay-postgres:5432/postgres", REPLAY_POSTGRES_USER: "postgres" });
  });
});
