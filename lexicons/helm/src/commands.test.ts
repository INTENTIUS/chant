/**
 * `chant helm classify` / `chant helm localize` / `chant helm renders` /
 * `chant helm diff` (#1248, epic #1228 Phase 6; `diff` itself is #1249).
 *
 * Handler-level, the way core's dispatcher drives them: cwd pointed at a
 * fixture, rawArgs handed over unparsed, exit code and printed output
 * asserted. `classify` is static analysis and needs no helm binary; the
 * verbs that render (`localize`) or discover a project whose `HelmRender`
 * shells out (`renders`) sit behind the same skipIf discipline as
 * render.test.ts. `diff` reads only the render store (render-store.ts) so it
 * needs neither helm nor a chart — its own fixtures persist renders directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESERVED_COMMAND_NAMES } from "@intentius/chant/cli/command-group";
import { formatRenderDiff, formatRenderRecords, helmCommandGroup } from "./commands";
import { helmPlugin } from "./plugin";
import { renderStability } from "./render-digest";
import { persistHelmRender } from "./render-store";
import type { HelmCapabilityProfile } from "./config";

function helmOnPath(): boolean {
  try {
    execFileSync("helm", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const helmAvailable = helmOnPath();

const MINIMAL_CHART = "apiVersion: v2\nname: unit\ntype: application\nversion: 0.1.0\n";

const cleanupDirs: string[] = [];

/** Materialize a chart (or any fixture tree) from a { relPath: content } map. */
function mkTree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-helm-commands-")));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function verb(name: string) {
  const command = helmCommandGroup().commands.find((c) => c.name === name);
  if (!command) throw new Error(`no verb ${name}`);
  return command;
}

let logged: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("the helm command group", () => {
  it("mounts under a name core does not reserve, with classify, localize, and renders", () => {
    const group = helmCommandGroup();
    expect(group.name).toBe("helm");
    expect(RESERVED_COMMAND_NAMES.has(group.name)).toBe(false);
    expect(group.commands.map((c) => c.name)).toEqual(["classify", "localize", "renders", "diff"]);
    expect(helmPlugin.commands?.().name).toBe("helm");
  });

  it("rejects flags it does not know, naming the ones it does", async () => {
    await expect(verb("classify").handler({ verb: "classify", rawArgs: ["--bogus"] })).rejects.toThrow(
      /Unknown flag: --bogus[\s\S]*--values/,
    );
    await expect(verb("renders").handler({ verb: "renders", rawArgs: ["--values", "x.yaml"] })).rejects.toThrow(
      /Unknown flag: --values[\s\S]*--json/,
    );
  });

  it("requires the chart directory positional where one is declared", async () => {
    await expect(verb("classify").handler({ verb: "classify", rawArgs: [] })).rejects.toThrow(
      /Usage: chant helm classify <chart-dir>/,
    );
    await expect(
      verb("renders").handler({ verb: "renders", rawArgs: ["some-chart"] }),
    ).rejects.toThrow(/takes no positional arguments/);
  });
});

