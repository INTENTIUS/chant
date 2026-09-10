import type { ChantConfig } from "@intentius/chant";

/**
 * Two lexicons, and that is the shape augur is for: aws declares the estate,
 * augur declares the question. A project already using k8s, or gcp, or several
 * at once, adds augur beside them the same way.
 */
export default { lexicons: ["augur", "aws"] } satisfies ChantConfig;
