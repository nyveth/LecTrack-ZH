# rag-bot

Semantic search and Q&A over Chinese-language lecture videos.
A transcription-first RAG pipeline: video → transcript → chunks → embeddings → vector search.

## Stack

| Layer         | Tool                                     |
|---------------|------------------------------------------|
| Transcription | faster-whisper (CTranslate2, CUDA, int8) |
| Embeddings    | BGE-M3 via sentence-transformers         |
| Vector store  | pgvector on PostgreSQL 18                |
| DB driver     | psycopg 3 (synchronous)                  |
| API           | FastAPI — not implemented yet            |
| Frontend      | Next.js — not implemented yet            |
| Lint          | ruff                                     |

## Requirements

- Python, managed via [uv](https://github.com/astral-sh/uv)
- PostgreSQL 18 with the pgvector extension
- CUDA 12.4 and a GPU with ≥3 GB VRAM — required by `transcribe` only.
  `embed` and `search` currently run on CPU (see [Known limitations](#known-limitations)).
- ~2.5 GB of free disk for the BGE-M3 weights, plus network access on first run

## Setup

### 1. Python environment

```bash
uv sync
```

### 2. PostgreSQL 18 + pgvector

The PGDG repository ships a prebuilt pgvector package; no compilation needed.

```bash
# add the PGDG repository
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh

sudo apt install -y postgresql-18 postgresql-18-pgvector
sudo systemctl enable --now postgresql
```

The pgvector package must match the server major version. Installing
`postgresql-17-pgvector` next to a PostgreSQL 18 server leaves `CREATE EXTENSION`
failing with a missing-file error that does not name the version mismatch.

Verify:

```bash
psql --version
ls /usr/lib/postgresql/18/lib/vector.so
```

### 3. Database, role, extension

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE ragbot LOGIN PASSWORD 'your-password-here';
CREATE DATABASE ragbot OWNER ragbot;
\c ragbot
CREATE EXTENSION vector;
```

`CREATE EXTENSION` requires superuser and is per-database: it must be run inside
`ragbot`, not in the default `postgres` database.

### 4. Schema

Connect as the application role and create the table:

```bash
psql "postgresql://ragbot:your-password-here@localhost:5432/ragbot"
```

```sql
CREATE TABLE embeddings (
    chunk_id          TEXT PRIMARY KEY,
    video_id          TEXT             NOT NULL,
    text              TEXT             NOT NULL,
    chunk_start       DOUBLE PRECISION NOT NULL,
    chunk_end         DOUBLE PRECISION NOT NULL,
    segment_start_idx INTEGER          NOT NULL,
    segment_end_idx   INTEGER          NOT NULL,
    embedding         vector(1024)     NOT NULL
);

CREATE INDEX ON embeddings (video_id);
```

Notes on the schema:

- Every column is `NOT NULL`. A row with a missing embedding or missing offsets
  is not a degraded row, it is a broken one: it would be returned by search and
  then fail at the point of use. The constraint turns a silent write into a
  loud one.
- `chunk_id` is `f"{video_id}:{segment_start_idx}"`, derived from the payload
  rather than from runtime state, so it is stable across reruns.
- `vector(1024)` matches BGE-M3 output. A different embedding model means a
  different dimension and a new table.
- The B-tree index on `video_id` supports the idempotency check. No vector index
  is created — see [Retrieval](#retrieval).

### 5. Configuration

```bash
cp .env.example .env
```

`.env` is gitignored. Required variables:

| Variable       | Example                                              | Notes                 |
|----------------|------------------------------------------------------|-----------------------|
| `DATABASE_URL` | `postgresql://ragbot:password@localhost:5432/ragbot` | read via `os.environ` |

`app/core/config.py` reads `DATABASE_URL` with `os.environ[...]`, not `.get()`:
a missing variable raises `KeyError` at import time rather than failing later
with an obscure connection error.

Non-secret constants live in `app/core/config.py`, not in `.env`:
`TARGET_TOKENS`, `OVERLAP_TOKENS`, `MODEL_NAME`, `TOP_K`.

### 6. Model weights

The first `embed` run downloads BGE-M3 from HuggingFace (~2.27 GB) and requires
network access. Note that `chunk` only needs the tokenizer, so a successful
`chunk` run does **not** mean the weights are cached.

Once cached, set `HF_HUB_OFFLINE=1` to run fully offline — this skips
revalidation calls to the Hub and removes any rate-limit exposure:

```bash
export HF_HUB_OFFLINE=1
```

### 7. Data directories

Created on demand by the pipeline, except the input directory:

```
data/lectures/      # put your .mp4 files here
data/transcripts/   # transcribe output
data/chunks/        # chunk output
logs/errors.log     # ERROR and above; INFO goes to stdout only
```

## Pipeline

Run every stage from the repository root as a module:

```bash
python3 -m app.ingestion.transcribe        # .mp4        → transcript JSON
python3 -m app.ingestion.chunk             # transcript  → overlapping chunks JSON
python3 -m app.ingestion.embed             # chunks      → pgvector rows
python3 -m app.retrieval.search "查询内容"   # query       → top-k ranked chunks
# API — not implemented yet
```

Every ingestion stage is idempotent and reports what it actually did:

```
Done: 0 written, 2 skipped, 0 empty, 0 failed (of 2)
```

Skip conditions differ by stage:

| Stage      | Skips when                                       |
|------------|--------------------------------------------------|
| transcribe | the transcript file already exists               |
| chunk      | the output is not older than the transcript      |
| embed      | rows for that `video_id` already exist in the DB |

`embed` writes one transaction per file with a single commit. The idempotency
check is a binary "are there rows for this `video_id`" — safe only because the
write is all-or-nothing. Partial state would make the check skip that video
forever, silently.

Note that the completion marker differs by stage: for `transcribe` and `chunk`
it is a file on disk, for `embed` it is rows in the table. Deleting the JSON
artifacts does **not** invalidate the embeddings — see
[Known limitations](#known-limitations).

## Retrieval

`search.py` embeds the query with the same model and the same call used for the
corpus, then runs an exact scan:

```sql
SELECT chunk_id, video_id, text, chunk_start, chunk_end,
       embedding <=> %s AS distance
FROM embeddings
ORDER BY distance
LIMIT %s
```

Decisions:

- **No vector index.** The scan is exact: recall is 1.0 by construction, and the
  result is itself the ground truth an approximate index would have to be
  measured against. An approximate index (HNSW or IVFFlat) trades recall for
  speed, and unlike a B-tree it changes the answer, not just the time. On two
  lectures IVFFlat would also produce a non-representative partitioning.
  Revisit trigger: corpus above ~500 chunks, or a query above 15 minutes.
- **Query comes from `sys.argv`, not `input()`.** `search()` takes a string and
  does not know where it came from, so the same function serves a shell loop
  over a query file and, later, a FastAPI endpoint.
- **Distance is printed, not filtered.** `LIMIT k` returns rows for *any* query,
  including nonsense — the database cannot answer "nothing found". Distance is
  the only signal separating a hit from the best available garbage. No cutoff
  threshold is applied because none has been calibrated yet.
- **Zero rows means an empty table or the wrong database**, not "no matches".
  The log message says so explicitly.
- **Normalization is not passed as an argument.** BGE-M3 carries a `Normalize`
  module in its `modules.json`, so its output is unit-length regardless of
  `normalize_embeddings`. The source of truth is the model's `modules.json`, not
  the `encode()` signature. Independently, `<=>` is cosine distance and divides
  by both norms internally, so vector length cannot affect ranking here at all.

Measuring the noise floor: run a query from an unrelated domain and read its
distance. Anything at or above that value is a non-hit. This has to be redone
whenever the corpus is rebuilt, since distances are not comparable across
different transcripts.

## Project structure

```
app/
  core/        # config.py (constants + .env), log_config.py, results.py (FileResult)
  ingestion/   # transcribe, chunk, embed
  retrieval/   # search
  api/         # pending
scripts/       # one-off measurement and snapshot helpers
```

Absolute imports from `app`; every stage is invoked as a module from the repo
root, never as a bare script path.

## Status

| Stage      | State                                                             |
|------------|-------------------------------------------------------------------|
| transcribe | ✓ atomic writes, existence-based idempotency                      |
| chunk      | ✓ sliding-window overlap, mtime-based cache invalidation          |
| embed      | ✓ BGE-M3 → pgvector, one transaction per video, rollback verified |
| retrieval  | ✓ exact cosine scan, CLI entry point                              |
| API        | not started                                                       |

## Known limitations

- **ASR mangles domain terminology, and a larger model does not fix it.**
  On Chinese technical lecture audio, whisper substitutes homophones: the
  correct term is replaced by a more frequent everyday word that sounds the
  same. Measured on one lecture by counting term forms in the transcript
  (`grep`, not retrieval — the hit/noise gap in cosine distance was 0.058, too
  small to read an ASR change against):

  | Model  | 管脚 + 引脚 (correct) | 广角 + 管角 (mangled) |
  |--------|-----------------------|------------------------|
  | small  | 36                    | 1                      |
  | medium | 5                     | 28                     |

  `medium` with `beam_size=5` was six times worse on the most frequent term of
  the lecture, so the pipeline runs `small`. Hypothesis, unverified: the larger
  multilingual model carries a stronger language prior and resolves homophones
  toward common vocabulary. Scope: one lecture, one domain, one language — this
  does not generalise to "medium is worse than small".

  Some terms (e.g. 时序逻辑, the title term of the lecture) are mangled by both
  models and are written in a third form not covered by the count, so the full
  distortion list is unknown. Known fixes, none implemented: `initial_prompt`
  with a term glossary, post-correction against a substitution table, or a
  domain fine-tune.

  Dense retrieval compensates in part — a query for a term absent from the
  corpus still ranked the right chunk below the noise floor, because BGE-M3
  encodes context rather than string overlap. Thematic queries work; queries
  aimed at one exact term are the fragile case.

- **`beam_size` is not isolated.** The comparison above is `small+beam5` against
  `medium+beam5`. `small+beam1` was never measured, so the contribution of beam
  search alone is unknown.

- **Re-transcribing does not refresh the embeddings.** `embed` skips on the
  existence of rows for a `video_id`, and `video_id` carries no information
  about the ASR model or its parameters. Changing the transcription settings
  rewrites the transcripts and the chunks, then `embed` reports `SKIPPED` and
  leaves the old vectors in place — a green log over a stale database. Until
  hash-based invalidation exists, `DELETE FROM embeddings;` before re-embedding.

- **`chunk` invalidation is mtime-only.** An edit that preserves mtime is
  missed, and a change of chunking parameters is not detected at all — the
  transcripts did not change, so nothing looks stale.

- **The last chunk of a file can be a pure duplicate.** If the final segment
  pushes the buffer past the token target, the chunk is emitted and the tail
  branch then emits the carried-over overlap as a chunk of its own, with no new
  content. It occupies a slot in the top-k result.

- **`TOP_K = 5` on a 10-chunk corpus returns half the database.** Ranking at
  this scale is not informative; the numbers only become meaningful once the
  corpus is substantially larger than `k`.

- **No calibrated cutoff.** The noise floor is a per-corpus observation, not a
  constant. A fixed set of evaluation queries, written *before* seeing any
  output, is still to be built.

- **`embed` and `search` run on CPU.** The installed torch build has no CUDA
  support for Pascal (GTX 1060, sm_61): PyTorch 2.8+ dropped it from the
  cu128/cu129 wheels. Fixing this needs a cu126 build and possibly a torch
  downgrade. Deferred — measured cost is ~1.4 s per chunk, acceptable at the
  current corpus size.

---

*Work in progress. Portfolio project — architecture and pipeline built stage by stage.*