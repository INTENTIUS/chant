import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Unit tests never see the developer's AWS credentials (chant #3958).
 *
 * The aws read transport resolves credentials through the AWS CLI chain
 * (`lexicons/aws/src/api/credential-chain.ts`) when a caller injects none:
 * environment keys, then `AWS_PROFILE` or `default` from `~/.aws/config` and
 * `~/.aws/credentials`, which can mean an SSO portal call or running a
 * `credential_process` command. A unit test that calls the transport without
 * injecting `env` would walk that chain against the real `~/.aws`.
 *
 * This setup file runs in every `unit` worker before the test files. It
 * removes the credential variables from `process.env` and points
 * AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE at paths that do not exist,
 * so the chain finds no keys, no profile and no shared files, whatever HOME
 * says. Processes a test spawns inherit the same environment.
 *
 * A test that needs a profile opts in by injecting `env` (with its own HOME or
 * AWS_CONFIG_FILE in a temp directory), as the credential-chain and whoami
 * tests do, or by setting `process.env` itself and restoring it afterwards.
 */
export const AWS_CREDENTIAL_VARS = [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;

/** Never created. The per-run TMPDIR (test/per-run-tmpdir.setup.ts) is removed after the run. */
export const NO_AWS_DIR = join(tmpdir(), "chant-unit-no-aws");

for (const name of AWS_CREDENTIAL_VARS) delete process.env[name];
process.env.AWS_CONFIG_FILE = join(NO_AWS_DIR, "config");
process.env.AWS_SHARED_CREDENTIALS_FILE = join(NO_AWS_DIR, "credentials");
