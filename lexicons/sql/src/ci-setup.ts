/**
 * What a SQL project's CI jobs need from the sql lexicon (#4572, over
 * #4550's `LexiconPlugin.ciSetup`): the setup lines for chant's default
 * image, and the replay server per dialect as a job service
 * (`LexiconPlugin.ciServices`). sql-yodeler's own versions were
 * `src/ci/render.ts` (`installLines`, `REPLAY_SERVICE`, `waitFor`), which
 * now come from here.
 *
 * The lines: a Node check, since the lexicon and chant run on Node 22, then
 * the project's packages with `npm ci` unless the lexicon is already
 * installed, with `node_modules/.bin` put on PATH for the job's later
 * steps. That one install carries the dialect's client too: Postgres is the
 * lexicon's own `pg` dependency and ClickHouse is spoken over HTTP, so no
 * separate client goes into the image. A token source needs no cloud
 * command line in CI either: in a job that traded its OIDC token through
 * chant's `ci.identity`, `./token-source.ts` mints from what the trade left.
 *
 * The replay server is the image the lexicon's emulator runs, at the same
 * pin (`./spec/pin.ts`, `./spec/postgres-pin.ts`), so a replay in CI and
 * `chant emulator up` on a laptop run one server. It is a throwaway: the
 * replay resets it. The dialects are read from the text of the project's
 * `chant.config.ts`, never by running it, as lexicon detection reads source.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiService } from "@intentius/chant/components/ci-services";
import { clickhouseImage } from "./spec/pin";
import { POSTGRES_LATEST_MAJOR, postgresImage } from "./spec/postgres-pin";

export type SqlCiDialect = "clickhouse" | "postgres";

/** The profile the replay check runs on, as sql-yodeler names it. */
export const REPLAY_PROFILE = "replay";

/** The oldest Node the lexicon and chant run on. */
export const SQL_CI_NODE_MAJOR = 22;

/** Fails the job, naming the version, when the image's Node is older than {@link SQL_CI_NODE_MAJOR}. */
export const NODE_CHECK_LINE = `node -e 'const m = Number(process.versions.node.split(".")[0]); if (m < ${String(SQL_CI_NODE_MAJOR)}) { console.error("the sql lexicon needs Node ${String(SQL_CI_NODE_MAJOR)} or newer; this image has " + process.versions.node); process.exit(1); }'`;

/**
 * The project's packages, unless the lexicon is already installed (an image
 * that carries them pays nothing), and their bins on PATH: exported for the
 * rest of a GitLab script, appended to `$GITHUB_PATH` for a GitHub or
 * Forgejo job's later steps.
 */
export const PACKAGES_INSTALL_LINE =
  '{ [ -d node_modules/@intentius/chant-lexicon-sql ] || npm ci; } && export PATH="$PWD/node_modules/.bin:$PATH" && if [ -n "${GITHUB_PATH:-}" ]; then echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"; fi';

/** The replay server of each dialect: the emulator's pinned image, under a prefixed name. */
export function replayService(dialect: SqlCiDialect): CiService {
  if (dialect === "clickhouse") {
    return {
      name: "replay-clickhouse",
      image: clickhouseImage(),
      port: 8123,
      // The default user, with no password, from outside the container.
      env: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
      health: "clickhouse-client --query 'SELECT 1'",
      jobEnv: { REPLAY_CLICKHOUSE_URL: "http://replay-clickhouse:8123" },
    };
  }
  return {
    name: "replay-postgres",
    image: postgresImage(POSTGRES_LATEST_MAJOR),
    port: 5432,
    env: { POSTGRES_PASSWORD: "replay" },
    // Over TCP: during its first start the image runs a server on the socket only, then restarts.
    health: "pg_isready -h 127.0.0.1 -U postgres",
    jobEnv: { REPLAY_POSTGRES_URL: "postgres://replay-postgres:5432/postgres", REPLAY_POSTGRES_USER: "postgres", REPLAY_POSTGRES_PASSWORD: "replay" },
  };
}

/** The text of the project's config, or undefined without one. */
function configText(dir: string): string | undefined {
  for (const name of ["chant.config.ts", "chant.config.mts", "chant.config.js"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      return readFileSync(file, "utf-8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The dialects the config names (`dialect: "postgres"`, or a list), in
 * {@link SqlCiDialect} order; ClickHouse, the lexicon's default, when it
 * names none.
 */
export function sqlDialectsOf(text: string): SqlCiDialect[] {
  const m = /\bdialect\s*:\s*(\[[^\]]*\]|["'][a-z]+["'])/.exec(text);
  if (!m) return ["clickhouse"];
  const named = new Set([...m[1]!.matchAll(/["']([a-z]+)["']/g)].map((x) => x[1]));
  const out = (["clickhouse", "postgres"] as const).filter((d) => named.has(d));
  return out.length > 0 ? [...out] : ["clickhouse"];
}

/** Whether the config declares the `replay` profile, the one the replay check runs on. */
export function declaresReplay(text: string): boolean {
  return new RegExp(`(^|[\\s{,])["']?${REPLAY_PROFILE}["']?\\s*:`).test(text);
}

/** The setup lines for the project at `dir`: none when it has no config naming the sql lexicon's settings. */
export function sqlCiSetup(ctx: { dir: string }): string[] {
  return configText(ctx.dir) === undefined ? [] : [NODE_CHECK_LINE, PACKAGES_INSTALL_LINE];
}

/** The replay service per dialect for the project at `dir`, when its config declares the `replay` profile. */
export function sqlCiServices(ctx: { dir: string }): CiService[] {
  const text = configText(ctx.dir);
  if (text === undefined || !declaresReplay(text)) return [];
  return sqlDialectsOf(text).map(replayService);
}
