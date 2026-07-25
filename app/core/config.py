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
