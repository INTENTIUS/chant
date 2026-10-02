import { view } from "../lexicon/index";
import { events } from "./events";

// #3047's example writes `ORDER BY ${users.id}` here. That renders as
// `ORDER BY id`, and active_users has no `id` column, so the server refuses
// it. The sort key names the view's own column, read from events.
export const activeUsers = view`
  CREATE MATERIALIZED VIEW active_users
  ENGINE = AggregatingMergeTree ORDER BY ${events.user_id} AS
  SELECT ${events.user_id}, count() AS n
  FROM ${events}
  GROUP BY ${events.user_id}`;
