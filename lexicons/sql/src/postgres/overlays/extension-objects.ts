/**
 * What the common extensions add, for lint: the types, functions, index
 * access methods and operator classes a declaration may name once the project
 * declares the extension. The pinned catalogs are read from a server with no
 * extension installed, so none of these are in them.
 *
 * The list is not exhaustive. A name the core catalog does not have and no
 * entry here covers is reported as a warning when the project declares any
 * extension (it may come from one), and as an error when it declares none.
 * A name an entry here covers, used without that extension declared, is an
 * error that names the extension.
 *
 * Sources: the reference page of each contrib module
 * (https://www.postgresql.org/docs/18/contrib.html), PostGIS
 * (https://postgis.net/docs/reference.html) and pgvector
 * (https://github.com/pgvector/pgvector#reference).
 */

export interface ExtensionObjects {
  types?: readonly string[];
  functions?: readonly string[];
  /** Function name prefixes the extension owns (`st_` for PostGIS). */
  functionPrefixes?: readonly string[];
  accessMethods?: readonly string[];
  /** Operator classes by access method. */
  opclasses?: Readonly<Record<string, readonly string[]>>;
}

const BTREE_GIN = [
  "int2_ops", "int4_ops", "int8_ops", "float4_ops", "float8_ops", "money_ops", "oid_ops", "timestamp_ops", "timestamptz_ops",
  "time_ops", "timetz_ops", "date_ops", "interval_ops", "macaddr_ops", "macaddr8_ops", "inet_ops", "cidr_ops", "text_ops",
  "varchar_ops", "char_ops", "bytea_ops", "bit_ops", "varbit_ops", "numeric_ops", "enum_ops", "uuid_ops", "name_ops",
  "bool_ops", "bpchar_ops",
];
const BTREE_GIST = [
  "gist_int2_ops", "gist_int4_ops", "gist_int8_ops", "gist_float4_ops", "gist_float8_ops", "gist_numeric_ops", "gist_oid_ops",
  "gist_timestamp_ops", "gist_timestamptz_ops", "gist_time_ops", "gist_timetz_ops", "gist_date_ops", "gist_interval_ops",
  "gist_cash_ops", "gist_macaddr_ops", "gist_macaddr8_ops", "gist_text_ops", "gist_bpchar_ops", "gist_bytea_ops", "gist_bit_ops",
  "gist_vbit_ops", "gist_inet_ops", "gist_cidr_ops", "gist_uuid_ops", "gist_enum_ops", "gist_bool_ops",
];
const VECTOR_OPS = ["vector_l2_ops", "vector_ip_ops", "vector_cosine_ops", "vector_l1_ops", "halfvec_l2_ops", "halfvec_ip_ops", "halfvec_cosine_ops", "halfvec_l1_ops", "sparsevec_l2_ops", "sparsevec_ip_ops", "sparsevec_cosine_ops", "sparsevec_l1_ops", "bit_hamming_ops", "bit_jaccard_ops"];

