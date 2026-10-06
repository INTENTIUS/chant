import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTOR_PIN, GENAI_SEMCONV_PIN } from "../../define";
import {
  builtinComponents,
  bumpPins,
  collectorAudit,
  componentDir,
  parseStability,
  stabilityFindings,
} from "./collector-audit";
import { compareSemver } from "./github";
import type { CommandRunner } from "./github";

const releases = (tags: string[]) => tags.map((t) => ({ tag_name: t, draft: false, prerelease: false }));

/** Answers the two release lists, and metadata.yaml for the components in `meta` (keyed by `<repo>/<tag>/<dir>`). */
function fakeFetch(contrib: string[], semconv: string[], meta: Record<string, string> = {}): { f: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("opentelemetry-collector-contrib/releases")) return Response.json(releases(contrib));
    if (url.includes("semantic-conventions/releases")) return Response.json(releases(semconv));
    const m = /raw\.githubusercontent\.com\/[^/]+\/([^/]+)\/([^/]+)\/(.+)\/metadata\.yaml$/.exec(url);
    const key = m ? `${m[1]}/${m[2]}/${m[3]}` : "";
    if (meta[key] !== undefined) return new Response(meta[key]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, urls };
}

const stability = (levels: Record<string, string[]>) =>
  `type: x\nstatus:\n  class: receiver\n  stability:\n${Object.entries(levels)
    .map(([l, s]) => `    ${l}: [${s.join(", ")}]`)
    .join("\n")}\n`;

describe("collectorAudit's pieces", () => {
  test("the built-in components, and where each lives upstream", () => {
    const comps = builtinComponents();
    expect(comps.length).toBeGreaterThan(10);
    expect(comps).toContainEqual({ kind: "receiver", type: "otlp" });
    expect(componentDir({ kind: "receiver", type: "k8s_cluster" })).toBe("receiver/k8sclusterreceiver");
    expect(componentDir({ kind: "extension", type: "health_check" })).toBe("extension/healthcheckextension");
  });

  test("stability by signal from metadata.yaml", () => {
    expect(parseStability(stability({ beta: ["traces", "metrics"], deprecated: ["logs"] }))).toEqual({ traces: "beta", metrics: "beta", logs: "deprecated" });
    expect(parseStability("type: x\n")).toBeUndefined();
  });

  test("a deprecated signal and a changed level are findings; an unchanged component is not", () => {
    const c = { kind: "receiver" as const, type: "x" };
    expect(stabilityFindings(c, { traces: "beta" }, { traces: "beta" }, "v1.0.0", "v1.1.0")).toEqual([]);
    expect(stabilityFindings(c, { traces: "alpha" }, { traces: "beta" }, "v1.0.0", "v1.1.0")).toEqual([
      { kind: "stability-changed", subject: "receiver/x", detail: "traces alpha to beta (v1.0.0 to v1.1.0)" },
    ]);
    expect(stabilityFindings(c, { logs: "beta" }, { logs: "deprecated" }, "v1.0.0", "v1.1.0")).toEqual([
      { kind: "deprecated", subject: "receiver/x", detail: "logs deprecated at v1.1.0" },
    ]);
  });

  test("bumpPins moves only the two pin versions in define.ts", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "..", "define.ts"), "utf8");
    const out = bumpPins(text, { collector: "v0.140.0", genai: "v1.50.0" });
    expect(out).toContain('version: "v0.140.0"');
    expect(out).toContain('version: "v1.50.0"');
    expect(out).not.toContain(`version: "${COLLECTOR_PIN.version}"`);
    // SEMCONV_PIN is left alone.
    const changed = out.split("\n").filter((l, i) => l !== text.split("\n")[i]);
    expect(changed).toHaveLength(2);
    expect(() => bumpPins("nothing", { collector: "v1.0.0" })).toThrow(/no COLLECTOR_PIN/);
  });

  test("semver ordering", () => {
    expect(compareSemver("v0.131.0", "v0.130.0")).toBeGreaterThan(0);
    expect(compareSemver("v0.99.0", "v0.130.0")).toBeLessThan(0);
  });
});

