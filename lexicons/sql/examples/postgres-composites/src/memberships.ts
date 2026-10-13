import { JoinTable } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";
import { teams, users } from "./accounts";

// The primary key (user_id, team_id) serves lookups by user; the reverse
// index on (team_id, user_id) serves lookups by team.
export const memberships = JoinTable({
  name: "memberships",
  schema: app,
  left: users.table,
  leftColumn: "user_id",
  right: teams.table,
  rightColumn: "team_id",
});
