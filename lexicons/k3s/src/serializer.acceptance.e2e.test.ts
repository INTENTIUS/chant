/**
 * The acceptance test is k3s, not a fixture (#1600).
 *
 * A fixture comparison proves the serializer matches what someone wrote
 * down. This proves the artifact is a file the native tool consumes: build
 * a declaration, serialize it, mount the output into the pinned rancher/k3s
 * image, and assert `k3s server --config` comes up far enough to accept it
 * — the apiserver answering on the containerized cluster is the pass.
 *
 * A config k3s rejects must fail: the negative case feeds a config with an
 * unknown key and asserts the process exits with the flag-parse error
 * rather than starting.
 *
 * Skipped, with the reason visible in the runner, when Docker is absent —
 * CI may not have it. On-demand, like the gitlab/forgejo runtime E2Es.
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { k3sSerializer } from "./serializer";
import { Server } from "./generated/index";
import { K3S_IMAGE_TAG } from "./spec/fetch";

function available(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = available("docker info");
const skipReason = hasDocker ? "" : "Docker is not running";

const IMAGE = `rancher/k3s:${K3S_IMAGE_TAG}`;
const CONTAINER = `chant-k3s-accept-${process.pid}`;

function emit(entities: Map<string, unknown>): string {
  const result = k3sSerializer.serialize(entities as never);
  return typeof result === "string" ? result : result.primary;
}

describe.skipIf(!hasDocker)(
  `k3s accepts the emitted config${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    afterAll(() => {
      try {
        execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
      } catch {
        // already gone
      }
    });

    it(
      "boots a server from serializer output until the apiserver answers",
      { timeout: 180_000 },
      () => {
        const yaml = emit(
          new Map([
            [
              "acceptance",
              new Server({
                "write-kubeconfig-mode": "0644",
                disable: ["traefik", "metrics-server"],
                "node-label": ["chant-acceptance=true"],
              }),
            ],
          ]),
        );

        const dir = mkdtempSync(join(tmpdir(), "chant-k3s-accept-"));
        const configPath = join(dir, "config.yaml");
        writeFileSync(configPath, yaml);

        try {
          execSync(
            `docker run -d --privileged --name ${CONTAINER} ` +
              `-v ${configPath}:/etc/rancher/k3s/config.yaml ` +
              `${IMAGE} server`,
            { stdio: "ignore" },
          );

          // Ready when the node registers with the label the config declared.
          const deadline = Date.now() + 150_000;
          let ready = false;
          let lastOut = "";
          while (Date.now() < deadline) {
            const probe = spawnSync(
              "docker",
              ["exec", CONTAINER, "kubectl", "get", "nodes", "-l", "chant-acceptance=true", "--no-headers"],
              { encoding: "utf-8" },
            );
            lastOut = probe.stdout ?? "";
            if (probe.status === 0 && /\sReady\s/.test(lastOut)) {
              ready = true;
              break;
            }
            execSync("sleep 3");
          }
          expect(ready, `node never became Ready; last output: ${lastOut}`).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it("fails fast on a config k3s rejects", { timeout: 60_000 }, () => {
      const dir = mkdtempSync(join(tmpdir(), "chant-k3s-reject-"));
      const configPath = join(dir, "config.yaml");
      writeFileSync(configPath, "not-a-real-k3s-flag: true\n");

      try {
        const run = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--privileged",
            "-v",
            `${configPath}:/etc/rancher/k3s/config.yaml`,
            IMAGE,
            "server",
          ],
          { encoding: "utf-8", timeout: 45_000 },
        );
        expect(run.status).not.toBe(0);
        expect(`${run.stdout}\n${run.stderr}`).toMatch(/not-a-real-k3s-flag|flag provided|unknown flag|invalid/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
