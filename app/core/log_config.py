import logging
from logging.handlers import RotatingFileHandler

from app.core.config import LOG_DIR


def setup_logging():
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    root.handlers.clear()
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )

    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(formatter)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    errfile = logging.FileHandler(LOG_DIR / "errors.log", mode="a", encoding="utf-8")
    errfile.setLevel(logging.ERROR)
    errfile.setFormatter(formatter)

    appfile = RotatingFileHandler(
        LOG_DIR / "app.log",
        mode="a",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    appfile.setLevel(logging.INFO)
    appfile.setFormatter(formatter)

    root.addHandler(console)
    root.addHandler(errfile)
    root.addHandler(appfile)
