/**
 * One drift issue per environment (#4790), over each forge's real client and
 * a fake forge that keeps its issues in memory.
 */

import { describe, expect, test } from "vitest";
import { driftIssueBody, driftIssueFingerprint, driftIssueMarker, keepDriftIssue, type DriftIssueInput, type DriftIssueRecord, type DriftIssueWords } from "./drift-issue";
import { forgejoForge, githubForge, gitlabForge, type ForgeFetch, type PrForge } from "./pr-forge";

interface FakeIssue {
  n: number;
  title: string;
  body: string;
  open: boolean;
  comments: string[];
}

/** A forge with issues in memory, answering the GitHub and Forgejo shape, or GitLab's. */
function fakeForge(kind: "github" | "forgejo" | "gitlab"): { forge: PrForge; issues: FakeIssue[]; writes: string[] } {
  const issues: FakeIssue[] = [];
  const writes: string[] = [];
  const gl = kind === "gitlab";
  const base = gl ? "/api/v4/projects/group%2Fapp/issues" : kind === "forgejo" ? "/api/v1/repos/acme/infra/issues" : "/repos/acme/infra/issues";
  const shape = (i: FakeIssue) => (gl ? { iid: i.n, title: i.title, description: i.body, web_url: `https://forge/i/${i.n}` } : { number: i.n, title: i.title, body: i.body, html_url: `https://forge/i/${i.n}` });
  const fetch: ForgeFetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
    if (init.method !== "GET") writes.push(`${init.method} ${u.pathname.slice(base.length) || "/"}`);
    if (u.pathname === base && init.method === "GET") return ok(u.searchParams.get("page") && u.searchParams.get("page") !== "1" ? [] : issues.filter((i) => i.open).map(shape));
    if (u.pathname === base && init.method === "POST") {
      const i = { n: issues.length + 1, title: body.title!, body: (gl ? body.description : body.body)!, open: true, comments: [] };
      issues.push(i);
      return ok(shape(i));
    }
    const m = /^\/(\d+)(\/comments|\/notes)?$/.exec(u.pathname.slice(base.length));
    const i = m ? issues.find((x) => x.n === Number(m[1])) : undefined;
    if (!m || !i) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    if (m[2]) {
      i.comments.push(body.body!);
      return ok({ id: 1 });
    }
    if (body.state === "closed" || body.state_event === "close") i.open = false;
    if (body.title !== undefined) i.title = body.title;
    const text = gl ? body.description : body.body;
    if (text !== undefined) i.body = text;
    return ok(shape(i));
  };
  const forge =
    kind === "github"
      ? githubForge({ apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch })
      : kind === "forgejo"
        ? forgejoForge({ apiBase: "https://codeberg.org/api/v1", repo: "acme/infra", token: "t", host: "codeberg.org", fetch })
        : gitlabForge({ apiBase: "https://gitlab.example.com/api/v4", project: "group/app", token: "t", fetch });
  return { forge, issues, writes };
}

const words: DriftIssueWords = {
  product: "plywood",
  title: (f) => `plywood: ${f.environment} has drifted`,
  address: "URN",
  advice: (f) => `To put the cloud back to the program, merge a change to ${f.environment} or run \`plywood up\`.`,
  cleared: (f) => `plywood's drift check at ${f.observedAt} found ${f.environment} matching its state, so this issue is closed.`,
};

const record = (address: string, status: DriftIssueRecord["status"], extra: Partial<DriftIssueRecord> = {}): DriftIssueRecord => ({
  member: "infra/prod",
  address,
  status,
  observedAt: "2026-11-09T06:00:00Z",
  ...extra,
});

const bucket = record("urn:pulumi:prod::infra::aws:s3/bucket:Bucket::logs", "drifted", { attributes: [{ path: "tags.owner", before: "ops", after: "dev" }] });
const queue = record("urn:pulumi:prod::infra::aws:sqs/queue:Queue::jobs", "missing");
const role = record("urn:pulumi:prod::infra::aws:iam/role:Role::ci", "in-sync");

