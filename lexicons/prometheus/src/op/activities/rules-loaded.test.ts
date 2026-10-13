import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredGroups, groupVerdict, rulesLoadedObserve, type ApiRuleGroup } from "./rules-loaded";

function rulesApi(groups: ApiRuleGroup[], extra: Record<string, unknown> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v1/rules")) return Response.json({ status: "success", data: { groups } });
    if (extra[url] !== undefined) return Response.json(extra[url]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const LOADED: ApiRuleGroup[] = [
  { name: "slo-checkout", file: "/etc/prometheus/rules.yml", rules: [{ name: "slo:sli_error:ratio_rate5m", type: "recording", health: "ok" }] },
  {
    name: "genai",
    rules: [
      { name: "genai:calls:rate5m", type: "recording", health: "ok" },
      { name: "GenAiErrors", type: "alerting", health: "err", lastError: 'vector contains metrics with the same labelset after applying rule labels' },
    ],
  },
];

describe("rulesLoadedObserve", () => {
  test("one resource per declared group: loaded and healthy, not loaded, or with a rule in error", async () => {
    const r = await rulesLoadedObserve({ url: "http://prom:9090", groups: ["slo-checkout", "genai", "slo-search"], _fetch: rulesApi(LOADED) });
    expect(r.resources).toEqual([
      { name: "slo-checkout", status: "in-sync", detail: "1 rule(s) loaded" },
      { name: "genai", status: "drifted", detail: "GenAiErrors: vector contains metrics with the same labelset after applying rule labels" },
      { name: "slo-search", status: "drifted", detail: "group not loaded" },
    ]);
  });

  test("the declared groups also come from rule files, without repeats", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-rules-loaded-"));
    writeFileSync(join(dir, "rules.yml"), "groups:\n  - name: slo-checkout\n    rules: []\n  - name: genai\n    rules: []\n");
    expect(declaredGroups({ groups: ["genai", "extra"], rules: "rules.yml" }, dir)).toEqual(["genai", "extra", "slo-checkout"]);
  });

  test("an unreadable API is unknown for every group, never drifted", async () => {
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r = await rulesLoadedObserve({ groups: ["a", "b"], _fetch: down });
    expect(r.resources.map((x) => x.status)).toEqual(["unknown", "unknown"]);
    expect(r.resources[0].detail).toMatch(/rules API unreadable: .*HTTP 503/);
  });

  test("no declared group is an error, not an empty observation", async () => {
    await expect(rulesLoadedObserve({ _fetch: rulesApi([]) })).rejects.toThrow(/no groups declared/);
  });

  test("a group split across files is judged on all its rules", () => {
    const split: ApiRuleGroup[] = [
      { name: "g", rules: [{ name: "a", health: "ok" }] },
      { name: "g", rules: [{ name: "b", health: "err", lastError: "" }] },
    ];
    expect(groupVerdict("g", split)).toEqual({ name: "g", status: "drifted", detail: "b: health err" });
  });
});
