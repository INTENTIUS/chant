import { PostgresMigrationOp } from "@intentius/chant-lexicon-sql/postgres";

// Adds `login` beside `username`, keeps the two in step with a trigger,
// backfills in batches, verifies the copy, and waits at a gate before the
// switch. The old column is kept 7 days and dropped at a second gate.
// `chant run rename-users-username-to-login` goes as far as the next gate each time.
export const { op } = PostgresMigrationOp({
  name: "rename-users-username-to-login",
  env: "prod",
  table: "app.users",
  column: "login",
  retain: "7d",
});
