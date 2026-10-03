import { describe, expect, test } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { sqlPlugin } from "./plugin";
import { sqlConfigSchema } from "./config";
import { CLICKHOUSE_VERSION } from "./spec/pin";

describe("sql plugin", () => {
  test("is a LexiconPlugin named sql", () => {
    expect(isLexiconPlugin(sqlPlugin)).toBe(true);
    expect(sqlPlugin.name).toBe("sql");
  });

  test("carries the sql serializer and its rule prefix", () => {
    expect(sqlPlugin.serializer.name).toBe("sql");
    expect(sqlPlugin.serializer.rulePrefix).toBe("SQL");
  });

  test("registers the LSP providers and docs()", () => {
    expect(typeof sqlPlugin.completionProvider).toBe("function");
    expect(typeof sqlPlugin.hoverProvider).toBe("function");
    expect(typeof sqlPlugin.docs).toBe("function");
  });

  test("every rule and check id it ships starts with SQL", () => {
    const ids = [...(sqlPlugin.lintRules?.() ?? []).map((r) => r.id), ...(sqlPlugin.postSynthChecks?.() ?? []).map((c) => c.id)];
    for (const id of ids) expect(id.startsWith("SQL")).toBe(true);
  });
});

describe("the sql config namespace", () => {
  test("accepts a known dialect and an empty namespace", () => {
    expect(sqlConfigSchema.safeParse({ dialect: "clickhouse" }).success).toBe(true);
    expect(sqlConfigSchema.safeParse({ dialect: "postgres" }).success).toBe(true);
    expect(sqlConfigSchema.safeParse({}).success).toBe(true);
  });

  test("accepts a list of dialects", () => {
    expect(sqlConfigSchema.safeParse({ dialect: ["clickhouse"] }).success).toBe(true);
    expect(sqlConfigSchema.safeParse({ dialect: ["clickhouse", "postgres"] }).success).toBe(true);
    expect(sqlConfigSchema.safeParse({ dialect: [] }).success).toBe(false);
  });

  test("refuses any other name as unknown", () => {
    const message = (dialect: unknown) => sqlConfigSchema.safeParse({ dialect }).error?.issues[0]?.message;
    expect(message("mysql")).toBe("expected a dialect (clickhouse, postgres) or a non-empty list of them");
    expect(message(["postgres", "mysql"])).toBe("expected a dialect (clickhouse, postgres) or a non-empty list of them");
  });

  test("refuses an unknown key rather than ignoring it", () => {
    expect(sqlConfigSchema.safeParse({ dialects: "clickhouse" }).success).toBe(false);
  });
});

describe("the upstream pin", () => {
  const pin = sqlPlugin.upstreamPin!;
  const line = `export const CLICKHOUSE_VERSION = "${CLICKHOUSE_VERSION}";`;

  test("reads the version constant", () => {
    expect(pin.pattern.exec(line)?.[1]).toBe(CLICKHOUSE_VERSION);
  });

  test("writes a GitHub LTS tag back as the bare version the docker tag uses", () => {
    expect(pin.replace("v26.8.16.2-lts", line)).toBe('export const CLICKHOUSE_VERSION = "26.8.16.2";');
  });

  test("looks only at LTS releases of ClickHouse", () => {
    expect(pin.upstream).toEqual({ owner: "ClickHouse", repo: "ClickHouse", kind: "releases", tagSuffix: "-lts" });
  });
});
