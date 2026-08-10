/**
 * The kubeconfig read surface and kubectl's merge semantics — chant #1630.
 *
 * Every case writes its own kubeconfig files into a temp directory and points
 * `KUBECONFIG` at them, so nothing reads the developer's real config and
 * nothing contacts a cluster: these are file reads, and the point of the
 * surface under test is that they stay file reads.
 *
 * Where kubectl is on PATH, `kubectl config view` is asked the same questions
 * and its answers are asserted to match — the merge rules are only worth
 * having because they are kubectl's, and a hardcoded expectation cannot prove
 * that. Skipped (with the expectations still asserted on their own) where it
 * is not installed.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readAmbientContext, readKubeconfigView, createK8sClient } from "./client";
import { fakeKubeconfig, fakeRequestLayer } from "./testing";

/** A kubeconfig naming one cluster, one user and one context, with a chosen
 * current-context — the material both merge divergences are reproduced with. */
function configYaml(opts: { cluster: string; server: string; context: string; user?: string }): string {
  const user = opts.user ?? `user-${opts.context}`;
  return [
    "apiVersion: v1",
    "kind: Config",
    `current-context: ${opts.context}`,
    "clusters:",
    `  - name: ${opts.cluster}`,
    "    cluster:",
    `      server: ${opts.server}`,
    "      insecure-skip-tls-verify: true",
    "users:",
    `  - name: ${user}`,
    "    user:",
    '      token: "test-token"',
    "contexts:",
    `  - name: ${opts.context}`,
    "    context:",
    `      cluster: ${opts.cluster}`,
    `      user: ${user}`,
    "",
  ].join("\n");
}

const kubectlAvailable = spawnSync("kubectl", ["version", "--client=true"], { encoding: "utf8" }).status === 0;

/** `kubectl config view` against a KUBECONFIG list, or undefined without kubectl. */
function kubectlView(kubeconfig: string, args: string[]): string | undefined {
  if (!kubectlAvailable) return undefined;
  const r = spawnSync("kubectl", ["config", ...args], {
    encoding: "utf8",
    env: { ...process.env, KUBECONFIG: kubeconfig },
  });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

let dir: string;
let savedKubeconfig: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-kubeconfig-"));
  savedKubeconfig = process.env.KUBECONFIG;
});

