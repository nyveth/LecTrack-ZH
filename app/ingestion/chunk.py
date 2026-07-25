import logging
import json
import sys

from app.core.config import (
    MODEL_NAME,
    TRANSCRIPTS_DIR,
    TARGET_TOKENS,
    CHUNKS_DIR,
    OVERLAP_TOKENS,
)
from collections import Counter
from transformers import AutoTokenizer
from pathlib import Path
from app.core.log_config import setup_logging
from app.core.results import FileResult


logger = logging.getLogger(__name__)


def _build_chunk(
    video_id: str,
    buffer: list,  # (idx, segment) tuples
    segment_start_idx: int,
    segment_end_idx: int,
) -> dict:

    # chunk_id derived from data, not runtime state -> stable across reruns
    return {
        "chunk_id": f"{video_id}:{segment_start_idx}",
        "video_id": video_id,
        "chunk_start": buffer[0][1]["start"],
        "chunk_end": buffer[-1][1]["end"],
        "segment_start_idx": segment_start_idx,
        "segment_end_idx": segment_end_idx,
        "text": "\n".join(seg["text"] for _, seg in buffer),
    }


def count_tokens(text: str, tokenizer) -> int:
    tokens_count = len(tokenizer.encode(text))
    return tokens_count


def chunk_transcript(
    transcript: dict,
    tokenizer,
    target_tokens: int,
    overlap_tokens: int,
) -> list[dict]:

    # degenerate case: the retained overlap would already exceed target,
    # so the buffer never shrinks
    if overlap_tokens >= target_tokens:
        raise ValueError("Overlap tokens more than target tokens")

    video_id = transcript["video_id"]
    segments = transcript["segments"]

    chunks = []
    buffer = []
    current_tokens = 0

    last_emitted_idx = -1

    for idx, segment in enumerate(segments):
        seg_tokens = count_tokens(segment["text"], tokenizer=tokenizer)

        # a fresh buffer anchors the chunk id
        if not buffer:
            segment_start_idx = idx
        buffer.append((idx, segment))
        current_tokens += seg_tokens

        # overshoot: segments are taken whole, target_tokens is a soft target
        if current_tokens >= target_tokens:
            overlap_sum = 0
            chunks.append(_build_chunk(video_id, buffer, segment_start_idx, idx))

            last_emitted_idx = idx
            # walk back from the end to collect the overlap tail
            for j in range(len(buffer) - 1, -1, -1):
                overlap_sum += count_tokens(buffer[j][1]["text"], tokenizer=tokenizer)
                if overlap_sum >= overlap_tokens:
                    i = j
                    break
            buffer = buffer[i:]
            segment_start_idx = buffer[0][0]
            current_tokens = overlap_sum

    # tail below the threshold becomes the last chunk of the lecture
    if buffer and buffer[-1][0] > last_emitted_idx:
        chunks.append(_build_chunk(video_id, buffer, segment_start_idx, buffer[-1][0]))

    return chunks


def chunk_file(
    transcript_path: Path,
    tokenizer,
    target_tokens: int,
    chunks_dir: Path,
    overlap_tokens: int,
) -> FileResult:
    """Split transcripts into overlapping token-bounded chunks."""
    final_path = chunks_dir / transcript_path.name

    # mtime-only invalidation: an edit preserving mtime is missed
    if final_path.exists():
        source_mtime = transcript_path.stat().st_mtime
        output_mtime = final_path.stat().st_mtime
        if output_mtime >= source_mtime:
            logger.info("Chunks up to date, skipping: %s", final_path.name)
            return FileResult.SKIPPED
        logger.info("Source newer, rechunking: %s", final_path.name)

    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    chunks = chunk_transcript(transcript, tokenizer, target_tokens, overlap_tokens)

    if not chunks:
        logger.warning("Zero chunks produced: %s", transcript_path.name)
        return FileResult.EMPTY

    # write-then-rename: a crash leaves the old file intact, not a truncated one
    tmp_path = chunks_dir / f"{transcript_path.name}.tmp"
    tmp_path.write_text(
        json.dumps(chunks, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    tmp_path.replace(final_path)

    logger.info("Wrote %d chunks: %s", len(chunks), final_path.name)
    return FileResult.WRITTEN


def main() -> None:
    setup_logging()

    if not TRANSCRIPTS_DIR.exists():
        logger.error("Transcripts dir not found: %s", TRANSCRIPTS_DIR)
        sys.exit(1)

    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)

    # tokenizer loaded here, not in config.py: keeps config import side-effect free
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

    counts = Counter()
    failed = 0
    total = 0

    for transcript_path in sorted(TRANSCRIPTS_DIR.glob("*.json")):
        total += 1
        try:
            counts[
                chunk_file(
                    transcript_path,
                    tokenizer,
                    TARGET_TOKENS,
                    CHUNKS_DIR,
                    OVERLAP_TOKENS,
                )
            ] += 1
        except Exception:
            logger.exception("Chunking failed: %s", transcript_path.name)
            failed += 1
    logger.info(
        "Done: %d written, %d skipped, %d empty, %d failed (of %d)",
        counts[FileResult.WRITTEN],
        counts[FileResult.SKIPPED],
        counts[FileResult.EMPTY],
        failed,
        total,
    )


if __name__ == "__main__":
    main()
