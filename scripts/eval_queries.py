import json

import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer

from app.core.config import BASE_DIR, DATABASE_URL, MODEL_NAME, TOP_K
from app.retrieval.search import search

QUERIES_PATH = BASE_DIR / "tests" / "queries.json"


def first_match_rank(results: list[dict], expect_terms: list[str]) -> int | None:
    """позиция первого чанка, содержащего любой из ожидаемых терминов"""
    for rank, row in enumerate(results, 1):
        if any(term in row["text"] for term in expect_terms):
            return rank
    return None


def main() -> None:
    entries = json.loads(QUERIES_PATH.read_text(encoding="utf-8"))

    # тяжёлое - один раз, до циклов
    model = SentenceTransformer(MODEL_NAME)

    print(f"{'concept':<16} {'lang':<5} {'kind':<6} {'dist':>7}  {'top1':<5} rank")

    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        register_vector(conn)

        for entry in entries:
            for lang, query in entry["queries"].items():
                if not query:
                    print(f"{entry['concept']:<16} {lang:<5} EMPTY QUERY")
                    continue

                results = search(query, conn, TOP_K, model)
                if not results:
                    print(f"{entry['concept']:<16} {lang:<5} NO RESULTS")
                    continue

                dist = results[0]["distance"]

                # у шума правильного ответа нет - меряется только расстояние
                if entry["kind"] == "noise":
                    top1, rank = "-", "-"
                else:
                    r = first_match_rank(results, entry["expect_terms"])
                    top1 = "OK" if r == 1 else "MISS"
                    rank = str(r) if r else "-"

                print(
                    f"{entry['concept']:<16} {lang:<5} {entry['kind']:<6} "
                    f"{dist:>7.4f}  {top1:<5} {rank}"
                )


if __name__ == "__main__":
    main()
