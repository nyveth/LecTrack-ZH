import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")

LECTURES_DIR = BASE_DIR / "data" / "lectures"
TRANSCRIPTS_DIR = BASE_DIR / "data" / "transcripts"
CHUNKS_DIR = BASE_DIR / "data" / "chunks"
LOG_DIR = BASE_DIR / "logs"
TARGET_TOKENS = 512
OVERLAP_TOKENS = 64
MODEL_NAME = "BAAI/bge-m3"
DATABASE_URL = os.environ["DATABASE_URL"]
TOP_K = 5

# measured on a 29-chunk corpus: worst hit 0.4821, best noise 0.6000.
# recalculate when the corpus changes - distances are not portable across corpora.
DISTANCE_THRESHOLD = 0.55
