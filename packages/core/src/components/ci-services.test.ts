/** #4572: forge-neutral job services, rendered per forge. */

import { describe, expect, test } from "vitest";
import { engineServices, githubServices, gitlabServices, serviceWaitLine, servicesJobEnv, type CiService } from "./ci-services";

const PG: CiService = {
  name: "replay-postgres",
  image: "postgres:18.6@sha256:abc",
  port: 5432,
  env: { POSTGRES_PASSWORD: "replay" },
  health: "pg_isready -h 127.0.0.1 -U postgres",
  jobEnv: { REPLAY_POSTGRES_URL: "postgres://replay-postgres:5432/postgres" },
};
const CH: CiService = { name: "replay-clickhouse", image: "clickhouse/clickhouse-server:26.8.15.10", port: 8123, env: {}, health: "clickhouse-client --query 'SELECT 1'", jobEnv: { REPLAY_CLICKHOUSE_URL: "http://replay-clickhouse:8123" } };

describe("engineServices", () => {
  test("joins each name once, in lexicon order", () => {
    expect(engineServices([[PG], undefined, [CH, PG]]).map((s) => s.name)).toEqual(["replay-postgres", "replay-clickhouse"]);
  });

  test("refuses one name with two images", () => {
    expect(() => engineServices([[PG], [{ ...PG, image: "postgres:17" }]])).toThrow(/replay-postgres/);
  });
});

describe("rendering", () => {
  test("GitHub and Forgejo: image, env and a health check per service", () => {
    expect(githubServices([PG, CH])).toEqual({
      "replay-postgres": { image: PG.image, env: { POSTGRES_PASSWORD: "replay" }, options: '--health-cmd "pg_isready -h 127.0.0.1 -U postgres" --health-interval 2s --health-timeout 5s --health-retries 45' },
      "replay-clickhouse": { image: CH.image, options: `--health-cmd "clickhouse-client --query 'SELECT 1'" --health-interval 2s --health-timeout 5s --health-retries 45` },
    });
  });

  test("GitLab: the image under its alias", () => {
    expect(gitlabServices([PG, CH])).toEqual([
      { name: PG.image, alias: "replay-postgres", variables: { POSTGRES_PASSWORD: "replay" } },
      { name: CH.image, alias: "replay-clickhouse" },
    ]);
  });

  test("the job's variables merge", () => {
    expect(servicesJobEnv([PG, CH])).toEqual({ ...PG.jobEnv, ...CH.jobEnv });
  });

  test("the wait line names the host and port, and refuses a host a shell would read as more", () => {
    const line = serviceWaitLine("replay-postgres", 5432);
    expect(line).toContain('net.connect(5432, "replay-postgres"');
    expect(line).toContain("n > 90");
    expect(() => serviceWaitLine("a'; rm -rf /", 1)).toThrow();
  });
});
