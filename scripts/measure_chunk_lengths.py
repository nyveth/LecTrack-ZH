import json
import statistics

from sentence_transformers import SentenceTransformer
from transformers import AutoTokenizer

from app.core.config import OVERLAP_TOKENS, TARGET_TOKENS, TRANSCRIPTS_DIR
from app.ingestion.chunk import chunk_transcript


def measure(transcript_path: str, target_tokens: int, overlap_tokens: int):
    tokenizer = AutoTokenizer.from_pretrained("BAAI/bge-m3")

    model = SentenceTransformer("BAAI/bge-m3")
    max_seq_length = model.max_seq_length

    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))

    chunks = chunk_transcript(
        transcript=transcript,
        tokenizer=tokenizer,
        target_tokens=target_tokens,
        overlap_tokens=overlap_tokens,
    )

    real_lengths = []
    for chunk in chunks:
        embed_len = len(tokenizer.encode(chunk["text"]))
        real_lengths.append(embed_len)

    n = len(real_lengths)
    median = statistics.median(real_lengths)
    maximum = max(real_lengths)
    p95 = sorted(real_lengths)[int(0.95 * len(real_lengths))]

    over_limit = sum(1 for length in real_lengths if length > max_seq_length)

    print(f"max_seq_length (ceiling embed): {max_seq_length}")
    print(f"chunks all: {n}")
    print(f"median: {median}  |  p95: {p95}  |  max: {maximum}")
    print(f"climb over the ceiling (will be cut down silently): {over_limit}")


if __name__ == "__main__":
    measure(
        transcript_path=next(TRANSCRIPTS_DIR.glob("*.json")),
        target_tokens=TARGET_TOKENS,
        overlap_tokens=OVERLAP_TOKENS,
    )
