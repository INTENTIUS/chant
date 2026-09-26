/**
 * A throwaway workspace for the decide tests: a git repository with an answer
 * kind (the reference workspace's), a task kind the points read through the
 * read contract, three points (a noul, a choice and a score), and a box member
 * that declares one brokered capability and one without a broker.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The chant checkout the tests run in. */
export const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const REF = join(REPO, "reference-workspace");

export const MODEL = "jev-1.13.0";

const model = (extra: Record<string, unknown> = {}) => ({ kind: "model", backend: "systemone", model: MODEL, threshold: 0.8, ...extra });

export const POINTS = {
  points: {
    triage: {
      title: "Does this task need a person now",
      question: { type: "noul", instructions: "Does the task need a person to look at it today?", criteria: { true: "A person looks at it today.", false: "It can wait." } },
      inputs: { "record.size": "the task's size in points", "record.risky": "whether the task touches production" },
      deciders: [{ kind: "table", rows: [{ when: { "record.size": 0 }, answer: false }] }, model(), { kind: "quorum", count: 1 }],
    },
    route: {
      title: "Which team takes this task",
      question: { type: "choice", instructions: "Pick the team that takes the task.", criteria: { platform: "The platform team.", app: "The app team.", docs: "The docs team." } },
      inputs: { "record.title": "the task's title", "record.size": "the task's size in points" },
      deciders: [model({ unreachable: "fail" }), { kind: "quorum", count: 1 }],
    },
    effort: {
      title: "How much effort this task takes",
      question: { type: "score", instructions: "Rate the effort the task takes.", criteria: ["low", "medium", "high"] },
      inputs: { "record.size": "the task's size in points", "member.kind": "the kind of the member the task is in" },
      deciders: [model(), { kind: "quorum", count: 1 }],
    },
  },
};

const TASK_KIND = `export const recordKind = {
  name: "task",
  location: { dir: ".", match: "^T-[0-9]+\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:test-task:1", path: "task.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["open", "done"],
  closedStates: ["done"],
};
`;

const TASK_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:intentius:chant:test-task:1",
  type: "object",
  required: ["id", "title", "state"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    state: { enum: ["open", "done"] },
    size: { type: "integer" },
    risky: { type: "boolean" },
  },
  additionalProperties: false,
};

const task = (id: string, title: string, size: number, risky: boolean) =>
  `---\nid: "${id}"\ntitle: "${title}"\nstate: "open"\nsize: ${size}\nrisky: ${risky}\n---\n\n# ${title}\n`;

const scratch: string[] = [];

export function cleanScratch(): void {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Make the workspace and commit it. Returns its root. */
export function workspace(points: unknown = POINTS): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-systemone-")));
  scratch.push(root);
  const files: Record<string, string> = {
    "chant.workspace.json": JSON.stringify(
      {
        name: "decide-test",
        schema: 1,
        members: [
          { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
          {
            name: "box",
            dir: "box",
            kind: "other",
            because: "the box the steward runs in",
            box: { capabilities: [{ name: "inference", broker: "lobby", scope: ["agent"] }, { name: "raw" }] },
          },
        ],
        records: [{ kind: "answers/answer.kind.mjs" }, { kind: "tasks/task.kind.mjs" }],
      },
      null,
      2,
    ),
    "app/server.mjs": "export const port = 8080;\n",
    "box/README.md": "The box.\n",
    "decisions/points.json": JSON.stringify(points, null, 2),
    "tasks/task.kind.mjs": TASK_KIND,
    "tasks/task.schema.json": JSON.stringify(TASK_SCHEMA, null, 2),
    "tasks/T-1.md": task("T-1", "Rotate the deploy key", 5, true),
    "tasks/T-2.md": task("T-2", "Fix a typo in the README", 1, false),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  cpSync(join(REF, "answers", "answer.kind.mjs"), join(root, "answers", "answer.kind.mjs"));
  cpSync(join(REF, "answers", "answer.schema.json"), join(root, "answers", "answer.schema.json"));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

/** The front matter text of a written record. */
export const recordText = (root: string, path: string): string => readFileSync(join(root, path), "utf-8");
