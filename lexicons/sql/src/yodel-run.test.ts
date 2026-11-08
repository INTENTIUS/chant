/**
 * yodel's commit jobs (#4724): the argv of `yodel new` and `yodel rebase`,
 * their commit-job specs, the lint findings that start them on the check
 * trigger, and the replies to yodel's refusals, read from yodel's own output.
 *
 * The refusal fixtures are what sql-yodeler 0.12.1 prints on standard error
 * (`guarded()` in src/env-args.ts puts `yodel <verb>: ` before the message of
 * src/rebase/index.ts, src/commands/rebase.ts and src/commands/new.ts).
 */
import { describe, expect, test } from "vitest";
import { CI_COMMIT_REPLY_FLOOR, commitArgv, commitSettingsEnv, commitSettingsFromEnv, resolveCommitSpec } from "@intentius/chant/ci-commit";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { NEXT_RELEASE } from "@intentius/chant/release-floors";
import { NODE_CHECK_LINE, PACKAGES_INSTALL_LINE } from "./ci-setup";
import {
  allowedYodelArgv,
  allowedYodelCommitArgv,
  YODEL_COMMIT_FINDINGS,
  YODEL_COMMIT_FLOOR,
  YODEL_REBASE_CONFLICT_FLOOR,
  YODEL_NEW_HISTORY_FLOOR,
  YODEL_NEW_NAME_FLOOR,
  yodelCommitRefusalReply,
  yodelCommitSetup,
  yodelCommitSpec,
  yodelFindingExit,
  yodelFindingTrigger,
  yodelNewArgs,
  yodelRebaseArgs,
  yodelReaderVariables,
  yodelRefusalReply,
} from "./yodel-run";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const A = "20261101T0900-add-email";
const B = "20261102T1000-add-phone";

describe("argv", () => {
  test("yodel new writes only when the schema moved and replaces the pull request's own migration", () => {
    expect(yodelNewArgs()).toEqual(["new", "--if-changed", "--replace-own"]);
    expect(yodelNewArgs({ name: "pr-12", dir: "db" })).toEqual(["new", "pr-12", "--if-changed", "--replace-own", "--dir", "db"]);
    expect(() => yodelNewArgs({ name: "Bad Name" })).toThrow(/not a migration name/);
  });

  test("yodel new takes --env per history, so --replace-own refuses a migration applied there (#4815)", () => {
    expect(yodelNewArgs({ name: "pr-12", envs: ["dev", "staging"], dir: "db" })).toEqual(["new", "pr-12", "--if-changed", "--replace-own", "--env", "dev", "--env", "staging", "--dir", "db"]);
    expect(() => yodelNewArgs({ envs: ["--force"] })).toThrow(/not an environment name/);
  });

  test("yodel rebase resolves the one fork, with --env per history and never --force", () => {
    expect(yodelRebaseArgs()).toEqual(["rebase"]);
    expect(yodelRebaseArgs({ envs: ["dev", "prod"], dir: "db" })).toEqual(["rebase", "--env", "dev", "--env", "prod", "--dir", "db"]);
    expect(() => yodelRebaseArgs({ envs: ["--force"] })).toThrow(/not an environment name/);
  });

  test("both are on the commit job's own list, apart from the capability's, and nothing else of new or rebase is", () => {
    for (const args of [yodelNewArgs(), yodelNewArgs({ name: "x", dir: "db" }), yodelNewArgs({ envs: ["dev"], dir: "db" }), yodelRebaseArgs(), yodelRebaseArgs({ envs: ["dev"], dir: "db" })]) {
      expect(allowedYodelCommitArgv(args)).toBe(true);
      expect(allowedYodelArgv(args)).toBe(false);
    }
    expect(allowedYodelCommitArgv(["new", "x"])).toBe(false);
    expect(allowedYodelCommitArgv(["new", "--if-changed"])).toBe(false);
    expect(allowedYodelCommitArgv(["new", "--if-changed", "--replace-own", "--sql"])).toBe(false);
    expect(allowedYodelCommitArgv(["new", "--if-changed", "--replace-own", "--env", "-x"])).toBe(false);
    expect(allowedYodelCommitArgv(["new", "--if-changed", "--replace-own", "--dir", "db", "--env", "dev"])).toBe(false);
    expect(allowedYodelCommitArgv(["new", "--env", "dev", "--if-changed", "--replace-own"])).toBe(false);
    expect(allowedYodelCommitArgv(["rebase", "--force"])).toBe(false);
    expect(allowedYodelCommitArgv(["rebase", A, "--onto", B])).toBe(false);
    expect(allowedYodelCommitArgv(["rebase", "--env", "-x"])).toBe(false);
    expect(allowedYodelCommitArgv(["rebase", "--dir", "db", "--env", "dev"])).toBe(false);
    expect(allowedYodelCommitArgv(["plan", "dev", "--part", "p.json"])).toBe(false);
  });
});

