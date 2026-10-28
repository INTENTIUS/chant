/**
 * The S3 client a state's lock and write use: chant core's (#4554,
 * `@intentius/chant/object-store`), which signs with chant's one AWS
 * signer. Get, put, put only when absent, head and delete one object; with
 * no static keys, a role is assumed with the job's OIDC token through STS
 * AssumeRoleWithWebIdentity.
 */
import { s3FromEnv as coreS3FromEnv, type S3Target } from "@intentius/chant/object-store";

export { assumeRoleWithWebIdentity, S3Client, sign, type S3Credentials, type S3Location, type S3Target, type S3WebIdentity } from "@intentius/chant/object-store";

/**
 * The target for `bucket` from the AWS environment variables. Credentials,
 * first match wins: static keys in `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY`; `AWS_ROLE_ARN` assumed with the token in
 * `AWS_WEB_IDENTITY_TOKEN_FILE`, in a session named `chant-state` unless
 * AWS_ROLE_SESSION_NAME names one.
 */
export function s3FromEnv(where: { bucket: string; endpoint?: string }, env: NodeJS.ProcessEnv = process.env): S3Target {
  return coreS3FromEnv({ ...where, sessionName: "chant-state", setting: "the state bucket" }, env);
}
