CREATE TABLE embeddings (
    chunk_id          TEXT PRIMARY KEY,
    video_id          TEXT             NOT NULL,
    text              TEXT             NOT NULL,
    chunk_start       DOUBLE PRECISION NOT NULL,
    chunk_end         DOUBLE PRECISION NOT NULL,
    segment_start_idx INTEGER          NOT NULL,
    segment_end_idx   INTEGER          NOT NULL,
    embedding         vector(1024)     NOT NULL
);

CREATE INDEX ON embeddings (video_id);

CREATE TABLE jobs (
    id         BIGSERIAL PRIMARY KEY,
    filename   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued' 
               CHECK (status IN ('queued', 'running', 'done', 'failed')),
    stage      TEXT 
               CHECK (stage IN ('transcribe', 'chunk', 'embed')),
    error      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_status ON jobs (status);