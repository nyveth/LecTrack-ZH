import json

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pgvector.psycopg import register_vector
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

from app.core.config import DATABASE_URL, DISTANCE_THRESHOLD, MODEL_NAME, TOP_K
from app.core.log_config import setup_logging
from app.generation.generate import (
    LlmTruncated,
    LlmUnavailable,
    RewriteUnavailable,
    iter_answer_tokens,
    rewrite_query,
    start_generate_answer,
)
from app.retrieval.search import search

setup_logging()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)

# тяжёлое - один раз, при импорте модуля
model = SentenceTransformer(MODEL_NAME)

conn = psycopg.connect(DATABASE_URL, autocommit=True)
register_vector(conn)


def sse(event, data):
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def empty_stream():
    yield sse("sources", [])
    yield sse("done", {"truncated": False})


def event_stream(stream, sources):
    yield sse("sources", sources)
    try:
        for text in iter_answer_tokens(stream):
            yield sse("token", {"t": text})
    except LlmTruncated:
        yield sse("done", {"truncated": True})
        return
    except LlmUnavailable:
        yield sse(
            "error",
            {"detail": "Connection lost while generating answer. Please try again."},
        )
        return
    yield sse("done", {"truncated": False})


class Message(BaseModel):
    question: str
    answer: str


class SearchRequest(BaseModel):
    query: str = Field(..., max_length=500)
    history: list[Message] = Field(default=[], max_length=10)
    top_k: int = Field(default=TOP_K, ge=1, le=20)


@app.post("/search")
def search_endpoint(body: SearchRequest):
    if not body.query.strip():
        raise HTTPException(
            status_code=400,
            detail="Search query cannot be empty or contain only whitespace.",
        )

    history_dicts = []
    if not body.history:
        results = search(query=body.query, conn=conn, top_k=body.top_k, model=model)
    else:
        history_dicts = [turn.model_dump() for turn in body.history]
        try:
            standalone_query = rewrite_query(body.query, history_dicts)
        except RewriteUnavailable:
            raise HTTPException(
                status_code=503,
                detail="We were unable to generate a response at this time. Please try again later.",
            )
        results = search(
            query=standalone_query, conn=conn, top_k=body.top_k, model=model
        )

    filtered_results = [row for row in results if row["distance"] <= DISTANCE_THRESHOLD]
    if not filtered_results:
        return StreamingResponse(empty_stream(), media_type="text/event-stream")

    try:
        stream = start_generate_answer(body.query, filtered_results, history_dicts)
    except LlmUnavailable:
        raise HTTPException(
            status_code=503,
            detail="We were unable to generate a response at this time. Please try again later.",
        )

    sources_payload = [
        {
            "chunk_id": row["chunk_id"],
            "video_id": row["video_id"],
            "text": row["text"],
            "chunk_start": row["chunk_start"],
            "chunk_end": row["chunk_end"],
        }
        for row in filtered_results
    ]
    return StreamingResponse(
        event_stream(stream, sources_payload), media_type="text/event-stream"
    )
