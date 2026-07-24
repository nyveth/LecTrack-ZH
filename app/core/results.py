from enum import Enum


class FileResult(Enum):
    """outcome of processing one file. failures do not appear here:
    they bubble up as exceptions and are counted by the orchestrator."""

    WRITTEN = "written"
    SKIPPED = "skipped"
    EMPTY = "empty"
