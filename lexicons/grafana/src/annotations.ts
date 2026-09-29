/**
 * Dashboard annotations: the queries in a dashboard's `annotations.list`
 * whose events Grafana draws on time series panels (deploy markers,
 * incidents, alert state changes).
 *
 * An annotation is plain data on `Dashboard.annotations`, typed from
 * Grafana's `AnnotationQuery`, except that its `datasource` takes the same
 * values a panel's does (a `Datasource`, an `ExternalDatasource`, a
 * `DatasourceVariable` or a `{ type, uid }` ref) and its `target` may be a
 * query entity (`new PromQuery({ expr })`). What a datasource plugin keeps
 * beside the common keys (Prometheus's legacy `expr`, `step`,
 * `titleFormat`) is written as given.
 *
 * Grafana adds its built-in "Annotations & Alerts" query (`builtIn: 1`, the
 * `-- Grafana --` datasource) to any dashboard without one, so a dashboard
 * leaves it out unless it changes it (hides the toggle, turns it off).
 */

import type { AnnotationEventFieldMapping, AnnotationPanelFilter, AnnotationQuery, AnnotationQueryPlacement, DataSourceRef } from "./schema/dashboard.gen";
import { isQueryEntity, type DatasourceInput, type QueryEntity } from "./query";
import { compact } from "./util";

/** One annotation query on a dashboard. */
export interface AnnotationInput {
  /** The name shown on its toggle, unique on the dashboard. */
  name: string;
  /** Where its events come from. Leave it out for Grafana's default datasource. */
  datasource?: DatasourceInput;
  /** Whether it runs when the dashboard loads. Defaults to true. */
  enable?: boolean;
  /** Hide its toggle in the dashboard's controls. */
  hide?: boolean;
  /** The colour of its markers. Defaults to `red`, as Grafana's editor does. */
  iconColor?: string;
  /** Only draw its events on these panels, or on every panel but these. */
  filter?: AnnotationPanelFilter;
  /** The query, in the datasource plugin's own shape, or a query entity of that plugin. */
  target?: Record<string, unknown> | QueryEntity;
  /** For the `-- Grafana --` datasource: `dashboard` or `tags`. */
  type?: string;
  /** 1 for Grafana's own "Annotations & Alerts" query. */
  builtIn?: number;
  placement?: AnnotationQueryPlacement;
  /** Prometheus's legacy query fields, kept beside `target` by dashboards saved before Grafana 10. */
  expr?: string;
  textFormat?: string;
  titleFormat?: string;
  tagKeys?: string;
  step?: string;
  useValueForTime?: boolean;
  /** How the fields of the query's result become an event's time, text and tags. */
  mappings?: Record<string, AnnotationEventFieldMapping>;
  /** Anything else a datasource plugin reads from its annotation query. */
  [key: string]: unknown;
}

/** The refId Grafana gives an annotation query's target. */
export const ANNOTATION_REF_ID = "Anno";

/**
 * One annotation as the entry Grafana stores in `annotations.list`.
 * `datasourceRef` resolves the datasource the same way a panel's is (it is
 * build.ts's, passed in so this module needs nothing from the build).
 */
export function annotationJson(input: AnnotationInput, datasourceRef: (d: DatasourceInput | undefined) => DataSourceRef | undefined): AnnotationQuery {
  const { name, datasource, enable, iconColor, target, ...rest } = input;
  let ds = datasourceRef(datasource);
  let targetJson: Record<string, unknown> | undefined;
  if (isQueryEntity(target)) {
    const { datasource: queryDs, ...model } = target.props as Record<string, unknown> & { datasource?: DatasourceInput };
    ds ??= datasourceRef(queryDs);
    targetJson = compact({ refId: ANNOTATION_REF_ID, ...(target.queryDefinition.defaults ?? {}), ...model });
  } else {
    targetJson = target;
  }
  return compact({
    ...(ds ? { datasource: ds } : {}),
    enable: enable ?? true,
    iconColor: iconColor ?? "red",
    name,
    ...rest,
    ...(targetJson !== undefined ? { target: targetJson } : {}),
  }) as AnnotationQuery;
}
