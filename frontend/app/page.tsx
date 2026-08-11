"use client";

import { useState } from "react";

type Source = {
  chunk_id: string;
  video_id: string;
  text: string;
  chunk_start: number;
  chunk_end: number;
};

type Frame = {
  event: string;
  data: Record<string, unknown>;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Turns one raw SSE frame (the text between two blank lines) into
 * {event, data}. Returns null for frames we cannot use: comments,
 * keep-alives, or anything whose data is not valid JSON.
 */
function parseFrame(raw: string): Frame | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    if (!query.trim() || loading) return;

    setLoading(true);
    setError("");
    setAnswer("");
    setSources([]);
    setTruncated(false);
    setSearched(false);

    try {
      const url = `http://127.0.0.1:8000/search?query=${encodeURIComponent(query)}`;
      const response = await fetch(url);

      // 1. Status first. 4xx/5xx always carry a JSON body with `detail`.
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        setError(problem?.detail ?? "Something went wrong. Please try again.");
        return;
      }

      // 2. Content type second. A 200 can still be plain JSON: that is the
      //    "no results" branch, which never opens a stream.
      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.includes("text/event-stream")) {
        const data = await response.json();
        setSources((data.sources as Source[]) ?? []);
        setAnswer((data.answer as string) ?? "");
        setSearched(true);
        return;
      }

      // 3. Stream.
      if (!response.body) {
        setError("The server sent an empty response. Please try again.");
        return;
      }

      setSearched(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminated = false;

      while (!terminated) {
        const { value, done } = await reader.read();

        // Server closed the stream. Whatever is on screen is final.
        if (done) break;

        // stream: true holds back incomplete multi-byte characters —
        // a Chinese glyph is 3 bytes and can be split across chunks.
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        // The last piece has not reached a frame boundary yet.
        buffer = parts.pop() ?? "";

        for (const raw of parts) {
          const frame = parseFrame(raw);
          if (!frame) continue;

          if (frame.event === "sources") {
            setSources(frame.data as unknown as Source[]);
          } else if (frame.event === "token") {
            const t = frame.data.t as string;
            setAnswer((prev) => prev + t);
          } else if (frame.event === "done") {
            setTruncated(Boolean(frame.data.truncated));
            terminated = true;
            break;
          } else if (frame.event === "error") {
            // The answer written so far stays on screen: it was delivered
            // and cannot be recalled. The banner sits above it.
            setError(
              (frame.data.detail as string) ??
              "The answer was interrupted. Please try again.",
            );
            terminated = true;
            break;
          }
        }
      }

      if (terminated) {
        await reader.cancel().catch(() => { });
      }
    } catch {
      setError("Cannot reach the server. Please try again later.");
    } finally {
      setLoading(false);
    }
  }

  const streaming = loading && answer.length > 0;

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
          disabled={loading}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          Search
        </button>
      </div>

      {/* Spinner only until the first token lands. After that the text
          itself is the progress indicator. */}
      {loading && answer.length === 0 && (
        <div className="mt-4 flex items-center gap-2 text-gray-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
          <span>Searching the lectures...</span>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 p-3 text-red-300">
          {error}
        </p>
      )}

      {!loading && !error && !answer && searched && sources.length === 0 && (
        <p className="mt-4 text-gray-400">
          No lecture segments matched that question. Try rephrasing it.
        </p>
      )}

      {answer && (
        <div className="mt-6 rounded border border-gray-700 bg-gray-900/40 p-4">
          <div className="mb-2 text-sm font-semibold text-gray-400">Answer</div>
          <p className="whitespace-pre-wrap">
            {answer}
            {streaming && (
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-gray-400 align-text-bottom" />
            )}
          </p>
          {truncated && (
            <p className="mt-3 text-sm text-amber-400">
              This answer hit the length limit and stops mid-thought.
            </p>
          )}
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
                  {s.video_id} · {formatTime(s.chunk_start)} –{" "}
                  {formatTime(s.chunk_end)}
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