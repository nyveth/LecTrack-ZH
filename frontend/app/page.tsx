"use client";

import { useState } from "react";

type Source = {
  chunk_id: string;
  video_id: string;
  text: string;
  chunk_start: number;
  chunk_end: number;
  distance: number;
};

type SearchResponse = {
  answer: string;
  sources: Source[];
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;

    setLoading(true);
    setError("");
    setAnswer("");
    setSources([]);

    try {
      const url = `http://127.0.0.1:8000/search?query=${encodeURIComponent(query)}`;
      const response = await fetch(url);

      if (!response.ok) {
        const problem = await response.json();
        setError(problem.detail ?? "Something went wrong. Please try again.");
        return;
      }

      const data: SearchResponse = await response.json();
      setAnswer(data.answer);
      setSources(data.sources);
      setSearched(true);
    } catch {
      setError("Cannot reach the server. Please try again later.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-bold">LecTrack-ZH</h1>

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          placeholder="Ask about the lectures"
          className="flex-1 rounded border border-gray-500 px-3 py-2"
        />
        <button
          onClick={handleSearch}
          className="rounded bg-blue-600 px-4 py-2 text-white"
        >
          Search
        </button>
      </div>

      {loading && (
        <div className="mt-4 flex items-center gap-2 text-gray-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
          <span>Processing your request...</span>
        </div>
      )}

      {!loading && error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 p-3 text-red-300">
          {error}
        </p>
      )}

      {!loading && !error && searched && sources.length === 0 && (
        <p className="mt-4 text-gray-400">Nothing found</p>
      )}

      {!loading && answer && (
        <div className="mt-6 rounded border border-gray-700 bg-gray-900/40 p-4">
          <div className="mb-2 text-sm font-semibold text-gray-400">Answer</div>
          <p className="whitespace-pre-wrap">{answer}</p>
        </div>
      )}

      {sources.length > 0 && (
        <>
          <div className="mt-6 mb-2 text-sm font-semibold text-gray-400">
            Sources
          </div>
          <ul className="space-y-3">
            {sources.map((s) => (
              <li key={s.chunk_id} className="rounded border border-gray-700 p-3">
                <div className="mb-2 text-sm text-gray-400">
                  {s.video_id} · {formatTime(s.chunk_start)} – {formatTime(s.chunk_end)}
                </div>
                <p className="whitespace-pre-wrap">{s.text}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}