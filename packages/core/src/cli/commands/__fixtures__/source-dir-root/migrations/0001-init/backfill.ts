// A migration's backfill script: a root build that loads it fails (#4921).
export const backfill = "ran";
throw new Error("migrations/0001-init/backfill.ts was loaded");
