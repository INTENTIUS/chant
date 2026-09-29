/**
 * `Datasource`: a Grafana datasource, declared once.
 *
 * A declared datasource is written to the datasource provisioning file, and
 * panels, queries and variables hold the entity itself rather than a uid
 * string. The class is generic in the plugin type, so a `PromQuery` cannot
 * be pointed at a Tempo datasource without a type error.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import { slugUid } from "./util";
import type { DatasourceJsonData, DatasourceSecureJsonData, TypedDatasourceType } from "./datasource-settings";

/**
 * Datasource plugin types this lexicon types queries and settings for
 * (`postgres` is the PostgreSQL plugin's old id). Any other plugin id is
 * accepted as a string.
 */
export type KnownDatasourceType = TypedDatasourceType;

/** How Grafana reaches the datasource: through its backend (`proxy`) or from the browser (`direct`). */
export type DatasourceAccess = "proxy" | "direct";

export interface DatasourceProps<T extends string = string> {
  /** Display name, unique within the Grafana organisation. */
  name: string;
  /** The datasource plugin id, e.g. `prometheus`, `tempo`, `loki`, `grafana-postgresql-datasource`. */
  type: T;
  /** Stable id panels refer to. Defaults to the name as a uid (`Prometheus` becomes `prometheus`). */
  uid?: string;
  url?: string;
  access?: DatasourceAccess;
  isDefault?: boolean;
  basicAuth?: boolean;
  basicAuthUser?: string;
  user?: string;
  database?: string;
  withCredentials?: boolean;
  /**
   * Plugin settings, typed for the plugins in `DatasourceJsonDataTypes`
   * (`./datasource-settings.ts`) and any object for others. A declared
   * `Datasource` anywhere in here is written as its uid, so
   * `tracesToLogsV2: { datasourceUid: loki }` links Tempo to a declared Loki;
   * a typed field that names a datasource accepts only the plugin types
   * Grafana offers there.
   */
  jsonData?: DatasourceJsonData<T>;
  /**
   * Secrets, by the keys the plugin reads. Write them as Grafana provisioning
   * expands them (`$__env{NAME}`, `$__file{/path}`, `${NAME}`), not as
   * literals: GRAF002 flags a literal.
   */
  secureJsonData?: DatasourceSecureJsonData<T>;
  /** Whether users may edit the provisioned datasource in the UI. Defaults to false. */
  editable?: boolean;
  orgId?: number;
  version?: number;
}

export interface DatasourceEntity<T extends string = string> extends Declarable {
  readonly props: DatasourceProps<T>;
  /** The plugin id. */
  readonly datasourceType: T;
  /** The uid panels will reference. */
  readonly uid: string;
}

export const DATASOURCE_TYPE = "Grafana::Datasource";

const Base = createResource(DATASOURCE_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

export interface DatasourceConstructor {
  new <T extends string>(props: DatasourceProps<T>): DatasourceEntity<T>;
}

/** A Grafana datasource, provisioned from `provisioning/datasources/chant.yaml`. */
export const Datasource = function (this: object, props: DatasourceProps) {
  Base.call(this, props as unknown as Record<string, unknown>);
  Object.defineProperty(this, "datasourceType", { value: props.type, enumerable: false });
  Object.defineProperty(this, "uid", { value: props.uid ?? slugUid(props.name), enumerable: false });
} as unknown as DatasourceConstructor;
Object.defineProperty(Datasource, "name", { value: "Datasource" });

export function isDatasourceEntity(value: unknown): value is DatasourceEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === DATASOURCE_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}

export const EXTERNAL_DATASOURCE_TYPE = "Grafana::ExternalDatasource";

export interface ExternalDatasourceProps<T extends string = string> {
  /** The datasource plugin id, e.g. `prometheus`. */
  type: T;
  /** The uid the datasource already has in Grafana. */
  uid: string;
  /** Its display name in Grafana, for messages and for a `DatasourceVariable` `regex`. */
  name?: string;
}

export interface ExternalDatasourceEntity<T extends string = string> extends Declarable {
  readonly props: ExternalDatasourceProps<T>;
  /** The plugin id. */
  readonly datasourceType: T;
  /** The uid panels will reference. */
  readonly uid: string;
}

const ExternalBase = createResource(EXTERNAL_DATASOURCE_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

export interface ExternalDatasourceConstructor {
  new <T extends string>(props: ExternalDatasourceProps<T>): ExternalDatasourceEntity<T>;
}

/**
 * A datasource that already exists in Grafana: provisioned by hand, by
 * another build root, or by another tool. It is never written to the
 * provisioning file. Panels, queries and variables use it like a
 * `Datasource`, and GRAF101/GRAF102 check references against it.
 */
export const ExternalDatasource = function (this: object, props: ExternalDatasourceProps) {
  ExternalBase.call(this, props as unknown as Record<string, unknown>);
  Object.defineProperty(this, "datasourceType", { value: props.type, enumerable: false });
  Object.defineProperty(this, "uid", { value: props.uid, enumerable: false });
} as unknown as ExternalDatasourceConstructor;
Object.defineProperty(ExternalDatasource, "name", { value: "ExternalDatasource" });

export function isExternalDatasource(value: unknown): value is ExternalDatasourceEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === EXTERNAL_DATASOURCE_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}

/** A declared or an external datasource: anything a panel can hold that has a fixed uid. */
export function isDatasourceDeclaration(value: unknown): value is DatasourceEntity | ExternalDatasourceEntity {
  return isDatasourceEntity(value) || isExternalDatasource(value);
}

/** A datasource declared somewhere this build can't see, named by its Grafana ref. */
export interface DatasourceRef<T extends string = string> {
  type: T;
  uid: string;
}

/** Grafana's own pseudo-datasources, which need no declaration. */
export const BUILTIN_DATASOURCE_UIDS: ReadonlySet<string> = new Set(["grafana", "-- Grafana --", "-- Mixed --", "-- Dashboard --"]);
