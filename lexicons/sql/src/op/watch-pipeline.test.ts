/**
 * The scheduled drift check for a sql environment, rendered to CI (#3642).
 *
 * `examples/drift-watch` declares a `WatchOp` with a `schedule` over its
 * `prod` environment, whose `sql.profiles.prod` reads the server as a reader
 * user. `generateOpsPipeline` renders it for each forge chant targets, through
 * the real github, gitlab and forgejo plugins and real Op discovery. The job
 * holds read-only credentials: the reader's user and password and nothing
 * else, and, where the forge lets a workflow say so, a token that can only
 * read the repository.
 *
 * `watch-drift.e2e.test.ts` runs the same kind of Op against a server.
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generateOpsPipeline } from "@intentius/chant/op";
import { parseYAML } from "@intentius/chant/yaml";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

const EXAMPLE = join(import.meta.dirname, "../../examples/drift-watch");

/** The reader's credentials, as each forge names a secret. */
const reader = (secret: (name: string) => string): ScheduledOpSpec => ({
  name: "schema-watch",
  variables: {
    CLICKHOUSE_READER_USER: "chant_reader",
    CLICKHOUSE_READER_PASSWORD: secret("CLICKHOUSE_READER_PASSWORD"),
  },
});
const actionsSecret = (name: string) => `\${{ secrets.${name} }}`;
const gitlabVariable = (name: string) => `$${name}`;

/**
 * Install the project, and put its `chant` on the job's PATH: `chant run`
 * runs `chant lifecycle` itself. A GitHub or Forgejo step is a shell of its
 * own, so the path goes through `$GITHUB_PATH`; GitLab's script lines share one.
 */
const INSTALL = {
  actions: ["npm ci", 'echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"'],
  gitlab: ["npm ci", 'export PATH="$PWD/node_modules/.bin:$PATH"'],
};

async function render(forge: "github" | "gitlab" | "forgejo", spec: ScheduledOpSpec) {
  const beforeScript = forge === "gitlab" ? INSTALL.gitlab : INSTALL.actions;
  const result = await generateOpsPipeline([spec], forge, { beforeScript }, EXAMPLE);
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.files).toHaveLength(1);
  expect(result.jobs).toEqual([
    { jobName: "schema-watch", op: "schema-watch", trigger: { kind: "cron", schedule: "17 * * * *" }, findingMode: "report" },
  ]);
  const file = result.files![0]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed workflow, read by path
  return { file, doc: parseYAML(file.yaml) as Record<string, any> };
}

const runLine = (steps: Array<Record<string, unknown>>) => steps.find((s) => s.run === "chant run schema-watch");

describe("generateOpsPipeline renders the sql drift watch (#3642)", () => {
  test("GitHub: the Op's own cron, a read-only token and the reader's credentials", async () => {
    const { file, doc } = await render("github", reader(actionsSecret));
    expect(file.name).toBe("schema-watch.yml");
    expect(doc.on.schedule).toEqual([{ cron: "17 * * * *" }]);
    expect(doc.permissions).toEqual({ contents: "read" });
    const job = doc.jobs["schema-watch"];
    expect(job.env).toEqual({
      CLICKHOUSE_READER_USER: "chant_reader",
      CLICKHOUSE_READER_PASSWORD: "${{ secrets.CLICKHOUSE_READER_PASSWORD }}",
    });
    expect(job.permissions).toBeUndefined();
    expect(job.steps.map((s: Record<string, unknown>) => s.run).filter(Boolean)).toEqual([...INSTALL.actions, "chant run schema-watch"]);
    expect(runLine(job.steps)?.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    expect(file.yaml).toMatchSnapshot();
  });

  test("GitLab: a schedule-only job with the reader's credentials and no token of its own", async () => {
    const { file, doc } = await render("gitlab", reader(gitlabVariable));
    expect(file.yaml).toContain('#   schema-watch: cron "17 * * * *", CHANT_SCHEDULED_OP="schema-watch", finding-mode report');
    const job = doc["schema-watch"];
    expect(job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "schema-watch"' }]);
    expect(job.variables).toEqual({
      CLICKHOUSE_READER_USER: "chant_reader",
      CLICKHOUSE_READER_PASSWORD: "$CLICKHOUSE_READER_PASSWORD",
    });
    expect(doc.variables).toBeUndefined();
    expect(job.script).toEqual([...INSTALL.gitlab, "chant run schema-watch"]);
    expect(file.yaml).toMatchSnapshot();
  });

  test("Forgejo: the Op's own cron and the reader's credentials; the runner's token takes no permissions block", async () => {
    const { file, doc } = await render("forgejo", reader(actionsSecret));
    expect(file.name).toBe("schema-watch.yml");
    expect(doc.on.schedule).toEqual([{ cron: "17 * * * *" }]);
    // Forgejo's runner reads no `permissions:`, so the generator writes none.
    expect(doc.permissions).toBeUndefined();
    const job = doc.jobs["schema-watch"];
    expect(job.env).toEqual({
      CLICKHOUSE_READER_USER: "chant_reader",
      CLICKHOUSE_READER_PASSWORD: "${{ secrets.CLICKHOUSE_READER_PASSWORD }}",
    });
    expect(job.steps.map((s: Record<string, unknown>) => s.run).filter(Boolean)).toEqual([...INSTALL.actions, "chant run schema-watch"]);
    expect(file.yaml).toMatchSnapshot();
  });

  test("the example's profile reads the server as the user and password the job holds", async () => {
    const { default: config } = await import(join(EXAMPLE, "chant.config.ts"));
    expect(config.sql.profiles.prod).toMatchObject({
      user: { env: "CLICKHOUSE_READER_USER" },
      password: { env: "CLICKHOUSE_READER_PASSWORD" },
    });
  });
});
