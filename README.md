# docs-rag

Retrieval-augmented Q&A over a Markdown documentation set, in TypeScript on
Node 22. Ask a question, get an answer that quotes only the retrieved
documentation, with every citation checked against what was actually
retrieved before it is shown to you.

The engineering point of this project isn't "call an LLM with some context" —
it's the parts around that call that make a RAG system trustworthy enough to
ship: hybrid retrieval that fuses two retrievers with genuinely different
failure modes, an abstention signal that refuses to guess when the corpus
doesn't cover the question, heading-aware chunking that keeps section context
attached to every chunk, and citation verification that strips any footnote
marker the model invents rather than trusting it. Every one of those is
exercised end-to-end against the real `sample-docs/` corpus in this repo, with
no mocked-out plumbing — see [Evaluation](#evaluation) for the numbers that
run produces.

It runs two ways. The **offline path** — an in-memory vector store, a
deterministic hashed n-gram embedder, and an extractive mock chat model — needs
no API key, no database, and no network access, and is what `npm test` and the
commands below actually exercise. The **real path** swaps in an OpenAI or
local embedder, Claude or GPT for generation, and Postgres/pgvector for
storage, behind the same interfaces. Nothing about the retrieval, chunking,
confidence, or citation code changes between the two — see
[Quickstart](#quickstart).

## Architecture

```mermaid
flowchart TB
    subgraph ingest["Ingestion — src/ingest/"]
        docs[("sample-docs/**/*.md")] --> walk["walk.ts\nfind + hash files"]
        walk --> fm["frontmatter.ts"]
        fm --> chunk["chunker.ts\nheading-aware chunking"]
        chunk --> embed1["Embedder.embed()"]
        embed1 --> store1[("VectorStore\nupsertDocument")]
    end

    subgraph ask["POST /ask · RagService.ask()"]
        q(["question"]) --> embed2["Embedder.embed(query)"]
        embed2 --> dense["VectorStore.denseSearch()\ncosine similarity"]
        q --> analyze["analyzer.ts\ntokenize + stem"]
        analyze --> sparse["VectorStore.sparseSearch()\nOkapi BM25"]
        dense --> rrf["rrf.ts\nReciprocal Rank Fusion"]
        sparse --> rrf
        rrf --> conf{"confidence.ts\nevidence strength × query coverage\n≥ RAG_MIN_CONFIDENCE?"}
        conf -- "no" --> refuse["refuse — model never called"]
        conf -- "yes" --> rerank["rerank.ts (optional)\nLLM cross-encoder-style reorder"]
        rerank --> context["context.ts\nbuildContext — pack under token budget"]
        context --> prompt["prompt.ts\nbuildAnswerPrompt"]
        prompt --> gen["ChatModel.complete() / .stream()"]
        gen --> verify["citations.ts\nverifyCitations\nstrip unverifiable [^n], renumber"]
        verify --> answer(["AnswerResult\nanswer + citations + timings"])
    end

    store1 -.-> dense
    store1 -.-> sparse
```

The three provider interfaces (`Embedder`, `ChatModel`, `VectorStore` — all in
[`src/types.ts`](src/types.ts)) are what everything above is written against.
[`src/providers/factory.ts`](src/providers/factory.ts) is the single place
that picks concrete implementations from config, which is what makes the
offline configuration a fully working system rather than a stubbed-out demo of
one — the exact same `RagService`, `HybridRetriever`, chunker and citation
verifier run in both paths.

## Why hybrid retrieval beats pure vector search

[`HybridRetriever`](src/retrieval/hybrid.ts) runs dense (cosine over
embeddings) and sparse (Okapi BM25, implemented directly in
[`bm25.ts`](src/retrieval/bm25.ts)) retrieval over the _same_ chunk corpus in
parallel and fuses the two candidate lists with
[Reciprocal Rank Fusion](src/retrieval/rrf.ts) — deliberately not a cascade
(BM25 filter → vector rerank), because a cascade can only lose recall, and the
whole point of running both is that they fail on different questions:

- **BM25 nails exact identifiers** — error codes, flag names, config keys —
  that an embedding smooths away into "something about errors". Asking this
  repo's ingested corpus _"What does error LK-3007 mean?"_ retrieves
  `reference/error-codes.md` at dense rank #4 but BM25 rank #2, because `LK-3007`
  is one exact token match worth more than any amount of semantic similarity.
- **Dense retrieval catches paraphrase** that shares no vocabulary with the
  docs — the eval set has a question that says _"the clocks changed"_ about a
  page that only ever says _"daylight saving"_, which is exactly the case BM25
  cannot help with.

RRF combines the two by **rank**, not by raw score, which matters because
cosine similarity and BM25 live on incompatible scales — one is roughly
`[0, 1]`, the other is unbounded and corpus-dependent — and per-query score
normalisation (min/max, z-score) is fragile on short candidate lists. Rank is
scale-free:

```
RRF(d) = Σ_r  w_r / (k + rank_r(d))
```

`RAG_DENSE_WEIGHT` / `RAG_SPARSE_WEIGHT` let either side be silenced entirely
(the eval command's `dense` and `sparse` modes do exactly that), and the
[measured numbers below](#evaluation) show the effect directly rather than
asserting it.

**Retrieval confidence is a separate, harder problem from fusion**, handled in
[`confidence.ts`](src/retrieval/confidence.ts) and worth calling out because
the obvious approaches don't work: thresholding the top cosine similarity
needs re-tuning per embedding model and, measured on this repo's own corpus,
on-topic and off-topic questions produce overlapping score ranges anyway.
Thresholding the fused RRF score doesn't work for a structural reason — RRF is
a function of rank alone, so the top result of a query with _no_ relevant
document scores identically to the top result of a perfect match. What
`computeConfidence` actually measures is **evidence strength × query
coverage**: how far the top candidate stands above the mediocre tail of its
own retriever's candidate list (a per-query, self-normalising baseline), times
how much of the question's content words the best passage actually contains.
Below `RAG_MIN_CONFIDENCE` (default `0.30`) the service refuses and **never
calls the chat model** — see `chat.requests` assertions in
[`tests/refusal.test.ts`](tests/refusal.test.ts) — because an abstention
should cost nothing, not one wasted generation.

## Chunking strategy

[`chunkDocument`](src/ingest/chunker.ts) is a heading-aware packer, not a
fixed-size splitter, built on a purpose-written block scanner
([`blocks.ts`](src/ingest/blocks.ts)) rather than a full CommonMark parser —
narrower, but line-faithful, which citations depend on. The algorithm:

1. Scan the document into heading / fenced-code / text blocks, tracking a
   heading stack so every block knows its full ancestry (`['Installation',
'Docker', 'Compose']`).
2. Pack blocks into chunks up to `CHUNK_TARGET_TOKENS` (default 400), starting
   a fresh chunk whenever the heading path changes — a chunk never straddles
   two sections.
3. Never split a fenced code block. An oversized fence becomes its own
   over-budget chunk instead, because half a `docker-compose.yml` is worse
   than useless as a retrieval result (see the `never splits a code fence
across chunks, even an oversized one` test).
4. Carry `CHUNK_OVERLAP_TOKENS` (default 60) of trailing text into the next
   chunk _within_ the same section, so a fact split across a chunk boundary
   is still retrievable from either side — but overlap never crosses a
   heading, and never repeats a code fence.
5. Merge chunks below `CHUNK_MIN_TOKENS` into a neighbour when they share a
   heading ancestor, keeping the _common_ ancestor path — a stub "See also"
   section doesn't become its own noisy retrieval unit, and a merge never
   claims a chunk came from a section it didn't.

Heading-awareness matters for two concrete reasons the code documents inline.
First, the heading line is kept **in the chunk body**, not only in the
structured `headingPath` — a chunk under `Troubleshooting > Job stuck in
pending` often never repeats the words "troubleshooting" or "pending" in its
own prose, so without the heading text physically in the indexed content,
neither BM25 nor the embedder can connect it to a question phrased in those
terms. Second, [`contextualText()`](src/ingest/chunker.ts) prepends the
document title and heading breadcrumb (`"Installation > Docker\n\n<chunk
body>"`) at embedding and prompt-build time — added there rather than stored
in `Chunk.content`, so the persisted chunk text stays byte-faithful to the
source for citation excerpts.

Ingestion is incremental at two levels
([`ingest/pipeline.ts`](src/ingest/pipeline.ts)): a document whose SHA-256
hasn't changed is skipped entirely (no parse, no chunk, no embed calls — see
`is a genuine no-op when nothing changed` in
[`tests/incremental.test.ts`](tests/incremental.test.ts)), and within a
changed document, each chunk is hashed over `heading path + text`, so editing
one paragraph of a long page re-embeds one chunk, not the whole file.

## Citation verification

Grounding a model in retrieved passages reduces hallucination; it does not
eliminate it, and invented citation markers are one of the places that shows
up most convincingly — a model shown five sources will cheerfully emit `[^7]`.
[`verifyCitations`](src/answer/citations.ts) treats every `[^n]` marker the
model produces as untrusted input and checks it against the actual retrieval
record before any citation reaches the caller:

1. **Strip** any marker whose number wasn't in the retrieved source set, and
   log it (`logger.warn('stripped unverifiable citation markers', ...)`) so a
   real deployment can alert on the rate.
2. **Strip footnote-definition blocks** the model appends despite being told
   not to — the source list the caller renders comes from retrieval data, not
   from anything the model wrote.
3. **Renumber** the survivors densely, `1..m` in order of first appearance, so
   a reader never sees `[^1]` then `[^5]` with nothing between them.
4. **Build each `Citation`** — file, heading path, retrieval score, excerpt —
   from the retrieval record, never from model output. Nothing in the final
   citation list originated from the model; the model only chose _which_
   already-verified passages to point at.

What it deliberately does **not** do is check that the cited passage actually
_supports_ the sentence it's attached to — that needs an entailment check, and
is called out honestly in [What's next](#design-decisions--whats-next) rather
than pretended away. [`tests/citations.test.ts`](tests/citations.test.ts)
exercises the mechanism directly: an invented `[^7]` among two real markers is
stripped while the real ones survive and renumber correctly, and a swap case
(`[^2]` then `[^1]` in the text) confirms renumbering doesn't clobber when two
markers trade places.

## Evaluation

[`docs-rag eval`](src/cli.ts) runs every question in
[`eval/questions.jsonl`](eval/questions.jsonl) (18 hand-written questions
against this repo's `sample-docs/` corpus, phrased the way a user would ask
rather than the way the docs are worded) against real `RagService.ask()` calls
and reports:

- **recall@k** — did _any_ chunk from an expected file make the top k? The
  ceiling on answer quality: a generator cannot cite what retrieval never
  surfaced.
- **MRR** — mean reciprocal rank of the first relevant chunk; sensitive to
  ordering in a way recall isn't, which matters once the context token budget
  starts truncating the tail.
- **citation precision** — of the citations the _answer_ actually emitted,
  what fraction point at an expected file. This is the metric that would catch
  a system that retrieves well and then cites the wrong passage — recall and
  MRR are both blind to that failure mode.

Labels are file-level on purpose (chunk-level gold would have to be
re-annotated every time the chunker changes, which defeats using the set to
compare chunking strategies), and `expected_files` accepts any of several
pages where more than one genuinely answers the question.

### Measured numbers — offline path (`local-hashed-ngram-512` embedder, `mock` chat, in-memory store)

Reproduce with `npm run dev -- eval` after `npm run dev -- ingest sample-docs`. These are the actual numbers that command prints against this repo's corpus — nothing here is estimated.

| mode        | recall@1 | recall@3 | recall@5 | recall@10 |   MRR | citation precision | citations emitted | mean confidence | refusals |
| ----------- | -------: | -------: | -------: | --------: | ----: | -----------------: | ----------------: | --------------: | -------: |
| hybrid      |    66.7% |    94.4% |    94.4% |    100.0% | 0.794 |              51.9% |                54 |           0.446 |   0 / 18 |
| dense-only  |    61.1% |    72.2% |    83.3% |    100.0% | 0.700 |              54.2% |                24 |           0.290 |  10 / 18 |
| sparse-only |    83.3% |    88.9% |   100.0% |    100.0% | 0.889 |              51.9% |                54 |           0.556 |   0 / 18 |

(18 questions, `RAG_MIN_CONFIDENCE=0.30`, no reranking. `npm run dev -- eval --modes hybrid --rerank` — enabling the offline LLM-style reranker, which `MockChat` implements deterministically by term-coverage score — moves hybrid to recall@1 77.8% / MRR 0.847 / citation precision 46.3% / 0 refusals on the same run.)

**Read this table honestly, not as "hybrid beats dense."** `LocalEmbedder` is a
hashed character/word n-gram vectoriser (see
[`local.ts`](src/providers/embedder/local.ts)) — a real, documented
information-retrieval technique (signed feature hashing, Weinberger et al.
2009), zero API keys, byte-identical vectors on every machine — but it's
fundamentally lexical, not semantic. That's _why_ dense-only refuses 10 of 18
questions here: its confidence signal correctly detects that its own
similarity scores aren't discriminating well on this corpus. Swap in a real
embedding model (`EMBEDDER_PROVIDER=openai`) and the semantic/lexical balance
would shift — the paraphrase question in the eval set (_"clocks changed"_ vs.
the docs' _"daylight saving"_) is exactly the case a real embedding model is
expected to help with more than this one does. What the table demonstrates
faithfully either way is the _mechanism_: RRF fusion, the abstention
threshold, and citation verification all behave correctly and are all
independent of which embedder is plugged in — the same `HybridRetriever`,
`computeConfidence`, and `verifyCitations` code runs unchanged with
`text-embedding-3-small`.

Run the test suite for the same honesty applied to correctness rather than
retrieval quality: `npm test` — 99 tests, including
[`tests/e2e.test.ts`](tests/e2e.test.ts), which ingests the real
`sample-docs/` corpus (not a synthetic fixture) and asserts that a real
question produces a citation pointing at a real file and a real heading path
on disk.

## Quickstart

### Zero-setup path — no API keys, no Docker

The defaults in [`.env.example`](.env.example) _are_ the offline
configuration, so an empty `.env` (or none at all) already gives you this:

```bash
npm install
npm run dev -- ingest sample-docs        # walk, chunk, embed, index — local embedder
npm run dev -- ask "How do I run the whole thing locally with docker compose?" --show-retrieval
npm run dev -- eval                       # recall@k / MRR / citation precision, see above
npm run serve                             # HTTP API on :8080 — same defaults
```

`npm run dev` is `tsx src/cli.ts`; `docs-rag <command>` after `npm run build`
and `npm link` works identically. Nothing here reaches the network.

### Real path — real embeddings, real generation, real storage

```bash
docker compose up -d                      # Postgres 17 + pgvector
cp .env.example .env
```

Then edit `.env`:

```bash
EMBEDDER_PROVIDER=openai
OPENAI_API_KEY=sk-...
CHAT_PROVIDER=anthropic          # or CHAT_PROVIDER=openai
ANTHROPIC_API_KEY=sk-ant-...
VECTOR_STORE=pgvector
DATABASE_URL=postgres://docsrag:docsrag@localhost:5432/docsrag
```

```bash
npm run dev -- ingest sample-docs         # applies migrations/001_init.sql itself, HNSW index included
npm run dev -- ask "How do I get a database password out of Vault into a job?"
npm run serve
```

`PgVectorStore` ([`src/providers/store/pgvector.ts`](src/providers/store/pgvector.ts))
substitutes the configured embedder's dimensionality into
[`migrations/001_init.sql`](migrations/001_init.sql) and applies it on first
connect, builds an HNSW cosine index, and stores its own analyzed BM25 terms
in a `chunk_terms` table rather than relying on Postgres `ts_rank_cd` — which
isn't Okapi BM25 and has no length normalisation — so the sparse half of
retrieval scores identically to the in-memory path.

## API reference

All three routes are defined in [`src/server.ts`](src/server.ts).

### `GET /healthz`

```json
{
  "status": "ok",
  "store": "memory",
  "embedder": "local-hashed-ngram-512",
  "chat": "mock",
  "documents": 20,
  "chunks": 74
}
```

`status` is `"degraded"` if the store can't be reached. The store is
initialised eagerly at server startup (not lazily on the first `/ask`), so a
bad `DATABASE_URL` fails at boot and `documents`/`chunks` are accurate from
the first request, not `0` until something happens to touch the store.

### `POST /ask`

```json
{ "question": "string, required", "topK": 6, "rerank": false, "minConfidence": 0.3, "stream": true }
```

`stream: false` returns one JSON `AnswerResult` (`answer`, `citations`,
`usage`, `timings`, `refused`, `confidence`, `retrieved`,
`droppedCitations`). The default, `stream: true`, opens
`text/event-stream` and emits, in order:

| event       | payload                          | when                                                                                         |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `retrieval` | fused candidates + confidence    | immediately, before generation, so a UI can show sources while the answer is still streaming |
| `token`     | one text delta                   | per generated chunk                                                                          |
| `final`     | the full verified `AnswerResult` | once, after citation verification completes                                                  |
| `error`     | `{ message }`                    | on a terminal failure mid-stream                                                             |

The `final` event repeats the whole answer rather than only citations,
because citation verification cannot run until generation finishes — a client
renders `token` deltas for perceived latency and then swaps in
`final.result.answer`, which is the text whose citations were actually
checked.

### `POST /ingest`

```json
{ "dir": "sample-docs", "force": false, "prune": true }
```

Returns an `IngestReport` — `filesScanned`, `documentsIngested`,
`documentsUnchanged`, `documentsPruned`, `chunksWritten`, `chunksReused`,
`chunksEmbedded`, `embeddingTokens`, `durationMs`. Safe to call repeatedly;
an unchanged corpus embeds nothing (see [Chunking strategy](#chunking-strategy)).

## Design decisions / what I'd do next

- **Citation verification checks provenance, not entailment.** A `[^n]`
  marker is proven to point at a chunk that was genuinely retrieved; it is not
  proven to actually support the sentence it's attached to. Closing that gap
  needs a lightweight entailment check (even a second cheap LLM call scoring
  claim-vs-passage support) run on the verified citation set before it ships
  to the user.
- **The offline embedder is intentionally lexical, not a substitute for a real
  one.** It exists so the demo, the tests, and the eval numbers above don't
  require an API key — it is not a claim that hashed n-grams compete with a
  trained embedding model on genuine paraphrase, and the README says so
  directly rather than picking eval numbers that would hide it.
- **RRF's `k` and the dense/sparse weights are fixed constants, not learned.**
  A larger eval set with graded (not binary) relevance would justify learning
  a small fusion model instead of equal-weighted RRF — not worth it at 18
  questions and one corpus, but the eval harness (`runEval`,
  [`src/evaluate/runner.ts`](src/evaluate/runner.ts)) is already shaped to
  support an A/B between fusion strategies if that corpus existed.
- **The in-memory store's JSON snapshot has no concurrent-writer story** —
  documented in [`memory.ts`](src/providers/store/memory.ts) as a developer
  convenience, not a database. `PgVectorStore` is the one meant to hold
  concurrent traffic; the memory store is correctly scoped to the zero-setup
  path and CI.
- **No reranker beyond the optional LLM pass.** A dedicated cross-encoder
  (e.g. a small local model via `transformers.js`) would remove the extra
  round-trip latency `rerank.ts` currently costs when `RAG_RERANK=true`.
- **No conversational memory.** Every `/ask` is a single independent
  question by design — multi-turn context would need its own retrieval
  strategy (query rewriting from history) rather than being bolted onto this
  one.

## License

MIT — see [`LICENSE`](LICENSE).
