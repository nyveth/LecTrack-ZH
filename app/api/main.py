import json
import logging
import shutil
from pathlib import Path
from uuid import uuid4

import psycopg
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

from app.core.config import (
    DATABASE_URL,
    DISTANCE_THRESHOLD,
    LECTURES_DIR,
    LLM_UNAVAILABLE_DETAIL,
    MODEL_NAME,
    TOP_K,
)
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
logger = logging.getLogger(__name__)

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
    standalone_query = body.query

    if not body.history:
        results = search(query=body.query, conn=conn, top_k=body.top_k, model=model)
    else:
        history_dicts = [turn.model_dump() for turn in body.history]
        try:
            standalone_query = rewrite_query(body.query, history_dicts)
        except RewriteUnavailable:
            raise HTTPException(
                status_code=503,
                detail=LLM_UNAVAILABLE_DETAIL,
            )
        results = search(
            query=standalone_query, conn=conn, top_k=body.top_k, model=model
        )

    distances = [round(row["distance"], 4) for row in results]
    query_changed = standalone_query.strip() != body.query.strip()
    logger.info(
        "retrieval | query: '%s', standalone: '%s', query_changed: %s, distances: %s",
        body.query.replace("\n", " "),
        standalone_query.replace("\n", " "),
        query_changed,
        distances,
    )

    filtered_results = [row for row in results if row["distance"] <= DISTANCE_THRESHOLD]
    if not filtered_results:
        return StreamingResponse(empty_stream(), media_type="text/event-stream")

    try:
        stream = start_generate_answer(body.query, filtered_results, history_dicts)
    except LlmUnavailable:
        raise HTTPException(
            status_code=503,
            detail=LLM_UNAVAILABLE_DETAIL,
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


@app.post("/upload")
def upload_endpoint(file: UploadFile = File(...)):
    if not file.filename or not file.filename.strip():
        raise HTTPException(status_code=400, detail="Filename cannot be empty")

    clean_filename = Path(file.filename).name
    if Path(clean_filename).suffix.lower() != ".mp4":
        raise HTTPException(status_code=400, detail="You can upload only .mp4 files")

    LECTURES_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = LECTURES_DIR / f"upload_{uuid4().hex}.tmp"
    written_path = tmp_path
    try:
        with open(tmp_path, "wb") as out_f:
            shutil.copyfileobj(file.file, out_f)
        with conn.transaction():
            with conn.cursor() as curr:
                curr.execute(
                    "INSERT INTO jobs (filename) VALUES (%s) RETURNING id",
                    (clean_filename,),
                )
                job_id = curr.fetchone()[0]

            final_path = LECTURES_DIR / f"{job_id}_{clean_filename}"
            tmp_path.replace(final_path)
            written_path = final_path
    except Exception:
        written_path.unlink(missing_ok=True)
        logger.exception("Failed to write uploaded file: %s", clean_filename)
        raise HTTPException(
            status_code=500, detail="Failed to store uploaded file on server."
        )
    logger.info("Upload accepted: job %s, file %s", job_id, clean_filename)
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def get_status(job_id: int):
    with conn.cursor(row_factory=dict_row) as curr:
        curr.execute("SELECT status, stage, error FROM jobs WHERE id = %s", (job_id,))
        result = curr.fetchone()

    if result is None:
        raise HTTPException(status_code=404, detail="Job not found!")
    return result
