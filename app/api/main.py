import psycopg
from fastapi import FastAPI
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import DATABASE_URL, MODEL_NAME, TOP_K, DISTANCE_THRESHOLD
from app.retrieval.search import search
from app.generation.generate import generate_answer

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# тяжёлое - один раз, при импорте модуля
model = SentenceTransformer(MODEL_NAME)

conn = psycopg.connect(DATABASE_URL, autocommit=True)
register_vector(conn)


@app.get("/search")
def search_endpoint(query: str, top_k: int = TOP_K) -> dict:
    results = search(query=query, conn=conn, top_k=top_k, model=model)

    filtered_results = [row for row in results if row["distance"] <= DISTANCE_THRESHOLD]
    if not filtered_results:
        return {"answer": "", "sources": []}

    answer_llm = generate_answer(query, filtered_results)
    return {"answer": answer_llm, "sources": filtered_results}