export const EXTENSION_OBJECTS: Readonly<Record<string, ExtensionObjects>> = {
  bloom: { accessMethods: ["bloom"], opclasses: { bloom: ["int4_ops", "text_ops"] } },
  btree_gin: { opclasses: { gin: BTREE_GIN } },
  btree_gist: { opclasses: { gist: BTREE_GIST } },
  citext: { types: ["citext"], opclasses: { btree: ["citext_ops", "citext_pattern_ops"], hash: ["citext_ops"] } },
  cube: { types: ["cube"], functions: ["cube", "cube_dim", "cube_ll_coord", "cube_ur_coord", "cube_is_point", "cube_enlarge", "cube_subset", "cube_union", "cube_inter", "cube_size", "cube_distance"], opclasses: { gist: ["gist_cube_ops"] } },
  earthdistance: { types: ["earth"], functions: ["earth", "earth_distance", "earth_box", "ll_to_earth", "latitude", "longitude", "sec_to_gc", "gc_to_sec"] },
  fuzzystrmatch: { functions: ["soundex", "difference", "levenshtein", "levenshtein_less_equal", "metaphone", "dmetaphone", "dmetaphone_alt", "daitch_mokotoff"] },
  hstore: {
    types: ["hstore"],
    functions: ["hstore", "akeys", "avals", "skeys", "svals", "hstore_to_array", "hstore_to_matrix", "hstore_to_json", "hstore_to_jsonb", "hstore_to_json_loose", "hstore_to_jsonb_loose", "slice", "exist", "defined", "delete", "each", "populate_record"],
    opclasses: { gist: ["gist_hstore_ops"], gin: ["gin_hstore_ops"], btree: ["btree_hstore_ops"], hash: ["hash_hstore_ops"] },
  },
  intarray: {
    functions: ["icount", "sort", "sort_asc", "sort_desc", "uniq", "idx", "subarray", "intset"],
    opclasses: { gist: ["gist__int_ops", "gist__intbig_ops"], gin: ["gin__int_ops"] },
  },
  isn: { types: ["ean13", "isbn", "isbn13", "ismn", "ismn13", "issn", "issn13", "upc"], functions: ["isn_weak", "make_valid", "is_valid"] },
  ltree: {
    types: ["ltree", "lquery", "ltxtquery"],
    functions: ["subltree", "subpath", "nlevel", "index", "text2ltree", "ltree2text", "lca"],
    opclasses: { gist: ["gist_ltree_ops", "gist__ltree_ops"], btree: ["ltree_ops"], hash: ["hash_ltree_ops"] },
  },
  pg_trgm: {
    functions: ["similarity", "word_similarity", "strict_word_similarity", "show_trgm", "show_limit", "set_limit"],
    opclasses: { gin: ["gin_trgm_ops"], gist: ["gist_trgm_ops"] },
  },
  pgcrypto: {
    functions: [
      "digest", "hmac", "crypt", "gen_salt", "gen_random_bytes", "gen_random_uuid", "encrypt", "decrypt", "encrypt_iv", "decrypt_iv",
      "pgp_sym_encrypt", "pgp_sym_encrypt_bytea", "pgp_sym_decrypt", "pgp_sym_decrypt_bytea", "pgp_pub_encrypt", "pgp_pub_encrypt_bytea",
      "pgp_pub_decrypt", "pgp_pub_decrypt_bytea", "pgp_key_id", "armor", "dearmor", "pgp_armor_headers",
    ],
  },
  postgis: {
    types: ["geometry", "geography", "box2d", "box3d"],
    functionPrefixes: ["st_", "postgis_"],
    opclasses: {
      gist: ["gist_geometry_ops_2d", "gist_geometry_ops_nd", "gist_geography_ops"],
      brin: ["brin_geometry_inclusion_ops_2d", "brin_geometry_inclusion_ops_3d", "brin_geometry_inclusion_ops_4d", "brin_geography_inclusion_ops"],
      spgist: ["spgist_geometry_ops_2d", "spgist_geometry_ops_3d", "spgist_geometry_ops_nd", "spgist_geography_ops_nd"],
      btree: ["btree_geometry_ops", "btree_geography_ops"],
      hash: ["hash_geometry_ops"],
    },
  },
  seg: { types: ["seg"], opclasses: { gist: ["gist_seg_ops"] } },
  tablefunc: { functions: ["crosstab", "normal_rand", "connectby"] },
  unaccent: { functions: ["unaccent"] },
  "uuid-ossp": {
    functions: ["uuid_generate_v1", "uuid_generate_v1mc", "uuid_generate_v3", "uuid_generate_v4", "uuid_generate_v5", "uuid_nil", "uuid_ns_dns", "uuid_ns_url", "uuid_ns_oid", "uuid_ns_x500"],
  },
  vector: {
    types: ["vector", "halfvec", "sparsevec"],
    functions: ["l2_distance", "inner_product", "cosine_distance", "l1_distance", "vector_dims", "vector_norm", "l2_norm", "l2_normalize", "binary_quantize", "subvector", "hamming_distance", "jaccard_distance"],
    accessMethods: ["hnsw", "ivfflat"],
    opclasses: { hnsw: VECTOR_OPS, ivfflat: VECTOR_OPS.filter((o) => !o.startsWith("sparsevec") && !o.endsWith("l1_ops") && o !== "bit_jaccard_ops") },
  },
};
