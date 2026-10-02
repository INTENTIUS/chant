/**
 * Skip index parameters: the overlay half.
 *
 * `system.data_skipping_index_types` names each type and gives a syntax line,
 * from which the generator reads parameter names and optionality. This adds
 * their kinds and ranges. `GRANULARITY` is fixed grammar the parser owns.
 */

import type { ArgumentOverlay } from "./kinds";

const HASHES: ArgumentOverlay = { kind: "number", range: [1, 1_000_000], note: "Hash functions per value." };
const BYTES: ArgumentOverlay = { kind: "number", note: "Bloom filter size in bytes." };
const SEED: ArgumentOverlay = { kind: "number", note: "Seed for the hash functions." };

export const SKIP_INDEX_PARAMETERS: Record<string, Record<string, ArgumentOverlay>> = {
  bloom_filter: {
    false_positive_rate: { kind: "number", range: [0, 1], note: "Exclusive of 0 and 1; 0.025 when omitted." },
  },
  set: { max_rows: { kind: "number", note: "0 keeps every distinct value." } },
  ngrambf_v1: {
    n: { kind: "number", range: [1, 256], note: "N-gram size." },
    size_in_bytes: BYTES,
    num_hash_functions: HASHES,
    seed: SEED,
  },
  tokenbf_v1: { size_in_bytes: BYTES, num_hash_functions: HASHES, seed: SEED },
  sparse_grams: {
    min_ngram_length: { kind: "number" },
    max_ngram_length: { kind: "number" },
    min_cutoff_length: { kind: "number" },
    size_in_bytes: BYTES,
    num_hash_functions: HASHES,
    seed: SEED,
  },
  text: { tokenizer: { kind: "expression", note: "A tokenizer such as splitByNonAlpha, ngrams(N) or array." } },
  vector_similarity: {
    hnsw: { kind: "keyword", values: ["hnsw"], note: "The only method." },
    distance_function: { kind: "keyword", values: ["L2Distance", "cosineDistance"] },
    dimensions: { kind: "number" },
    quantization: { kind: "keyword", values: ["f64", "f32", "f16", "bf16", "i8", "b1"] },
    hnsw_max_connections_per_layer: { kind: "number" },
    hnsw_candidate_list_size_for_construction: { kind: "number" },
  },
};
