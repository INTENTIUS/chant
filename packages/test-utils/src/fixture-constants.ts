/**
 * Lexicon-neutral test fixture constants.
 *
 * Use these in core tests instead of hardcoding any specific lexicon's
 * names, entity types, or package names.
 */
export const FIXTURE = {
  lexicon: "testdom",
  namespace: "TST",
  entityType: "TestDom::Storage::Bucket",
  packageName: "@intentius/chant-lexicon-testdom",
  lexiconJsonFilename: "lexicon-testdom.json",
  intrinsicPrefix: "Fn::",
  pseudoParam: "TestDom::StackName",
  interpolationFn: "Fn::Interpolate",
} as const;
