# tests/test_chunk_transcript.py

from app.ingestion.chunk import chunk_transcript


class FakeTokenizer:
    def encode(self, text):
        return list(text)


def test_tail_no_duplicate_on_exact_fit():
    transcript = {
        "video_id": "test_vid",
        "segments": [
            {"text": "aaaaa", "start": 0.0, "end": 1.0},
            {"text": "bbbbb", "start": 1.0, "end": 2.0},
            {"text": "ccccc", "start": 2.0, "end": 3.0},
            {"text": "ddddd", "start": 3.0, "end": 4.0},
        ],
    }

    chunks = chunk_transcript(
        transcript,
        FakeTokenizer(),
        target_tokens=10,
        overlap_tokens=3,
    )

    assert len(chunks) == 3
