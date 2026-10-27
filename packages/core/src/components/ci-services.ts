/**
 * Job services a lexicon asks for (#4572, `LexiconPlugin.ciServices`): a
 * throwaway server a CI job starts beside it, such as the sql lexicon's
 * replay server per dialect. A service is forge-neutral data here; a
 * product's job renders it for its forge with {@link githubServices} (GitHub
 * and Forgejo) or {@link gitlabServices}, sets {@link servicesJobEnv} on the
 * job, and runs {@link serviceWaitLine} before the step that uses it.
 *
 * The job runs in a container (chant's default image, or the product's), so
 * it reaches each service by its name on the job's own network. A name is
 * prefixed by the lexicon (`replay-postgres`), so two lexicons' services
 * never answer for one host.
 */

import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `LexiconPlugin.ciServices` and this module (#4572). */
export const CI_SERVICES_FLOOR = NEXT_RELEASE;

/** One service a job starts. */
export interface CiService {
  /** The host the job reaches it at, and its alias on GitLab. */
  name: string;
  /** The image, pinned by the lexicon (tag, and digest where the lexicon pins one). */
  image: string;
  /** The port the server listens on inside its container. */
  port: number;
  /** The service container's environment. */
  env: Record<string, string>;
  /** A command run inside the service container that exits 0 once the server answers. */
  health: string;
  /** What the job that uses it sets: the server's URL and its throwaway credentials, by variable name. */
  jobEnv: Record<string, string>;
}

/**
 * Join the services each lexicon gives, each name once, in the order the
 * lexicons come. Two services under one name with different images are
 * refused: a host that answers for two servers would split the job.
 */
export function engineServices(perLexicon: ReadonlyArray<readonly CiService[] | undefined>): CiService[] {
  const out = new Map<string, CiService>();
  for (const svc of perLexicon.flatMap((list) => list ?? [])) {
    const seen = out.get(svc.name);
    if (seen && seen.image !== svc.image) throw new Error(`two lexicons give a CI service named ${svc.name}, ${seen.image} and ${svc.image}; a job reaches one server per name`);
    if (!seen) out.set(svc.name, svc);
  }
  return [...out.values()];
}

/** A job's `services:` on GitHub and Forgejo: each image with its environment and a health check the runner waits on. */
export function githubServices(services: readonly CiService[]): Record<string, { image: string; env?: Record<string, string>; options: string }> {
  return Object.fromEntries(
    services.map((s) => [
      s.name,
      {
        image: s.image,
        ...(Object.keys(s.env).length > 0 ? { env: { ...s.env } } : {}),
        options: `--health-cmd "${s.health}" --health-interval 2s --health-timeout 5s --health-retries 45`,
      },
    ]),
  );
}

/** A job's `services:` on GitLab: each image under its alias, with its variables. GitLab waits on the port itself. */
export function gitlabServices(services: readonly CiService[]): Array<{ name: string; alias: string; variables?: Record<string, string> }> {
  return services.map((s) => ({ name: s.image, alias: s.name, ...(Object.keys(s.env).length > 0 ? { variables: { ...s.env } } : {}) }));
}

/** The variables a job using `services` sets, merged in order. */
export function servicesJobEnv(services: readonly CiService[]): Record<string, string> {
  return Object.assign({}, ...services.map((s) => s.jobEnv)) as Record<string, string>;
}

/**
 * A shell line that waits up to `seconds` for `host:port` to accept a
 * connection, with `node -e`, so every forge and image with node runs it
 * the same. It exits 1 naming the host when nothing answers.
 */
export function serviceWaitLine(host: string, port: number, seconds = 90): string {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error(`a service host is letters, digits, dots and hyphens, not ${JSON.stringify(host)}`);
  return `node -e 'const net = require("net"); let n = 0; (function t() { const s = net.connect(${String(port)}, "${host}", () => { s.end(); process.exit(0); }); s.on("error", () => { if (++n > ${String(seconds)}) { console.error("${host}:${String(port)} did not answer"); process.exit(1); } setTimeout(t, 1000); }); })()'`;
}
