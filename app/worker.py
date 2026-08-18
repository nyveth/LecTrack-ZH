import logging
import time

import psycopg
from psycopg.rows import dict_row

from app.core.config import DATABASE_URL, POLL_INTERVAL
from app.core.log_config import setup_logging

setup_logging()
logger = logging.getLogger(__name__)

conn = psycopg.connect(DATABASE_URL, autocommit=True)


def claim_job(conn) -> dict | None:
    """Вернуть самую старую строку в queued или None, если очередь пуста."""
    with conn.cursor(row_factory=dict_row) as curr:
        curr.execute(
            """
            SELECT id, filename
            FROM jobs
            WHERE status = 'queued'
            ORDER BY created_at
            LIMIT 1
            """
        )
        return curr.fetchone()


def main() -> None:
    """Крутить опрос до Ctrl+C. Есть строка — залогировать, нет — поспать."""
    while True:
        job = claim_job(conn)
        if job:
            logger.info(f"I got new job: {job['id']} {job['filename']}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
