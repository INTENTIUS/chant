/**
 * The Alertmanager config APIs (#3371).
 *
 * | Kind | Config | Health |
 * |---|---|---|
 * | `alertmanager` | `/api/v2/status` `config.original` | the same answer: `cluster.status`, `versionInfo.version` |
 * | `mimir`, `cortex` | `/api/v1/alerts` (YAML: `alertmanager_config`, `template_files`) | `<prefix>/api/v2/status`, best effort |
 *
 * A plain Alertmanager's `config.original` is not the file it loaded. It is
 * the loaded config marshalled again (`Config.String()` in Alertmanager's
 * `config/config.go`): secrets read `<secret>`, the global defaults are
 * written out, and every receiver carries the settings it inherited from
 * `global:`. ../import/alertmanager-live.ts takes those back out. Mimir and
 * Cortex return the config as the tenant uploaded it.
 *
 * `setConfig` is for the ruler apply target (#3372): `POST /api/v1/alerts`,
 * which Mimir and Cortex serve with `-alertmanager.enable-api`. A plain
 * Alertmanager has no config write API.
 */

import { dump } from "js-yaml";
import { loadPrometheusYaml } from "../import/parser";
import type { AlertmanagerTarget } from "../config";
import { PromApiError, type PromClient } from "./client";

/** What `/api/v2/status` says about the Alertmanager itself. */
export interface AlertmanagerHealth {
  /** `ready`, `settling` or `disabled` (no clustering). */
  cluster?: string;
  peers?: number;
  version?: string;
}

/** A live Alertmanager config, as text, with where it came from. */
export interface LiveAlertmanagerConfig {
  /** The config YAML. */
  text: string;
  /** Where it was read. */
  address: string;
  /** True when it is Alertmanager's own re-marshalled form (`/api/v2/status`), with defaults written out and secrets masked. */
  remarshalled: boolean;
  /** Mimir and Cortex: the notification templates uploaded with it, by file name. */
  templateFiles?: Record<string, string>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A bound Alertmanager: the transport and the target it reaches. */
export class AlertmanagerApi {
  constructor(
    readonly client: PromClient,
    readonly target: AlertmanagerTarget,
  ) {}

  /** Where `/api/v2/status` is served. */
  get statusPath(): string {
    return this.target.kind === "alertmanager" ? "/api/v2/status" : `${this.target.alertmanagerPrefix}/api/v2/status`;
  }

  /** The status answer, read once per client; undefined on 404. */
  private status(): Promise<Record<string, unknown> | undefined> {
    return this.client.once("status", () => this.client.getJson<Record<string, unknown>>(this.statusPath));
  }

  /** The loaded config; undefined when there is none (Mimir answers 404 for a tenant with no config). */
  async readConfig(): Promise<LiveAlertmanagerConfig | undefined> {
    return this.client.once("config", async () => {
      if (this.target.kind === "alertmanager") {
        const status = await this.status();
        if (status === undefined) return undefined;
        const original = isObject(status.config) ? status.config.original : undefined;
        if (typeof original !== "string") throw new PromApiError(502, "GET", this.statusPath, "the status has no config.original");
        return { text: original, address: this.statusPath, remarshalled: true };
      }
      const path = "/api/v1/alerts";
      const text = await this.client.getText(path);
      if (text === undefined) return undefined;
      const doc = loadPrometheusYaml(text);
      if (!isObject(doc) || typeof doc.alertmanager_config !== "string") {
        throw new PromApiError(502, "GET", path, "the answer has no alertmanager_config");
      }
      const templateFiles = isObject(doc.template_files)
        ? Object.fromEntries(Object.entries(doc.template_files).map(([k, v]) => [k, String(v)]))
        : undefined;
      return {
        text: doc.alertmanager_config,
        address: path,
        remarshalled: false,
        ...(templateFiles && Object.keys(templateFiles).length > 0 ? { templateFiles } : {}),
      };
    });
  }

  /** Cluster status and version. Never throws: a failed read is no health, since health is an attribute, not presence. */
  async health(): Promise<AlertmanagerHealth | undefined> {
    let status: Record<string, unknown> | undefined;
    try {
      status = await this.status();
    } catch {
      return undefined;
    }
    if (!status) return undefined;
    const cluster = isObject(status.cluster) ? status.cluster : {};
    const version = isObject(status.versionInfo) ? status.versionInfo.version : undefined;
    return {
      ...(typeof cluster.status === "string" ? { cluster: cluster.status } : {}),
      ...(Array.isArray(cluster.peers) ? { peers: cluster.peers.length } : {}),
      ...(typeof version === "string" ? { version } : {}),
    };
  }

  /** Upload a config (Mimir and Cortex, `POST /api/v1/alerts`, 201). */
  async setConfig(config: string, templateFiles: Record<string, string> = {}): Promise<void> {
    if (this.target.kind === "alertmanager") {
      throw new Error(`a plain Alertmanager (${this.target.source}) has no config API; it reads alertmanager.yml from disk`);
    }
    const body = dump({ template_files: templateFiles, alertmanager_config: config }, { lineWidth: -1, noRefs: true });
    await this.client.send("POST", "/api/v1/alerts", { text: body, contentType: "application/yaml" });
  }
}
