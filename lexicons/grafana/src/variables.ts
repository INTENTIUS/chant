/**
 * Dashboard variables (Grafana's "templating"): query, custom, interval,
 * datasource, constant and textbox.
 *
 * A variable is declared on its own and listed in a dashboard's
 * `variables`. Queries reference it as `$name` or `${name}` in their
 * expression; GRAF103 checks every such reference names a declared
 * variable. A `DatasourceVariable` can stand in for a datasource on a panel
 * or query, and the reference becomes `${name}`.
 */

import { createProperty } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { DatasourceEntity, DatasourceRef, ExternalDatasourceEntity } from "./datasource";
import type { VariableOption } from "./schema/dashboard.gen";

export type VariableKind = "query" | "custom" | "interval" | "datasource" | "constant" | "textbox";

/** Where the variable shows: with its label, without it, or not at all. */
export type VariableHide = "label" | "valueOnly" | "hidden";

interface CommonVariableProps {
  /** The name queries use, `$name`. Letters, digits and `_`. */
  name: string;
  label?: string;
  description?: string;
  hide?: VariableHide;
  /** Keep the value out of the URL. */
  skipUrlSync?: boolean;
  /** The value selected when the dashboard loads. */
  current?: VariableOption;
}

interface MultiValueProps {
  multi?: boolean;
  includeAll?: boolean;
  /** What `All` expands to, e.g. `.*` for a regex matcher. */
  allValue?: string;
}

/** A variable anything can hold before its datasource is known: its own datasource ref or a datasource variable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VariableDatasource = DatasourceEntity<any> | ExternalDatasourceEntity<any> | DatasourceRef | DatasourceVariableEntity<any>;

export interface QueryVariableProps extends CommonVariableProps, MultiValueProps {
  datasource: VariableDatasource;
  /** The datasource's variable query, e.g. `label_values(up, job)` for Prometheus. */
  query: string;
  regex?: string;
  /** When to re-run the query. Defaults to on dashboard load. */
  refresh?: "never" | "onLoad" | "onTimeRangeChange";
  /** Grafana's `VariableSort` (0 disabled, 1 alphabetical asc, 2 desc, 3 numerical asc, …). */
  sort?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export interface CustomVariableProps extends CommonVariableProps, MultiValueProps {
  values: string[];
}

export interface IntervalVariableProps extends CommonVariableProps {
  /** e.g. `["1m", "5m", "1h"]`. */
  values: string[];
  auto?: boolean;
  autoCount?: number;
  autoMin?: string;
}

export interface DatasourceVariableProps<T extends string = string> extends CommonVariableProps, MultiValueProps {
  /** The datasource plugin id to choose among, e.g. `prometheus`. */
  pluginType: T;
  /** Only datasources whose name matches. */
  regex?: string;
}

export interface ConstantVariableProps extends Omit<CommonVariableProps, "hide"> {
  value: string;
}

export interface TextboxVariableProps extends CommonVariableProps {
  value?: string;
}

export interface VariableEntity<P = CommonVariableProps> extends Declarable {
  readonly props: P;
  readonly variableKind: VariableKind;
  /** The variable name, `$name` in queries. */
  readonly variableName: string;
}

export interface DatasourceVariableEntity<T extends string = string> extends VariableEntity<DatasourceVariableProps<T>> {
  readonly variableKind: "datasource";
  readonly pluginType: T;
}

export const VARIABLE_TYPE_PREFIX = "Grafana::Variable::";

function variableClass<P extends CommonVariableProps | ConstantVariableProps>(kind: VariableKind, className: string) {
  const Base = createProperty(`${VARIABLE_TYPE_PREFIX}${kind}`, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;
  const Cls = function (this: object, props: P) {
    Base.call(this, props as unknown as Record<string, unknown>);
    Object.defineProperty(this, "variableKind", { value: kind, enumerable: false });
    Object.defineProperty(this, "variableName", { value: props.name, enumerable: false });
    if (kind === "datasource") {
      Object.defineProperty(this, "pluginType", { value: (props as unknown as DatasourceVariableProps).pluginType, enumerable: false });
    }
  };
  Object.defineProperty(Cls, "name", { value: className });
  return Cls;
}

/** A variable whose values come from a datasource query. */
export const QueryVariable = variableClass<QueryVariableProps>("query", "QueryVariable") as unknown as new (
  props: QueryVariableProps,
) => VariableEntity<QueryVariableProps>;

/** A variable with a fixed list of values. */
export const CustomVariable = variableClass<CustomVariableProps>("custom", "CustomVariable") as unknown as new (
  props: CustomVariableProps,
) => VariableEntity<CustomVariableProps>;

/** A time interval to choose, used as `$name` in range selectors. */
export const IntervalVariable = variableClass<IntervalVariableProps>("interval", "IntervalVariable") as unknown as new (
  props: IntervalVariableProps,
) => VariableEntity<IntervalVariableProps>;

/** A choice of datasource of one plugin type. Usable wherever a datasource is. */
export const DatasourceVariable = variableClass<DatasourceVariableProps>("datasource", "DatasourceVariable") as unknown as {
  new <T extends string>(props: DatasourceVariableProps<T>): DatasourceVariableEntity<T>;
};

/** A hidden, fixed value. */
export const ConstantVariable = variableClass<ConstantVariableProps>("constant", "ConstantVariable") as unknown as new (
  props: ConstantVariableProps,
) => VariableEntity<ConstantVariableProps>;

/** A free-text box. */
export const TextboxVariable = variableClass<TextboxVariableProps>("textbox", "TextboxVariable") as unknown as new (
  props: TextboxVariableProps,
) => VariableEntity<TextboxVariableProps>;

export function isVariableEntity(value: unknown): value is VariableEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === "grafana" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith(VARIABLE_TYPE_PREFIX)
  );
}

export function isDatasourceVariable(value: unknown): value is DatasourceVariableEntity {
  return isVariableEntity(value) && value.variableKind === "datasource";
}

/** Variable names Grafana defines itself; queries may use them without declaring anything. */
export function isBuiltinVariable(name: string): boolean {
  return name.startsWith("__") || name === "timeFilter" || name === "interval" || name === "interval_ms";
}

/** A valid variable name: what `$name` can match. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
