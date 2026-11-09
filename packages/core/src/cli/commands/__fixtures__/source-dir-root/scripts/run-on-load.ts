// A script that runs on load: a build that loads it fails (#4794).
export const script = "ran";
throw new Error("scripts/run-on-load.ts was loaded");
