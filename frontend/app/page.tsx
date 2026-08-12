"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const STORAGE_KEY = "lectrack:conversations:v1";

type Source = {
  chunk_id: string;
  video_id: string;
  text: string;
  chunk_start: number;
  chunk_end: number;
};

/**
 * One completed exchange. Everything that ever happened stays here so the
 * visible chat never loses a message. What goes to the backend as history
 * is decided separately, at POST time.
 */
type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  truncated: boolean;
  /** Threshold cut everything: no tokens, no sources. Rendered as
      "not found", excluded from history so it never becomes a referent
      for query rewriting. */
  miss: boolean;
  /** Non-empty if the stream broke mid-answer. The partial answer stays
      on screen; the turn is excluded from history because a
      half-delivered answer is a corrupted referent. */
  error: string;
};

type Conversation = {
  id: string;
  /** The full first question, or whatever the user renamed it to. Never
      shortened at write time — cutting here would throw the text away
      permanently; the sidebar cuts it visually with CSS instead. */
  title: string;
  turns: Turn[];
  updatedAt: number;
  /** Optional so conversations saved before pinning existed still parse:
      `undefined` is falsy, which is exactly "not pinned". */
  pinned?: boolean;
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

function relTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * Turns one raw SSE frame (the text between two blank lines) into
 * {event, data}. Returns null for frames we cannot use: comments,
 * keep-alives, or anything whose data is not valid JSON.
 */
/**
 * The brand mark: three bars standing in for a transcript. `active`
 * turns it into the progress indicator while a search runs, so the
 * waiting state animates the product's own symbol rather than adding a
 * generic spinner beside it.
 */
function Mark({ size, active = false }: { size: number; active?: boolean }) {
  return (
    <span
      className="mark-tile"
      data-active={active}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: size > 24 ? "var(--r-md)" : "var(--r-sm)",
      }}
      aria-hidden
    >
      <svg width={size} height={size} viewBox="0 0 24 24">
        <rect className="mark-bar" x="5" y="7" width="14" height="2" rx="1" />
        <rect className="mark-bar" x="5" y="11" width="9" height="2" rx="1" />
        <rect className="mark-bar" x="5" y="15" width="12" height="2" rx="1" />
      </svg>
      <span className="mark-sweep" />
    </span>
  );
}

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

/**
 * The drifting dot field behind the conversation. Purely decorative, so
 * it is pointer-transparent, sits under everything, and does not mount
 * at all for users who asked the OS to reduce motion.
 */