describe("the commit-job specs", () => {
  test("new on a comment changes only the migrations directory and merges nothing first", () => {
    const spec = yodelCommitSpec("new", { on: "comment", dir: "db", tokenEnv: "YODEL_PUSH_TOKEN" });
    expect(spec).toMatchObject({ on: "comment", comment: "/yodel new", command: ["yodel", "new", "--if-changed", "--replace-own", "--dir", "db"], allowed: ["db/migrations/"], tokenEnv: "YODEL_PUSH_TOKEN" });
    expect(spec.mergeBase).toBeUndefined();
    expect(yodelCommitSpec("new", { on: "comment", tokenEnv: "T" }).allowed).toEqual(["migrations/"]);
  });

  test("/yodel new on a comment takes a migration name after it, put after new in the argv (#4820)", () => {
    const spec = yodelCommitSpec("new", { on: "comment", dir: "db", tokenEnv: "T" });
    expect(spec.commentArg).toEqual({ pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$", position: 2 });
    const s = resolveCommitSpec("yodel-new", spec, "yodel");
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "yodel")).toEqual(s);
    const argv = commitArgv(s, "add-note");
    expect(argv).toEqual(["yodel", "new", "add-note", "--if-changed", "--replace-own", "--dir", "db"]);
    expect(allowedYodelCommitArgv(argv.slice(1))).toBe(true);
    expect(() => commitArgv(s, "Add_Note")).toThrow(/not a name/);
    // A fixed name, the check trigger and rebase take nothing from the comment.
    expect(yodelCommitSpec("new", { on: "comment", name: "fixed", tokenEnv: "T" }).commentArg).toBeUndefined();
    expect(yodelCommitSpec("new", { on: "check", tokenEnv: "T" }).commentArg).toBeUndefined();
    expect(yodelCommitSpec("rebase", { on: "comment", tokenEnv: "T" }).commentArg).toBeUndefined();
  });

  test("on the check trigger each starts on chant's drift code", () => {
    expect(yodelCommitSpec("new", { on: "check", tokenEnv: "T" })).toMatchObject({ on: "check", findings: [CHANT_EXIT.drift] });
    expect(yodelCommitSpec("rebase", { on: "check", tokenEnv: "T" })).toMatchObject({ on: "check", findings: [CHANT_EXIT.drift], mergeBase: true });
  });

  test("rebase merges the base first, and with envs sees the reader's variables only", () => {
    const spec = yodelCommitSpec("rebase", { on: "comment", envs: ["dev", "prod/acme"], dialect: "postgres", tokenEnv: "T" });
    expect(spec.command).toEqual(["yodel", "rebase", "--env", "dev", "--env", "prod/acme"]);
    expect(spec.mergeBase).toBe(true);
    expect(spec.commandEnv).toEqual([...yodelReaderVariables("dev", "postgres"), "PROD_ACME_POSTGRES_URL", "PROD_ACME_POSTGRES_READER_USER", "PROD_ACME_POSTGRES_READER_PASSWORD"]);
    expect(yodelReaderVariables("dev", "clickhouse")).toEqual(["DEV_CLICKHOUSE_URL", "DEV_CLICKHOUSE_READER_USER", "DEV_CLICKHOUSE_READER_PASSWORD"]);
    const s = resolveCommitSpec("yodel-rebase", spec, "yodel");
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "yodel")).toEqual(s);
    expect(yodelCommitSpec("rebase", { on: "comment", envs: ["dev"], readerVariables: ["DEV_PG_URL", "DEV_RO_USER"], tokenEnv: "T" }).commandEnv).toEqual(["DEV_PG_URL", "DEV_RO_USER"]);
  });

  test("new with envs reads each history as the reader, as rebase does (#4815)", () => {
    const spec = yodelCommitSpec("new", { on: "comment", envs: ["dev"], dialect: "clickhouse", dir: "db", tokenEnv: "T" });
    expect(spec.command).toEqual(["yodel", "new", "--if-changed", "--replace-own", "--env", "dev", "--dir", "db"]);
    expect(spec.commandEnv).toEqual(yodelReaderVariables("dev", "clickhouse"));
    expect(spec.mergeBase).toBeUndefined();
    const s = resolveCommitSpec("yodel-new", spec, "yodel");
    expect(commitSettingsFromEnv(commitSettingsEnv(s), "yodel")).toEqual(s);
    expect(yodelCommitSpec("new", { on: "comment", envs: ["dev"], readerVariables: ["DEV_PG_URL"], tokenEnv: "T" }).commandEnv).toEqual(["DEV_PG_URL"]);
    expect(() => yodelCommitSpec("new", { on: "comment", envs: ["dev"], tokenEnv: "T" })).toThrow(/yodel new with envs needs dialect/);
    expect(() => yodelCommitSpec("new", { on: "comment", envs: ["dev"], readerVariables: ["DEV_POSTGRES_WRITER_USER"], tokenEnv: "T" })).toThrow(/yodel new --env reads histories as the reader only/);
  });

  test("refuses a writer, envs without a dialect and a name on rebase", () => {
    expect(() => yodelCommitSpec("rebase", { on: "comment", envs: ["dev"], readerVariables: ["DEV_POSTGRES_WRITER_PASSWORD"], tokenEnv: "T" })).toThrow(/as the reader only.*DEV_POSTGRES_WRITER_PASSWORD/);
    expect(() => yodelCommitSpec("rebase", { on: "comment", envs: ["dev"], readerVariables: ["YODEL_ROLE"], tokenEnv: "T" })).toThrow(/YODEL_ROLE/);
    expect(() => yodelCommitSpec("rebase", { on: "comment", envs: ["dev"], tokenEnv: "T" })).toThrow(/needs dialect/);
    expect(() => yodelCommitSpec("rebase", { on: "comment", name: "x", tokenEnv: "T" })).toThrow(/takes no name/);
    expect(() => yodelCommitSpec("drop" as never, { on: "comment", tokenEnv: "T" })).toThrow(/new and rebase/);
  });

  test("the setup lines are the sql lexicon's CI setup", () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-commit-setup-"));
    expect(yodelCommitSetup({ dir })).toEqual([]);
    writeFileSync(join(dir, "chant.config.ts"), 'export default { sql: { dialect: "postgres" } };\n');
    expect(yodelCommitSetup({ dir })).toEqual([{ run: NODE_CHECK_LINE }, { run: PACKAGES_INSTALL_LINE }]);
  });

  test("the floor is the commit job's reply floor", () => {
    expect(YODEL_COMMIT_FLOOR).toBe(CI_COMMIT_REPLY_FLOOR);
  });

  test("the conflict reply's floor is the next release until it ships (#4821)", () => {
    expect(YODEL_REBASE_CONFLICT_FLOOR).toBe(NEXT_RELEASE);
  });

  test("new's envs floor is the next release until it ships (#4815)", () => {
    expect(YODEL_NEW_HISTORY_FLOOR).toBe(NEXT_RELEASE);
  });

  test("the name's floor is core's commit-job argument floor (#4820)", () => {
    expect(YODEL_NEW_NAME_FLOOR).toBe(NEXT_RELEASE);
  });
});

