import { view } from "@intentius/chant-lexicon-sql/clickhouse";
import { events, shopDb } from "./schema";

// country is Nullable(String): a sort key that can be NULL.
export const eventsByCountry = view<"shop.events_by_country">`
  CREATE MATERIALIZED VIEW ${shopDb}.events_by_country
  ENGINE = SummingMergeTree ORDER BY ${events.columns.country} AS
  SELECT ${events.columns.country}, count() AS n FROM ${events} GROUP BY ${events.columns.country}`;
