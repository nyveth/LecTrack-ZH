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
  `embed` currently runs on CPU (see [Known limitations](#known-limitations)).
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

````sql
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
````

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

| Variable       | Example                                                | Notes                        |
|----------------|--------------------------------------------------------|------------------------------|
| `DATABASE_URL` | `postgresql://ragbot:password@localhost:5432/ragbot`   | read via `os.environ`        |

`app/core/config.py` reads `DATABASE_URL` with `os.environ[...]`, not `.get()`:
a missing variable raises `KeyError` at import time rather than failing later
with an obscure connection error.

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
python3 -m app.ingestion.transcribe   # .mp4        → transcript JSON
python3 -m app.ingestion.chunk        # transcript  → overlapping chunks JSON
python3 -m app.ingestion.embed        # chunks      → pgvector rows
# retrieval / API — not implemented yet
```

Every stage is idempotent and reports what it actually did:

```
Done: 0 written, 2 skipped, 0 empty, 0 failed (of 2)
```

Skip conditions differ by stage:

| Stage      | Skips when                                    |
|------------|-----------------------------------------------|
| transcribe | the transcript file already exists            |
| chunk      | the output is not older than the transcript   |
| embed      | rows for that `video_id` already exist in the DB |

`embed` writes one transaction per file with a single commit. The idempotency
check is a binary "are there rows for this `video_id`" — safe only because the
write is all-or-nothing. Partial state would make the check skip that video
forever, silently.

## Retrieval

Not implemented yet. Design decision recorded here because it shapes the schema:

Search will run as an exact scan — `ORDER BY embedding <=> $query LIMIT k` with
no vector index. On the current corpus size this is instant, and it guarantees
perfect recall by construction.

An approximate index (HNSW or IVFFlat) trades recall for speed, and unlike a
B-tree it changes the answer, not just the time. Before adding one, two things
must exist: a fixed set of evaluation queries written *before* anyone has seen
the index output, and a script comparing approximate results against exact ones
(`SET LOCAL enable_indexscan = off`). Written afterwards, the queries get
unconsciously fitted to what the index already finds.

Revisit trigger: corpus above ~500 chunks, or a pipeline run above 15 minutes.

## Project structure

```
app/
  core/        # config.py (constants + .env), log_config.py, results.py (FileResult)
  ingestion/   # transcribe, chunk, embed
  retrieval/   # pending
  api/         # pending
scripts/       # one-off measurement and snapshot helpers
```

Absolute imports from `app`; every stage is invoked as a module from the repo
root, never as a bare script path.

## Status

| Stage      | State                                                                 |
|------------|-----------------------------------------------------------------------|
| transcribe | ✓ atomic writes, existence-based idempotency                          |
| chunk      | ✓ sliding-window overlap, mtime-based cache invalidation              |
| embed      | ✓ BGE-M3 → pgvector, one transaction per video, rollback verified     |
| retrieval  | not started                                                            |
| API        | not started                                                            |

## Known limitations

- **`embed` runs on CPU.** The installed torch build has no CUDA support for
  Pascal (GTX 1060, sm_61): PyTorch 2.8+ dropped it from the cu128/cu129 wheels.
  Fixing this needs a cu126 build and possibly a torch downgrade. Deferred —
  measured cost is ~1.4 s per chunk, acceptable at the current corpus size.
- **`chunk` invalidation is mtime-only.** An edit that preserves mtime is missed,
  and a change of chunking parameters is not detected at all — the transcripts
  did not change, so nothing looks stale. Content- or config-hash invalidation
  is the fix, not yet implemented.
- **ASR quality on technical vocabulary.** whisper `small` mangles domain terms
  and Latin abbreviations in Chinese lecture audio. General speech transcribes
  well. Whether this actually breaks term-based retrieval is unverified.

---

*Work in progress. Portfolio project — architecture and pipeline built stage by stage.*