/** A `yodel lint --json` report (sql-yodeler schemas/lint.schema.json) with these findings. */
const lint = (findings: Array<{ rule: string; level?: "error" | "warning"; silenced?: string }>, status: "passed" | "failed" = "passed") => ({
  status,
  dialect: "postgres",
  migrations: [A],
  errors: findings.filter((f) => f.level !== "warning" && !f.silenced).length,
  warnings: 0,
  silenced: 0,
  findings: findings.map((f) => ({ level: "error", message: "m", ...f })),
  silences: [],
});

describe("the check trigger", () => {
  test("unmigrated starts new, fork starts rebase, and a fork comes first", () => {
    expect(YODEL_COMMIT_FINDINGS).toEqual({ new: "unmigrated", rebase: "fork" });
    expect(yodelFindingTrigger(lint([{ rule: "unmigrated" }]))).toBe("new");
    expect(yodelFindingTrigger(lint([{ rule: "fork" }], "failed"))).toBe("rebase");
    expect(yodelFindingTrigger(lint([{ rule: "unmigrated" }, { rule: "fork" }], "failed"))).toBe("rebase");
    expect(yodelFindingTrigger(lint([{ rule: "destructive" }], "failed"))).toBeUndefined();
    expect(yodelFindingTrigger(lint([{ rule: "unmigrated", silenced: "on purpose" }]))).toBeUndefined();
    expect(yodelFindingTrigger(JSON.stringify(lint([{ rule: "fork" }])))).toBe("rebase");
    expect(yodelFindingTrigger("not json")).toBeUndefined();
  });

  test("the check exits drift for its own job's finding, failed for another failure and done otherwise", () => {
    expect(yodelFindingExit(lint([{ rule: "unmigrated" }]), "new")).toBe(CHANT_EXIT.drift);
    expect(yodelFindingExit(lint([{ rule: "unmigrated" }]), "rebase")).toBe(CHANT_EXIT.done);
    expect(yodelFindingExit(lint([{ rule: "fork" }], "failed"), "rebase")).toBe(CHANT_EXIT.drift);
    expect(yodelFindingExit(lint([{ rule: "fork" }, { rule: "unmigrated" }], "failed"), "new")).toBe(CHANT_EXIT.failed);
    expect(yodelFindingExit(lint([{ rule: "destructive" }], "failed"), "new")).toBe(CHANT_EXIT.failed);
    expect(yodelFindingExit(lint([]), "new")).toBe(CHANT_EXIT.done);
    expect(yodelFindingExit("{", "new")).toBe(CHANT_EXIT.failed);
  });
});

