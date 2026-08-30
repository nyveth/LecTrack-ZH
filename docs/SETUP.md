# Setup

Installation and operation of LecTrack-ZH. Architecture and design decisions
live in the [README](../README.md).

## Requirements

- [uv](https://github.com/astral-sh/uv)
- PostgreSQL 18 with the pgvector extension
- Node.js 20+ and npm - frontend only
- NVIDIA GPU with >=3 GB VRAM and CUDA 12.4 - required by `transcribe` only.
  `embed` and `search` run on CPU (see
  [Known limitations](../README.md#known-limitations)).
- ~2.5 GB of free disk for the BGE-M3 weights, plus network access on first run
- A DeepSeek API key **with a non-zero balance**. There is no free grant: a new
  account returns `granted_balance: "0.00"` from `GET /user/balance` and every
  call fails until the account is topped up. The key is required to *import*
  the pipeline at all - see [step 5](#5-configuration).

These commands were written from a live install and the upstream docs. They
have not been reproduced on a clean machine. Treat them as a hypothesis until
someone runs them from scratch.

## 1. PostgreSQL 18 + pgvector

The PGDG repository ships a prebuilt pgvector package; no compilation needed.

```bash
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

## 2. Database, role, extension

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE ragbot LOGIN PASSWORD 'your-password-here';
CREATE DATABASE ragbot OWNER ragbot;
\c ragbot
CREATE EXTENSION vector;
GRANT CREATE ON SCHEMA public TO ragbot;
```

`CREATE EXTENSION` requires superuser and is per-database: it must be run inside
`ragbot`, not in the default `postgres` database.

`GRANT CREATE ON SCHEMA public` is not redundant either. Since PostgreSQL 15 the
`public` schema no longer grants `CREATE` to every role by default, so a freshly
created role fails on its first `CREATE TABLE` with a permission error - before
any SQL in it is parsed.

## 3. Schema

```bash
psql "postgresql://ragbot:your-password-here@localhost:5432/ragbot" -f db/schema.sql
```

`db/schema.sql` is the single source of truth for the database structure. It is
not idempotent by design: a second run against a populated database fails loudly
instead of silently doing nothing.

The tables, their constraints and the reasoning behind them are documented in
[Schema](../README.md#schema).

## 4. Python dependencies

```bash
uv sync
```

This creates `.venv` but does not activate it. Every command in this document is
prefixed with `uv run`, which resolves the environment without activation. If you
activate the venv yourself, drop the prefix - but do not mix the two conventions
in one shell.

## 5. Configuration

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
imported by `transcribe`, `chunk`, `embed` and `search` alike, and the subscript
is evaluated at import. Without the key a fresh clone cannot even chunk a
transcript, though chunking never talks to DeepSeek. This is a deliberate trade -
one loud failure at import beats four quiet ones later - but it is a real cost
for anyone who only wants the ingestion half.

What the check does **not** cover: the key's validity and the account balance.
An invalid key and a zero balance both pass the import silently and fail on the
first API call, because verifying either requires a network round trip at import
time.

The DeepSeek key is displayed **once**, at creation, and cannot be recovered -
only regenerated. Copy the whole value including the `sk-` prefix; a key without
it returns `authentication_error`.

Non-secret constants live in `app/core/config.py`, not in `.env`:
`TARGET_TOKENS`, `OVERLAP_TOKENS`, `MODEL_NAME`, `TOP_K`, `DISTANCE_THRESHOLD`,
`DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_MAX_TOKENS`, `DEEPSEEK_TIMEOUT`,
`REWRITE_TIMEOUT`.

`DISTANCE_THRESHOLD` is corpus-specific and is not a portable constant - see
[Evaluation](../README.md#evaluation).

## 6. Frontend

```bash
cd frontend
npm install
```

The frontend reads one variable of its own, from `frontend/.env.local`:

| Variable              | Example                 | Notes                              |
|-----------------------|-------------------------|------------------------------------|
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000` | optional; falls back to that value |

`NEXT_PUBLIC_` is not decoration: Next.js inlines only variables carrying that
prefix into the browser bundle. The value is therefore public by construction
and must never hold a secret. It has a fallback in code, so local development
needs no `.env.local` at all - the file exists for deployment, where the API is
not on the same host as the page.

For a non-local API host:

```bash
echo 'NEXT_PUBLIC_API_URL=https://api.example.com' > frontend/.env.local
```

## 7. Model weights

The first `embed` run downloads BGE-M3 from HuggingFace (~2.27 GB) into
`~/.cache/huggingface` and requires network access. The download prints nothing
for minutes on a slow connection and is easily mistaken for a hung process.

`chunk` only needs the tokenizer, so a successful `chunk` run does **not** mean
the weights are cached.

Once cached, `HF_HUB_OFFLINE=1` runs fully offline - it skips revalidation calls
to the Hub and removes any rate-limit exposure:

```bash
export HF_HUB_OFFLINE=1
```

## 8. Data directories

Only the input directory has to be created; the rest appear on demand.

```bash
mkdir -p data/lectures    # put your .mp4 files here
```

```
data/transcripts/   # transcribe output
data/chunks/        # chunk output
logs/errors.log     # ERROR and above; INFO goes to stdout only
```

## 9. Verify the install

```bash
uv run python -c "import app.core.config"
psql "postgresql://ragbot:your-password-here@localhost:5432/ragbot" -c "\dt"
```

The first command fails if a required variable is missing or `.env` was never
copied. The second lists `embeddings` and `jobs`.

Both tables are empty at this point. Search returns zero results until at least
one lecture has been ingested - that is the expected state of a fresh install,
not a failure.

## Running

Three processes. The API and the worker are independent and share only the
database; neither knows the other exists.

```bash
uv run uvicorn app.api.main:app          # API      - http://127.0.0.1:8000
uv run python -m app.worker              # worker   - polls the jobs table
cd frontend && npm run dev               # frontend - http://localhost:3000
```

**Without a running worker an upload stays in `queued` indefinitely and the
interface shows no error**, because nothing has failed. The job is waiting for a
process that is not there.

`--reload` on uvicorn re-imports the module on every file change, and the module
loads 2.27 GB of weights at import. Add the flag only while editing.

Ingestion can also be driven stage by stage from the command line, without the
API or the worker - see [Pipeline](../README.md#pipeline).