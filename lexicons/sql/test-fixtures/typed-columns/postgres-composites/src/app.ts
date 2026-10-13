import { schema } from "@intentius/chant-lexicon-sql/postgres";

// The type argument is the schema's name, which a composite placed in it needs
// to know its members' qualified names.
export const app = schema<"app">`CREATE SCHEMA app`;
