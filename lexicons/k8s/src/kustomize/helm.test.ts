/**
 * Helm inflation for kustomize renders (#5112). What must hold: --enable-helm
 * is passed only when the entry asks for it; a kustomization with helmCharts
 * and no such ask fails naming the charts and the option; a chart that is not
 * in the chart home fails naming the chart, without a pull, unless fetchCharts
 * allows the network; and a workspace member that cannot render keeps the
 * chart and values nodes it read as data.
 *
 * The fixtures hold a local chart in their chart home, so nothing here
 * reaches the network. The real-binary test runs when kubectl and helm are
 * installed.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHelmOptions, renderCommand, renderKustomizeDocuments, KustomizeHelmDisabledError, KustomizeHelmRenderError, type KustomizeRunner } from "./render";
import { renderKustomizeRoots } from "./root";
import { memberHelmOptions, readK8sMember } from "../workspace-member";
import { createKustomizeApplyCapability } from "../components/kustomize-apply";

const here = dirname(fileURLToPath(import.meta.url));
const withChart = join(here, "..", "testdata", "helm-chart-root");
const noChart = join(here, "..", "testdata", "helm-chart-missing");
const plain = join(here, "..", "testdata", "kustomize-root", "overlays", "prod");

const CONFIGMAP = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web-config\ndata:\n  message: hello from values\n";

/** Records each command and answers with the rendered ConfigMap. */
function recording(): { commands: string[]; run: KustomizeRunner } {
  const commands: string[] = [];
  return { commands, run: async (command) => (commands.push(command), { stdout: CONFIGMAP }) };
}

describe("renderCommand", () => {
  test("passes no helm flag by default", () => {
    expect(renderCommand("/x")).toBe("kustomize build '/x'");
    expect(renderCommand("/x", "kubectl")).toBe("kubectl kustomize '/x'");
  });
  test("enableHelm adds --enable-helm to either binary, and helmCommand adds --helm-command", () => {
    expect(renderCommand("/x", "kustomize", { enableHelm: true })).toBe("kustomize build --enable-helm '/x'");
    expect(renderCommand("/x", "kubectl", { enableHelm: true, helmCommand: "/opt/bin/helm" })).toBe(
      "kubectl kustomize --enable-helm --helm-command '/opt/bin/helm' '/x'",
    );
  });
  test("helmCommand and fetchCharts alone add nothing without enableHelm", () => {
    expect(renderCommand("/x", "kustomize", { helmCommand: "helm", fetchCharts: true })).toBe("kustomize build '/x'");
  });
});

describe("checkHelmOptions", () => {
  test("a kustomization with no helmCharts needs nothing", () => {
    expect(() => checkHelmOptions(plain)).not.toThrow();
  });
  test("helmCharts without enableHelm is refused naming the chart and the option, before any run", async () => {
    const { commands, run } = recording();
    await expect(renderKustomizeDocuments(withChart, run)).rejects.toThrow(KustomizeHelmDisabledError);
    await expect(renderKustomizeDocuments(withChart, run)).rejects.toThrow(/"webchart" 0\.1\.0.*enableHelm: true/s);
    expect(commands).toEqual([]);
  });
  test("a chart in the chart home renders with no network setting", async () => {
    const { commands, run } = recording();
    const docs = await renderKustomizeDocuments(withChart, run, { enableHelm: true });
    expect(docs).toHaveLength(1);
    expect(commands).toEqual([`kustomize build --enable-helm '${withChart}'`]);
  });
  test("a chart that is not in the chart home fails naming it, and starts no pull", async () => {
    const { commands, run } = recording();
    const err = await renderKustomizeDocuments(noChart, run, { enableHelm: true }).catch((e) => e);
    expect(err).toBeInstanceOf(KustomizeHelmRenderError);
    expect(err.message).toMatch(/"absent" 9\.9\.9/);
    expect(err.message).toMatch(/no network is used/);
    expect(err.message).toMatch(/fetchCharts: true/);
    expect(commands).toEqual([]);
  });
  test("fetchCharts lets the render run, which is the one setting that reaches the network", async () => {
    const { commands, run } = recording();
    await renderKustomizeDocuments(noChart, run, { enableHelm: true, fetchCharts: true });
    expect(commands).toHaveLength(1);
  });
  test("kustomize's own refusal from a base the pre-check cannot see still names the option", async () => {
    const run: KustomizeRunner = async () => {
      throw new Error("error: trouble configuring builtin HelmChartInflationGenerator with config: x: must specify --enable-helm");
    };
    await expect(renderKustomizeDocuments(plain, run)).rejects.toThrow(/enableHelm: true/);
  });
  test("a missing helm binary reported by kustomize is a helm failure, not a missing kustomize", async () => {
    const run: KustomizeRunner = async () => {
      throw new Error('Error: unable to run: \'helm pull\' (is \'helm\' installed?): exec: "helm": executable file not found in $PATH');
    };
    await expect(renderKustomizeDocuments(withChart, run, { enableHelm: true })).rejects.toThrow(KustomizeHelmRenderError);
  });
});

