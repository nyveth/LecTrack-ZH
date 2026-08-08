import psycopg
from fastapi import FastAPI, HTTPException
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import DATABASE_URL, MODEL_NAME, TOP_K, DISTANCE_THRESHOLD
from app.retrieval.search import search
from app.generation.generate import generate_answer, LlmUnavailable
from app.core.log_config import setup_logging

setup_logging()

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
    if not query.strip():
        raise HTTPException(
            status_code=400,
            detail="Search query cannot be empty or contain only whitespace.",
        )

    results = search(query=query, conn=conn, top_k=top_k, model=model)

    filtered_results = [row for row in results if row["distance"] <= DISTANCE_THRESHOLD]
    if not filtered_results:
        return {"answer": "", "sources": []}

    try:
        answer_llm = generate_answer(query, filtered_results)
    except LlmUnavailable:
        raise HTTPException(
            status_code=503,
            detail="We were unable to generate a response at this time. Please try again later.",
        )

    return {"answer": answer_llm, "sources": filtered_results}
