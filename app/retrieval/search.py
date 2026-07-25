import sys
import psycopg
import logging

from psycopg.rows import dict_row
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer
from app.core.log_config import setup_logging
from app.core.config import MODEL_NAME, TOP_K, DATABASE_URL

logger = logging.getLogger(__name__)


def search(query: str, conn, top_k: int, model: SentenceTransformer) -> list[dict]:

    query_embendding = model.encode(query)

    with conn.cursor(row_factory=dict_row) as curr:
        curr.execute(
            """
            SELECT
                chunk_id,
                video_id,
                text,
                chunk_start,
                chunk_end,
                embedding <=> %s AS distance
            FROM embeddings
            ORDER BY distance
            LIMIT %s
            """,
            (query_embendding, top_k),
        )
        return curr.fetchall()


def main() -> None:
    setup_logging()

    if len(sys.argv) <= 1:
        logger.error("Usage: python3 -m app.retrieval.search 'query'")
        sys.exit(1)

    query = sys.argv[1]

    model = SentenceTransformer(MODEL_NAME)

    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        register_vector(conn)
        results = search(query, conn, TOP_K, model)

    if not results:
        logger.warning("No matches found for the query: %s", query)
        return

    for rank, row in enumerate(results, 1):
        print(
            f"\n[{rank}] distance={row['distance']:.4f}  "
            f"{row['video_id']}  "
            f"{row['chunk_start']:.1f}-{row['chunk_end']:.1f}s  "
            f"{row['chunk_id']}"
        )
        print(row["text"])


if __name__ == "__main__":
    main()