function DotField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 520;
    const H = 440;
    // Capped at 2: past that the pixel cost doubles for no visible gain.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Clustered toward the bottom-left corner, thinning outward.
    const dots = Array.from({ length: 150 }, () => {
      const t = Math.pow(Math.random(), 1.05);
      const angle = (Math.random() * Math.PI) / 2;
      const radius = t * 560;
      const x = Math.cos(angle) * radius + (Math.random() - 0.5) * 60;
      const y = H - Math.sin(angle) * radius * 0.92 + (Math.random() - 0.5) * 60;
      return {
        x,
        y,
        ox: x,
        oy: y,
        vx: 0,
        vy: 0,
        r: 0.8 + Math.random() * 1.3,
        o: 0.07 + (1 - t) * 0.16,
      };
    });

    const mouse = { x: -9999, y: -9999 };
    const onMove = (e: MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      mouse.x = e.clientX - box.left;
      mouse.y = e.clientY - box.top;
    };
    window.addEventListener("mousemove", onMove);

    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, W, H);
      for (const d of dots) {
        const dx = mouse.x - d.x;
        const dy = mouse.y - d.y;
        const dist = Math.hypot(dx, dy);

        // Each dot has a home; the cursor only offers a target within
        // 120px, and the spring below always pulls it back.
        let tx = d.ox;
        let ty = d.oy;
        if (dist < 120) {
          const pull = (1 - dist / 120) * 14;
          tx = d.ox + (dx / (dist || 1)) * pull;
          ty = d.oy + (dy / (dist || 1)) * pull;
        }

        d.vx = (d.vx + (tx - d.x) * 0.06) * 0.82;
        d.vy = (d.vy + (ty - d.y) * 0.06) * 0.82;
        d.x += d.vx;
        d.y += d.vy;

        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(78, 70, 56, ${d.o.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Without this the loop and the listener survive every navigation
    // and stack up invisibly.
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute bottom-0 left-0 z-0"
      style={{ width: "520px", height: "440px" }}
    />
  );
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Guards the save effect: without it the first render writes an empty
  // array over whatever localStorage holds, before the load effect runs.
  const [hydrated, setHydrated] = useState(false);

  const [query, setQuery] = useState("");

  // Live state paints the turn that is currently streaming. When the
  // stream ends the finished turn is appended to the conversation and
  // this is wiped.
  const [liveQuestion, setLiveQuestion] = useState("");
  const [liveAnswer, setLiveAnswer] = useState("");
  const [liveSources, setLiveSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);

  // Transport-level failure (HTTP error, network down). Not a turn: the
  // question never produced an exchange, so nothing is appended and the
  // text goes back into the input for a retry.
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);

  // Sources are folded per answer; the key is the turn index.
  const [openSources, setOpenSources] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Which chunk was just copied, so the button can confirm it. Cleared on
  // a timer below.
  const [copied, setCopied] = useState<string | null>(null);

  // Renaming happens in the sidebar row now, so it is keyed by id rather
  // than being a flag about the active chat: any row can be renamed,
  // including one that is not open. `draftTitle` is separate state so an
  // abandoned edit never touches the stored conversation.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  // Which row's ⋯ menu is open. One at a time.
  const [menuId, setMenuId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // localStorage does not exist during server rendering, so it cannot be
  // read in a useState initializer — that produces markup on the server
  // that does not match the client and React throws a hydration error.
  // Read after mount instead.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Conversation[];
        setConversations(parsed);
        setActiveId(parsed[0]?.id ?? null);
      }
    } catch {
      // Corrupted or unreadable storage: start empty rather than crash.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      // Quota exceeded or private mode: the session still works in memory.
    }
  }, [conversations, hydrated]);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const turns = active?.turns ?? [];

  // Follow the bottom as tokens arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, liveAnswer, liveQuestion]);

  // "Copied" is a transient label, not a state of the chunk. The timer is
  // cleared on unmount and on the next copy, so a fast second click never
  // leaves a stale timer running.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  // A menu that only closed on its own items would stay open forever when
  // the user clicks anywhere else. Both listeners are removed on unmount.
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuId(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  function resetView() {
    setError("");
    setRenamingId(null);
    setMenuId(null);
    setOpenSources({});
    setExpanded({});
  }

  function startNew() {
    if (loading) return;
    setActiveId(null);
    setQuery("");
    resetView();
  }

  function selectConversation(id: string) {
    if (loading) return;
    setActiveId(id);
    resetView();
  }

  function deleteConversation(id: string) {
    if (loading) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) {
      setActiveId(null);
      resetView();
    }
  }

  function startRename(id: string) {
    const target = conversations.find((c) => c.id === id);
    if (!target) return;
    setDraftTitle(target.title);
    setRenamingId(id);
  }

  function commitRename() {
    const id = renamingId;
    const next = draftTitle.trim();
    setRenamingId(null);
    // An empty title would leave an unreadable blank row in the sidebar,
    // so a blank edit is a cancel.
    if (!id || !next) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: next } : c)),
    );
  }

  function togglePin(id: string) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
    );
  }

  function growTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    // Reset first: without it the box only ever grows, never shrinks
    // back when text is deleted.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  async function handleSearch() {
    const question = query.trim();
    if (!question || loading) return;

    // A new chat gets its record now, so the question is visible in the
    // sidebar while it streams. `id` is captured in a local because
    // setActiveId does not update `activeId` inside this call.
    let id = activeId;
    if (!id) {
      id = crypto.randomUUID();
      const fresh: Conversation = {
        id,
        title: question,
        turns: [],
        updatedAt: Date.now(),
      };
      setConversations((prev) => [fresh, ...prev]);
      setActiveId(id);
    }

    setLoading(true);
    setError("");
    setOffline(false);
    setRenamingId(null);
    setMenuId(null);
    setLiveQuestion(question);
    setLiveAnswer("");
    setLiveSources([]);
    setQuery("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // History for the backend, built from the record on screen:
    //  - misses are filtered HERE, not removed from state — the screen
    //    keeps them, the model never sees them;
    //  - broken turns go the same way;
    //  - slice(-10) satisfies the SearchRequest Field limit; the 3-turn
    //    window for rewriting is cut server-side.
    const history = turns
      .filter((t) => !t.miss && !t.error)
      .map((t) => ({ question: t.question, answer: t.answer }))
      .slice(-10);

    // Local accumulators for the turn being built. React state cannot do
    // this job: `liveAnswer` read inside this function is the value
    // captured when the closure was created (empty string), not what
    // setLiveAnswer has painted since. State repaints; these assemble.
    let answer = "";
    let sources: Source[] = [];
    let truncated = false;
    let streamError = "";

    try {
      const response = await fetch(`${API_BASE}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, history }),
      });

      // 4xx/5xx always carry a JSON body with `detail` — the 503 from
      // RewriteUnavailable arrives here, before any stream opens.
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        setError(problem?.detail ?? "Something went wrong. Please try again.");
        setQuery(question);
        return;
      }

      // A 200 is always a stream: the no-results case arrives as an
      // empty_stream (sources [] + done), so the frontend reads one path.
      if (!response.body) {
        setError("The server sent an empty response. Please try again.");
        setQuery(question);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminated = false;

      while (!terminated) {
        const { value, done } = await reader.read();

        // Server closed the stream. Whatever was accumulated is final.
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
            sources = frame.data as unknown as Source[];
            setLiveSources(sources);
          } else if (frame.event === "token") {
            answer += frame.data.t as string;
            setLiveAnswer(answer);
          } else if (frame.event === "done") {
            truncated = Boolean(frame.data.truncated);
            terminated = true;
            break;
          } else if (frame.event === "error") {
            // The answer delivered so far stays: it cannot be recalled.
            // The turn is recorded with the error attached.
            streamError =
              (frame.data.detail as string) ??
              "The answer was interrupted. Please try again.";
            terminated = true;
            break;
          }
        }
      }

      if (terminated) {
        await reader.cancel().catch(() => { });
      }

      // A miss is "the stream ended clean but carried nothing":
      // empty_stream sends sources [] and done without a single token.
      const turn: Turn = {
        question,
        answer,
        sources,
        truncated,
        miss: !streamError && sources.length === 0,
        error: streamError,
      };

      setConversations((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, turns: [...c.turns, turn], updatedAt: Date.now() }
            : c,
        ),
      );
    } catch {
      setError("Cannot reach the server. Please try again later.");
      setOffline(true);
      setQuery(question);
    } finally {
      setLiveQuestion("");
      setLiveAnswer("");
      setLiveSources([]);
      setLoading(false);
    }
  }

  const streaming = loading && liveAnswer.length > 0;
  const waiting = loading && liveAnswer.length === 0;

  const status = offline
    ? { label: "No connection", color: "var(--danger)" }
    : waiting
      ? { label: "Retrieving", color: "var(--warn)" }
      : streaming
        ? { label: "Streaming", color: "var(--warn)" }
        : { label: "Ready", color: "var(--ok)" };

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ── sidebar ─────────────────────────────────────────────── */}
      <aside
        className="relative z-10 flex flex-none flex-col"
        style={{
          width: "280px",
          background: "var(--sidebar)",
          backdropFilter: "saturate(160%) blur(20px)",
          borderRight: "1px solid var(--line)",
        }}
      >
        <div
          className="flex flex-none items-center gap-2 px-4"
          style={{ height: "52px", borderBottom: "1px solid var(--line-soft)" }}
        >
          <Mark size={22} active={loading} />
          <span style={{ fontSize: "14px", fontWeight: 600 }}>LecTrack-ZH</span>
        </div>

        <div className="p-3">
          <button
            className="btn btn-primary"
            onClick={startNew}
            disabled={loading}
          >
            <span style={{ fontSize: "16px", lineHeight: 1, marginTop: "-1px" }}>
              +
            </span>
            New chat
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div
            className="px-2 pb-1.5 pt-2"
            style={{
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.4px",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            History
          </div>

          {conversations.length === 0 && (
            <div
              className="px-2 py-1"
              style={{ fontSize: "12.5px", color: "var(--text-muted)" }}
            >
              Nothing yet.
            </div>
          )}

          {/* Pinned rows float to the top. `sort` mutates, so it runs on a
              copy — sorting `conversations` in place would rewrite state
              during render. */}
          {[...conversations]
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
            .map((c) =>
              renamingId === c.id ? (
                <div key={c.id} className="thread" data-on={c.id === activeId}>
                  <input
                    autoFocus
                    className="thread-input"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                </div>
              ) : (
                <div
                  key={c.id}
                  className="thread"
                  data-on={c.id === activeId}
                  onClick={() => selectConversation(c.id)}
                  title={c.title}
                >
                  {/* min-w-0 is what lets a flex item shrink below its text
                      width — without it the ellipsis never appears. */}
                  <div className="min-w-0 flex-1">
                    <div className="thread-title">
                      {c.pinned && <span className="thread-pin">▪</span>}
                      {c.title}
                    </div>
                    <div className="thread-meta">
                      {relTime(c.updatedAt)} · {c.turns.length}{" "}
                      {c.turns.length === 1 ? "turn" : "turns"}
                    </div>
                  </div>

                  <div className="relative flex-none">
                    <button
                      className="btn btn-quiet thread-x"
                      onClick={(e) => {
                        // Without this the window listener that closes the
                        // menu would fire on the very click that opens it.
                        e.stopPropagation();
                        setMenuId(menuId === c.id ? null : c.id);
                      }}
                      disabled={loading}
                      aria-label="Chat actions"
                    >
                      ⋯
                    </button>

                    {menuId === c.id && (
                      <div
                        className="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="menu-item"
                          onClick={() => {
                            setMenuId(null);
                            startRename(c.id);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            setMenuId(null);
                            togglePin(c.id);
                          }}
                        >
                          {c.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          className="menu-item menu-item-danger"
                          onClick={() => {
                            setMenuId(null);
                            deleteConversation(c.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
        </div>

        <div
          className="flex flex-none items-center gap-2 px-3 py-2.5"
          style={{ borderTop: "1px solid var(--line-soft)" }}
        >
          <span
            className="mark"
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "var(--r-pill)",
              fontSize: "11px",
              background: "var(--pill)",
              color: "var(--accent-deep)",
            }}
          >
            ⌘
          </span>
          <div className="min-w-0" style={{ fontSize: "11.5px" }}>
            <div style={{ fontWeight: 500 }}>Local history</div>
            <div style={{ color: "var(--text-muted)" }}>
              Stored in this browser
            </div>
          </div>
        </div>
      </aside>

      {/* ── main ────────────────────────────────────────────────── */}
      <main
        className="relative z-10 flex min-w-0 flex-1 flex-col"
        style={{ background: "var(--panel)" }}
      >
        <header
          className="flex flex-none items-center justify-between gap-3 px-5"
          style={{
            height: "52px",
            borderBottom: "1px solid var(--line)",
            background: "rgba(244, 242, 234, 0.82)",
            backdropFilter: "saturate(160%) blur(20px)",
          }}
        >
          {/* Title only. Renaming lives in the sidebar row's ⋯ menu, where
              it can reach any chat rather than just the open one. */}
          <div
            className="min-w-0 truncate"
            style={{ fontSize: "14px", fontWeight: 600 }}
            title={active?.title}
          >
            {active?.title ?? "New chat"}
          </div>

          <div className="pill flex-none">
            <span className="pill-dot" style={{ background: status.color }} />
            {status.label}
          </div>
        </header>

        <DotField />

        <div
          ref={scrollRef}
          className="relative z-10 min-h-0 flex-1 overflow-y-auto"
          style={{ padding: "32px 0 12px" }}
        >
          <div
            className="mx-auto flex flex-col px-6"
            style={{ maxWidth: "720px", gap: "26px" }}
          >
            {turns.length === 0 && !loading && (
              <div style={{ fontSize: "14px", color: "var(--text-soft)" }}>
                Ask about the indexed lectures. Follow-up questions keep the
                thread: pronouns and short forms are resolved against what was
                already asked.
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className="flex flex-col" style={{ gap: "26px" }}>
                <div className="flex justify-end">
                  <div className="bubble-user">{t.question}</div>
                </div>

                <div className="flex flex-col" style={{ gap: "12px" }}>
                  <div className="flex" style={{ gap: "11px" }}>
                    {/* The mark rides the newest answer only. On every
                        turn it read as decoration; on one it marks where
                        the conversation currently is. Earlier turns keep
                        a spacer so their text stays on the same left
                        edge. A miss is left grey exactly as before. */}
                    {i === turns.length - 1 && !loading ? (
                      <span
                        style={{
                          marginTop: "1px",
                          opacity: t.miss ? 0.45 : 1,
                          display: "flex",
                        }}
                      >
                        <Mark size={26} />
                      </span>
                    ) : (
                      <span
                        className="flex-none"
                        style={{ width: "26px" }}
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0">
                      {t.error && (
                        <div className="notice" style={{ marginBottom: "10px" }}>
                          {t.error}
                        </div>
                      )}

                      <div
                        className="bubble-bot"
                        style={{
                          color: t.miss ? "var(--text-muted)" : "var(--text)",
                        }}
                      >
                        {t.miss
                          ? "No lecture segments matched that question. Try rephrasing it."
                          : t.answer}
                      </div>

                      {t.truncated && (
                        <div
                          style={{
                            marginTop: "8px",
                            fontSize: "11.5px",
                            color: "var(--warn)",
                          }}
                        >
                          Hit the length limit and stops mid-thought.
                        </div>
                      )}
                    </div>
                  </div>

                  {t.sources.length > 0 && (
                    <div
                      className="flex flex-col"
                      style={{ marginLeft: "37px", gap: "7px" }}
                    >
                      <button
                        className="btn btn-quiet self-start"
                        style={{ marginLeft: "-8px" }}
                        onClick={() =>
                          setOpenSources((prev) => ({
                            ...prev,
                            [i]: !prev[i],
                          }))
                        }
                      >
                        {openSources[i] ? "▾" : "▸"} Sources ({t.sources.length})
                      </button>

                      {openSources[i] &&
                        t.sources.map((s) => {
                          const key = `${i}:${s.chunk_id}`;
                          const open = expanded[key];
                          return (
                            <div key={s.chunk_id} className="src">
                              {/* Only the head row toggles. Text inside a
                                  <button> cannot be selected by the
                                  browser, which is why the transcript
                                  used to be impossible to copy. */}
                              <button
                                className="src-head"
                                onClick={() =>
                                  setExpanded((prev) => ({
                                    ...prev,
                                    [key]: !prev[key],
                                  }))
                                }
                              >
                                <span className="src-time">
                                  {formatTime(s.chunk_start)}
                                </span>
                                <span className="src-title min-w-0 flex-1">
                                  {s.video_id}
                                </span>
                                <span
                                  className="flex-none"
                                  style={{
                                    fontSize: "11px",
                                    color: "var(--text-muted)",
                                    fontVariantNumeric: "tabular-nums",
                                  }}
                                >
                                  {formatTime(s.chunk_end)}
                                </span>
                                <span
                                  className="flex-none"
                                  style={{
                                    fontSize: "10px",
                                    color: "var(--text-muted)",
                                  }}
                                >
                                  {open ? "▾" : "▸"}
                                </span>
                              </button>

                              {open ? (
                                <>
                                  <p className="src-text">{s.text}</p>
                                  <div
                                    className="flex"
                                    style={{ marginTop: "8px" }}
                                  >
                                    <button
                                      className="src-copy"
                                      onClick={() =>
                                        navigator.clipboard
                                          .writeText(s.text)
                                          .then(
                                            () => setCopied(key),
                                            () => setCopied("failed"),
                                          )
                                      }
                                    >
                                      {copied === key
                                        ? "Copied"
                                        : copied === "failed"
                                          ? "Copy failed"
                                          : "Copy"}
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <p className="src-preview">{s.text}</p>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex flex-col" style={{ gap: "26px" }}>
                <div className="flex justify-end">
                  <div className="bubble-user">{liveQuestion}</div>
                </div>
                <div className="flex" style={{ gap: "11px" }}>
                  <span style={{ marginTop: "1px", display: "flex" }}>
                    <Mark size={26} active={liveAnswer.length === 0} />
                  </span>
                  <div className="bubble-bot min-w-0">
                    {liveAnswer || (
                      <span style={{ color: "var(--text-muted)" }}>
                        Searching the lectures
                      </span>
                    )}
                    <span className="caret" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── composer ──────────────────────────────────────────── */}
        <div
          className="relative z-10 flex-none"
          style={{
            padding: "8px 24px 22px",
            background:
              "linear-gradient(to top, var(--panel) 62%, rgba(244, 242, 234, 0))",
          }}
        >
          <div className="mx-auto" style={{ maxWidth: "720px" }}>
            {error && (
              <div className="notice" style={{ marginBottom: "10px" }}>
                {error}
              </div>
            )}

            <div className="composer">
              <textarea
                ref={textareaRef}
                rows={1}
                value={query}
                placeholder="Ask about the lectures…"
                onChange={(e) => {
                  setQuery(e.target.value);
                  growTextarea();
                }}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks the line — the
                  // convention every chat client already taught the user.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
              />
              <button
                className="btn btn-send"
                data-ready={query.trim().length > 0}
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                aria-label="Send"
              >
                ↑
              </button>
            </div>

            <div
              className="text-center"
              style={{
                marginTop: "9px",
                fontSize: "11px",
                color: "var(--text-muted)",
              }}
            >
              Answers are drawn only from indexed lectures. Check the timecodes.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}