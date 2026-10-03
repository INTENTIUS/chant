import { index, table } from "../lexicon/index";
import { app, orderStatus } from "./app";
import { users } from "./users";

export const orders = table`
  CREATE TABLE ${app}.orders (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id   bigint NOT NULL REFERENCES ${users} (${users.columns.id}) ON DELETE CASCADE,
    status    ${orderStatus} NOT NULL DEFAULT 'placed',
    amount    numeric(12, 2) NOT NULL CHECK (amount >= 0),
    placed_at timestamptz NOT NULL DEFAULT now()
  )`;

// A same-file reference to a tag const (#3221).
export const ordersUserId = index`
  CREATE INDEX orders_user_id_idx ON ${orders} (${orders.columns.user_id}, ${orders.columns.placed_at} DESC)`;