describe("chant helm classify", () => {
  it("prints a deterministic verdict for a closed chart and exits 0", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-cm\n",
    });
    expect(await verb("classify").handler({ verb: "classify", rawArgs: [chart] })).toBe(0);
    expect(logged.join("\n")).toContain("verdict: deterministic");
  });

  it("locates capability references and open generated inputs on a pinnable chart", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/secret.yaml":
        "kube: {{ .Capabilities.KubeVersion.Version }}\npassword: {{ .Values.adminPassword | default (randAlphaNum 16) | quote }}",
    });
    expect(await verb("classify").handler({ verb: "classify", rawArgs: [chart] })).toBe(0);
    const out = logged.join("\n");
    expect(out).toContain("verdict: pinnable");
    expect(out).toContain("requires capability profile");
    expect(out).toContain("randAlphaNum");
  });

  it("exits 1 on an unpinnable chart — the verdict is the gate", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": '{{- if not (lookup "v1" "ConfigMap" "ns" "seen") }}\nx: 1\n{{- end }}',
    });
    expect(await verb("classify").handler({ verb: "classify", rawArgs: [chart] })).toBe(1);
    expect(logged.join("\n")).toContain("verdict: unpinnable");
  });

  it("merges --values files into the classification", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/secret.yaml": "password: {{ .Values.adminPassword | default (randAlphaNum 16) | quote }}",
      "supplied.yaml": "adminPassword: pinned\n",
    });
    expect(
      await verb("classify").handler({ verb: "classify", rawArgs: [chart, "--values", join(chart, "supplied.yaml")] }),
    ).toBe(0);
    const out = logged.join("\n");
    expect(out).toContain("verdict: pinnable");
    expect(out).toContain("supplied-values");
    expect(out).not.toContain("randAlphaNum");
  });

  it("emits the full report as JSON with --json", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "templates/ing.yaml": "kube: {{ .Capabilities.KubeVersion.Version }}",
    });
    expect(await verb("classify").handler({ verb: "classify", rawArgs: [chart, "--json"] })).toBe(0);
    const report = JSON.parse(logged.join("\n")) as {
      verdict: string;
      requiresProfile: { capability: string; file: string; line: number }[];
      closedInputs: unknown[];
      hazards: unknown[];
      reasons: string[];
      lookups: { controlFlow: unknown[]; valuePosition: unknown[] };
      warnings: string[];
    };
    expect(report.verdict).toBe("pinnable");
    expect(report.requiresProfile).toHaveLength(1);
    expect(report.requiresProfile[0].capability).toBe("KubeVersion");
    expect(report.lookups.controlFlow).toEqual([]);
  });
});

describe.skipIf(!helmAvailable)("chant helm localize", () => {
  it("confirms a closed chart deterministic via the double render", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-cm\n",
    });
    expect(await verb("localize").handler({ verb: "localize", rawArgs: [chart] })).toBe(0);
    expect(logged.join("\n")).toContain("deterministic (double render byte-stable)");
  });

  it("maps unstable lines to the generator and suggests the validated pin", async () => {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/secret.yaml": [
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: {{ .Release.Name }}-admin",
        "stringData:",
        "  password: {{ .Values.adminPassword | default (randAlphaNum 16) | quote }}",
      ].join("\n"),
    });
    expect(await verb("localize").handler({ verb: "localize", rawArgs: [chart, "--json"] })).toBe(0);
    const report = JSON.parse(logged.join("\n")) as {
      deterministic: boolean;
      inputs: { fn: string; suppliable: boolean; valuesPath?: string }[];
      unlocalized: unknown[];
      renders: number;
    };
    expect(report.deterministic).toBe(false);
    expect(report.inputs).toHaveLength(1);
    expect(report.inputs[0].fn).toBe("randAlphaNum");
    expect(report.inputs[0].suppliable).toBe(true);
    expect(report.inputs[0].valuesPath).toBe("adminPassword");
    expect(report.unlocalized).toEqual([]);
  });
});