describe("keepDriftIssue (#4790)", () => {
  for (const kind of ["github", "forgejo", "gitlab"] as const) {
    test(`${kind}: opens, leaves an unchanged drift alone, updates a new one, closes when it clears`, async () => {
      const { forge, issues, writes } = fakeForge(kind);
      const input: DriftIssueInput = { words, environment: "infra/prod", records: [bucket, role, queue], runUrl: "https://ci/run/1" };

      const opened = await keepDriftIssue(forge, input);
      expect(opened).toMatchObject({ action: "opened", number: 1, marker: "<!-- plywood:drift infra/prod -->", fingerprint: driftIssueFingerprint([bucket, queue]) });
      expect(issues[0]!.title).toBe("plywood: infra/prod has drifted");
      expect(issues[0]!.body.split("\n")[0]).toBe("<!-- plywood:drift infra/prod -->");

      // The next run names another run and finds the same drift: no write.
      const before = writes.length;
      expect((await keepDriftIssue(forge, { ...input, runUrl: "https://ci/run/2", records: [queue, role, bucket] })).action).toBe("unchanged");
      expect(writes.length).toBe(before);

      // The drift moved: the one issue is edited, not a second one opened.
      const moved = record(bucket.address, "drifted", { attributes: [{ path: "tags.owner", before: "ops", after: "qa" }] });
      expect(await keepDriftIssue(forge, { ...input, records: [moved, queue] })).toMatchObject({ action: "updated", number: 1 });
      expect(issues).toHaveLength(1);
      expect(issues[0]!.body).toContain(driftIssueFingerprint([moved, queue]));

      // Another environment keeps its own issue.
      expect((await keepDriftIssue(forge, { ...input, environment: "infra/dev" })).action).toBe("opened");
      expect(issues).toHaveLength(2);

      // Clean: closed, with the product's comment.
      const closed = await keepDriftIssue(forge, { ...input, records: [record(bucket.address, "in-sync"), role] });
      expect(closed).toMatchObject({ action: "closed", number: 1 });
      expect(issues[0]).toMatchObject({ open: false, comments: ["plywood's drift check at 2026-11-09T06:00:00Z found infra/prod matching its state, so this issue is closed."] });
      expect(issues[1]!.open).toBe(true);

      // Clean again: nothing open, nothing written.
      const after = writes.length;
      expect((await keepDriftIssue(forge, { ...input, records: [role] })).action).toBe("none");
      expect(writes.length).toBe(after);

      // Drift found after a close opens a fresh issue: a closed one is never reopened.
      expect(await keepDriftIssue(forge, input)).toMatchObject({ action: "opened", number: 3 });
    });
  }

  test("a read that proves nothing leaves the open issue as it is", async () => {
    const { forge, issues, writes } = fakeForge("github");
    const input: DriftIssueInput = { words, environment: "infra/prod", records: [bucket] };
    await keepDriftIssue(forge, input);
    const before = writes.length;
    const unread = record(bucket.address, "not-observed", { unobserved: { reason: "no-credentials" } });
    expect(await keepDriftIssue(forge, { ...input, records: [unread, role] })).toMatchObject({
      action: "left",
      number: 1,
      why: "1 resource could not be read, so whether infra/prod drifted is unknown",
    });
    expect(await keepDriftIssue(forge, { ...input, records: [], unknown: "the drift could not be read (exit 1)" })).toMatchObject({ action: "left", why: "the drift could not be read (exit 1)" });
    expect(writes.length).toBe(before);
    expect(issues[0]!.open).toBe(true);
  });

  test("a product's own marker keeps its open issues", async () => {
    const { forge, issues } = fakeForge("gitlab");
    const marker = "<!-- yodel:drift project=. env=prod -->";
    await keepDriftIssue(forge, { words: { product: "yodel", title: () => "Drift in prod" }, environment: "prod", records: [queue], marker });
    expect(issues[0]!.body.startsWith(`${marker}\n`)).toBe(true);
    expect(await keepDriftIssue(forge, { words: { product: "yodel", title: () => "Drift in prod" }, environment: "prod", records: [queue], marker })).toMatchObject({ action: "unchanged", marker });
  });
});

