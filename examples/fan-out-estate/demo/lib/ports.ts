/**
 * The three things the fan-out demo's cycle talks to, as small interfaces:
 * the forge (Forgejo's REST API and git), the bucket (floci's S3, where the
 * step, the cycles and chant's reports live) and chant (`chant approve` from
 * the reviewer's clone, and the base applied again with `chant run`). They
 * are the e2e harness's ports (chant#4587); the cycle needs only the pull
 * request loop of its forge. The real ones are in forgejo.ts, bucket.ts and
 * chant.ts; the tests pass fakes.
 */
export {
  realClock,
  type ApproveInput,
  type Bucket,
  type Chant,
  type Clock,
  type Log,
  type PullForge as Forge,
} from "../../../../packages/core/src/e2e-harness/ports.js";
