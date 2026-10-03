import { view } from "../lexicon/index";
import { app } from "./app";
import { orders } from "./orders";
import { users } from "./users";

export const orderTotals = view`
  CREATE VIEW ${app}.order_totals AS
  SELECT u.${users.columns.id} AS user_id,
         u.${users.columns.email},
         count(o.${orders.columns.id}) AS order_count,
         coalesce(sum(o.${orders.columns.amount}), 0) AS total
  FROM ${users} u
  LEFT JOIN ${orders} o ON o.${orders.columns.user_id} = u.${users.columns.id}
  GROUP BY u.${users.columns.id}, u.${users.columns.email}`;
