import logging

from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI, Stream
from openai.types.chat import ChatCompletionChunk

from app.core.config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MAX_TOKENS,
    DEEPSEEK_MODEL,
    DEEPSEEK_TIMEOUT,
    REWRITE_MAX_TOKENS,
    REWRITE_TIMEOUT,
)
from app.generation.prompts import (
    CRITICAL_LANGUAGE_INSTRUCTION,
    REWRITE_PROMPT,
    SYSTEM_PROMPT,
)


class LlmUnavailable(Exception):
    pass


class LlmTruncated(Exception):
    pass


class RewriteUnavailable(Exception):
    pass


client = OpenAI(
    api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=DEEPSEEK_TIMEOUT
)
logger = logging.getLogger(__name__)


def build_user_message(query: str, chunks: list[dict], history: list[dict]) -> str:
    """Combines the question, context fragments, and history into a structured user message."""
    formatted_chunks = []
    formatted_history = []

    if history:
        for idx, turn in enumerate(history[-2:], start=1):
            question = turn["question"].strip()
            formatted_history.append(f"[Question {idx}]\n{question}")
        formatted_history.append(f"[Answer {idx}]\n{history[-1]['answer'].strip()}")

    for idx, chunk in enumerate(chunks, start=1):
        text = chunk["text"].strip()
        formatted_chunks.append(f"[Fragment {idx}]\n{text}")

    parts = []

    if history:
        history_block = "\n\n".join(formatted_history)
        parts.append(f"<history>\n{history_block}\n</history>")

    context_block = "\n\n".join(formatted_chunks)
    parts.append(f"<context>\n{context_block}\n</context>")
    parts.append(f"<question>\n{query.strip()}\n</question>")

    parts.append(CRITICAL_LANGUAGE_INSTRUCTION)
    return "\n\n".join(parts)


def rewrite_query(query: str, history: list[dict]) -> str:

    formatted_history = []
    for idx, turn in enumerate(history[-3:], start=1):
        question = turn["question"].strip()
        formatted_history.append(f"[Question {idx}]\n{question}")

    formatted_history.append(f"[Truncated Answer]\n{history[-1]['answer'][:400]}")
    formatted_history.append(f"[Latest Query]\n{query.strip()}")

    chat_context = "\n\n".join(formatted_history)

    messages = [
        {"role": "system", "content": REWRITE_PROMPT},
        {"role": "user", "content": chat_context},
    ]
    try:
        response = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=messages,
            extra_body={"thinking": {"type": "disabled"}},
            max_tokens=REWRITE_MAX_TOKENS,
            timeout=REWRITE_TIMEOUT,
        )
    except (APIConnectionError, APIStatusError, APITimeoutError):
        logger.exception("Problem when rewritting user query")
        raise RewriteUnavailable("DeepSeek unreachable during query rewrite")

    rewritten = response.choices[0].message.content.strip()

    if not rewritten:
        logger.error("Answer from LLM empty")
        raise RewriteUnavailable("Empty rewrite returned by model")

    return rewritten


def start_generate_answer(
    query: str, chunks: list[dict], history: list[dict]
) -> Stream[ChatCompletionChunk]:
    """Generates the model's text response based on the question and context chunks."""
    user_content = build_user_message(query, chunks, history)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
    try:
        return client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=messages,
            extra_body={"thinking": {"type": "disabled"}},
            max_tokens=DEEPSEEK_MAX_TOKENS,
            stream=True,
        )
    except APIConnectionError:
        logger.exception("Network error while connecting to DeepSeek")
        raise LlmUnavailable("Network error while connecting to DeepSeek")
    except APITimeoutError:
        logger.exception("Timeout after waiting for OpenAI endpoint")
        raise LlmUnavailable("Timeout after waiting for OpenAI endpoint")
    except APIStatusError as exc:
        logger.exception("LLM service unavailable (HTTP %s)", exc.status_code)
        raise LlmUnavailable("Provider rejected request")


def iter_answer_tokens(stream: Stream[ChatCompletionChunk]):
    finish_reason = None
    try:
        for chunk in stream:
            if not chunk.choices:
                continue

            choice = chunk.choices[0]

            if choice.finish_reason is not None:
                finish_reason = choice.finish_reason

            text = choice.delta.content
            if text:
                yield text
    except (APIConnectionError, APIStatusError, APITimeoutError):
        logger.exception("Stream interrupted while reading LLM response tokens")
        raise LlmUnavailable("Network stream interrupted during generation")

    if finish_reason != "stop":
        raise LlmTruncated(f"Response stopped by {finish_reason}")
