// The factory's builder hook, a stub (#3406). An orchestrator such as studio
// runs a builder agent here: in the run's worktree, for FACTORY_ITEM at
// FACTORY_TIER, with the context bundle FACTORY_CONTEXT names. It exits 0 when
// the builder finished, and may print { "reverted": [paths] } as its last line
// when its guard put changes back.
console.error(`no builder is wired in this reference workspace; ${process.env.FACTORY_ITEM} at tier ${process.env.FACTORY_TIER} was not built`);
process.exit(1);
