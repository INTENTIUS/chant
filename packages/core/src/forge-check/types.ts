/**
 * The forge check's rows and result (#4608).
 */

import type { IdentityCloud } from "../ci-identity";
import type { ForgeFetch, ForgeKind } from "../pr-forge";
import type { ForgeCheckRepository } from "./contract";

export const CHECK_STATUSES = ["match", "mismatch", "unknown", "not-checked"] as const;

/**
 * `match` and `mismatch` compare what was read with the contract. `unknown`:
 * the setting could not be read (a scope the token lacks, an edition without
 * the feature). `not-checked`: no credentials for that cloud.
 */
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type CheckWhere = ForgeKind | IdentityCloud;

export interface CheckRow {
  where: CheckWhere;
  /**
   * What is checked: repository, environment, deployment-branches,
   * runner-group, protected-environment, protected-runners, variable,
   * protected-branch, required-status, status-reported, oidc-issuer, trust.
   */
  check: string;
  /** The thing checked: an environment, a runner group or tag set, a variable, a branch, a status, a role, a provider, an app, a Pulumi token. */
  subject: string;
  expected: string;
  found: string;
  status: CheckStatus;
}

export interface ForgeCheckResult {
  /** `<product>.forge-check/v1`. */
  schema: string;
  /** The config the contract came from, when the product names one. */
  file?: string;
  forge: ForgeKind;
  repository: ForgeCheckRepository;
  rows: CheckRow[];
  counts: Record<CheckStatus, number>;
  /** No mismatch, and with `requireClouds` no cloud left unchecked. */
  ok: boolean;
}

export interface ForgeCheckDeps {
  /** Every request goes through ./read-only.ts's wrapper around it. */
  fetch: ForgeFetch;
  /** Credentials: AWS_ACCESS_KEY_ID and the rest, GOOGLE_OAUTH_ACCESS_TOKEN, AZURE_GRAPH_TOKEN, PULUMI_ACCESS_TOKEN, and AWS_ENDPOINT_URL_IAM. */
  env: Record<string, string | undefined>;
  /** Reads the AWS shared credentials file; undefined when there is none. */
  readFile?: (path: string) => string | undefined;
  now?: () => Date;
  /** For a loopback fake: GCP IAM's and Microsoft Graph's origins. */
  endpoints?: { gcpIam?: string; graph?: string };
}

/** A read's outcome: the value, or why it could not be had. */
export type Read<T> = { ok: true; value: T } | { ok: false; status: number | undefined; why: string };

export const couldNot = (r: { status: number | undefined }, need: string): string => `could not read (${r.status ?? "no answer"}); ${need}`;

export const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/** The scopes each read needs, as the rows and the docs name them. */
export const SCOPES = {
  github: "the token needs Metadata: read and Actions: read on the repository (classic: repo)",
  githubOrg: "the token needs Self-hosted runners: read on the organization (classic: admin:org)",
  gitlab: "the token needs the read_api scope and the Maintainer role",
  gitlabEdition: "protected environments are GitLab Premium; on another edition, or without read_api and the Maintainer role, they cannot be read",
  forgejo: "the token needs read:repository, and its user admin on the repository",
  aws: "the credentials need iam:GetRole on the role",
  gcp: "the token needs iam.workloadIdentityPoolProviders.get on the provider",
  azure: "the token needs Application.Read.All (Microsoft Graph)",
  pulumi: "the token needs to read the organization's OIDC issuers and their policies (an organization admin's)",
};
