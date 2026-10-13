import { view } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";
import { projects, tasks } from "./work";

// security_invoker makes the view read its tables as the caller, so row-level
// security on them (a policy on tenant_id) applies to whoever queries it.
export const openTasks = view`
  CREATE VIEW ${app}.open_tasks WITH (security_invoker = true) AS
  SELECT t.${tasks.columns.tenant_id},
         p.${projects.columns.name} AS project,
         count(t.${tasks.columns.id}) AS open
  FROM ${tasks} t
  JOIN ${projects} p ON p.${projects.columns.tenant_id} = t.${tasks.columns.tenant_id} AND p.${projects.columns.id} = t.${tasks.columns.project_id}
  WHERE t.${tasks.columns.done} = false
  GROUP BY t.${tasks.columns.tenant_id}, p.${projects.columns.name}`;
