import json

import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer

from app.core.config import (
    BASE_DIR,
    DATABASE_URL,
    DISTANCE_THRESHOLD,
    MODEL_NAME,
)
from app.retrieval.search import search

QUERIES_PATH = BASE_DIR / "tests" / "queries.json"


def compare_case_shift(query: str, conn, model, top_k: int = 3) -> dict:
    clean_query = query.strip()
    if not clean_query:
        return {
            "top1_match": False,
            "top3_overlap": "0/0",
            "orig_dist": None,
            "lower_dist": None,
            "signed_delta": None,
            "outcome": "empty_query",
        }

    orig_res = search(query=clean_query, conn=conn, top_k=top_k, model=model)
    lower_res = search(query=clean_query.lower(), conn=conn, top_k=top_k, model=model)

    if not orig_res or not lower_res:
        raise RuntimeError(
            "БД вернула пустую выдачу. Проверь наличие данных в таблице."
        )

    orig_top = orig_res[0]
    lower_top = lower_res[0]

    orig_ids = [r["chunk_id"] for r in orig_res]
    lower_ids = [r["chunk_id"] for r in lower_res]

    top1_match = orig_top["chunk_id"] == lower_top["chunk_id"]
    overlap_count = len(set(orig_ids) & set(lower_ids))
    top3_overlap = f"{overlap_count}/{top_k}"

    signed_delta = lower_top["distance"] - orig_top["distance"]

    orig_passed = orig_top["distance"] <= DISTANCE_THRESHOLD
    lower_passed = lower_top["distance"] <= DISTANCE_THRESHOLD

    if orig_passed and lower_passed:
        outcome = "both_pass"
    elif not orig_passed and not lower_passed:
        outcome = "both_fail"
    elif orig_passed and not lower_passed:
        outcome = "orig_only"
    else:
        outcome = "lower_only"

    return {
        "top1_match": top1_match,
        "top3_overlap": top3_overlap,
        "orig_dist": orig_top["distance"],
        "lower_dist": lower_top["distance"],
        "signed_delta": signed_delta,
        "outcome": outcome,
    }


def main():
    model = SentenceTransformer(MODEL_NAME)
    conn = psycopg.connect(DATABASE_URL, autocommit=True)
    register_vector(conn)

    with open(QUERIES_PATH, "r", encoding="utf-8") as f:
        entries = json.load(f)

    header = (
        f"{'CONCEPT':<20} | {'TOP1_MATCH':<10} | {'TOP3_OVERLAP':<12} | "
        f"{'ORIG_DIST':<10} | {'LOWER_DIST':<10} | {'DELTA':<8} | {'OUTCOME'}"
    )
    print(header)
    print("-" * len(header))

    try:
        for entry in entries:
            concept = entry.get("concept", "unknown")
            en_query = entry.get("queries", {}).get("en", "")

            metrics = compare_case_shift(en_query, conn, model)

            if metrics["outcome"] == "empty_query":
                print(f"{concept:<20} | SKIP (empty query)")
                continue

            orig_d = f"{metrics['orig_dist']:.4f}"
            lower_d = f"{metrics['lower_dist']:.4f}"
            delta_d = f"{metrics['signed_delta']:+.4f}"

            print(
                f"{concept:<20} | "
                f"{str(metrics['top1_match']):<10} | "
                f"{metrics['top3_overlap']:<12} | "
                f"{orig_d:<10} | "
                f"{lower_d:<10} | "
                f"{delta_d:<8} | "
                f"{metrics['outcome']}"
            )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
