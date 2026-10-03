import { index, table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";
import { tenants, users } from "./tenants";

export const projects = table`
  CREATE TABLE ${app}.projects (
    tenant_id  uuid NOT NULL,
    id         bigint GENERATED ALWAYS AS IDENTITY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id) REFERENCES ${tenants} (${tenants.columns.id}) ON DELETE CASCADE
  )`;

export const tasks = table`
  CREATE TABLE ${app}.tasks (
    tenant_id   uuid NOT NULL,
    id          bigint GENERATED ALWAYS AS IDENTITY,
    project_id  bigint NOT NULL,
    assignee_id bigint,
    title       text NOT NULL,
    done        boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES ${projects} (${projects.columns.tenant_id}, ${projects.columns.id}) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, assignee_id) REFERENCES ${users} (${users.columns.tenant_id}, ${users.columns.id})
  )`;

// Both foreign keys are indexed, and each index starts with the tenant.
export const tasksByProject = index`
  CREATE INDEX tasks_by_project_idx ON ${tasks} (${tasks.columns.tenant_id}, ${tasks.columns.project_id}, ${tasks.columns.created_at} DESC)`;

export const tasksByAssignee = index`
  CREATE INDEX tasks_by_assignee_idx ON ${tasks} (${tasks.columns.tenant_id}, ${tasks.columns.assignee_id}) WHERE ${tasks.columns.done} = false`;
