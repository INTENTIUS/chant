/**
 * The acceptance test is k3d, not a fixture (#1408).
 *
 * A fixture comparison proves the serializer matches what someone wrote down.
 * This proves the artifact is a file the native tool consumes: build a
 * declaration, serialize it, hand the output to `k3d cluster create --config`,
 * assert a cluster comes up, delete it.
 *
 * Skipped, with the reason visible in the runner, when Docker or k3d is
 * absent — CI may have neither. The test's own config pins the safe
 * kubeconfig options regardless of serializer defaults: a test that switches
 * the developer's active context is exactly the surprise this lexicon exists
 * to make explicit.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { k3dSerializer } from "./serializer";
import { Cluster, K3dOptions, KubeconfigOptions, Options } from "./generated/index";

function available(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasK3d = available("k3d version");
const hasDocker = available("docker info");
const enabled = hasK3d && hasDocker;
const skipReason = !hasK3d ? "k3d is not installed" : !hasDocker ? "Docker is not running" : "";

// Distinctive name; the deletes below run even on failure so a failed run
// does not leave a Docker network and containers behind on someone's laptop.
const CLUSTER = `chant-k3d-accept-${process.pid}`;

describe.skipIf(!enabled)(`k3d accepts the emitted config${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  afterAll(() => {
    try {
      execSync(`k3d cluster delete ${CLUSTER}`, { stdio: "ignore" });
    } catch {
      // already gone — deletion is the success case here
    }
  });

  it("creates a working cluster from serializer output, then tears it down", () => {
    const declaration = new Cluster({
      metadata: { name: CLUSTER },
      servers: 1,
      agents: 0,
      options: new Options({
        k3d: new K3dOptions({ disableLoadbalancer: true, wait: true }),
        kubeconfig: new KubeconfigOptions({
          updateDefaultKubeconfig: false,
          switchCurrentContext: false,
        }),
      }),
    });

    const result = k3dSerializer.serialize(new Map([["acceptance", declaration]]));
    const yaml = typeof result === "string" ? result : result.primary;

    const dir = mkdtempSync(join(tmpdir(), "chant-k3d-accept-"));
    const configPath = join(dir, "cluster.yaml");
    writeFileSync(configPath, yaml);

    try {
      const before = execSync("kubectl config current-context 2>/dev/null || true").toString().trim();

      execSync(`k3d cluster create --config ${configPath}`, {
        stdio: "pipe",
        timeout: 240_000,
      });

      const listed = execSync(`k3d cluster list ${CLUSTER} --no-headers`).toString();
      expect(listed).toContain(CLUSTER);

      // The safe kubeconfig options held: the active context is what it was.
      const after = execSync("kubectl config current-context 2>/dev/null || true").toString().trim();
      expect(after).toBe(before);

      execSync(`k3d cluster delete ${CLUSTER}`, { stdio: "pipe", timeout: 120_000 });
      const gone = execSync(`k3d cluster list -o json`).toString();
      expect(gone).not.toContain(`"${CLUSTER}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
