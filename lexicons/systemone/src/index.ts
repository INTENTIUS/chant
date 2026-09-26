// The config namespace: importing the package brings `systemone` into ChantConfig.
export { systemoneConfigSchema, backendSchema, keySchema } from "./config";
export type { SystemoneConfig, SystemoneBackend, BackendKey, EnvKey, BrokeredKey } from "./config";

// The typed step builder for the decide activity.
export { decide } from "./op/builders";
export type { DecideArgs, DecideResult } from "./op/activities/decide";

// The wire-format client and the stub server for tests.
export { systemoneAsk, postQuestion, questionName, resolveKey, brokeredCapability, SYSTEMONE_PATH, SystemoneConfigError } from "./backend";
export type { SystemoneRequest, SystemoneResponse, SystemoneAskOptions, BrokeredCapability } from "./backend";
export { startStubBackend, defaultAnswer } from "./stub-backend";
export type { StubBackend, StubBackendOptions } from "./stub-backend";

// Plugin
export { systemonePlugin } from "./plugin";

// Serializer
export { systemoneSerializer } from "./serializer";
