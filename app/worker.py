import logging
import time

import psycopg
from faster_whisper import WhisperModel
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from sentence_transformers import SentenceTransformer
from transformers import AutoTokenizer

from app.core.config import (
    BATCH_SIZE,
    CHUNKS_DIR,
    DATABASE_URL,
    LECTURES_DIR,
    MODEL_NAME,
    OVERLAP_TOKENS,
    POLL_INTERVAL,
    TARGET_TOKENS,
    TRANSCRIPTS_DIR,
)
from app.core.log_config import setup_logging
from app.ingestion.chunk import chunk_file
from app.ingestion.embed import embed_file
from app.ingestion.transcribe import transcribe_file

setup_logging()
logger = logging.getLogger(__name__)

CLAIM_QUERY = """
WITH next_job AS (
    SELECT id
    FROM jobs
    WHERE status = 'queued'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE jobs
SET status = 'running'
FROM next_job
WHERE jobs.id = next_job.id
RETURNING jobs.id, jobs.filename
"""


def claim_job(conn) -> dict | None:
    with conn.transaction():
        with conn.cursor(row_factory=dict_row) as curr:
            curr.execute(CLAIM_QUERY)
            return curr.fetchone()


def set_stage(conn, job_id, stage):
    with conn.cursor() as curr:
        curr.execute("UPDATE jobs SET stage = %s WHERE id = %s", (stage, job_id))


def process_job(
    conn,
    transcribe_model: WhisperModel,
    embed_model: SentenceTransformer,
    job: dict,
    tokenizer,
) -> None:
    video_path = LECTURES_DIR / f"{job['id']}_{job['filename']}"
    transcript_path = TRANSCRIPTS_DIR / f"{video_path.stem}.json"
    chunk_path = CHUNKS_DIR / transcript_path.name

    try:
        set_stage(conn, job["id"], "transcribe")
        transcribe_file(video_path, transcribe_model, TRANSCRIPTS_DIR)

        set_stage(conn, job["id"], "chunk")
        chunk_file(
            transcript_path, tokenizer, TARGET_TOKENS, CHUNKS_DIR, OVERLAP_TOKENS
        )

        set_stage(conn, job["id"], "embed")
        embed_file(chunk_path, embed_model, BATCH_SIZE, conn)

        with conn.cursor() as curr:
            curr.execute(
                "UPDATE jobs SET status = %s WHERE id = %s", ("done", job["id"])
            )

    except Exception as e:
        logger.exception("Job %s failed", job["id"])
        with conn.cursor() as curr:
            curr.execute(
                "UPDATE jobs SET status = %s, error = %s WHERE id = %s",
                ("failed", str(e), job["id"]),
            )


def main() -> None:
    conn = psycopg.connect(DATABASE_URL, autocommit=True)
    register_vector(conn)
    #transcribe_model = WhisperModel("small", device="cuda", compute_type="int8")
    transcribe_model = WhisperModel(
    "large-v3",
    device="cuda",
    compute_type="float16",
)
    embed_model = SentenceTransformer(MODEL_NAME)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

    while True:
        job = claim_job(conn)
        if job:
            process_job(conn, transcribe_model, embed_model, job, tokenizer)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