describe("collectorAudit", () => {
  test("current pins and no stability reading: no findings, report mode does nothing else", async () => {
    const { f } = fakeFetch([COLLECTOR_PIN.version, "v0.129.0"], [GENAI_SEMCONV_PIN.version]);
    const r = await collectorAudit({ stability: false, _fetch: f, _run: async () => { throw new Error("no git in report mode"); } });
    expect(r.findings).toEqual([]);
    expect(r.collector).toEqual({ pin: COLLECTOR_PIN.version, latest: COLLECTOR_PIN.version, behind: 0 });
    expect(r.summary).toContain(`COLLECTOR_PIN ${COLLECTOR_PIN.version}: current`);
  });

  test("pins behind the newest releases are findings, prereleases ignored", async () => {
    const { f } = fakeFetch(["v0.132.0", "v0.131.0", COLLECTOR_PIN.version], ["v1.42.0", GENAI_SEMCONV_PIN.version]);
    const r = await collectorAudit({ stability: false, _fetch: f });
    expect(r.findings.map((x) => x.kind)).toEqual(["collector-pin-behind", "semconv-pin-behind"]);
    expect(r.collector).toEqual({ pin: COLLECTOR_PIN.version, latest: "v0.132.0", behind: 2 });
    expect(r.semconv.behind).toBe(1);
  });

  test("component stability at the pin and at the newest release, contrib then core, within the budget", async () => {
    const meta = {
      // otlp is a core component: contrib answers 404 for it.
      [`opentelemetry-collector/v0.131.0/receiver/otlpreceiver`]: stability({ stable: ["traces"], deprecated: ["logs"] }),
      [`opentelemetry-collector/${COLLECTOR_PIN.version}/receiver/otlpreceiver`]: stability({ stable: ["traces", "logs"] }),
    };
    const { f, urls } = fakeFetch(["v0.131.0", COLLECTOR_PIN.version], [GENAI_SEMCONV_PIN.version], meta);
    const r = await collectorAudit({ _fetch: f, stabilityBudget: 500 });
    expect(r.findings).toContainEqual({ kind: "deprecated", subject: "receiver/otlp", detail: "logs deprecated at v0.131.0" });
    expect(r.unchecked).not.toContain("receiver/otlp");
    expect(r.unchecked.length).toBe(builtinComponents().length - 1);
    // Looked for in contrib first, then core.
    const otlp = urls.filter((u) => u.includes("/v0.131.0/receiver/otlpreceiver/"));
    expect(otlp[0]).toContain("opentelemetry-collector-contrib");
    expect(otlp[1]).toContain("open-telemetry/opentelemetry-collector/");

    const capped = fakeFetch(["v0.131.0", COLLECTOR_PIN.version], [GENAI_SEMCONV_PIN.version], meta);
    await collectorAudit({ _fetch: capped.f, stabilityBudget: 3 });
    expect(capped.urls.filter((u) => u.includes("raw.githubusercontent.com"))).toHaveLength(3);
  });

  test("an unreadable release list is no finding", async () => {
    const f = (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch;
    const r = await collectorAudit({ stability: false, _fetch: f });
    expect(r.findings).toEqual([]);
    expect(r.collector.latest).toBeNull();
    expect(r.summary).toContain("release list unreadable");
  });

  test("pull-request mode bumps the pins in a worktree and opens a pull request", async () => {
    const { f } = fakeFetch(["v0.131.0", COLLECTOR_PIN.version], [GENAI_SEMCONV_PIN.version]);
    const calls: string[] = [];
    const lexiconDir = join(import.meta.dirname, "..", "..", "..");
    const run: CommandRunner = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (args[0] === "rev-parse") return join(lexiconDir, "..", "..") + "\n";
      if (args[0] === "symbolic-ref") return "origin/main\n";
      if (args[0] === "worktree" && args[1] === "add") throw new Error("stop before writing files");
      return "";
    };
    await expect(collectorAudit({ mode: "pull-request", stability: false, lexiconDir, _fetch: f, _run: run })).rejects.toThrow(/stop before/);
    expect(calls.some((c) => c.startsWith("git worktree add --force -B chant/otel-pins"))).toBe(true);
    expect(calls.some((c) => c.startsWith("git worktree remove"))).toBe(false);
  });

  test("pull-request mode end to end against a recorded git and gh", async () => {
    const { f } = fakeFetch(["v0.131.0", COLLECTOR_PIN.version], [GENAI_SEMCONV_PIN.version]);
    const calls: string[] = [];
    const lexiconDir = join(import.meta.dirname, "..", "..", "..");
    const { mkdirSync } = await import("node:fs");
    const run: CommandRunner = async (bin, args) => {
      calls.push(`${bin} ${args.join(" ")}`);
      if (args[0] === "rev-parse") return join(lexiconDir, "..", "..") + "\n";
      if (args[0] === "symbolic-ref") return "origin/main\n";
      if (args[0] === "worktree" && args[1] === "add") mkdirSync(join(args[5], "lexicons", "otel", "src"), { recursive: true });
      if (bin === "gh" && args[1] === "list") return "[]";
      if (bin === "gh" && args[1] === "create") return "https://github.com/INTENTIUS/chant/pull/1\n";
      return "";
    };
    const r = await collectorAudit({ mode: "pull-request", stability: false, lexiconDir, _fetch: f, _run: run });
    expect(r.prUrl).toBe("https://github.com/INTENTIUS/chant/pull/1");
    expect(calls).toContain("git add lexicons/otel/src/define.ts");
    expect(calls.some((c) => c.startsWith("git commit -m chore(otel): move COLLECTOR_PIN to v0.131.0"))).toBe(true);
    expect(calls.some((c) => c.startsWith("git push --force origin HEAD:refs/heads/chant/otel-pins"))).toBe(true);
    expect(calls.some((c) => c.startsWith("gh pr create --head chant/otel-pins --base main"))).toBe(true);
  });
});
