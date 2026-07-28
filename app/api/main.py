import psycopg
from fastapi import FastAPI
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer

from app.core.config import DATABASE_URL, MODEL_NAME, TOP_K, DISTANCE_THRESHOLD
from app.retrieval.search import search

app = FastAPI()

# тяжёлое - один раз, при импорте модуля
model = SentenceTransformer(MODEL_NAME)

conn = psycopg.connect(DATABASE_URL, autocommit=True)
register_vector(conn)


@app.get("/search")
def search_endpoint(query: str, top_k: int = TOP_K) -> list[dict]:
    results = search(query=query, conn=conn, top_k=top_k, model=model)
    filtered_results = [row for row in results if row["distance"] <= DISTANCE_THRESHOLD]
    return filtered_results
