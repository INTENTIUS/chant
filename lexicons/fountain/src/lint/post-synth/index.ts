export { networkingExplicitCheck } from "./ftn010-networking-explicit";
export { noCloudCredentialEnvCheck } from "./ftn012-no-cloud-credential-env";

import { networkingExplicitCheck } from "./ftn010-networking-explicit";
import { noCloudCredentialEnvCheck } from "./ftn012-no-cloud-credential-env";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";

export const postSynthChecks: PostSynthCheck[] = [networkingExplicitCheck, noCloudCredentialEnvCheck];
