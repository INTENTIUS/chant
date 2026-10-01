#!/usr/bin/env tsx
/**
 * `just fetch-notifiers`: read the contact point integrations from a running
 * Grafana (`GET /api/alert-notifiers?version=2`, the options each
 * integration's settings take, which are required, which are secure, their
 * select values) and rewrite `src/contact-point-settings.gen.ts`: one settings
 * interface per integration and the option table GRAF114 and GRAF002 read.
 *
 * With no argument it starts `grafana/grafana:<GRAFANA_NOTIFIERS_SOURCE.version>`
 * under Docker, reads the endpoint and removes the container. Pass a base URL
 * (`http://localhost:3000`, admin:admin) to read one you already run. The
 * response is the same on 12.4.11 and 13.2.2; in 13.x it comes from the
 * `grafana/alerting` module's receiver schemas.
 */
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { GRAFANA_NOTIFIERS_SOURCE, renderNotifiers, type NotifierResponse } from "./notifiers";

/** curl, not fetch: the response is read from a Grafana the caller runs, and the egress catalogue lists only the commands that reach a remote host. */
function get(url: string, auth = false): string {
  return execFileSync("curl", ["-sf", ...(auth ? ["-u", "admin:admin"] : []), url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readFrom(base: string): NotifierResponse[] {
  return JSON.parse(get(`${base}/api/alert-notifiers?version=2`, true)) as NotifierResponse[];
}

async function viaDocker(): Promise<NotifierResponse[]> {
  const name = `chant-notifiers-${process.pid}`;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
  docker("run", "-d", "--name", name, "-p", "127.0.0.1::3000", `grafana/grafana:${GRAFANA_NOTIFIERS_SOURCE.version}`);
  try {
    const port = docker("port", name, "3000/tcp").split("\n")[0].split(":").pop();
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        get(`${base}/api/health`);
        return readFrom(base);
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Grafana did not become healthy in 120s");
  } finally {
    docker("rm", "-f", name);
  }
}

const notifiers = process.argv[2] ? readFrom(process.argv[2].replace(/\/$/, "")) : await viaDocker();
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "contact-point-settings.gen.ts");
writeFileSync(out, renderNotifiers(notifiers));
console.log(`wrote ${out} (${notifiers.length} integrations)`);
