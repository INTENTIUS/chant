// Outside sourceDir: a build of the project that loads it fails (#4794).
export const app = "app";
throw new Error("app.ts was loaded");
