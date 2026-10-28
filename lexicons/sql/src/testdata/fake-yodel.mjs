#!/usr/bin/env node
// A fake `yodel` for the sql-migrate tests (#4569). It answers the three
// commands chant runs, writes the files sql-yodeler would, and appends each
// call (argv, and whether the writer was in its environment) to
// $FAKE_YODEL_LOG. $FAKE_YODEL_APPLY_EXIT sets the apply's exit status, and
// $FAKE_YODEL_WAVE_DIGEST the wave plan's digest.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const write = (file, doc) => {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
};

if (process.env.FAKE_YODEL_LOG) {
  appendFileSync(
    process.env.FAKE_YODEL_LOG,
    `${JSON.stringify({ args, role: process.env.YODEL_ROLE ?? null, writer: process.env.DEV_POSTGRES_WRITER_PASSWORD ?? null })}\n`,
  );
}

const env = args[1];
if (args[0] === "plan") {
  write(at("--part"), {
    member: { member: "app", lexicon: "sql", planner: "sql", scope: env, status: "planned", planDigest: "jcs1-sha256:migrations", holes: [] },
    entries: [
      { member: "app", lexicon: "sql", planner: "sql", address: "app.users", type: "Postgres::Table", action: "update", disruption: "rolling", scope: env, attributes: [{ path: "columns.email", after: "text" }] },
      { member: "app", lexicon: "sql", planner: "sql", address: "app.audit", type: "Postgres::Table", action: "create", scope: env, attributes: [] },
    ],
  });
  process.exit(0);
}
if (args[0] === "apply" && args[2] === "--wave-plan") {
  write(at("--wave-plan"), {
    planDigest: process.env.FAKE_YODEL_WAVE_DIGEST ?? "jcs1-sha256:wave",
    destructive: true,
    empty: false,
    environment: env,
    migrations: "jcs1-sha256:migrations",
    gate: "on-destructive",
    base: "0".repeat(40),
    pending: ["0002_users_email"],
    destructiveSteps: [{ migration: "0002_users_email", step: 0, what: "ALTER TABLE app.users", why: "pg-rewrite, pg-lock" }],
    requires: [],
  });
  process.exit(0);
}
if (args[0] === "apply" && args[2] === "--wave-apply") {
  const code = Number(process.env.FAKE_YODEL_APPLY_EXIT ?? "0");
  if (code === 0) process.stdout.write("Applied: 0002_users_email\n");
  else process.stderr.write(`refused: ${env}'s wave plan moved since the wave was decided; nothing was applied. Run the wave again.\n`);
  process.exit(code);
}
process.stderr.write(`fake yodel: no answer for ${args.join(" ")}\n`);
process.exit(1);
