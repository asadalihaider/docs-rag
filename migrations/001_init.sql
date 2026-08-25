-- docs-rag schema.
--
-- {{EMBEDDING_DIM}} is substituted by the migration runner from the configured
-- embedder's dimensionality (see src/providers/store/pgvector.ts). If you apply
-- this file by hand with psql, substitute it yourself, e.g.
--   sed 's/{{EMBEDDING_DIM}}/1536/' migrations/001_init.sql | psql "$DATABASE_URL"

CREATE EXTENSION IF NOT EXISTS vector;

-- Key/value metadata so a mismatch between the configured embedder and the one
-- the index was built with fails loudly instead of returning garbage neighbours.
CREATE TABLE IF NOT EXISTS rag_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id            text PRIMARY KEY,           -- path relative to the ingest root
  title         text NOT NULL,
  content_hash  text NOT NULL,              -- sha256 of the raw file
  frontmatter   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id            text PRIMARY KEY,           -- "<document_id>#<ordinal>"
  document_id   text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,
  heading_path  text[] NOT NULL DEFAULT '{}',
  content       text NOT NULL,
  content_hash  text NOT NULL,              -- sha256 of heading path + content
  token_count   integer NOT NULL,
  term_count    integer NOT NULL,           -- |D| for BM25 length normalisation
  start_line    integer NOT NULL,
  end_line      integer NOT NULL,
  embedding     vector({{EMBEDDING_DIM}}) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);

-- HNSW over cosine distance.
--
-- HNSW rather than IVFFlat: IVFFlat needs a representative sample to build its
-- lists, so it must be (re)built *after* data is loaded and degrades as the
-- corpus grows past the list count. Documentation is ingested incrementally, so
-- an index that can be created up front and stays correct as rows arrive is
-- worth the extra build cost and memory.
--
-- m = 16 / ef_construction = 64 are pgvector's defaults and are a sensible
-- starting point up to a few hundred thousand chunks. Query-time recall is
-- tuned with hnsw.ef_search, which the store sets per connection.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Inverted index for the BM25 half of hybrid retrieval.
--
-- We store our own analyzed terms rather than using to_tsvector/ts_rank so that
-- the *identical* analyzer (see src/retrieval/analyzer.ts) runs for the Postgres
-- store and the in-memory store, and so scoring is true Okapi BM25 rather than
-- Postgres' ts_rank_cd, which is not BM25 and has no length normalisation.
CREATE TABLE IF NOT EXISTS chunk_terms (
  chunk_id  text NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  term      text NOT NULL,
  tf        integer NOT NULL,
  PRIMARY KEY (chunk_id, term)
);

CREATE INDEX IF NOT EXISTS chunk_terms_term_idx ON chunk_terms (term);
