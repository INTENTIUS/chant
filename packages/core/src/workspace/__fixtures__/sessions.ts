/**
 * A repository with the reference workspace's decisions and design member,
 * and helpers that write sessions and review entries into it, for the
 * session and records --since tests (#2673).
 */

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionSeal } from "../record-sessions";
import { commitAll, git, REPO, scratchDir } from "./contract-repo";

export const SESSIONS_KIND = "design/sessions/session.kind.mjs";
export const DECISIONS_KIND = "decisions/decision.kind.mjs";

/** A git repository holding a copy of the reference workspace's decisions and design member. */
export function sessionsRepo(): string {
  const root = scratchDir("chant-sessions-");
  for (const d of ["decisions", "design"]) cpSync(join(REPO, "reference-workspace", d), join(root, d), { recursive: true });
  git(root, "init", "-q");
  commitAll(root, "reference");
  return root;
}

/** A session file's text, sealed when it is closed. */
export function sessionText(s: { id: string; state: "open" | "closed"; verdicts?: { record: string; principal: string; verdict: string }[]; agenda?: string[] }): string {
  const lines = [
    "---",
    "schema: 1",
    `id: "${s.id}"`,
    `title: "Session ${s.id}"`,
    `state: "${s.state}"`,
    "agenda:",
    ...(s.agenda ?? ["ref-001"]).map((r) => `  - record: "${r}"`),
    "attendance:",
    '  - principal: "lex00"',
    '    class: "person"',
    '  - principal: "alice"',
    '    class: "person"',
    '  - principal: "helper"',
    '    class: "agent"',
    'opened: "2026-09-24T18:00:00Z"',
    `closed: ${s.state === "closed" ? '"2026-09-24T19:00:00Z"' : "null"}`,
    ...(s.verdicts?.length
      ? ["verdicts:", ...s.verdicts.flatMap((v) => [`  - record: "${v.record}"`, `    principal: "${v.principal}"`, `    verdict: "${v.verdict}"`])]
      : ["verdicts: []"]),
    ...(s.state === "closed" ? ['closed_digest: "SEAL"'] : []),
    "---",
    "",
    `# Session ${s.id}`,
    "",
  ];
  const text = lines.join("\n");
  return s.state === "closed" ? text.replace('"SEAL"', `"${sessionSeal(text, "closed_digest")}"`) : text;
}

/** Rewrite ref-001 with the given review entries, each naming `session`. */
export function reviewed(root: string, reviewers: string[], session: string, state = "decided"): void {
  const file = join(root, "decisions", "ref-001-how-the-app-is-deployed.md");
  const reviews = reviewers.map((r) => `  - reviewer: "${r}"\n    verdict: "agree"\n    on: "2026-09-24"\n    session: "${session}"`).join("\n");
  writeFileSync(
    file,
    readFileSync(file, "utf-8")
      .replace(/^state: .*$/m, `state: "${state}"`)
      .replace(/^reviews: .*$/m, reviewers.length ? `reviews:\n${reviews}` : "reviews: []"),
  );
}

/**
 * Declare the fixture's two kinds in a chant.workspace.json (#2693): the
 * decisions at the root and the session kind in the design member, as the
 * reference workspace declares them, so review --session, close and
 * --since <session id> find the session kind.
 */
export function declareSessions(root: string): void {
  writeFileSync(
    join(root, "chant.workspace.json"),
    `${JSON.stringify(
      {
        name: "sessions",
        schema: 1,
        members: [{ name: "design", dir: "design", kind: "other", because: "the session fixture", records: [{ kind: "sessions/session.kind.mjs" }] }],
        records: [{ kind: DECISIONS_KIND }],
        pins: [],
      },
      null,
      2,
    )}\n`,
  );
}

/** The fields of a new open session, as a UI sends them to records new. */
export function newSessionFields(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    title: "Second walk",
    state: "open",
    agenda: [{ record: "ref-001" }, { record: "ref-002" }],
    attendance: [
      { principal: "lex00", class: "person" },
      { principal: "alice", class: "person" },
    ],
    opened: "2026-09-25T09:00:00Z",
    closed: null,
    verdicts: [],
    ...over,
  });
}