describe("the drift issue's parts (#4790)", () => {
  test("the fingerprint is the drift's: order, time, run and unread or in-sync records leave it as it is", () => {
    const later = { ...bucket, observedAt: "2026-11-10T00:00:00Z" };
    const unread = record("urn:x", "not-observed", { unobserved: { reason: "no-credentials" } });
    expect(driftIssueFingerprint([bucket, queue])).toBe(driftIssueFingerprint([queue, role, later, unread]));
    expect(driftIssueFingerprint([bucket, queue])).toMatch(/^[0-9a-f]{16}$/);
    expect(driftIssueFingerprint([bucket])).not.toBe(driftIssueFingerprint([bucket, queue]));
    expect(driftIssueFingerprint([bucket])).not.toBe(driftIssueFingerprint([{ ...bucket, attributes: [{ path: "tags.owner", before: "ops", after: "qa" }] }]));
  });

  test("the body: marker, intro, table, unread records, notes, advice, run and fingerprint", () => {
    const unread = record("urn:pulumi:prod::infra::aws:s3/bucket:Bucket::audit", "not-observed", { unobserved: { reason: "no-credentials", detail: "AccessDenied" } });
    const body = driftIssueBody({ words, environment: "infra/prod", records: [queue, bucket, role, unread], runUrl: "https://ci/run/1", notes: ["Who changed each attribute:", "- tags.owner: alice"] }, "f00");
    expect(body).toBe(
      [
        "<!-- plywood:drift infra/prod -->",
        "plywood's drift check read infra/prod at 2026-11-09T06:00:00Z and found 2 resources that differ.",
        "",
        "| URN | Status | Attributes |",
        "|---|---|---|",
        "| `urn:pulumi:prod::infra::aws:s3/bucket:Bucket::logs` | drifted | `tags.owner` |",
        "| `urn:pulumi:prod::infra::aws:sqs/queue:Queue::jobs` | missing |  |",
        "",
        "Could not be read, so their state is unknown:",
        "",
        "- `urn:pulumi:prod::infra::aws:s3/bucket:Bucket::audit`: no-credentials (AccessDenied)",
        "",
        "Who changed each attribute:",
        "- tags.owner: alice",
        "",
        "To put the cloud back to the program, merge a change to infra/prod or run `plywood up`.",
        "",
        "Found by https://ci/run/1.",
        "",
        "<!-- plywood:drift-fingerprint f00 -->",
      ].join("\n"),
    );
  });

  test("values in the product's words, a member column when several drifted, and a cell that keeps the table", () => {
    const yodel: DriftIssueWords = { product: "yodel", title: () => "t", values: { before: "declared", after: "live" } };
    const secret = record("app.users", "drifted", { member: "db", attributes: [{ path: "password", sensitive: true }, { path: "columns[1]", before: "int", after: "bigint" }] });
    const piped = record("a|b", "missing", { member: "other" });
    const body = driftIssueBody({ words: yodel, environment: "prod", records: [secret, piped] }, "f");
    expect(body).toContain("| Member | Address | Status | Attributes |");
    expect(body).toContain("| `db` | `app.users` | drifted | `columns[1]`: declared `int`, live `bigint`, `password` (sensitive) |");
    expect(body).toContain("| `other` | `a\\|b` | missing |  |");
  });

  test("statuses names what is drift, for a read with no snapshot", async () => {
    const gone = record("app.events", "pending", { member: "." });
    expect(driftIssueFingerprint([gone])).toBe(driftIssueFingerprint([]));
    const { forge } = fakeForge("github");
    const yodel: DriftIssueWords = { product: "yodel", title: () => "Drift in prod" };
    expect((await keepDriftIssue(forge, { words: yodel, environment: "prod", records: [gone] })).action).toBe("none");
    expect((await keepDriftIssue(forge, { words: yodel, environment: "prod", records: [gone], statuses: ["drifted", "missing", "pending"] })).action).toBe("opened");
  });

  test("the default marker cannot end its comment", () => {
    expect(driftIssueMarker("plywood", "a b-->c")).toBe("<!-- plywood:drift a_bc -->");
  });
});
