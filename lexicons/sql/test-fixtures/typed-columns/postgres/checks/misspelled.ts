import { index } from "@intentius/chant-lexicon-sql/postgres";
import { orders } from "../src/schema";

export const byEmail = index`CREATE INDEX orders_email_idx ON ${orders} (${orders.columns.emial})`;