describe.skipIf(!helmAvailable)("chant helm renders", () => {
  const cwd = process.cwd();
  const renderModule = join(dirname(fileURLToPath(import.meta.url)), "render.ts");

  afterEach(() => {
    process.chdir(cwd);
  });

  /** A chant project whose one source file records a pinned HelmRender. */
  function mkProject(): string {
    const chart = mkTree({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-cm\n",
    });
    return mkTree({
      "chant.config.json": JSON.stringify({ lexicons: ["helm"] }),
      "infra.ts": [
        `import { HelmRender } from ${JSON.stringify(renderModule)};`,
        "export const web = HelmRender({",
        '  name: "web",',
        `  chart: ${JSON.stringify(chart)},`,
        "  noCache: true,",
        '  capabilityProfile: { name: "test-profile", kubeVersion: "1.33.0" },',
        "} as never);",
      ].join("\n"),
    });
  }

  it("discovers the project and lists the record with both digests", async () => {
    process.chdir(mkProject());
    expect(await verb("renders").handler({ verb: "renders", rawArgs: [] })).toBe(0);
    const out = logged.join("\n");
    expect(out).toContain("web");
    expect(out).toContain("test-profile");
    expect(out).toMatch(/sha256:[0-9a-f]{12}/);
    expect(out).toContain("1 stable group(s), 0 unstable, 0 unassessed");
  });

  it("emits records and stability as JSON with --json", async () => {
    process.chdir(mkProject());
    expect(await verb("renders").handler({ verb: "renders", rawArgs: ["--json"] })).toBe(0);
    const payload = JSON.parse(logged.join("\n")) as {
      records: { name: string; inputDigest?: string; contentDigest?: string; capabilityProfile?: { name: string } }[];
      stability: { stable: unknown[]; unstable: unknown[]; unassessed: string[] };
    };
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].name).toBe("web");
    expect(payload.records[0].inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.records[0].contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.records[0].capabilityProfile?.name).toBe("test-profile");
    expect(payload.stability.stable).toHaveLength(1);
    expect(payload.stability.unassessed).toEqual([]);
  });

  it("refuses outside a chant project instead of discovering an arbitrary directory", async () => {
    process.chdir(mkTree({ "readme.txt": "not a chant project" }));
    await expect(verb("renders").handler({ verb: "renders", rawArgs: [] })).rejects.toThrow(/Not a chant project/);
  });
});

describe("chant helm diff", () => {
  const PROFILE: HelmCapabilityProfile = { name: "prod", kubeVersion: "1.33.6" };
  const RENDERED_A = [
    "---",
    "# Source: tiny/templates/configmap.yaml",
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: tiny-config",
    "  namespace: web",
    "data:",
    "  color: blue",
    "",
  ].join("\n");
  const RENDERED_B = RENDERED_A.replace("color: blue", "color: green");

  function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "chant-helm-diff-cli-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("rejects anything other than exactly two digest positionals", async () => {
    await expect(verb("diff").handler({ verb: "diff", rawArgs: [] })).rejects.toThrow(
      /Usage: chant helm diff <from-digest> <to-digest>/,
    );
    await expect(verb("diff").handler({ verb: "diff", rawArgs: ["only-one"] })).rejects.toThrow(
      /Usage: chant helm diff <from-digest> <to-digest>/,
    );
  });

  it("rejects flags it does not know", async () => {
    await expect(
      verb("diff").handler({ verb: "diff", rawArgs: ["a", "b", "--bogus"] }),
    ).rejects.toThrow(/Unknown flag: --bogus[\s\S]*--json/);
  });

  it("reports the field change between two stored renders, text and --json", async () => {
    const root = freshRoot();
    const { manifest: from } = persistHelmRender({
      rendered: RENDERED_A,
      releaseName: "rel",
      chart: "tiny",
      namespace: "web",
      capabilityProfile: PROFILE,
      root,
    });
    const { manifest: to } = persistHelmRender({
      rendered: RENDERED_B,
      releaseName: "rel",
      chart: "tiny",
      namespace: "web",
      capabilityProfile: PROFILE,
      root,
    });

    const origRoot = process.env.CHANT_HELM_RENDER_ROOT;
    process.env.CHANT_HELM_RENDER_ROOT = root;
    try {
      expect(
        await verb("diff").handler({ verb: "diff", rawArgs: [from.contentDigest, to.contentDigest] }),
      ).toBe(0);
      const out = logged.join("\n");
      expect(out).toContain("CHANGED  ConfigMap web/tiny-config");
      expect(out).toContain("changed data.color: \"blue\" -> \"green\"");

      logged = [];
      expect(
        await verb("diff").handler({ verb: "diff", rawArgs: [from.contentDigest, to.contentDigest, "--json"] }),
      ).toBe(0);
      const payload = JSON.parse(logged.join("\n"));
      expect(payload.changed).toHaveLength(1);
      expect(payload.changed[0].changes).toEqual([
        { path: "data.color", kind: "changed", before: "blue", after: "green" },
      ]);
      expect(payload.unindexed).toEqual({ from: 0, to: 0 });
    } finally {
      if (origRoot === undefined) delete process.env.CHANT_HELM_RENDER_ROOT;
      else process.env.CHANT_HELM_RENDER_ROOT = origRoot;
    }
  });

  it("surfaces the store's own error when a digest was never persisted", async () => {
    const root = freshRoot();
    const origRoot = process.env.CHANT_HELM_RENDER_ROOT;
    process.env.CHANT_HELM_RENDER_ROOT = root;
    try {
      await expect(
        verb("diff").handler({
          verb: "diff",
          rawArgs: [`sha256:${"0".repeat(64)}`, `sha256:${"1".repeat(64)}`],
        }),
      ).rejects.toThrow(/no stored render for sha256:0{64}/);
    } finally {
      if (origRoot === undefined) delete process.env.CHANT_HELM_RENDER_ROOT;
      else process.env.CHANT_HELM_RENDER_ROOT = origRoot;
    }
  });
});

