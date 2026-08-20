import logging
import time

import psycopg
from psycopg.rows import dict_row

from app.core.config import DATABASE_URL, POLL_INTERVAL
from app.core.log_config import setup_logging

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
    """Вернуть самую старую строку в queued или None, если очередь пуста."""
    with conn.transaction():
        with conn.cursor(row_factory=dict_row) as curr:
            curr.execute(CLAIM_QUERY)
            return curr.fetchone()


def main() -> None:
    """Крутить опрос до Ctrl+C. Есть строка — залогировать, нет — поспать."""

    conn = psycopg.connect(DATABASE_URL, autocommit=True)
    while True:
        job = claim_job(conn)
        if job:
            logger.info(f"I got new job: {job['id']} {job['filename']}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
