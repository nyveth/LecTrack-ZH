# LecTrack-ZH

Semantic search and Q&A over Chinese-language lecture videos.
A transcription-first RAG pipeline: video → transcript → chunks → embeddings →
vector search → generated answer.

**[Live demo](#demo)** · [Setup](docs/SETUP.md) · [Deployment](#deployment) ·
[Architecture](#pipeline) · [Known limitations](#known-limitations)

## Demo

**[nyveth.xyz](https://nyveth.xyz)**

The frontend is on Vercel and is always up. The API is not hosted: it runs on
the machine that owns the GPU, and that machine is not kept running around the
clock. Outside demo hours the page loads and search returns a connection error.
This is a deliberate trade, not an outage — see [Deployment](#deployment).

https://private-user-images.githubusercontent.com/55897970/645814603-39152815-9f2c-44a9-b1b5-d89bf8476973.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODg0NTIzNjQsIm5iZiI6MTc4ODQ1MjA2NCwicGF0aCI6Ii81NTg5Nzk3MC82NDU4MTQ2MDMtMzkxNTI4MTUtOWYyYy00NGE5LWIxYjUtZDg5YmY4NDc2OTczLm1wND9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNjA5MDMlMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwOTAzVDE2MTQyNFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTNjNTAzYmExNTBhYjMxMWVlYjQ0YTE3NTU1NDIxMzc0MzkwMTIzN2Y1YzhmYjZhNmJmNWFkYTFmMWFmMWFmMzQmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0JnJlc3BvbnNlLWNvbnRlbnQtdHlwZT12aWRlbyUyRm1wNCJ9.YRmwEpWw_ql41wBi2Nn0ohyIO8wYxH0ot5G7JX1CVmk

*A question in English against a Chinese lecture corpus: retrieval finds the
relevant chunks, DeepSeek generates the answer, and the sources with timestamps
let the user verify it against the video.*

## Stack

| Layer          | Tool                                       |
|----------------|--------------------------------------------|
| Transcription  | faster-whisper (CTranslate2, CUDA, int8)   |
| Embeddings     | BGE-M3 via sentence-transformers           |
| Vector store   | pgvector on PostgreSQL 16+                 |
| DB driver      | psycopg 3 (synchronous)                    |
| Generation     | DeepSeek via the `openai` SDK              |
| API            | FastAPI + uvicorn                          |
| Transport      | Server-Sent Events (token streaming)       |
| Frontend       | Next.js (App Router, TypeScript, Tailwind) |
| Frontend host  | Vercel                                     |
| API exposure   | Tailscale Funnel                           |
| Lint           | ruff                                       |
| Tests          | pytest                                     |

Developed on PostgreSQL 18; reproduced on 16.14 with pgvector 0.8.0 during an
independent install on a different distribution.

## Setup

Full installation instructions: **[docs/SETUP.md](docs/SETUP.md)**.

Prerequisites: PostgreSQL 16+ with pgvector, uv, Node.js 20+, a DeepSeek API key
with a non-zero balance, and an NVIDIA GPU for transcription only.

Once installed, three processes:

```bash
uv run uvicorn app.api.main:app     # API      - http://127.0.0.1:8000
uv run python -m app.worker         # worker   - without it uploads stay queued
cd frontend && npm run dev          # frontend - http://localhost:3000
```

## Deployment

Two halves, deployed differently, joined by CORS.

The frontend is a Next.js build on Vercel behind `nyveth.xyz`. The API is
exposed straight from the development machine through Tailscale Funnel:

```bash
sudo tailscale funnel --bg 8000     # https://<host>.ts.net → 127.0.0.1:8000
```

`--bg` survives a reboot, and Tailscale issues the TLS certificate itself. The
browser calls the Funnel hostname directly, so the API's CORS allowlist carries
the Vercel origin and nothing sits between the two.

Decisions:

- **The API stays on the local machine.** `transcribe` needs a GPU; hosted CPU
  transcription runs tens of minutes per lecture, which is worse than not
  offering the feature. A rented GPU host is not worth a monthly bill for a
  portfolio demo. The cost of that choice is availability, stated plainly at
  the top of this file rather than hidden.
- **Tailscale Funnel, not Cloudflare Tunnel.** Cloudflare tunnels were built
  and abandoned: on this connection the session to the Cloudflare edge is
  terminated after two to three minutes, silently and reproducibly, on both
  QUIC and HTTP/2. Funnel held where Cloudflare did not. Measured from
  check-host.net, HTTP 200 from every node: 0.238 s Frankfurt, 0.271 s London,
  0.288 s Amsterdam, 0.380 s Zurich. Long-run stability over hours has not
  been measured.
- **The browser calls the Funnel URL directly, not through a Next.js rewrite.**
  A rewrite would put Vercel's edge in front of the API, and every request
  would arrive from the same address — collapsing the per-IP rate limit into a
  second global one. Funnel forwards the real client address, so nothing has to
  parse `X-Forwarded-For`, and parsing it would make the limit forgeable by any
  caller willing to set a header.
- **CORS is not access control.** An allowlist is a rule the browser enforces
  on itself; `curl` ignores it entirely. The Funnel hostname is also public the
  moment its certificate is issued, because Certificate Transparency logs are
  public. What bounds cost is the rate limit, not the origin list.

Funnel constraints worth knowing before copying this setup: ports are limited
to 443, 8443 and 10000, a custom domain cannot be attached, and there is an
unpublished bandwidth ceiling.

## Pipeline

Run every stage from the repository root as a module:

```bash
uv run python -m app.ingestion.transcribe        # .mp4        → transcript JSON
uv run python -m app.ingestion.chunk             # transcript  → overlapping chunks JSON
uv run python -m app.ingestion.embed             # chunks      → pgvector rows
uv run python -m app.retrieval.search "查询内容"   # query       → ranked chunks above threshold
uv run python -m scripts.eval_queries            # query set   → measurement table
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

`app/worker.py` builds its own model and does not read this one. Changing the
CLI alone leaves uploads processed by the old settings — see
[Known limitations](#known-limitations).

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

## Schema

`db/schema.sql` is the single source of truth for the database structure. It is
not idempotent by design: a second run against a populated database fails loudly
instead of silently doing nothing. Applying it is
[step 3 of the setup](docs/SETUP.md#3-schema).

### `embeddings`

One row per chunk, `chunk_id` as primary key, `embedding` as `vector(1024)`.

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

### `jobs`

One row per uploaded lecture awaiting processing. The upload endpoint inserts,
the worker claims and updates, the status endpoint reads. Neither process knows
the other exists.

- `status` is constrained by `CHECK`. A typo written by the worker would produce
  a row nobody can find again: not `queued`, so never claimed; not `done`, so
  never closed. The job would disappear without an error anywhere. The
  constraint rejects it at write time instead.
- `stage` exists only to tell the user what is happening. No decision is taken
  on it — neither whether to claim a row nor where to resume — because it is
  written *before* the step runs and therefore records intent, not result.
- `error` is nullable, and `NULL` means no failure occurred. An empty string
  would collapse the difference between "no error" and "an error with no
  message".
- `created_at` defaults to `now()`, so the insert never carries a timestamp of
  its own.

**Rejected: resuming a partially processed job from its last stage.** It requires
every stage to answer "how much of me is already done". Without that, re-running
`embed` on a job that died halfway inserts duplicate chunks — same text, new
embeddings, no error raised, and retrieval quietly returns the same fragment
twice. Abandoned jobs are reset to `queued` and reprocessed from the start.

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

- `prompts.py` — string constants only (`SYSTEM_PROMPT`, `REWRITE_PROMPT`). No
  imports, no functions, no file reads.
- `generate.py` — `build_user_message()` assembles history, chunks and the
  question into one text; `start_generate_answer()` opens the streamed call;
  `iter_answer_tokens()` yields the pieces; `rewrite_query()` turns a
  follow-up into a standalone query.

```python
rewrite_query(query: str, history: list[dict]) -> str
start_generate_answer(query: str, chunks: list[dict], history: list[dict])
iter_answer_tokens(stream) -> Iterator[str]
```

The answer is streamed, not returned whole. A full answer takes seconds of
provider time; with a single return the user watches a spinner for all of it,
and the first token is the only signal that the pipeline is alive. Streaming
also changes the failure surface: the status code is committed the moment the
response starts, so anything that can fail with a status has to fail *before*
the first byte — see [API](#api).

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
  at `max_tokens=800`; the current value is 1000, and no observed call has
  reached it either.
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
- **The message is assembled as XML-tagged blocks, question last.** Since
  14 Aug, `build_user_message()` emits `<history>` (the last two questions plus
  the last answer in full), then `<context>`, then `<question>`, followed by an
  explicit language instruction — answer in the language of `<question>`, do
  not output Chinese unless the question is Chinese. The tags give the model an
  unambiguous boundary between conversation, source text and the actual
  question; the trailing instruction puts the language rule in the highest-
  leverage position, the last thing the model reads before generating.
- **The answer language usually follows the query language; the prompt barely
  influences it.** Measured across two prompt configurations. With the system
  prompt written in Russian: Russian query → Russian, English query → Russian,
  Chinese query → Chinese. After rewriting the prompt in English: Russian
  query → Russian, English query → English, Chinese query → Chinese. The only
  case the prompt ever decided was the one where it agreed with nothing —
  and rewriting it flipped exactly that case. The instruction sets a
  probability; the query and the retrieved context set the rest. A later
  counterexample broke the rule: an English question over Chinese chunks
  returned an answer entirely in Chinese, the language of the corpus. The
  14 Aug message-layout change above was the response, and it flipped that
  exact case: the same question now answers in English, and the English
  benchmark runs that followed stayed in English throughout. One evening of
  observations; Chinese and Russian queries have not been re-measured since
  the change, and the trailing instruction is still a request, not a
  mechanism — a post-generation language check does not exist.
- **History goes to generation; the rewritten query goes to retrieval.** Two
  different needs. Retrieval needs one self-contained string, because an
  embedding of "and the second one" points nowhere. Generation needs the
  conversation, because "can you say that shorter" is a request about the
  previous answer, not a question about the corpus — a standalone query
  preserves referents but not the dialogue.
- **The `<history>` block is absent, not empty, on the first turn.** An empty
  labelled section is a prompt telling the model that a conversation exists and
  contained nothing.
- **Error accumulation inside history is bounded by the prompt, not by code.**
  A wrong answer stays in the window and can be cited by the next one. One line
  in `SYSTEM_PROMPT` separates the roles: history is for understanding the
  question, facts come from `<context>`. That is a request, not a mechanism —
  see the language limitation above for what that distinction is worth.
- **The timeout is derived from the output ceiling, not from expected load.**
  `DEEPSEEK_TIMEOUT = 30.0` measures the duration of a single provider call.
  Concurrency does not enter the calculation: requests queue *before* the call
  starts, so the clock is not running while they wait. Under load the correct
  move is a *smaller* value, not a larger one — a hanging call holds its worker
  for exactly as long as the timeout allows. Basis: 6 measured calls, longest
  6–7 s, none of which reached the 1000-token cap; extrapolated to a full cap
  that is roughly 15 s, and 30 leaves a 2× margin for provider tail latency.

## Multi-turn

A follow-up question is rarely self-contained. "And how is it measured?" embeds
into a vector that points at nothing in particular; the threshold then rejects
every chunk and the user reads "nothing found" about material that is in the
corpus. Before retrieval, `rewrite_query()` sends the last three turns and the
new question to the provider and asks for one standalone query.

Decisions:

- **Rewriting is a separate call, not part of generation.** Its output feeds
  `search()`, which runs before generation exists. Cost: roughly 1.3 s measured
  per call, paid on every turn after the first.
- **`REWRITE_PROMPT` forbids expansion.** The instruction is to resolve
  references and nothing else — no added synonyms, no clarifying terms. The
  reason is numeric: `DISTANCE_THRESHOLD` was calibrated with a margin of 0.029
  (see [Evaluation](#evaluation)), and a query enriched with plausible-sounding
  extra terms moves in vector space by more than that. Measured behaviour
  against this constraint: the rewrite systematically compresses questions into
  noun phrases — an edit the rule does not permit, and one that currently
  *helps* retrieval — see
  [the rewrite benchmark](#the-threshold-on-rewritten-queries).
- **The format label in the prompt matches the code literally.** The prompt
  describes the exact markers `rewrite_query()` writes. A prompt describing
  a format the code does not produce is a silent defect: the call still returns
  something.
- **An empty rewrite is rejected by an `if`, not by an `except`.** The provider
  returning an empty string is a successful call that fails the task criterion.
  It raises the same domain exception, `RewriteUnavailable`, as the three
  `openai` transport failures.
- **`REWRITE_TIMEOUT` is separate from `DEEPSEEK_TIMEOUT` and much shorter**
  (10 s against 30 s). Rewriting emits a single short line, so its expected
  duration is a fraction of a full answer's; the same clock for both would let a
  stalled rewrite hold a worker for the length of a generation. Observed once
  on a live call: a rewrite hit the 10 s ceiling and surfaced as the pre-stream
  `503`, so the value is not slack.
- **The rewritten query is logged next to the original.** One `INFO` line per
  request carries the original query, the standalone form, whether the text
  actually changed, and the raw distances *before* threshold filtering. "The
  rewrite call happened" and "the text changed" are different facts — the
  rewriter legitimately returns self-contained inputs verbatim — so the flag is
  computed as `standalone != query` after stripping, not from which branch ran.
  A thin result is now attributable by reading one line: rewrite drift and
  threshold cuts are separable. The line goes to the console handler only and
  does not survive a process restart — see
  [Known limitations](#known-limitations).

## API

`app/api/main.py` wires retrieval and generation into one endpoint. From the
repository root:

```bash
uv run uvicorn app.api.main:app --reload
```

This is the one stage not invoked with `python -m`: uvicorn imports the module
and needs the app object named. Interactive docs at `http://127.0.0.1:8000/docs`.
`--reload` re-imports the module on every file change, and the module loads
2.27 GB of weights at import, so drop the flag when not editing.

| | |
|---|---|
| Route        | `POST /search` |
| Body         | `{"query": str, "history": [{"question": str, "answer": str}], "top_k": int}` |
| `200`        | `text/event-stream` — see the frame table below |
| `200`, no match | the same stream: a `sources` frame carrying `[]`, then `done` |
| `422`        | body fails validation (length, type, missing field) |
| `429`        | the per-IP or the global daily search budget is exhausted |
| `503`        | query rewriting unavailable — raised before the stream opens |

Constraints are declared on the pydantic models, not checked in the handler:
`query` non-blank and ≤ 500 characters, `history` ≤ 10 turns, `top_k` between
1 and 20.

Stream frames:

| Event     | Data                                | When |
|-----------|-------------------------------------|------|
| `sources` | the chunk list (possibly empty)      | once, first |
| `token`   | `{"t": "..."}`                       | repeatedly |
| `done`    | `{"truncated": bool}`                | once, last |
| `error`   | `{"detail": str}`                    | instead of `done`, if generation breaks mid-answer |

Each `chunk` in `sources` carries `chunk_id`, `video_id`, `text`, `chunk_start`,
`chunk_end`, `distance` — the raw row from `search()`, deliberately unfiltered
(single consumer, own frontend; field selection becomes worth it with a second
consumer).

Decisions:

- **`POST`, not `GET`.** The request carries a nested list of turns. A query
  string encodes flat scalars; nesting it means inventing an encoding and
  paying for it at both ends, against a URL length limit that is not in the
  standard but is enforced by proxies.
- **Typed models, not `list[dict]`.** `Message` and `SearchRequest` are pydantic
  models, so a malformed turn is rejected at the boundary with a `422` naming
  the offending index and field, and the handler body never runs. With
  `list[dict]` the same input reaches business logic and surfaces as a
  `KeyError` several frames deep, at a place that has no idea what a valid
  request looks like.
- **Conversion to plain dicts happens at the boundary.** `model_dump()` is
  called in the endpoint, so `generate.py` receives dictionaries and does not
  import the API's schema. The direction of dependency stays one-way: the API
  knows about generation, generation knows nothing about HTTP.
- **The empty result is still a stream.** "Nothing found" could have been a
  plain JSON body, which would force the client to branch on content type
  before it can read anything. Instead the endpoint returns a stream carrying
  `sources: []` and `done`. One reading path, one code path in the client.
- **A failure that has a status code must happen before the first byte.** Once
  a `StreamingResponse` starts, the status is already sent and cannot be
  changed. Rewriting therefore runs *before* the response is constructed, so
  `RewriteUnavailable` can still become an honest `503`. A generation failure
  after the stream opens has no such option and is delivered as an `error`
  frame instead.
- **The response shape is constant across outcomes.** "Found" and "found
  nothing" differ in content, not in structure: the client reads the same
  frames either way. Distinguishable outcomes that need distinguishable
  *handling* get distinguishable signals instead — `422`, `429` and `503` are
  separate statuses, not sentinel values inside a `200`.
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
- **CORS allows `POST` and `OPTIONS`, not just `POST`.** A cross-origin `POST`
  carrying JSON is not a simple request: the browser sends an `OPTIONS`
  preflight first and only issues the real call if it succeeds. A missing
  `OPTIONS` shows up as a `POST` that never appears in the access log while the
  `OPTIONS` does — a symptom that points at the handler and is not in the
  handler.
- **The CORS allowlist carries the local Next.js origin and the deployed
  frontend origin.** Vercel preview deployments get unpredictable hostnames and
  are deliberately left out: they are development surfaces, and widening the
  list to a wildcard would trade a real boundary for convenience.

### Rate limiting

`/search` is metered by a middleware in `app/api/main.py`. Two ceilings, both
constants in `core/config.py`: `SEARCH_IP_DAILY_LIMIT` per client address and
`SEARCH_DAILY_LIMIT` across all callers. Over either one, the request is
answered with `429` before any embedding or provider call happens.

- **In-process counters, not Redis.** One uvicorn process serves the demo, so
  there is no state to share across processes and nothing for a broker to
  coordinate. Module-level dictionaries reset when the date changes. A second
  process would make this wrong immediately, and that is the trigger to
  revisit, not the traffic volume.
- **The global ceiling is the spend control; the per-IP one is the fairness
  control.** A per-IP limit alone is defeated by any VPN, so it cannot bound
  what the demo costs. The global ceiling bounds it, and pays for that with a
  self-denial surface — see [Known limitations](#known-limitations).
- **Authentication was rejected as the spend control.** Free registration caps
  no spend; it moves the same unbounded usage behind a signup form and puts a
  closed door in front of a demo. Auth is an access-control feature and is
  scheduled as one.
- **Verified against the live deployment, not assumed.** Tailscale Funnel
  forwards the real client address, confirmed by logging it; three consecutive
  requests against a limit of 2 returned `200`, `200`, `429`.

## Frontend

A chat interface in English: a conversation of turns, tokens appearing as they
arrive, retrieved chunks folded under each answer, and several conversations
kept side by side.

```bash
cd frontend
npm run dev
```

Decisions:

- **Misses are shown but not sent.** A turn whose retrieval returned nothing —
  and a turn whose stream broke mid-answer — stays on screen, because a message
  that vanishes is worse than a message that failed. Neither is included in the
  `history` sent with the next request: an empty or half-delivered answer is a
  corrupted referent, and `rewrite_query()` would resolve the next pronoun
  against it. The filter runs at send time; nothing is deleted from state.
  Accepted cost, stated plainly: after a miss, a pronoun in the next question
  resolves against the last *successful* turn, which is usually right and is
  silently wrong when it is not.
- **Conversations live in `localStorage`.** There is no auth, so there is no
  account to attach them to, and losing a thread to a page refresh is not
  acceptable. `localStorage` does not exist during server rendering, so it is
  read in an effect after mount, never in a `useState` initializer — the latter
  produces server markup that does not match the client. A hydration flag
  guards the save effect, or the first render writes an empty array over the
  saved data.
- **Tokens are accumulated in a local variable, not read back from state.**
  A state value read inside the streaming loop is the value captured when the
  closure was created, not what the setter has painted since. State drives the
  screen; a plain variable assembles the record that is stored at the end.
- **The stream is decoded with `stream: true` and split on a blank line.**
  A Chinese character is three bytes and can be cut across two network chunks;
  the flag holds an incomplete character back rather than emitting a
  replacement glyph. Frames are separated by `\n\n`, so the trailing piece of
  every read is kept in a buffer until its boundary arrives.
- **Fonts are self-hosted through `next/font`, with no runtime `@import`.**
  A `@import` from a font CDN inside `theme.css` makes the production build
  depend on that CDN being reachable, which is a build failure on a restricted
  network and a render-blocking request on every page load for everyone else.
- **The API base URL comes from `NEXT_PUBLIC_API_URL`,** with a localhost
  fallback so a fresh clone runs without configuration. The fallback is also a
  hazard in a deployed build — see [Known limitations](#known-limitations).

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
uv run python -m scripts.eval_queries
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

### The threshold on rewritten queries

Rewriting produces a different string, therefore a different vector, therefore
different distances — and the threshold was calibrated on human phrasings with
a margin of 0.029. Measured 15 Aug, in English: five pairs, one referent type
each. A pair is a follow-up question carrying an unresolved referent, resolved
by `rewrite_query()` against a real conversation, run against a human-written
self-contained formulation of the same question with an empty history.
Distances come from the retrieval log; chunks are counted against
`DISTANCE_THRESHOLD = 0.55`.

| # | referent | follow-up | passed (human / rewritten) | best hit (human / rewritten) |
|---|---|---|---|---|
| 1 | object     | "Where should that file be saved?"     | 3 / 3 | 0.4279 / 0.4022 |
| 3 | property   | "What about the LED?"                  | 5 / 5 | 0.3941 / 0.3814 |
| 4 | object     | "Can I edit it manually?"              | 2 / 2 | 0.4446 / 0.4195 |
| 5 | clarifying | "Why does that step need USB Blaster?" | 5 / 5 | 0.5124 / 0.4820 |

The numbering keeps a gap: pair 2 measured nothing — see below.

Findings on the four valid pairs: the pass counts are identical, and the
rewritten query lands *closer* than the human phrasing in every pair (−0.013 to
−0.030 on the best hit). No chunk that the human formulation retrieved was lost
to the rewrite. The mechanism is visible in the log: the rewriter compresses
questions into noun phrases — "What about the LED?" becomes
`LED pin on the AC620 board` — and a dense noun phrase sits closer to dense
technical transcript text than a full interrogative sentence does. The
compression is itself an edit beyond what `REWRITE_PROMPT` permits; here it
pays.

Pair 2, the ordinal ("What about the second one?"), is excluded twice over.
The rewriter resolved the ordinal by *choosing* a method — the query came back
as `Manual writing of pin assignment file in Quartus` — instead of preserving
the reference, and the human baseline had been mis-written against the *other*
method, so the two runs target different chunks and their numbers are not
comparable. What the pair yielded instead is qualitative and worth more: the
ordinal defect itself (see [Known limitations](#known-limitations)) and one
live execution of the refusal path — generation, given the original question
plus two above-threshold chunks, answered that the fragments contain no
"second one" instead of extrapolating an answer.

Scope, stated plainly: English only, five pairs, all aimed at one lecture's
material. Chinese was not benchmarked and owns two logged incidents of its own
class: the same question returning 5 chunks on an empty history and 1 with
history present, and one rewrite that returned a statement lifted from the
previous answer — the question form was lost entirely. Neither is reproduced
by the English measurement.

Conclusion for the measured scope: `DISTANCE_THRESHOLD = 0.55` holds on
rewritten English queries, and no recalibration is warranted.

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
  worker.py    # polls the jobs table, runs the pipeline for one job at a time
db/            # schema.sql — the single source of truth for the database
docs/          # SETUP.md — installation and operation
frontend/      # Next.js app — search UI
scripts/       # measurement helpers: eval_queries, measure_chunk_lengths, snapshot
tests/         # queries.json — the evaluation set; test_chunk_transcript.py — tail-branch regression
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
| API        | ✓ POST /search, SSE streaming, typed request models, threshold applied |
| generation | ✓ error boundary, truncation check, logged failures, token streaming |
| multi-turn | ✓ query rewriting before retrieval; threshold benchmark passed on EN, zh unmeasured |
| frontend   | ✓ chat UI, streamed tokens, local conversations, folded sources   |
| upload     | ✓ jobs table, polling worker, atomic claim; no auth, no rate limit |
| deployment | ✓ frontend on Vercel, API through Tailscale Funnel, per-IP and daily caps |

## Known limitations

### Availability and operations

- **The public API is up only when the machine is.** The GPU host is a desk
  machine, not a server, and it is brought up for demos rather than kept
  running. The Vercel frontend stays reachable either way, so the failure the
  visitor sees is a working page whose search cannot connect. Naming it is the
  fix that was chosen; hosting the API is the fix that was not.
- **Funnel stability past a few minutes is unmeasured.** Latency and reachability
  were checked from four European nodes at a single point in time. Nothing has
  observed the tunnel across hours of idle time, which is exactly the interval
  a visitor arrives in.
- **The daily search ceiling is a self-denial surface.** Whoever exhausts
  `SEARCH_DAILY_LIMIT` first closes the demo for everyone else until the date
  changes. That is the price of bounding spend without auth, and the cheapest
  attack against the demo is also the least interesting one.
- **The rate limiter resets at midnight and forgets on restart.** Counters are
  in memory, so a process restart clears them; a burst inside one day is not
  smoothed, only stopped at the ceiling; and the per-IP dictionary grows with
  every distinct address, which an IPv6 client can supply indefinitely. A token
  bucket keyed on an account, in shared storage, is the production shape. This
  is not that.
- **`/upload` has neither auth nor a rate limit.** Any caller can queue an mp4
  and occupy the GPU for the length of a transcription, and nothing bounds the
  size or number of files accepted. It is closed by not exposing the machine
  rather than by code.
- **Throughput has never been measured.** No load test has been run against
  `/search`. The concurrency ceiling below is derived from the code, not
  observed, and the two should not be confused.
- **`NEXT_PUBLIC_API_URL` falls back to localhost.** The fallback exists so a
  fresh clone runs without configuration, and it means a deployed build with
  the variable unset does not fail: it silently asks the visitor's own machine
  for the API. A missing variable should stop the build instead.
- **A failed job is retried by hand.** The worker only claims `queued`, so a job
  left in `failed` stays there until someone runs
  `UPDATE jobs SET status='queued', stage=NULL, error=NULL WHERE id=...`.
  There is no retry endpoint and no button.
- **A job left in `running` by a dead worker is never reclaimed.** `status`
  records that a worker took the row, not that a worker is alive. Nothing
  detects the difference, so the row is invisible to every future claim.
- **The connection is opened at import and never reopened.** If PostgreSQL
  restarts, or the connection drops, the API process must be restarted with it.

### Installation and platform

- **The install was reproduced once on another machine, and it failed.** An
  independent run on an RPM-based distribution with a different GPU exposed
  three blockers before the pipeline started: package instructions written for
  APT only, `pg_hba.conf` defaulting to `ident` for local TCP, and missing CUDA
  math libraries. [docs/SETUP.md](docs/SETUP.md) now covers all three; it has
  been reproduced on two platforms, which is two more than zero and far fewer
  than enough.
- **An NVIDIA driver is not a CUDA runtime.** `nvidia-smi` can list the GPU and
  `ctranslate2` can count devices while `transcribe` still dies on
  `libcublas.so.12`. cuBLAS and cuDNN ship separately from the driver, and the
  probe that reports device capability does not load them, so the failure
  arrives at the first matrix multiply rather than at startup.
- **The Whisper configuration exists in two places.** The CLI builds its model
  in `app/ingestion/transcribe.py`; the worker builds its own in
  `app/worker.py`. Editing one does not affect the other, and a running worker
  keeps the model it loaded at startup regardless of either. Neither the
  transcript nor the embedding rows record which model produced them.
- **The worker path does not create its output directories.**
  `transcribe_file()` and `chunk_file()` rely on `main()` having created
  `data/transcripts` and `data/chunks`, and the worker calls them directly. On a
  machine where those directories do not exist yet, an upload transcribes
  successfully and then dies with `FileNotFoundError` on the write.
- **The DeepSeek key blocks every stage, not just generation.** `config.py` is
  imported by `transcribe`, `chunk`, `embed` and `search` alike, and reads the
  key with `os.environ[...]` at import. A fresh clone cannot chunk a transcript
  without a key, though chunking never talks to DeepSeek. One loud failure at
  import was preferred to four quiet ones later; the cost falls on anyone who
  wants only the ingestion half.

### Retrieval and the threshold

- **The threshold cuts relevant chunks, not only noise.** Observed at 0.5815: a
  chunk listing the actual pin assignments for the experiment, containing the
  queried term eight times, sat above the 0.55 cutoff and was dropped. The
  mirror-image failure was seen in the same week — chunks passing the cutoff on
  a query they did not answer. Both follow from a threshold calibrated on 5
  concepts over 29 chunks; neither is fixed by moving the number.
- **The threshold margin is thin.** 0.55 sits 0.029 above the worst measured
  hit and 0.050 below the best measured noise. One slightly harder query would
  push a valid hit past the cutoff.

  Case sensitivity was then measured systematically across the 7 evaluation
  concepts: lowercasing the English query shifts top-1 distance by at most
  ±0.009, changes no outcome, and never displaces the top-1 chunk (top-3
  membership shifts in 2 of 7). One query outside that set behaves differently:
  "How does a counter work in Verilog" retrieves at 0.5170, and the same query
  with `verilog` lowercased falls past the 0.55 cutoff — a shift of at least
  +0.033, and the difference between an answer and "nothing found". The proper
  noun is the only structural difference from the 7 concepts, which suggests
  the effect scales with how unusual the casing is for that token rather than
  with casing as such. One observation, not a measured effect.
- **`TOP_K = 5` can spend slots on near-duplicate chunks.** Chunking overlaps by
  design, so two retrieved chunks may share most of their text. Observed: five
  results of which two were largely the same passage. Input tokens are paid for
  all five, and `max_tokens` does not cap input.
- **`TOP_K = 5` also means slot competition between lectures.** As the corpus
  grows, chunks from a newly added lecture can displace chunks that previously
  answered a question, with no error and no signal — the answer simply gets
  worse. Reranking over a wider `k`, MMR-style diversification, or per-lecture
  boosting are the candidate fixes; none is implemented, and the case is
  recorded as a concrete eval target.
- **`TOP_K = 5` on a 29-chunk corpus returns a sixth of the database.** Ranking
  at this scale is weakly informative; the numbers only become meaningful once
  the corpus is substantially larger than `k`.
- **Retrieval output cannot be judged by eye.** Results come back in Chinese.
  The `expect_terms` check makes pass/fail mechanical, but diagnosing *why* a
  query failed still requires an intermediary. This is the open blocker for
  analysing false positives at scale.
- **The evaluation set is small and partly non-blind.** 2 noise concepts across
  3 videos in 1.5 domains. `管脚分配` and `红烧肉怎么做` were both run in earlier
  sessions, so they are not blind; they are kept because they are the only
  anchor to pre-existing measurements. `pin_assignment` also uses a bare noun
  phrase in Chinese against full questions in Russian and English, which is the
  same formulation drift the rest of the set was cleaned of.
- **The threshold filter is duplicated.** The same list comprehension lives in
  `main()` of `search.py` and in the endpoint. A threshold change requires
  editing both. The fix is a `max_distance=None` parameter on `search()`, so the
  filter has one home and the caller supplies the policy; deferred until a third
  caller exists, because at two the indirection costs more than the duplication.

### Generation

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
  returning an answer entirely in Chinese, the language of the corpus. The
  14 Aug message-layout change — XML-tagged blocks with a trailing language
  instruction — flipped that observed case and held through the English
  benchmark runs that followed. It remains an instruction, not a check:
  Chinese and Russian queries have not been re-measured since the change, and
  there is still no post-generation verification, so nothing *prevents* the
  wrong language from reaching a user.
- **A conversation grows the prompt every turn.** `<history>` carries the last
  two questions and the last answer in full, so input tokens per request rise
  with the length of the thread. Nothing truncates by token count — the bound
  is a turn count, which is a proxy, not a limit.
- **Provider disconnection mid-stream is untested.** The three `openai`
  exception classes are caught around `iter_answer_tokens()`, but the branch
  has never been triggered against a real interruption; only the timeout path
  was forced and observed.
- **The "no answer in the corpus" path has executed once, unplanned.** During
  the rewrite benchmark, generation received two above-threshold chunks and a
  question they could not answer, and stated that the fragments contain no such
  information instead of extrapolating. The refusal rule works in at least one
  configuration. The designed test — a term from the corpus crossed with an
  aspect the lectures do not cover — has still not run, and one execution says
  little about the `<history>`/`<context>` separation in general.

### Multi-turn

- **The rewrite benchmark covers English only.** On four valid referent pairs
  the calibrated threshold held and the rewritten query landed closer than the
  human phrasing every time — see
  [Evaluation](#the-threshold-on-rewritten-queries). Chinese is the unmeasured
  half, and it owns the two worst logged incidents: the same question returning
  5 chunks with an empty history and 1 with history present, and a rewrite that
  returned a statement lifted from the previous answer instead of a query. The
  failure class stands — retrieval degrades into a fluent answer, not into an
  error — but its size in Chinese is unknown.
- **Ordinal referents are resolved by guessing.** "What about the second one?"
  was rewritten into one concrete method the model picked itself. The
  enumeration that defines "second" lives in the previous *answer*, and only
  its first 400 characters reach `rewrite_query()`. Generation then refused
  honestly — the rewritten query retrieved real chunks, but the original
  question had no "second one" to bind to in them. One observation; no fix
  scheduled before deployment.
- **The rewrite alters wording beyond what the prompt allows.** Observed: a
  question containing a mis-typed term came back with the term corrected. The
  correction was right, and it is still an edit the instruction forbids, which
  means the constraint holds by disposition rather than by construction. The
  English benchmark added a systematic form of the same thing: questions are
  compressed into noun phrases, which measurably helps retrieval — see
  [Evaluation](#the-threshold-on-rewritten-queries) — and is still an edit the
  instruction forbids.
- **The retrieval log does not survive a restart.** The `INFO` line carrying
  the original query, the rewritten form and the raw distances goes to the
  console handler only; `logs/errors.log` starts at `ERROR`. A crashed or
  restarted process takes the retrieval history with it. A file handler for
  `INFO` is deferred to the deploy phase.

### Transcription

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

### Invalidation and staleness

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

### Concurrency

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
  worst case is bounded by `DEEPSEEK_TIMEOUT` (30 s) rather than by the SDK
  default of 600 s. None of these numbers come from a load test.
- **A hanging LLM call holds a threadpool worker for the length of its
  timeout.** The DeepSeek call is synchronous, so a slow provider occupies its
  worker until `DEEPSEEK_TIMEOUT` (30 s) expires, and a stalled rewrite until
  `REWRITE_TIMEOUT` (10 s). Both are bounded now, which the SDK default of
  600 s was not; combined with the single DB connection, a burst of slow
  requests still leaves the API unresponsive while the process is alive and the
  port is open.
- **`embed` and `search` run on CPU.** The installed torch build has no CUDA
  support for Pascal (GTX 1060, sm_61): PyTorch 2.8+ dropped it from the
  cu128/cu129 wheels. Fixing this needs a cu126 build and possibly a torch
  downgrade. Deferred — measured cost is ~1.4 s per chunk, acceptable at the
  current corpus size.

## Rejected alternatives

Options considered and turned down, with the reason. Kept because the reasons
are the argument; the list is what stops a decision from being re-opened every
time it feels inconvenient.

| Option | Rejected because |
|---|---|
| LangChain | The pipeline is four explicit stages; a framework would hide exactly the parts this project exists to demonstrate. |
| IVFFlat / HNSW | An approximate index trades recall for speed and changes the answer, not just the time. At 29 chunks the exact scan *is* the ground truth. Revisit above ~500 chunks. |
| Resuming a partially processed job from its last stage | Every stage would have to answer "how much of me is already done"; without that, a half-finished `embed` inserts duplicate chunks and retrieval returns the same fragment twice. |
| Two standalone queries instead of history in generation | A standalone query preserves referents but not the conversation: "say that shorter" and "no, I meant the second one" have nothing to attach to. |
| Sending misses in the conversation history | An empty or half-delivered answer becomes the referent the next pronoun resolves against. |
| Server-side conversation storage | Requires auth, which does not exist. `localStorage` costs nothing and survives a refresh. |
| A right-hand sources column | Sources belong under the answer they support; a separate column forces the eye to bind them by position. |
| Async rewriting | The rewrite is on the critical path before retrieval; concurrency buys nothing when nothing else can start. |
| Open registration | Free registration caps no spend. Spend is capped by a per-IP rate limit and a global daily ceiling, which is a separate mechanism. |
| Hosted CPU transcription | Tens of minutes per lecture — worse than not offering the feature. |
| A rented VPS for the API | It would still have no GPU, so transcription would stay on this machine and the tunnel with it. Paying a monthly bill to move only the cheap half of the system buys nothing. |
| Cloudflare Tunnel | Built and abandoned: on this connection the session to the Cloudflare edge is terminated after two to three minutes, reproducibly, on QUIC and HTTP/2 alike. Tailscale Funnel held under the same conditions. |
| A Next.js rewrite proxying the API | Every request would then arrive from Vercel's edge address, collapsing the per-IP limit into a second global one. |
| Redis for the rate limit | One process, no state to share. A broker coordinates nothing here. |
| Docker before the public deployment | One target host, one deploy. Containerisation is work that buys nothing until there is a second environment — and it would not have fixed the CUDA failure that cost the most time, since the driver stays on the host either way. |

---

*Portfolio project — architecture and pipeline built stage by stage.*