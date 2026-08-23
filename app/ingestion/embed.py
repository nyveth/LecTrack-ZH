import json
import logging
import sys
from collections import Counter

import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer

from app.core.config import BATCH_SIZE, CHUNKS_DIR, DATABASE_URL, MODEL_NAME
from app.core.log_config import setup_logging
from app.core.results import FileResult

logger = logging.getLogger(__name__)


def embed_file(
    chunk_path: str, model: SentenceTransformer, batch_size: int, conn
) -> FileResult:
    """embed one chunk file into the DB. Idempotent per video_id, all-or-nothing."""

    with open(chunk_path, "r", encoding="utf-8") as f:
        chunks: list[dict] = json.load(f)

    if not chunks:
        logger.warning("Chunks %s is empty!", chunk_path)
        return FileResult.EMPTY

    # from payload, not filename: idempotency key must survive a rename
    video_id = chunks[0]["video_id"]

    # safe only because the write below is atomic - partial rows would skip forever
    with conn.cursor() as curr:
        curr.execute(
            "SELECT EXISTS(SELECT 1 FROM embeddings WHERE video_id = %s);", (video_id,)
        )
        already_exists = curr.fetchone()[0]

    if already_exists:
        logger.info("Embeddings for this file %s exists, skipping", video_id)
        return FileResult.SKIPPED

    texts = [chunk["text"] for chunk in chunks]
    embeddings = model.encode(texts, batch_size=batch_size)

    # one transaction per file: kills the partial-state case
    with conn.transaction():
        with conn.cursor() as curr:
            for chunk, embedding in zip(chunks, embeddings):
                curr.execute(
                    """
                    INSERT INTO embeddings(
                        chunk_id,
                        video_id,
                        text,
                        chunk_start,
                        chunk_end,
                        segment_start_idx,
                        segment_end_idx,
                        embedding
                    ) VALUES(%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        chunk["chunk_id"],
                        chunk["video_id"],
                        chunk["text"],
                        chunk["chunk_start"],
                        chunk["chunk_end"],
                        chunk["segment_start_idx"],
                        chunk["segment_end_idx"],
                        embedding,
                    ),
                )
        logger.info("Embedded %d chunks: %s", len(chunks), video_id)
        return FileResult.WRITTEN


def main() -> None:
    setup_logging()

    if not CHUNKS_DIR.exists():
        logger.error("Chunks directory doesn't exist")
        sys.exit(1)

    # 3GB VRAM; peak scales as batch_size x max_seq_len^2 due to padding
    model = SentenceTransformer(MODEL_NAME)

    counts = Counter()
    failed = 0
    total = 0

    # autocommit=True so conn.transaction() is the only explicit boundary
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        # numpy.ndarray -> pgvector adapter
        register_vector(conn)
        for chunk_path in sorted(CHUNKS_DIR.glob("*.json")):
            total += 1

            # error boundary per file: one bad file must not kill the run
            try:
                counts[embed_file(chunk_path, model, BATCH_SIZE, conn)] += 1
            except Exception as e:
                failed += 1
                logger.error("Embedding error %s: %s", chunk_path, e)
    logger.info(
        "Done: %d written, %d skipped, %d empty, %d failed (of %d)",
        counts[FileResult.WRITTEN],
        counts[FileResult.SKIPPED],
        counts[FileResult.EMPTY],
        failed,
        total,
    )


if __name__ == "__main__":
    main()