describe("formatRenderDiff", () => {
  it("prints added, removed, and changed documents with field-level lines", () => {
    const out = formatRenderDiff({
      from: { contentDigest: `sha256:${"a".repeat(64)}`, chart: "tiny", releaseName: "rel-a" },
      to: { contentDigest: `sha256:${"b".repeat(64)}`, chart: "tiny", releaseName: "rel-b" },
      added: [{ kind: "Secret", namespace: "web", name: "new-secret", source: null, digest: `sha256:${"c".repeat(64)}` }],
      removed: [{ kind: "ConfigMap", namespace: "web", name: "old-cm", source: null, digest: `sha256:${"d".repeat(64)}` }],
      changed: [
        {
          kind: "Deployment",
          namespace: "web",
          name: "app",
          source: null,
          beforeDigest: `sha256:${"e".repeat(64)}`,
          afterDigest: `sha256:${"f".repeat(64)}`,
          changes: [{ path: "spec.replicas", kind: "changed", before: 2, after: 3 }],
        },
      ],
      unchanged: [{ kind: "ServiceAccount", namespace: "web", name: "sa", source: null }],
      unindexed: { from: 0, to: 0 },
    });
    expect(out).toContain("REMOVED  ConfigMap web/old-cm");
    expect(out).toContain("ADDED    Secret web/new-secret");
    expect(out).toContain("CHANGED  Deployment web/app (1 field change(s))");
    expect(out).toContain("changed spec.replicas: 2 -> 3");
    expect(out).toContain("1 unchanged document(s)");
  });

  it("says so plainly when there are no differences", () => {
    const out = formatRenderDiff({
      from: { contentDigest: `sha256:${"a".repeat(64)}`, chart: "tiny", releaseName: "rel" },
      to: { contentDigest: `sha256:${"a".repeat(64)}`, chart: "tiny", releaseName: "rel" },
      added: [],
      removed: [],
      changed: [],
      unchanged: [{ kind: "ServiceAccount", namespace: "web", name: "sa", source: null }],
      unindexed: { from: 0, to: 0 },
    });
    expect(out).toContain("no differences — identical documents on both sides");
  });
});

describe("formatRenderRecords", () => {
  it("prints unpinned renders honestly and flags unstable groups", () => {
    const records = [
      { name: "legacy", chart: "old-chart", version: "1.0.0" },
      {
        name: "web",
        chart: "tiny",
        version: "0.1.0",
        capabilityProfile: { name: "gke", kubeVersion: "1.33.0" },
        inputDigest: `sha256:${"a".repeat(64)}`,
        contentDigest: `sha256:${"b".repeat(64)}`,
      },
      {
        name: "web",
        chart: "tiny",
        version: "0.1.0",
        capabilityProfile: { name: "gke", kubeVersion: "1.33.0" },
        inputDigest: `sha256:${"a".repeat(64)}`,
        contentDigest: `sha256:${"c".repeat(64)}`,
      },
    ];
    const out = formatRenderRecords(records, renderStability(records));
    expect(out).toContain("(unpinned)");
    expect(out).toContain("0 stable group(s), 1 unstable, 1 unassessed");
    expect(out).toContain("UNSTABLE web: 2 distinct content digests");
  });
});
