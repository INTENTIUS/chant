import { index } from "@intentius/chant-lexicon-sql/postgres";
import { users } from "../src/accounts";

export const byEmail = index`CREATE INDEX users_email_idx ON ${users.table} (${users.table.columns.emial})`;
