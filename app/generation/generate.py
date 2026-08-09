import logging

from openai import OpenAI, APIConnectionError, APITimeoutError, APIStatusError

from app.core.config import (
    DEEPSEEK_MODEL,
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MAX_TOKENS,
    DEEPSEEK_TIMEOUT,
)
from app.generation.prompts import SYSTEM_PROMPT


class LlmUnavailable(Exception):
    pass


client = OpenAI(
    api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL, timeout=DEEPSEEK_TIMEOUT
)
logger = logging.getLogger(__name__)


def build_user_message(query: str, chunks: list[dict]) -> str:
    """Combines the question and the chunks into a single text for the model."""
    formatted_chunks = []

    for idx, chunk in enumerate(chunks, start=1):
        text = chunk["text"].strip()
        formatted_chunks.append(f"[Фрагмент{idx}]\n{text}")

    context_block = "\n\n".join(formatted_chunks)

    return f"Контекст:\n{context_block}\n\nВопрос:\n{query}"


def generate_answer(query: str, chunks: list[dict]) -> str:
    """Generates the model's text response based on the question and context chunks."""
    user_content = build_user_message(query, chunks)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]
    try:
        response = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=messages,
            extra_body={"thinking": {"type": "disabled"}},
            max_tokens=DEEPSEEK_MAX_TOKENS,
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

    finish_reason = response.choices[0].finish_reason
    if finish_reason != "stop":
        logger.error("LLM model stopped by %s", finish_reason)
        raise LlmUnavailable(f"LLM model stopped by {finish_reason}")

    return response.choices[0].message.content
