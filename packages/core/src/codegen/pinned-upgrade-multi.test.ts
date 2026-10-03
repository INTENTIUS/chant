import { describe, test, expect, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { loadUpstreamPins, checkPinnedUpgrades, checkPinnedUpgrade, pinsOfPlugin } from "./pinned-upgrade";
import { printPinnedUpgradeResults } from "../cli/commands/pinned-upgrade";
import type { UpstreamPin } from "../lexicon";

// The sql lexicon declares ClickHouse's pin and five Postgres pins (#3288).
const sqlDir = join(__dirname, "../../../../lexicons/sql");

// Recorded shape of GET /repos/postgres/postgres/tags (see pinned-upgrade-tags.test.ts),
// with two newer minors added so the 14 and 17 pins have something to report.
const recorded = JSON.parse(readFileSync(join(__dirname, "testdata", "postgres-tags.json"), "utf-8")) as Array<{ name: string }>;
const tags = [...recorded, { name: "REL_17_12" }, { name: "REL_14_25" }, { name: "REL_19_BETA1" }];

function stubGitHub() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname.startsWith("/repos/postgres/postgres/tags")) {
        const page = Number(u.searchParams.get("page"));
        return new Response(JSON.stringify(page === 1 ? tags : []), { status: 200 });
      }
      if (u.pathname.startsWith("/repos/ClickHouse/ClickHouse/releases")) {
        return new Response(JSON.stringify([{ tag_name: "v99.1.1.1-lts" }, { tag_name: "v26.8.15.10-lts" }]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("pinsOfPlugin", () => {
  const pin = (label?: string): UpstreamPin => ({
    ...(label ? { label } : {}),
    file: "f",
    pattern: /x/,
    replace: (v) => v,
    upstream: { owner: "o", repo: "r", kind: "releases" },
  });

  test("a lone upstreamPin is labelled by its own label, else the lexicon", () => {
    expect(pinsOfPlugin({ upstreamPin: pin() }, "k8s").map((p) => p.label)).toEqual(["k8s"]);
    expect(pinsOfPlugin({ upstreamPin: pin("main") }, "k8s").map((p) => p.label)).toEqual(["main"]);
  });

  test("upstreamPin comes first, then upstreamPins in order", () => {
    const labels = pinsOfPlugin({ upstreamPin: pin("a"), upstreamPins: [pin("b"), pin("c")] }, "x").map((p) => p.label);
    expect(labels).toEqual(["a", "b", "c"]);
  });

  test("no pins", () => {
    expect(pinsOfPlugin({}, "aws")).toEqual([]);
  });
});

describe("sql declares six pins", () => {
  test("clickhouse first, then postgres-14 to postgres-18", async () => {
    const pins = await loadUpstreamPins("sql", sqlDir);
    expect(pins.map((p) => p.label)).toEqual(["clickhouse", "postgres-14", "postgres-15", "postgres-16", "postgres-17", "postgres-18"]);
    // The digest sits beside the version in both, so neither is rewritten blind.
    for (const { pin } of pins) expect(pin.alsoMoves).toMatch(/digest/);
  });
});

describe("checkPinnedUpgrades on the sql lexicon (network mocked)", () => {
  test("reports each pin, in order, and edits nothing", async () => {
    stubGitHub();
    const pinFiles = ["src/spec/pin.ts", "src/spec/postgres-pin.ts"].map((f) => join(sqlDir, f));
    const before = pinFiles.map((f) => readFileSync(f, "utf-8"));
    const results = await checkPinnedUpgrades({ lexiconDir: sqlDir, lexicon: "sql" });
    expect(pinFiles.map((f) => readFileSync(f, "utf-8"))).toEqual(before);

    const byPin = Object.fromEntries(results.map((r) => [r.pin, r]));
    expect(results.map((r) => r.pin)).toEqual(["clickhouse", "postgres-14", "postgres-15", "postgres-16", "postgres-17", "postgres-18"]);
    expect(results.every((r) => r.fetchError === null)).toBe(true);

    expect(byPin["clickhouse"]).toMatchObject({ hasUpgrade: true, to: "v99.1.1.1-lts" });
    // Each Postgres pin sees only its own major: 17 reports 17.12, never 18.6.
    expect(byPin["postgres-14"]).toMatchObject({ hasUpgrade: true, from: "14.24", to: "14.25" });
    expect(byPin["postgres-15"]).toMatchObject({ hasUpgrade: false, from: "15.19", to: "15.19" });
    expect(byPin["postgres-16"]).toMatchObject({ hasUpgrade: false, from: "16.15", to: "16.15" });
    expect(byPin["postgres-17"]).toMatchObject({ hasUpgrade: true, from: "17.11", to: "17.12" });
    expect(byPin["postgres-18"]).toMatchObject({ hasUpgrade: false, from: "18.6", to: "18.6" });

    // alsoMoves pins are report-only: instructions, no regen.
    for (const label of ["clickhouse", "postgres-14", "postgres-17"]) {
      expect(byPin[label]!.validation, label).toBeNull();
      expect(byPin[label]!.manualPin?.instructions, label).toMatch(/digest/);
    }
    expect(byPin["postgres-17"]!.manualPin?.file).toBe("src/spec/postgres-pin.ts");
    expect(byPin["postgres-15"]!.manualPin).toBeUndefined();
  });

  test("a pin label checks one pin and queries only its upstream", async () => {
    const urls = stubGitHub();
    const results = await checkPinnedUpgrades({ lexiconDir: sqlDir, lexicon: "sql", pin: "postgres-17" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pin: "postgres-17", to: "17.12" });
    expect(urls.every((u) => u.includes("/repos/postgres/postgres/tags"))).toBe(true);

    const ch = await checkPinnedUpgrades({ lexiconDir: sqlDir, lexicon: "sql", pin: "clickhouse" });
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ pin: "clickhouse", hasUpgrade: true });
  });

  test("an unknown label names the pins there are", async () => {
    const [r] = await checkPinnedUpgrades({ lexiconDir: sqlDir, lexicon: "sql", pin: "postgres-13" });
    expect(r!.fetchError).toMatch(/no pin labelled "postgres-13"/);
    expect(r!.fetchError).toMatch(/clickhouse, postgres-14/);
  });

  test("a network failure on one pin leaves the others reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/repos/ClickHouse/") ? new Response("boom", { status: 404 }) : new Response(JSON.stringify(url.includes("page=1") ? tags : []), { status: 200 }),
      ),
    );
    const results = await checkPinnedUpgrades({ lexiconDir: sqlDir, lexicon: "sql" });
    expect(results[0]!.fetchError).toBeTruthy();
    expect(results[4]).toMatchObject({ pin: "postgres-17", to: "17.12", fetchError: null });
  });

  test("checkPinnedUpgrade (singular) still checks the first pin, ClickHouse", async () => {
    stubGitHub();
    const r = await checkPinnedUpgrade({ lexiconDir: sqlDir, lexicon: "sql" });
    expect(r.pin).toBe("clickhouse");
  });
});

describe("printPinnedUpgradeResults", () => {
  test("several results print as a JSON array carrying each pin", async () => {
    stubGitHub();
    const results = await checkPinnedUpgrades({ lexiconDir: sqlDir, lexicon: "sql" });
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    try {
      printPinnedUpgradeResults(results, true);
      const parsed = JSON.parse(out.join("\n")) as Array<{ pin: string; to: string }>;
      expect(parsed.map((p) => p.pin)).toEqual(results.map((r) => r.pin));
      out.length = 0;
      process.env.NO_COLOR = "1";
      printPinnedUpgradeResults(results, false);
      expect(out.join("\n")).toContain("[sql/postgres-17] upgrade available  17.11 -> 17.12");
      expect(out.join("\n")).toContain("[sql/postgres-18] up to date");
    } finally {
      delete process.env.NO_COLOR;
      spy.mockRestore();
    }
  });
});