const REBASE = ["yodel", "rebase"];
const NEW = ["yodel", "new", "--if-changed", "--replace-own"];

describe("the refusal replies", () => {
  test("the same object changed on both branches names the migrations on each side and the objects (#4821)", () => {
    // Copied from yodel rebase's stderr (sql-yodeler src/rebase/index.ts), the moved migration's parent set.
    const output = [
      "yodel rebase: refused: 20300101T0002-add-memo and the migrations after 20261108T1936-init up to 20300101T0001-add-note both change orders, differently; rebase does not merge two changes to one object. " +
        "Nothing was written. Resolve it by hand: delete 20300101T0002-add-memo's directory, then run yodel new from a declared schema that makes both changes.",
      "",
    ].join("\n");
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output })).toBe(
      "`yodel rebase` refused: `20300101T0002-add-memo` and the migrations after `20261108T1936-init` up to `20300101T0001-add-note` both change `orders`, differently, and a rebase does not merge two changes to one object. " +
        "Resolve it on the branch: delete `20300101T0002-add-memo`'s directory, declare both changes, then run `yodel new` (or comment `/yodel new`).",
    );
    // The moved migration's parent is null: the other side is the chain ending at the new parent.
    const fromNothing = `yodel rebase: refused: ${B} and the chain ending at ${A} both change shop.orders, shop.order_items / shop.items, differently; rebase does not merge two changes to one object. Nothing was written.\n`;
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: fromNothing })).toBe(
      "`yodel rebase` refused: `" + B + "` and the chain ending at `" + A + "` both change `shop.orders`, `shop.order_items / shop.items`, differently, and a rebase does not merge two changes to one object. " +
        "Resolve it on the branch: delete `" + B + "`'s directory, declare both changes, then run `yodel new` (or comment `/yodel new`).",
    );
  });

  test("a hand edit names the migrations edited", () => {
    const one = `yodel rebase: refused: ${B} has files that differ from what yodel wrote (an edit by hand, or a checksum that no longer matches). Rebasing writes them again from their recorded schema and drops that edit. Nothing was written; pass --force to rebase anyway, then make the edit again.\n`;
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: one })).toBe(
      "`yodel rebase` refused: `" + B + "` was edited by hand (its files differ from what yodel wrote), and a rebase writes it again from the recorded schema, dropping the edit. " +
        "Rebase on your machine with `yodel rebase --force` and make the edit again, or put the change in the declared schema.",
    );
    const two = `yodel rebase: refused: ${A}, ${B} have files that differ from what yodel wrote (an edit by hand). Nothing was written.\n`;
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: two })).toContain("`" + A + "`, `" + B + "` were edited by hand");
  });

  test("a history that records the migration names the environment and the migration", () => {
    const output = `yodel rebase: refused: prod's history records ${B} (applied), ${A} (ran part way, failed). Nothing was written. A migration that ran is never rebased: its statements already ran in that order. Rebase the other branch onto it instead (yodel rebase <the other> --onto <the end of this one>).\n`;
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output })).toBe(
      "`yodel rebase` refused: `prod`'s history records `" + B + "` (applied), `" + A + "` (ran part way, failed), and a migration that ran is never rewritten. " +
        "Rebase the other branch onto it instead: `yodel rebase <the other> --onto <the end of this one>`.",
    );
    const replaced = `yodel new: refused: ${B} is applied in dev, so it is not redone; write the change as a new migration (yodel new <name>). Nothing written.\n`;
    expect(yodelRefusalReply({ command: NEW, rc: "1", output: replaced })).toBe("`yodel new` refused: `" + B + "` is applied in `dev`, so it is not replaced. Write the change as a migration of its own: `yodel new <name>`.");
  });

  test("anything else keeps chant's own reply", () => {
    const conflict = `yodel rebase: refused: ${B} and the migrations after ${A} up to ${A} both change \`x\`@everyone, differently; rebase does not merge.\n`;
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: conflict })).toBeUndefined();
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: "yodel rebase: refused: not-an-id and the chain ending at x both change a, differently;\n" })).toBeUndefined();
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: `yodel rebase: refused: ${B} and the migrations after not-an-id up to ${A} both change a, differently;\n` })).toBeUndefined();
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: `yodel rebase: refused: ${B} and the migrations after ${A} up to \`${A}\` both change a, differently;\n` })).toBeUndefined();
    // The single-id form yodel does not print is not read either.
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: `yodel rebase: refused: ${B} and ${A} both change a, differently;\n` })).toBeUndefined();
    expect(yodelRefusalReply({ command: REBASE, rc: "1", output: "yodel rebase: chant.config.ts: Cannot find module\n" })).toBeUndefined();
    expect(yodelRefusalReply({ command: REBASE, rc: "2", output: `yodel rebase: refused: ${B} has files that differ from what yodel wrote\n` })).toBeUndefined();
    expect(yodelRefusalReply({ command: ["yodel", "plan"], rc: "1", output: "yodel plan: refused: x\n" })).toBeUndefined();
    expect(yodelRefusalReply({ command: NEW, rc: "1", output: `yodel new: refused: ${B} has files that differ from what yodel wrote\n` })).toBeUndefined();
  });

  test("as the commit job takes it, from the job's settings", () => {
    const settings = resolveCommitSpec("yodel-rebase", yodelCommitSpec("rebase", { on: "comment", tokenEnv: "T" }), "yodel");
    const output = `noise before\nyodel rebase: refused: ${B} has files that differ from what yodel wrote (an edit by hand).\n`;
    expect(yodelCommitRefusalReply({ settings, rc: "1", output })).toContain("`" + B + "` was edited by hand");
    const npx = resolveCommitSpec("yodel-rebase", { ...yodelCommitSpec("rebase", { on: "comment", tokenEnv: "T" }), command: ["npx", "yodel", "rebase"] }, "yodel");
    expect(yodelCommitRefusalReply({ settings: npx, rc: "1", output })).toContain("was edited by hand");
  });
});
