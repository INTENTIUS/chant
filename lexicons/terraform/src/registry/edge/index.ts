/**
 * The edge function for bucket-hosted module registries (chant#4566): the
 * download header always, and with `auth` a bearer token check and signed
 * tarball URLs. Platform adapters for a Cloudflare Worker and Lambda@Edge.
 */
export * from "./edge";
export * from "./worker";
export * from "./lambda-edge";
export * from "./token-source";
export * from "./sigv4-web";
