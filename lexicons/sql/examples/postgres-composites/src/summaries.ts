import { RefreshedView } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";
import { memberships } from "./memberships";

// REFRESH MATERIALIZED VIEW CONCURRENTLY needs the unique index on team_id,
// which the composite declares with the view.
export const teamSizes = RefreshedView({
  name: "team_sizes",
  schema: app,
  source: memberships.table,
  select: "team_id, count(*) AS members",
  groupBy: "team_id",
});
