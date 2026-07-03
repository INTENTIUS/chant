/**
 * Preset: `SingleHostComposeComponent` (#566, epic #551 §"6. Presets (Level 2
 * reuse)").
 *
 * The named-composition builder for the registry-less single-host Docker
 * Compose shape (`../__fixtures__/single-host-compose.json`): `docker-build`
 * -> `load-image-on-host` (registry-free promotion, see
 * ../verbs/publish.ts's `load-image-on-host` docstring) -> `copy-to-host` the
 * compose file -> `remote-exec` a `docker compose up -d` -> `wait-endpoint`
 * against the service's health path. This is the N=1 case of the fan-out
 * shape `neo4j-fanout.pilot.ts` composes by hand at N=3 — single-host compose
 * and a host fleet are the same composition shape at different N (see
 * docs/components/composition-and-wiring.mdx#fan-out-is-composition-not-orchestrator-knowledge).
 */

import type { Component } from "../component";
import { phase } from "../component";

export interface SingleHostComposeComponentConfig {
  /** Component name (kebab-case). */
  name: string;
  /** Docker build context. Default: ".". */
  context?: string;
  /** Path to the compose file inside the archive. Default: "archive:compose.yaml". */
  composeFile?: string;
  /** Destination path for the compose file on the host. Default: `/opt/<name>/compose.yaml`. */
  hostComposePath?: string;
  /** Target host (SSM instance id, hostname, or host group). Default: `"$env.host"`. */
  host?: string;
  /** Health check path polled after `docker compose up -d`. */
  healthPath: string;
  /** Port the health check listens on. */
  healthPort: number;
  /** Other components that must complete first. */
  dependsOn?: string[];
}

/**
 * Expand a single-host Docker Compose deploy to its standard
 * Publish/Apply/Verify composition. No registry ever in the path: the built
 * image tarball is copied straight onto the host and `docker load`ed there
 * (`load-image-on-host`), the compose file follows the same way, and
 * `docker compose up -d` runs via `remote-exec` — the registry-less backend
 * axis documented in docs/components/build-archive.mdx.
 */
export function SingleHostComposeComponent(config: SingleHostComposeComponentConfig): Component {
  const host = config.host ?? "$env.host";
  const hostComposePath = config.hostComposePath ?? `/opt/${config.name}/compose.yaml`;

  return {
    name: config.name,
    archetype: "service",
    dependsOn: config.dependsOn ?? [],
    build: { kind: "docker-build", context: config.context ?? ".", into: "archive" },
    deploy: [
      phase("Publish", [{ kind: "load-image-on-host", from: "archive", host }]),
      phase("Apply", [
        { kind: "copy-to-host", from: config.composeFile ?? "archive:compose.yaml", to: hostComposePath, host },
        { kind: "remote-exec", host, command: `docker compose -f ${hostComposePath} up -d` },
      ]),
      phase("Verify", [{ kind: "wait-endpoint", host, path: config.healthPath, port: config.healthPort }]),
    ],
  };
}
