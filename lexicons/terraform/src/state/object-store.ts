/**
 * What the state stores share: the fetch they call, their errors, and how a
 * key goes into a URL. Since #4554 these are chant core's object-store
 * definitions (`@intentius/chant/object-store`), so a store error thrown by
 * a core client is the one a state caller catches.
 */
export { defaultFetch, encodePath, encodeStrict, StoreConflict, StoreError, xmlText, type StoreCondition, type StoreFetch } from "@intentius/chant/object-store";
