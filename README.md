# LecTrack-ZH

Semantic search and Q&A over Chinese-language lecture videos.
A transcription-first RAG pipeline: video → transcript → chunks → embeddings →
vector search → generated answer.

## Demo


https://github.com/user-attachments/assets/330158a7-0056-46d7-b5bb-32151f0eee4a


*A question in English against a Chinese lecture corpus: retrieval finds the
relevant chunks, DeepSeek generates the answer, and the sources with
timestamps let the user verify it against the video.*

## Stack

| Layer         | Tool                                     |
|---------------|------------------------------------------|
| Transcription | faster-whisper (CTranslate2, CUDA, int8) |
| Embeddings    | BGE-M3 via sentence-transformers         |
| Vector store  | pgvector on PostgreSQL 18                |
| DB driver     | psycopg 3 (synchronous)                  |
| Generation    | DeepSeek via the `openai` SDK            |
| API           | FastAPI + uvicorn                        |
| Frontend      | Next.js (App Router, TypeScript, Tailwind) |
| Lint          | ruff                                     |
| Tests         | pytest                                   |

## Requirements

- Python, managed via [uv](https://github.com/astral-sh/uv)
- PostgreSQL 18 with the pgvector extension
- CUDA 12.4 and a GPU with ≥3 GB VRAM — required by `transcribe` only.
  `embed` and `search` currently run on CPU (see [Known limitations](#known-limitations)).
- ~2.5 GB of free disk for the BGE-M3 weights, plus network access on first run
- Node.js 20+ and npm — frontend only
- A DeepSeek API key **with a non-zero balance**. There is no free grant: a new
  account returns `granted_balance: "0.00"` from `GET /user/balance` and every
  call fails until the account is topped up. The key is required to *import*
  the pipeline at all — see [Configuration](#5-configuration).

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

| Variable           | Example                                              | Notes                 |
|--------------------|------------------------------------------------------|-----------------------|
| `DATABASE_URL`     | `postgresql://ragbot:password@localhost:5432/ragbot` | read via `os.environ` |
| `DEEPSEEK_API_KEY` | `sk-...`                                             | read via `os.environ` |

`app/core/config.py` reads both with `os.environ[...]`, not `.get()`: a missing
variable raises `KeyError` at import time rather than failing later with an
obscure connection error.

**`DEEPSEEK_API_KEY` blocks every stage, not just generation.** `config.py` is
imported by `transcribe`, `chunk`, `embed` and `search` alike, and the
subscript is evaluated at import. Without the key a fresh clone cannot even
chunk a transcript, though chunking never talks to DeepSeek. This is a
deliberate trade — one loud failure at import beats four quiet ones later — but
it is a real cost for anyone who only wants the ingestion half.

What the check does **not** cover: the key's validity and the account balance.
An invalid key and a zero balance both pass the import silently and fail on the
first API call, because verifying either requires a network round trip at import
time.

The DeepSeek key is displayed **once**, at creation, and cannot be recovered —
only regenerated. Copy the whole value including the `sk-` prefix; a key without
it returns `authentication_error`.

Non-secret constants live in `app/core/config.py`, not in `.env`:
`TARGET_TOKENS`, `OVERLAP_TOKENS`, `MODEL_NAME`, `TOP_K`, `DISTANCE_THRESHOLD`,
`DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_MAX_TOKENS` `DEEPSEEK_TIMEOUT`.

`DISTANCE_THRESHOLD` is corpus-specific and is not a portable constant — see
[Evaluation](#evaluation).

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

### 8. Frontend

```bash
cd frontend
npm install
```

## Pipeline

Run every stage from the repository root as a module:

```bash
python3 -m app.ingestion.transcribe        # .mp4        → transcript JSON
python3 -m app.ingestion.chunk             # transcript  → overlapping chunks JSON
python3 -m app.ingestion.embed             # chunks      → pgvector rows
python3 -m app.retrieval.search "查询内容"   # query       → ranked chunks above threshold
python3 -m scripts.eval_queries            # query set   → measurement table
uv run uvicorn app.api.main:app --reload   # HTTP        → JSON: answer + sources
```

Frontend, from `frontend/` in a second shell:

```bash
npm run dev                                # http://localhost:3000
```

Module invocation (`-m`) is not cosmetic. Running a file by path puts its own
directory first on `sys.path`, so `import app` fails from anything under
`scripts/`.

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

### Choosing the transcription model

The whisper model name and its decoding parameters are **hardcoded in `main()`
of `app/ingestion/transcribe.py`**, not exposed in `config.py` and not read from
the environment. To change them, edit that function:

```python
model = WhisperModel("small", device="cuda", compute_type="int8")
segments, info = model.transcribe(path, beam_size=5, language="zh")
```

Three of these values are deliberate and should not be raised without
re-measuring:

- **`small`, not `medium` or `large`.** On this corpus the larger model is
  measurably *worse* at domain terminology — six times worse on the most
  frequent term of the lecture. See
  [Known limitations](#known-limitations) for the counts.
- **`compute_type="int8"`.** A GTX 1060 has 3 GB of VRAM; `float16` on a larger
  model does not fit.
- **`language="zh"`.** Fixing the language skips autodetection, which is both a
  round trip and a failure mode on the first seconds of a lecture.

Changing any of these invalidates the transcripts, the chunks **and** the
calibrated `DISTANCE_THRESHOLD` — and `embed` will not notice, because its skip
check keys on `video_id` alone. Delete the affected rows before re-embedding.

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
  speed, and unlike a B-tree it changes the answer, not just the time. At the
  current corpus size IVFFlat would also produce a non-representative
  partitioning. Revisit trigger: corpus above ~500 chunks, or a query above
  15 minutes.
- **Query comes from `sys.argv`, not `input()`.** `search()` takes a string and
  does not know where it came from, so the same function serves the evaluation
  script and, later, a FastAPI endpoint.
- **The cutoff is applied by the callers, not inside `search()`.** `LIMIT k`
  returns rows for *any* query, including nonsense — the database cannot answer
  "nothing found", so distance is the only signal separating a hit from the best
  available garbage. `search()` therefore returns everything: `main()` and the
  API endpoint filter at `DISTANCE_THRESHOLD`, while `eval_queries.py` needs the
  raw distances. Filtering inside `search()` would blind the very script that
  calibrates the threshold.
- **Zero rows means an empty table or the wrong database**, not "no matches".
  A non-empty result where everything sits above the threshold is a different
  event and gets a different message.
- **Normalization is not passed as an argument.** BGE-M3 carries a `Normalize`
  module in its `modules.json`, so its output is unit-length regardless of
  `normalize_embeddings`. The source of truth is the model's `modules.json`, not
  the `encode()` signature. Independently, `<=>` is cosine distance and divides
  by both norms internally, so vector length cannot affect ranking here at all.
  

## Generation

`app/generation/` turns retrieved chunks into an answer. Two modules:

- `prompts.py` — string constants only. No imports, no functions, no file reads.
- `generate.py` — `build_user_message()` assembles the chunks and the question
  into one text; `generate_answer()` makes the API call and returns the reply.

```python
generate_answer(query: str, chunks: list[dict]) -> str
```

Decisions:

- **The prompt lives in its own module, not in `config.py`.** `config.py` is
  imported by every stage and holds measured or configured values; the prompt
  is needed by one module and will be edited often. Keeping it separate stops
  prompt churn from filling the history of a file everyone depends on.
- **The `openai` SDK, not raw HTTP.** DeepSeek keeps an OpenAI-compatible
  contract, so switching providers costs a `base_url` and a model name; the
  exception classes and the timeout come from one place. The cost is that the
  wire format is hidden — mitigated by having driven the endpoint with `curl`
  before adding the library.
- **The client is created at module level.** Unlike `psycopg.connect()`,
  `OpenAI(...)` opens no connection: it stores settings in an object and the
  network is first touched at call time. There is therefore no "client went
  stale while the provider restarted" failure mode to catch.
- **Thinking mode is disabled** via `extra_body={"thinking": {"type": "disabled"}}`.
  It is on by default on DeepSeek and its reasoning tokens are billed as output.
  A side effect documented by the provider and worth knowing: while thinking is
  enabled, `temperature`, `top_p`, `presence_penalty` and `frequency_penalty`
  raise no error and have no effect.
- **`max_tokens` caps the output only.** Input size is set by `TOP_K` and by
  chunk length (up to 255 s of speech per chunk), so `max_tokens` is not a cost
  ceiling for the request. A measured call sat at 1542 total tokens with 
  `finish_reason: stop` — the cap was never reached. That measurement was taken
  at `max_tokens=800`; the current value is 1000, and no observed call has reached
  it either.
- **A non-empty `chunks` list is a precondition, not something the function
  re-checks.** Threshold filtering happens in the endpoint, so "nothing passed
  the cutoff" is decided before generation is reached and costs zero API calls.
- **Provider exceptions do not cross the module boundary.** The three `openai`
  exception classes (`APIConnectionError`, `APITimeoutError`, `APIStatusError`)
  are caught here and re-raised as one domain exception, `LlmUnavailable`;
  the endpoint knows nothing about the SDK. Truncation is the fourth failure
  and the only silent one: it arrives as a *valid* response with
  `finish_reason: "length"` — measured: with a low cap the content can be
  entirely empty — so it is detected by an `if` after the call, not by an
  `except`, and raises the same `LlmUnavailable`. Details (`status_code`,
  traceback) go to the log at the point of failure; the client receives one
  generic message, because the user's only recourse is to retry.
- **The answer language follows the query language; the prompt barely
  influences it.** Measured across two prompt configurations. With the system
  prompt written in Russian: Russian query → Russian, English query → Russian,
  Chinese query → Chinese. After rewriting the prompt in English: Russian
  query → Russian, English query → English, Chinese query → Chinese. The only
  case the prompt ever decided was the one where it agreed with nothing —
  and rewriting it flipped exactly that case. The instruction sets a
  probability; the query and the retrieved context set the rest. - **The answer
  language follows the query language; the prompt barely
  influences it.** Measured across two prompt configurations. With the system
  prompt written in Russian: Russian query → Russian, English query → Russian,
  Chinese query → Chinese. After rewriting the prompt in English: Russian
  query → Russian, English query → English, Chinese query → Chinese. The only
  case the prompt ever decided was the one where it agreed with nothing —
  and rewriting it flipped exactly that case. The instruction sets a
  probability; the query and the retrieved context set the rest. A later
  counterexample breaks the rule: an English question about a medical topic
  returned an answer entirely in Chinese, the language of the corpus, while an
  English question about the engineering material in the same corpus answered
  in English. Two of three observed cases follow the query, one follows the
  context; the mechanism behind the split is unknown and one observation is not
  enough to name it. For this product the usual behaviour is the desired one —
  the user gets an answer in the language they asked in — but it is emergent
  and demonstrably not guaranteed: anything that must hold has to hold in code,
  and a post-generation language check does not exist yet.
- **The timeout is derived from the output ceiling, not from expected load.**
  `DEEPSEEK_TIMEOUT = 30.0` measures the duration of a single provider call.
  Concurrency does not enter the calculation: requests queue *before* the call
  starts, so the clock is not running while they wait. Under load the correct
  move is a *smaller* value, not a larger one — a hanging call holds its worker
  for exactly as long as the timeout allows. Basis: 6 measured calls, longest
  6–7 s, none of which reached the 1000-token cap; extrapolated to a full cap
  that is roughly 15 s, and 30 leaves a 2× margin for provider tail latency.

## API

`app/api/main.py` wires retrieval and generation into one endpoint. From the
repository root:

```bash
uv run uvicorn app.api.main:app --reload
```

This is the one stage not invoked with `python3 -m`: uvicorn imports the module
and needs the app object named. Interactive docs at `http://127.0.0.1:8000/docs`.
`--reload` re-imports the module on every file change, and the module loads
2.27 GB of weights at import, so drop the flag when not editing.

| | |
|---|---|
| Route        | `GET /search` |
| Query params | `query` (required, non-blank), `top_k` (defaults to `TOP_K`) |
| `200`        | `{"answer": str, "sources": [chunk, ...]}` |
| `200`, no match | `{"answer": "", "sources": []}` — same shape, empty values |
| `400`        | blank or whitespace-only `query` |
| `503`        | LLM provider failed; retrieval result is discarded |

Each `chunk` in `sources` carries `chunk_id`, `video_id`, `text`, `chunk_start`,
`chunk_end`, `distance` — the raw row from `search()`, deliberately unfiltered
(single consumer, own frontend; field selection becomes worth it with a second
consumer).

Decisions:

- **The response shape is constant across outcomes.** "Found" and "found
  nothing" differ in content, not in structure: the client reads `answer` and
  `sources` unconditionally and detects emptiness by content. Distinguishable
  outcomes that need distinguishable *handling* get distinguishable signals
  instead — `400` and `503` are separate statuses, not sentinel values inside a
  `200`.
- **An empty retrieval result exits before generation.** The LLM call is paid
  and there is nothing to generate from; the early return costs zero API calls.
- **Provider failure maps to `503`, not `500`.** `500` means a bug in this
  code; `503` means this code is fine and an external dependency is not. The
  distinction is readable from a monitoring dashboard before opening the logs.
  On failure the found sources are discarded — a deliberate trade: keeping them
  requires a partial-failure field in the contract and a third rendering branch
  in the client, for an event that is rare and delivers little (sources without
  an answer are raw Chinese text).
- **Blank queries are rejected on both sides.** The frontend refuses to send
  them (user convenience); the endpoint returns `400` regardless (the API has
  other callers than this frontend — curl, tests, future clients). An empty
  string embeds into a centroid-like vector that *passes* the distance
  threshold, so without validation a blank query returns arbitrary chunks and
  pays for a generation call.
- **Errors are logged at the point of failure, not by the framework.**
  `setup_logging()` is called at import; `generate.py` logs with
  `logger.exception` inside its `except` branches, where `status_code` and the
  provider traceback still exist. FastAPI's own 500 logging knows neither.
- **The handler is a plain `def`, not `async def`.** FastAPI runs a plain `def`
  in an external threadpool; an `async def` runs directly on the event loop.
  Both calls inside the handler block — psycopg 3 is synchronous and
  `model.encode()` is CPU-bound for seconds — so `async def` would stall every
  concurrent request. See [Known limitations](#known-limitations) for what this
  costs under load and where the numbers point.
- **The model and the connection live at module level.** Module-level code runs
  once per process; per-request loading of 2.27 GB of weights would make the
  endpoint unusable. A second, independent reason: module level runs at import,
  so a broken `DATABASE_URL` kills uvicorn at startup instead of failing for
  the first user in production.
- **`Depends` is not used.** Its payoff is substitutability under test, and
  there are no API tests yet. It goes in when they exist, not before.
- **The threshold is applied here, not in the client.** It is calibrated
  against the corpus, so it belongs next to the data.
- **CORS is enabled for the local Next.js origin only.**

## Frontend

A single-page interface in English: query box, Enter to submit, a generated
answer block, and the source chunks with video timestamps underneath. Blank
queries are blocked before `fetch`. Non-2xx responses render an error banner
from the response's `detail`; a network-level failure (server down) gets its
own message via `catch`. State is reset at the start of every search, so an
error from one request cannot survive into the rendering of the next.

```bash
cd frontend
npm run dev
```

The API base URL is currently hardcoded — see
[Known limitations](#known-limitations).

## Evaluation

`tests/queries.json` is a fixed query set: 7 concepts × 3 languages = 21
queries, 5 of them expected hits and 2 expected noise. It is written and
committed **before** any output is inspected. Judging relevance after seeing
results bends the criterion to fit them; a check that cannot fail is not a
check.

Each entry carries `expect_terms` — a domain term that must appear in the text
of the retrieved chunk. This makes the check mechanical rather than editorial,
which matters here because the corpus is in a language the author does not read.

```bash
python3 -m scripts.eval_queries
```

```
concept          lang  kind      dist  top1  rank
pin_assignment   zh    hit     0.3578  OK    1
...
braised_pork     zh    noise   0.6107  -     -
```

`dist` is the distance of the top-1 chunk, `top1` whether the expected term
appeared in it, `rank` the position of the first chunk that contained the term.
Noise entries have no expected answer, so only distance is read.

### Calibrating the threshold

The cutoff lives between the worst hit and the best noise. On the current corpus
(29 chunks, 3 videos):

| | worst hit | best noise | window |
|---|---|---|---|
| all languages | 0.5209 | 0.6000 | 0.079 |

`DISTANCE_THRESHOLD = 0.55` sits inside that window. It is an observation about
this corpus, not a constant: distances are not comparable across different
transcripts, and the value must be re-measured whenever the corpus is rebuilt.

### One threshold, not one per language

An earlier measurement suggested the hit/noise gap differed by language
(0.255 / 0.20 / 0.075) and that a single cutoff was therefore impossible. That
result was an artifact: the noise queries were *different concepts* per
language, so the difference in meaning was being counted as a difference in
language. With each concept translated from a single formulation, the per-language
windows come out comparable:

| Language | worst hit | best noise | window |
|----------|-----------|------------|--------|
| zh       | 0.4720    | 0.6000     | 0.128  |
| ru       | 0.5040    | 0.6090     | 0.105  |
| en       | 0.5209    | 0.6330     | 0.112  |

A query in Russian or English retrieves the correct Chinese chunk at rank 1;
no translation layer is needed in front of the pipeline. Chinese queries score
closest in all five hit concepts, which is expected for a Chinese corpus but is
a five-sample observation, not a measured effect.

Distances are not comparable *across* languages any more than across corpora:
a hit at 0.52 in English and a hit at 0.35 in Chinese say nothing about relative
quality. What is comparable is ranking — which `chunk_id` came back, and in what
order.

### Dense retrieval bridges mangled terminology

ASR substitutes homophones for domain terms (see
[Known limitations](#known-limitations)), so an expected term may be literally
absent from the corpus. This was measured directly: a query containing the
correct 计数器 against a corpus containing only the mangled 技术器, with no other
phrase shared between query and target chunk, still returned the right chunk at
rank 1 in all three languages. The cost of the substitution is visible as
distance:

| Language | query sharing a phrase with the chunk | isolated query | cost |
|----------|---------------------------------------|----------------|------|
| zh       | 0.4227                                | 0.4720         | +0.049 |
| ru       | 0.4201                                | 0.5040         | +0.084 |
| en       | 0.4196                                | 0.5209         | +0.101 |

BGE-M3 encodes context rather than string overlap, so thematic queries survive
mangled terminology. Queries aimed at one exact term are the fragile case, and
they consume most of the threshold margin.

### What the metric cannot do

`expect_terms` is a string containment check, so it measures ASR and retrieval
as a product and cannot separate the two. The `clock` entry fails on all three
languages while its distances sit in hit range: the top-1 chunk is about
dividing a clock signal into counters and is semantically correct, but the
characters 时钟 never appear in it. That is a false negative of the metric, not
a retrieval defect. The entry is kept in the set precisely because it documents
the failure mode.

Two derived rules:

- Never put a phrase into a test query that appears verbatim in the target
  chunk. The match will come from the literal overlap and the measurement stops
  measuring meaning. This mistake was made and caught in the `counter` entry,
  which is why `counter_isolated` exists alongside it.
- Distance is not quality. Quality is which chunks came back and in what order.

## Project structure

```
app/
  core/        # config.py (constants + .env), log_config.py, results.py (FileResult)
  ingestion/   # transcribe, chunk, embed
  retrieval/   # search
  generation/  # prompts.py (strings), generate.py (prompt assembly + API call)
  api/         # main.py — FastAPI app over search()
frontend/      # Next.js app — search UI
scripts/       # measurement helpers: eval_queries, measure_chunk_lengths, snapshot
tests/       # queries.json — the evaluation set; test_chunk_transcript.py — tail-branch regression
```

Absolute imports from `app`; every stage is invoked as a module from the repo
root, never as a bare script path.

## Status

| Stage      | State                                                             |
|------------|-------------------------------------------------------------------|
| transcribe | ✓ atomic writes, existence-based idempotency                      |
| chunk      | ✓ sliding-window overlap, mtime-based cache invalidation          |
| embed      | ✓ BGE-M3 → pgvector, one transaction per video, rollback verified |
| retrieval  | ✓ exact cosine scan, calibrated cutoff, CLI entry point           |
| evaluation | ✓ fixed multilingual query set, mechanical term check             |
| API        | ✓ GET /search, threshold applied, interactive docs                |
| frontend   | ✓ search box, answer block, sources list, error states            |
| generation | ✓ wired into /search: error boundary, truncation check, logged failures |

## Known limitations

- **The model extrapolates when the retrieved context is thin.** Observed: a
  question about clock generation returned chunks in which the lecturer said
  only that it is "standard" and moved on; the answer supplied the standard
  Verilog construction from pre-training, phrased as if it came from the source.
  The system prompt forbids exactly this. A prompt is a request, not a
  mechanism — anything that must hold has to hold in code.

- **The answer language is emergent, not enforced.** It usually follows the
  query language regardless of what the prompt requests (measured across two
  prompt configurations, three query languages each — see
  [Generation](#generation)). Not always: an English query has been observed
  returning an answer entirely in Chinese, the language of the corpus, with the
  prompt explicitly instructing English. There is no post-generation check, so
  nothing prevents this from happening in front of a user.

- **The threshold cuts relevant chunks, not only noise.** Observed at 0.5815: a
  chunk listing the actual pin assignments for the experiment, containing the
  queried term eight times, sat above the 0.55 cutoff and was dropped. The
  mirror-image failure was seen in the same week — chunks passing the cutoff on
  a query they did not answer. Both follow from a threshold calibrated on 5
  concepts over 29 chunks; neither is fixed by moving the number.

- **`TOP_K = 5` can spend slots on near-duplicate chunks.** Chunking overlaps by
  design, so two retrieved chunks may share most of their text. Observed: five
  results of which two were largely the same passage. Input tokens are paid for
  all five, and `max_tokens` does not cap input.

- **The frontend hardcodes `http://127.0.0.1:8000`** in its `fetch` call. It
  works for local development and blocks any deployment where the API is not on
  the same host.

- **ASR mangles domain terminology, and a larger model does not fix it.**
  On Chinese technical lecture audio, whisper substitutes homophones: the
  correct term is replaced by a more frequent everyday word, or by a
  non-existent compound, that sounds identical. Measured on one lecture by
  counting term forms in the transcript (`grep`, not retrieval — the hit/noise
  gap in cosine distance was 0.058 at the time, too small to read an ASR change
  against):

  | Model  | 管脚 + 引脚 (correct) | 广角 + 管角 (mangled) |
  |--------|-----------------------|------------------------|
  | small  | 36                    | 1                      |
  | medium | 5                     | 28                     |

  `medium` with `beam_size=5` was six times worse on the most frequent term of
  the lecture, so the pipeline runs `small`. Hypothesis, unverified: the larger
  multilingual model carries a stronger language prior and resolves homophones
  toward common vocabulary. Scope: one lecture, one domain, one language — this
  does not generalise to "medium is worse than small".

  Known substitutions so far, all central to the domain:

  | Correct  | Produced | Meaning        |
  |----------|----------|----------------|
  | 计数器   | 技术器   | counter        |
  | 波特率   | 波特绿   | baud rate      |
  | 管脚     | 广角 / 管角 | pin         |
  | 时序逻辑 | (a third form, uncounted) | sequential logic |

  The full distortion list is unknown: terms scoring zero in both columns of the
  count are being written in some form nobody looked for. Known fixes, none
  implemented: `initial_prompt` with a term glossary, post-correction against a
  substitution table, or a domain fine-tune. Priority is not raised, because
  dense retrieval currently bridges the substitutions (see
  [Evaluation](#evaluation)).

- **`beam_size` is not isolated.** The comparison above is `small+beam5` against
  `medium+beam5`. `small+beam1` was never measured, so the contribution of beam
  search alone is unknown.

- **Re-transcribing does not refresh the embeddings.** `embed` skips on the
  existence of rows for a `video_id`, and `video_id` carries no information
  about the ASR model or its parameters. Changing the transcription settings
  rewrites the transcripts and the chunks, then `embed` reports `SKIPPED` and
  leaves the old vectors in place — a green log over a stale database. Until
  hash-based invalidation exists, `DELETE FROM embeddings WHERE video_id = '...'`
  before re-embedding.

- **`chunk` invalidation is mtime-only.** An edit that preserves mtime is
  missed, and a change of chunking parameters is not detected at all — the
  transcripts did not change, so nothing looks stale.

- **The threshold margin is thin.** 0.55 sits 0.029 above the worst measured hit
  and 0.050 below the best measured noise. One slightly harder query would push
  a valid hit past the cutoff.Measured live: the same English query with `Verilog`
  lowercased shifted its top-1 distance from 0.5170 to above the 0.55 cutoff — a
  capitalization choice the user cannot be expected to control decided between an
  answer and "nothing found".

- **The evaluation set is small and partly non-blind.** 2 noise concepts across
  3 videos in 1.5 domains. `管脚分配` and `红烧肉怎么做` were both run in earlier
  sessions, so they are not blind; they are kept because they are the only
  anchor to pre-existing measurements. `pin_assignment` also uses a bare noun
  phrase in Chinese against full questions in Russian and English, which is the
  same formulation drift the rest of the set was cleaned of.

- **`TOP_K = 5` on a 29-chunk corpus returns a sixth of the database.** Ranking
  at this scale is weakly informative; the numbers only become meaningful once
  the corpus is substantially larger than `k`.

- **Retrieval output cannot be judged by eye.** Results come back in Chinese.
  The `expect_terms` check makes pass/fail mechanical, but diagnosing *why* a
  query failed still requires an intermediary. This is the open blocker for
  analysing false positives at scale.

- **`embed` and `search` run on CPU.** The installed torch build has no CUDA
  support for Pascal (GTX 1060, sm_61): PyTorch 2.8+ dropped it from the
  cu128/cu129 wheels. Fixing this needs a cu126 build and possibly a torch
  downgrade. Deferred — measured cost is ~1.4 s per chunk, acceptable at the
  current corpus size.

- **The threshold filter is duplicated.** The same list comprehension lives in
  `main()` of `search.py` and in the endpoint. A threshold change requires
  editing both. The fix is a `max_distance=None` parameter on `search()`, so the
  filter has one home and the caller supplies the policy; deferred until a third
  caller exists, because at two the indirection costs more than the duplication.

- **Concurrency ceiling: ~40 requests, and the bottlenecks are serial.**
  FastAPI runs sync handlers in a 40-worker threadpool. Inside each request,
  three stages block: `model.encode()` (~1.4 s of CPU on this machine), the
  single module-level psycopg connection (thread-safe but *serializing* —
  concurrent queries queue behind each other), and the DeepSeek call (network
  wait, seconds). Estimated behaviour: fine below ~5 concurrent users, linear
  degradation to ~20, full stop at 40+ when the pool is exhausted. The worst
  case is a slow provider: workers sit in network wait while the CPU idles.
  Going async would fix only the waiting stages — and only with an async DB
  driver and `AsyncOpenAI`; `model.encode()` would still need an executor, or
  it blocks the event loop for everyone, which is *worse* than the threadpool.
  At demo load (one user) none of this binds, so the sync design stays. The 
  worst case is now bounded by DEEPSEEK_TIMEOUT (30 s) rather than by the SDK 
  default of 600 s.

- **The connection is opened at import and never reopened.** If PostgreSQL
  restarts, or the connection drops, the API process must be restarted with it.

- **A hanging LLM call holds a threadpool worker.** The DeepSeek call is
  synchronous and currently has no timeout, so a slow provider occupies its
  worker for the full duration. Combined with the single DB connection, a
  handful of such requests leaves the API unresponsive while the process is
  alive and the port is open.

---

*Work in progress. Portfolio project — architecture and pipeline built stage by stage.*
