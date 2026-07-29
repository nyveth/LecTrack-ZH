"use client";

import { useState } from "react";

type SearchResult = {
  chunk_id: string;
  video_id: string;
  text: string;
  chunk_start: number;
  chunk_end: number;
  distance: number;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    setLoading(true);
    const url = `http://127.0.0.1:8000/search?query=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data: SearchResult[] = await response.json();
    setResults(data);
    setSearched(true);
    setLoading(false);
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-bold">rag-bot</h1>

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          placeholder="Введите запрос"
          className="flex-1 rounded border border-gray-500 px-3 py-2"
        />
        <button
          onClick={handleSearch}
          className="rounded bg-blue-600 px-4 py-2 text-white"
        >
          Найти
        </button>
      </div>

      {loading && <p className="mt-4">Ищу...</p>}

      {!loading && searched && results.length === 0 && (
        <p className="mt-4 text-gray-400">Ничего не нашлось</p>
      )}

      <ul className="mt-4 space-y-3">
        {results.map((r) => (
          <li key={r.chunk_id} className="rounded border border-gray-700 p-3">
            <div className="mb-2 text-sm text-gray-400">
              {r.video_id} · {formatTime(r.chunk_start)} – {formatTime(r.chunk_end)}
            </div>
            <p>{r.text}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}