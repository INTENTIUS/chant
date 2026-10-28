/**
 * The images the e2e harness runs (chant#4587), in the one file every
 * harness compose reads. A product's compose project gets its images from
 * here through `harnessStack` (./stack.ts), never by naming a digest itself,
 * so a pin moves for every bench at once.
 */

/** The floci build the harness pins, by its index digest (linux/amd64 and linux/arm64). */
export const FLOCI_DIGEST = "sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec";

/**
 * floci from the lex00/floci fork at {@link FLOCI_DIGEST}: the build
 * choudoufu pins in live/floci-image and plunge in
 * tests/plunge-corpus/emulator-images, which serves Cloud Control
 * ListResources for the types choudoufu's discovery and plunge's sweep read.
 *
 * The epic named 63d8f1ed (chant#4586 ruling D). On 2026-10-27 the
 * maintainer ruled to hold this pin at 5ec92ae8 and file upstream instead,
 * because 63d8f1ed answers ListResources with UnsupportedActionException for
 * 619 of 628 Cloud Control types. lex00/floci#265 asks for one image with
 * both lines' fixes; the pin moves when that image exists.
 */
export const FLOCI_IMAGE = `ghcr.io/lex00/floci@${FLOCI_DIGEST}`;

/**
 * The other floci line, 63d8f1ed (ghcr.io/lex00/floci:b491869, branch
 * fix/cfn-change-set-changes): it describes a CloudFormation change set's
 * changes, which chant's plan counts read, and keeps SNS tags and IAM
 * permission boundaries. The fan-out demo plans CloudFormation stacks and
 * needs that, so it names this line until lex00/floci#265's image carries
 * both. No claim row is recorded on it: rows name {@link FLOCI_DIGEST}.
 */
export const FLOCI_CHANGE_SET_DIGEST = "sha256:63d8f1ed5ef595d7356c6f76318f3d76bc31ce3250cdf2dd8d14bd4d59604b8d";
export const FLOCI_CHANGE_SET_IMAGE = `ghcr.io/lex00/floci@${FLOCI_CHANGE_SET_DIGEST}`;

/** Forgejo, as terragucci's stack and the fan-out demo run it. */
export const FORGEJO_IMAGE = "codeberg.org/forgejo/forgejo:16.0.5";

/** forgejo-runner, with the docker executor (terragucci stack/docker-compose.yml). */
export const FORGEJO_RUNNER_IMAGE = "data.forgejo.org/forgejo/runner:13.2.0";

/**
 * The sql emulator's servers, the ones `chant emulator up sql` starts. The
 * sql lexicon owns these pins (lexicons/sql/src/spec/pin.ts and
 * postgres-pin.ts); stack.test.ts fails when the two disagree.
 */
export const CLICKHOUSE_IMAGE =
  "clickhouse/clickhouse-server:26.8.15.10@sha256:9716a352d25f538bd19d868b001141e7a60e4d035bc9b823658c6a071660aa61";
export const POSTGRES_IMAGE = "postgres:18.6@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722";

/** The Postgres emulator's password, as `chant emulator` sets it. */
export const POSTGRES_PASSWORD = "chant";
