/**
 * A small policy set, authored against schema-derived types.
 *
 * Everything imported below is generated from `schema.cedarschema` — the
 * action constants, the entity type names, and the entity UID types. A typo in
 * `App::Documnt` or a reference to an action the schema never declared is a
 * compile error here, which is the whole reason this lexicon exists: Cedar's
 * own toolchain can only tell you after the text is written.
 */

import {
  DeleteAction,
  ListAction,
  Policy,
  ReadAction,
  WriteAction,
  type UserUid,
} from "@intentius/chant-lexicon-cedar";

/** The break-glass account that owns the archive folder. */
const archivist: UserUid = 'App::User::"archivist"';

/** Anyone in engineering may read a document they own. */
export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { in: [ReadAction, ListAction] },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
  annotations: {
    doc: "Owners always read their own documents.",
  },
});

/** Public documents are readable by every user, with MFA. */
export const publicRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.public == true", "context.mfa == true"],
});

/** Writes are limited to the owner and require MFA. */
export const ownerWrite = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: WriteAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
  unless: ["context.mfa == false"],
});

/** Nobody deletes a confidential document except the archivist. */
export const restrictDelete = new Policy({
  effect: "forbid",
  action: { eq: DeleteAction },
  resource: { is: "App::Document" },
  when: ['resource.classification == "confidential"'],
  unless: [`principal == ${archivist}`],
});
