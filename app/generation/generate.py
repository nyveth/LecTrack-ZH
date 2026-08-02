from openai import OpenAI

from app.core.config import (
    DEEPSEEK_MODEL,
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MAX_TOKENS,
)
from app.generation.prompts import SYSTEM_PROMPT


# РЕШЕНИЕ 3: уровень модуля или внутрь функции — сверься с прецедентом соединения к БД
client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)


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

    response = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=messages,
        extra_body={"thinking": {"type": "disabled"}},
        max_tokens=DEEPSEEK_MAX_TOKENS,
    )
    return response.choices[0].message.content