describe("kustomize.roots entries", () => {
  test("an entry with enableHelm renders; one without is refused naming the entry's charts", async () => {
    const { commands, run } = recording();
    const ok = await renderKustomizeRoots({ projectRoot: dirname(withChart), roots: [{ path: "helm-chart-root", enableHelm: true, helmCommand: "helm" }], run });
    expect([...ok.entities.keys()]).toEqual(["helm-chart-root/configMapWebConfig"]);
    expect(commands[0]).toBe(`kustomize build --enable-helm --helm-command 'helm' '${withChart}'`);
    await expect(renderKustomizeRoots({ projectRoot: dirname(withChart), roots: ["helm-chart-root"], run })).rejects.toThrow(/"webchart".*enableHelm: true/s);
  });
});

describe("the deploy-time render", () => {
  test("kustomize-apply passes the same options", async () => {
    const { commands, run } = recording();
    const cap = createKustomizeApplyCapability(run, async () => ({ applied: [], pruned: [] }) as never);
    await cap.run({ env: "dev" } as never, { dir: withChart, enableHelm: true });
    expect(commands[0]).toContain("--enable-helm");
  });
});

describe("a workspace member with helmCharts", () => {
  const member = { kind: "kustomize" as const, dir: withChart, label: "web", workspace: dirname(withChart) };

  test("the environment allows inflation when the config says nothing", () => {
    expect(memberHelmOptions(member, {})).toEqual({ enableHelm: false, helmCommand: undefined, fetchCharts: false });
    expect(memberHelmOptions(member, { CHANT_K8S_ENABLE_HELM: "1", CHANT_K8S_HELM_COMMAND: "/b/helm", CHANT_K8S_FETCH_CHARTS: "true" })).toEqual({
      enableHelm: true,
      helmCommand: "/b/helm",
      fetchCharts: true,
    });
    expect(memberHelmOptions({ ...member, enableHelm: false }, { CHANT_K8S_ENABLE_HELM: "1" }).enableHelm).toBe(false);
  });

  test("with inflation off the member is not rendered but keeps its kustomization node and says why", async () => {
    const { commands, run } = recording();
    const read = await readK8sMember({ member, run });
    expect(commands).toEqual([]);
    expect(read.report.rendered).toBe(false);
    expect(read.report.reason).toMatch(/enableHelm: true/);
    expect(read.warnings.join("\n")).toMatch(/was not rendered/);
    const kinds = [...read.entities.values()].map((e) => (e as unknown as { kind?: string; props?: { kind?: string } }).props?.kind ?? (e as { kind?: string }).kind);
    expect(kinds).toContain("Kustomization");
    expect(kinds).not.toContain("ConfigMap");
  });

  test("with inflation on the objects the chart renders join the nodes read as data", async () => {
    const { commands, run } = recording();
    const read = await readK8sMember({ member: { ...member, enableHelm: true }, run });
    expect(commands[0]).toContain("--enable-helm");
    expect(read.report.rendered).toBe(true);
    const kinds = [...read.entities.values()].map((e) => (e as unknown as { kind?: string; props?: { kind?: string } }).props?.kind ?? (e as { kind?: string }).kind);
    expect(kinds).toContain("Kustomization");
    expect(kinds).toContain("ConfigMap");
  });

  test("with inflation on and the chart missing the member is not rendered, not lost", async () => {
    const { run } = recording();
    const read = await readK8sMember({ member: { ...member, dir: noChart, label: "absent", enableHelm: true }, run });
    expect(read.report.rendered).toBe(false);
    expect(read.report.reason).toMatch(/"absent" 9\.9\.9/);
    expect(read.entities.size).toBeGreaterThan(0);
  });

  test("a render failure with no helm in it still fails the member", async () => {
    const run: KustomizeRunner = async () => {
      throw new Error("error: accumulating resources: missing base");
    };
    await expect(readK8sMember({ member: { ...member, dir: plain, label: "p" }, run })).rejects.toThrow(/missing base/);
  });
});

function installed(bin: string, arg: string): boolean {
  try {
    execFileSync(bin, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(installed("kubectl", "version") && installed("helm", "version")))("with the real binaries", () => {
  test("a local chart renders with enableHelm, with no network", async () => {
    const docs = await renderKustomizeDocuments(withChart, undefined, { enableHelm: true });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: "ConfigMap", metadata: { name: "web-config" }, data: { message: "hello from values" } });
  });
  test("a chart that is not cached fails naming it, and writes nothing into the root", async () => {
    await expect(renderKustomizeDocuments(noChart, undefined, { enableHelm: true })).rejects.toThrow(/"absent" 9\.9\.9/);
  });
});
