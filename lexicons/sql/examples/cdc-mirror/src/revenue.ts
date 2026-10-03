import { view } from "@intentius/chant-lexicon-sql/clickhouse";
import { customers, orders } from "./mirrors";

// Revenue per country over the live rows of both mirrors.
export const revenueByCountry = view`
  CREATE VIEW revenue_by_country AS
  SELECT c.country AS country, sum(o.total) AS revenue
  FROM ${orders.current} AS o
  INNER JOIN ${customers.current} AS c ON o.customer_id = c.id
  GROUP BY country`;
