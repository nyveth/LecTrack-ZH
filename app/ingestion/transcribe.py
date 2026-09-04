import json
import logging
import sys
from collections import Counter
from pathlib import Path

from faster_whisper import WhisperModel

from app.core.config import LECTURES_DIR, TRANSCRIPTS_DIR
from app.core.log_config import setup_logging
from app.core.results import FileResult

logger = logging.getLogger(__name__)


def transcribe_file(
    video_path: Path, model: WhisperModel, transcripts_dir: Path
) -> FileResult:
    """Transcribe one lecture video to a JSON transcript."""
    file_name = video_path.stem
    out_file = transcripts_dir / f"{file_name}.json"
    transcripts_dir.mkdir(parents=True, exist_ok=True)

    # the artifact on disk is the completion marker, not the log
    if out_file.exists():
        logger.info("Transcript exists, skipping: %s", out_file.name)
        return FileResult.SKIPPED

    logger.info("Start transcribing: %s", file_name)

    # lazy generator: corrupt-audio errors surface during iteration, not here
    segments, info = model.transcribe(
        str(video_path), beam_size=5, language="zh", vad_filter=True
    )

    # ms precision is noise for retrieval
    result_segments = []
    for segment in segments:
        result_segments.append(
            {
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text,
            }
        )

    data = {
        "video_id": file_name,
        "language": info.language,
        "segments": result_segments,
    }

    # write-then-rename: a crash mid-write leaves no half-written transcript
    tmp_file = out_file.with_name(out_file.name + ".tmp")
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp_file.replace(out_file)

    logger.info("Wrote %d segments: %s", len(result_segments), out_file.name)
    return FileResult.WRITTEN


def main() -> None:
    setup_logging()

    if not LECTURES_DIR.exists():
        logger.error("The folder containing the lecture materials doesn't exist")
        sys.exit(1)

    video_files = sorted(LECTURES_DIR.glob("*.mp4"))
    if not video_files:
        logger.warning("Lectures haven't been uploaded")
        sys.exit(0)

    model_size = "small"
    model = WhisperModel(model_size, device="cuda", compute_type="int8")

    counts = Counter()
    failed = 0
    total = 0

    for video_path in video_files:
        total += 1

        # error boundary per file: one bad video must not kill the run
        try:
            counts[transcribe_file(video_path, model, TRANSCRIPTS_DIR)] += 1
        except Exception:
            logger.exception("Transcription failed: %s", video_path.name)
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
