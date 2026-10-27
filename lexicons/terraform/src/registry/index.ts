/**
 * The Terraform module registry protocol (chant#4565): addresses, the writer
 * of the protocol's files, the reader as Terraform and OpenTofu read them,
 * and a handler that serves the files with the download header both CLIs
 * install from. Moved from terragucci's `publish/registry.ts`; products keep
 * their config keys and presets and call this.
 */

export * from "./address";
export * from "./semver";
export * from "./writer";
export * from "./reader";
export * from "./handler";
export * from "./serve";
export * from "./headers-file";
export * from "./mirror";
export * from "./edge";
