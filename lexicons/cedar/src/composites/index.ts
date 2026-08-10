/**
 * Cedar lexicon composites.
 *
 * Cedar has no functions, no modules, no loops, and templates with exactly two
 * slots — so every repeated policy shape is copy-paste in `.cedar` text. These
 * factories are where that repetition goes instead.
 */

export { OwnerCanManage } from "./owner-can-manage";
export type { OwnerCanManageOpts } from "./owner-can-manage";

export { DenyByDefaultSet } from "./deny-by-default-set";
export type { DenyByDefaultSetOpts, DenyByDefaultSetResources } from "./deny-by-default-set";
