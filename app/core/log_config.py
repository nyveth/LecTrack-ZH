import logging

from app.core.config import LOG_DIR


def setup_logging():
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
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

    root.addHandler(console)
    root.addHandler(errfile)
