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
# Setup

Installation and operation of LecTrack-ZH. Architecture and design decisions
live in the [README](../README.md).

**Reproduction status.** These steps were written from a live install on Debian
and then reproduced once, independently, on an RPM-based distribution with a
different GPU. That second run failed three times before it worked, and the
three fixes are folded into the steps below. Two platforms is not "portable";
treat anything outside them as untested.

## Requirements

- [uv](https://github.com/astral-sh/uv)
- PostgreSQL 16 or newer with the pgvector extension. Developed on 18,
  reproduced on 16.14 with pgvector 0.8.0.
- Node.js 20+ and npm - frontend only
- NVIDIA GPU with >=3 GB VRAM - required by `transcribe` only. `embed` and
  `search` run on CPU (see
  [Known limitations](../README.md#known-limitations)). The driver alone is not
  enough; see [step 5](#5-cuda-libraries-for-transcription).
- ~2.5 GB of free disk for the BGE-M3 weights, plus network access on first run
- A DeepSeek API key **with a non-zero balance**. There is no free grant: a new
  account returns `granted_balance: "0.00"` from `GET /user/balance` and every
  call fails until the account is topped up. The key is required to *import*
  the pipeline at all - see [step 6](#6-configuration).

## 1. PostgreSQL and pgvector

The pgvector build must match the server major version. Installing the
extension for one major next to a server of another leaves `CREATE EXTENSION`
failing with a missing-file error that never mentions the mismatch.

If a PostgreSQL cluster is already running on the machine, **do not install a
newer major on top of it**. A data directory written by one major cannot be
served by another without `pg_upgrade` or a dump and restore. Version 16 is
supported; use what is already there.

### Debian / Ubuntu

The PGDG repository ships a prebuilt pgvector package; no compilation needed.

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt install -y postgresql-18 postgresql-18-pgvector
sudo systemctl enable --now postgresql
```

### Fedora / RHEL / Rocky / Alma

Package names differ between the distribution repository and PGDG, and so does
the initialisation command. From the distribution repository:

```bash
sudo dnf install -y postgresql-server pgvector
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

From PGDG the packages are `postgresql18-server` and `pgvector_18`, the unit is
`postgresql-18`, and initialisation is
`sudo /usr/pgsql-18/bin/postgresql-18-setup initdb`.

### Verify

`psql --version` reports the *client*. The number that matters is the server's:

```bash
sudo -u postgres psql -c "SHOW server_version;"
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

### Password authentication over localhost

The application connects over TCP with a password. On some distributions the
default `pg_hba.conf` answers local TCP with `ident`, and a correct URL then
fails with:

```
FATAL: Ident authentication failed for user "ragbot"
```

Creating the role and its password is not enough; the rule has to allow
password auth. Find the file and read the active rules from the server rather
than guessing at a path:

```bash
sudo -u postgres psql -c "SHOW hba_file;"
sudo -u postgres psql -c "SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules;"
```

Back the file up, then add one narrow rule for this database and role only,
above any broader `ident` line:

```
# TYPE  DATABASE  USER    ADDRESS        METHOD
host    ragbot    ragbot  127.0.0.1/32   scram-sha-256
```

Reload and verify the connection itself, not the file:

```bash
sudo systemctl reload postgresql
psql "postgresql://ragbot:your-password-here@localhost:5432/ragbot" -c "SELECT 1;"
```

Do not reach for `trust` as a quick fix. It removes authentication for every
caller that matches the line, and a temporary edit at this point in an install
is the kind that stays.

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

`pyproject.toml` requires Python 3.13 or newer, and uv will pick the newest
interpreter it can find. Pin it explicitly to stay on the version this project
was built and measured on:

```bash
uv sync --python 3.13
```

## 5. CUDA libraries for transcription

Skip this step if you are not going to transcribe anything.

**An NVIDIA driver is not a CUDA runtime.** The driver provides `libcuda`;
CTranslate2, the engine under faster-whisper, additionally needs cuBLAS 12 and
cuDNN 9, and those ship separately. The trap is that everything looks correct
until the first matrix multiply:

```
RuntimeError: Library libcublas.so.12 is not found or cannot be loaded
```

`nvidia-smi` lists the GPU, and `ctranslate2.get_cuda_device_count()` returns 1,
because both ask the driver about the device. Neither loads cuBLAS.

Install the two wheels into the project environment:

```bash
uv pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
```

They land in `site-packages/nvidia/*/lib`, and CTranslate2 resolves them with
`dlopen`, which does not look there. The directories have to be on
`LD_LIBRARY_PATH` **before the interpreter starts**:

```bash
export LD_LIBRARY_PATH=$(uv run python -c 'import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + os.path.dirname(nvidia.cudnn.lib.__file__))')
```

Two things about that line. It lives only in the current shell, so a new
terminal needs it again - put it in a launcher script or the shell profile
rather than retyping it. And if the substitution fails, `export` writes an empty
value without complaining, so check it landed:

```bash
echo "$LD_LIBRARY_PATH"
```

Two paths separated by `:`, both inside `.venv`. Anything else means the export
silently did nothing.

The download is roughly 1.3 GB.

## 6. Configuration

```bash
cp .env.example .env
chmod 600 .env
```

`.env` is gitignored. `.env.example` is **not** - it is tracked, so real values
must never be edited into it. Put them in `.env` only.

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
`BATCH_SIZE`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_MAX_TOKENS`,
`DEEPSEEK_TIMEOUT`, `REWRITE_TIMEOUT`, `SEARCH_DAILY_LIMIT`,
`SEARCH_IP_DAILY_LIMIT`.

`DISTANCE_THRESHOLD` is corpus-specific and is not a portable constant - see
[Evaluation](../README.md#evaluation).

`SEARCH_DAILY_LIMIT` and `SEARCH_IP_DAILY_LIMIT` bound what a public deployment
can spend on generation. Locally they only get in the way; raise them while
developing - see [Rate limiting](../README.md#rate-limiting).

## 7. Frontend

```bash
cd frontend
npm ci
```

`npm ci` installs exactly the lockfile, which `npm install` does not guarantee.
On a slow or filtered network it can time out on small tarballs; retrying fills
the cache and usually gets further each time. `npm config set maxsockets 1`
helps when it does not.

The frontend reads one variable of its own, from `frontend/.env.local`:

| Variable              | Example                 | Notes                              |
|-----------------------|-------------------------|------------------------------------|
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000` | optional; falls back to that value |

`NEXT_PUBLIC_` is not decoration: Next.js inlines only variables carrying that
prefix into the browser bundle. The value is therefore public by construction
and must never hold a secret. It is also inlined **at build time**, not read at
runtime, so changing it means rebuilding.

Local development needs no `.env.local` at all - the fallback covers it. The
file exists for the case where the API is not on the same host as the page:

```bash
echo 'NEXT_PUBLIC_API_URL=https://api.example.com' > frontend/.env.local
```

The same fallback is a hazard in a deployed build: with the variable unset, the
page does not fail, it asks the visitor's own machine for the API. If you deploy
this, set the variable and confirm the built bundle contains the host you
expect.

## 8. Model weights

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

## 9. Data directories

Create both output directories, not just the input one. The worker calls
`transcribe_file()` and `chunk_file()` directly, bypassing the `main()` that
would have created them, so a missing directory surfaces as a
`FileNotFoundError` *after* a transcription has already run - see
[Known limitations](../README.md#known-limitations).

```bash
mkdir -p data/lectures data/transcripts data/chunks    # put your .mp4 files in data/lectures
```

```
data/lectures/      # input, placed by you
data/transcripts/   # transcribe output
data/chunks/        # chunk output
logs/errors.log     # ERROR and above; INFO goes to stdout only
```

## 10. Verify the install

```bash
uv run python -c "import app.core.config"
psql "postgresql://ragbot:your-password-here@localhost:5432/ragbot" -c "\dt"
```

The first command fails if a required variable is missing or `.env` was never
copied. The second lists `embeddings` and `jobs`.

If you set up the GPU in step 5, check that the compute path actually loads.
Creating a `WhisperModel` is not sufficient - it succeeds even when cuBLAS is
missing, because nothing has multiplied anything yet. Run a real transcription
of a short clip instead.

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

The worker needs `LD_LIBRARY_PATH` from [step 5](#5-cuda-libraries-for-transcription)
in its own shell, and it loads the Whisper model at startup: editing the source
of a running worker changes nothing until it is restarted.

**Without a running worker an upload stays in `queued` indefinitely and the
interface shows no error**, because nothing has failed. The job is waiting for a
process that is not there.

**A failed job does not retry itself.** The worker claims only `queued` rows, so
fixing the cause of a failure does not re-run the job. Reset it by hand:

```sql
UPDATE jobs SET status = 'queued', stage = NULL, error = NULL WHERE id = <id>;
```

`--reload` on uvicorn re-imports the module on every file change, and the module
loads 2.27 GB of weights at import. Add the flag only while editing.

Ingestion can also be driven stage by stage from the command line, without the
API or the worker - see [Pipeline](../README.md#pipeline).

## Exposing the API publicly

Optional, and specific to this deployment: the frontend runs on Vercel while the
API stays on the GPU machine behind a Tailscale Funnel. The reasoning, the
alternatives that were tried and dropped, and the constraints that come with
Funnel are in [Deployment](../README.md#deployment).
`--reload` on uvicorn re-imports the module on every file change, and the module
loads 2.27 GB of weights at import. Add the flag only while editing.

Ingestion can also be driven stage by stage from the command line, without the
API or the worker - see [Pipeline](../README.md#pipeline).