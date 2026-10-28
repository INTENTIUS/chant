/**
 * The e2e harness's compose project (chant#4587), the whole stack:
 * floci, Forgejo and forgejo-runner with the docker executor on one network,
 * and the sql emulator's ClickHouse and Postgres behind the `sql` profile.
 * The services are ../../stack.ts's, and every image is ../../pins.ts's.
 *
 * The project name comes from CHANT_E2E_PROJECT at build time (default
 * chant-e2e) and names the network, the containers and the volumes; pass the
 * same name to `docker compose -p`. Host ports bind to 127.0.0.1 and move
 * with CHANT_E2E_FLOCI_PORT, CHANT_E2E_FORGEJO_PORT, CHANT_E2E_CLICKHOUSE_PORT
 * and CHANT_E2E_POSTGRES_PORT.
 *
 *   chant build <this dir>/src --lexicon docker -o compose.yaml
 *   docker compose -p chant-e2e -f compose.yaml up -d
 *   docker compose -p chant-e2e -f compose.yaml --profile sql up -d
 *
 * A product with its own words or ports writes the same few lines with its
 * own options to harnessStack.
 */
import { Network, Service, Volume } from "@intentius/chant-lexicon-docker";
import { harnessStack } from "../../stack";

const h = harnessStack({ project: process.env.CHANT_E2E_PROJECT ?? "chant-e2e" });

export const harness = new Network(h.network);
export const forgejoData = new Volume(h.volumes.forgejoData);
export const runnerData = new Volume(h.volumes.runnerData);

export const floci = new Service(h.services.floci);
export const forgejo = new Service(h.services.forgejo);
export const forgejoRunner = new Service(h.services.forgejoRunner);
export const clickhouse = new Service(h.services.clickhouse);
export const postgres = new Service(h.services.postgres);
