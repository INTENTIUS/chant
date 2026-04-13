/**
 * TemporalDevStack composite — a local dev server + default namespace.
 *
 * Wires together a TemporalServer (dev mode) and a TemporalNamespace so
 * that `chant build` emits a docker-compose.yml and temporal-setup.sh
 * ready for local development.
 *
 * @example
 * ```typescript
 * export const { server, ns } = TemporalDevStack({
 *   namespace: "my-app",
 *   retention: "7d",
 * });
 * ```
 */

import { TemporalServer, TemporalNamespace } from "../resources";

export interface TemporalDevStackConfig {
  /**
   * Temporal server version.
   * @default "1.26.2"
   */
  version?: string;
  /**
   * gRPC port for the Temporal frontend.
   * @default 7233
   */
  port?: number;
  /**
   * Port for the Temporal Web UI.
   * @default 8080
   */
  uiPort?: number;
  /**
   * Namespace to create on first run.
   * @default "default"
   */
  namespace?: string;
  /**
   * Workflow history retention for the namespace.
   * @default "7d"
   */
  retention?: string;
  /**
   * Human-readable description for the namespace.
   */
  description?: string;
}

export interface TemporalDevStackResources {
  server: InstanceType<typeof TemporalServer>;
  ns: InstanceType<typeof TemporalNamespace>;
}

/**
 * Create a local Temporal dev stack.
 *
 * Returns a TemporalServer (dev mode) and a TemporalNamespace wired to the
 * same default namespace. Export both from your chant project:
 *
 * ```typescript
 * export const { server, ns } = TemporalDevStack({ namespace: "my-app" });
 * ```
 */
export function TemporalDevStack(config: TemporalDevStackConfig = {}): TemporalDevStackResources {
  const server = new TemporalServer({
    mode: "dev",
    version: config.version,
    port: config.port,
    uiPort: config.uiPort,
  } as Record<string, unknown>);

  const ns = new TemporalNamespace({
    name: config.namespace ?? "default",
    retention: config.retention ?? "7d",
    ...(config.description ? { description: config.description } : {}),
  } as Record<string, unknown>);

  return { server, ns };
}