afterEach(() => {
  if (savedKubeconfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = savedKubeconfig;
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("readKubeconfigView (#1630)", () => {
  test("returns each context joined to its apiserver, plus the current context", async () => {
    const view = await readKubeconfigView({
      kubeconfig: fakeKubeconfig({
        contexts: [
          { name: "ctx-a", cluster: "cluster-a", user: "user-a", namespace: "team" },
          { name: "ctx-b", cluster: "cluster-b", user: "user-b" },
        ],
        currentContext: "ctx-b",
        server: "https://cluster.test:6443",
      }),
    });

    expect(view.currentContext).toBe("ctx-b");
    expect(view.contexts).toEqual([
      { name: "ctx-a", cluster: "cluster-a", user: "user-a", namespace: "team", server: "https://cluster.test:6443" },
      { name: "ctx-b", cluster: "cluster-b", user: "user-b", server: "https://cluster.test:6443" },
    ]);
  });

  test("reads an address behind an auth plugin the client would refuse to run", async () => {
    // `createK8sClient` throws ExecCredentialNotAllowedError here, correctly —
    // it is about to run the plugin. Reading the address out of the file runs
    // nothing, so refusing would report "no target" for a cluster kubectl
    // reads without complaint.
    const view = await readKubeconfigView({
      kubeconfig: fakeKubeconfig({ exec: { command: "harvest-credentials" }, server: "https://plugin.test:6443" }),
    });
    expect(view.contexts).toHaveLength(1);
    expect(view.contexts[0].server).toBe("https://plugin.test:6443");
  });

  test("a context resolving to no cluster is reported without a server, not as a failure", async () => {
    const view = await readKubeconfigView({
      kubeconfig: [
        "apiVersion: v1",
        "kind: Config",
        "current-context: dangling",
        "clusters: []",
        "users: []",
        "contexts:",
        "  - name: dangling",
        "    context:",
        "      cluster: gone",
        "      user: nobody",
        "",
      ].join("\n"),
    });
    expect(view.currentContext).toBe("dangling");
    expect(view.contexts).toEqual([{ name: "dangling", cluster: "gone", user: "nobody" }]);
  });

  test("an unreadable or absent kubeconfig is an empty view, never a throw", async () => {
    await expect(readKubeconfigView({ kubeconfigPath: join(dir, "nope.yaml") })).resolves.toEqual({ contexts: [] });
    await expect(readKubeconfigView({ kubeconfig: "%%% not yaml : [" })).resolves.toEqual({ contexts: [] });
    // A machine that has never seen Kubernetes: KUBECONFIG points at nothing
    // that exists, and a lens over an aws-only project still renders.
    process.env.KUBECONFIG = [join(dir, "a.yaml"), join(dir, "b.yaml")].join(delimiter);
    await expect(readKubeconfigView()).resolves.toEqual({ contexts: [] });
  });
});

describe("KUBECONFIG merge semantics match kubectl (#1630)", () => {
  test("overlapping names resolve first-wins instead of failing", async () => {
    // client-node's `mergeConfig` throws `Duplicate cluster: shared` here. A
    // team-wide file plus a personal one both naming `dev` is the ordinary way
    // people get into this, and kubectl keeps the first.
    const a = write("a.yaml", configYaml({ cluster: "shared", server: "https://from-a:6443", context: "ctx-a" }));
    const b = write("b.yaml", configYaml({ cluster: "shared", server: "https://from-b:6443", context: "ctx-b" }));
    const kubeconfig = [a, b].join(delimiter);
    process.env.KUBECONFIG = kubeconfig;

    const view = await readKubeconfigView();
    expect(view.contexts.map((c) => c.name)).toEqual(["ctx-a", "ctx-b"]);
    // Both contexts name the cluster `shared`, and the first file's server is
    // the one `shared` means.
    expect(view.contexts.map((c) => c.server)).toEqual(["https://from-a:6443", "https://from-a:6443"]);

    const kubectlServer = kubectlView(kubeconfig, [
      "view",
      "-o",
      'jsonpath={.clusters[?(@.name=="shared")].cluster.server}',
    ]);
    if (kubectlServer !== undefined) expect(kubectlServer).toBe("https://from-a:6443");
    const kubectlContexts = kubectlView(kubeconfig, ["view", "-o", 'jsonpath={range .contexts[*]}{.name}{"\\n"}{end}']);
    if (kubectlContexts !== undefined) expect(kubectlContexts.split("\n")).toEqual(["ctx-a", "ctx-b"]);
  });

  test("readAmbientContext answers for a duplicate-name list instead of reporting no kubeconfig", async () => {
    // The load lives inside readAmbientContext's try/catch, so client-node's
    // throw came out as `undefined` — chant read these users as having no
    // kubeconfig at all when they have a perfectly good one.
    const a = write("a.yaml", configYaml({ cluster: "shared", server: "https://from-a:6443", context: "ctx-a" }));
    const b = write("b.yaml", configYaml({ cluster: "shared", server: "https://from-b:6443", context: "ctx-b" }));
    process.env.KUBECONFIG = [a, b].join(delimiter);

    await expect(readAmbientContext()).resolves.toBe("ctx-a");
  });

  test("current-context comes from the FIRST file that sets one, not the last", async () => {
    const a = write("a.yaml", configYaml({ cluster: "cluster-a", server: "https://from-a:6443", context: "ctx-a" }));
    const c = write("c.yaml", configYaml({ cluster: "cluster-c", server: "https://from-c:6443", context: "ctx-c" }));
    const kubeconfig = [a, c].join(delimiter);
    process.env.KUBECONFIG = kubeconfig;

    // client-node's mergeConfig overwrites currentContext from each later
    // file, so the bare loadFromDefault() answered `ctx-c` — the opposite of
    // every `kubectl get` the operator ran to check.
    await expect(readAmbientContext()).resolves.toBe("ctx-a");
    expect((await readKubeconfigView()).currentContext).toBe("ctx-a");

    const kubectlCurrent = kubectlView(kubeconfig, ["current-context"]);
    if (kubectlCurrent !== undefined) expect(kubectlCurrent).toBe("ctx-a");
  });

  test("a file the list names but cannot be read is skipped, not fatal", async () => {
    const a = write("a.yaml", configYaml({ cluster: "cluster-a", server: "https://from-a:6443", context: "ctx-a" }));
    process.env.KUBECONFIG = [join(dir, "missing.yaml"), a].join(delimiter);

    const view = await readKubeconfigView();
    expect(view.currentContext).toBe("ctx-a");
    expect(view.contexts.map((c) => c.server)).toEqual(["https://from-a:6443"]);
  });

  test("createK8sClient binds the cluster kubectl would bind", async () => {
    const a = write("a.yaml", configYaml({ cluster: "shared", server: "https://from-a:6443", context: "ctx-a" }));
    const b = write("b.yaml", configYaml({ cluster: "shared", server: "https://from-b:6443", context: "ctx-b" }));
    process.env.KUBECONFIG = [a, b].join(delimiter);

    // Constructing the client issues no request; the layer is here so nothing
    // could reach a network if it tried.
    const client = await createK8sClient({ requestLayer: fakeRequestLayer(() => ({ body: {} })) });
    expect(client.provenance.server).toBe("https://from-a:6443");
    expect(client.provenance.context).toBe("ctx-a");
    expect(client.provenance.kubeconfigSource).toBe("default");
  });

  test("an explicit kubeconfig string or path is untouched by the list", async () => {
    const a = write("a.yaml", configYaml({ cluster: "cluster-a", server: "https://from-a:6443", context: "ctx-a" }));
    const explicit = write("explicit.yaml", configYaml({ cluster: "cluster-x", server: "https://from-x:6443", context: "ctx-x" }));
    process.env.KUBECONFIG = a;

    expect((await readKubeconfigView({ kubeconfigPath: explicit })).currentContext).toBe("ctx-x");
    await expect(readAmbientContext({ kubeconfigPath: explicit })).resolves.toBe("ctx-x");
    expect(
      (await readKubeconfigView({ kubeconfig: configYaml({ cluster: "c", server: "https://s:6443", context: "ctx-lit" }) }))
        .currentContext,
    ).toBe("ctx-lit");
  });
});
