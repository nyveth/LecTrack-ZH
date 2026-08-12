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
DEEPSEEK_API_KEY = os.environ["DEEPSEEK_API_KEY"]
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-v4-flash"
DEEPSEEK_MAX_TOKENS = 1000
REWRITE_MAX_TOKENS = 200

# measured: 6 calls, longest 6-7s, none reached the 1000-token cap.
# extrapolated worst case ~15s at a full cap; 30 is a 2x margin over that.
# not derived from concurrency - the queue forms before the call starts.
DEEPSEEK_TIMEOUT = 30.0
REWRITE_TIMEOUT = 10.0

# measured on a 29-chunk corpus: worst hit 0.5209, best noise 0.6000.
# margin is 0.029 - a single new chunk can invalidate this.
# recalculate when the corpus changes - distances are not portable across corpora.
DISTANCE_THRESHOLD = 0.55
