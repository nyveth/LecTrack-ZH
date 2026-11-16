/* 404. Серверный компонент: иллюстрация — статичный SVG, всё движение
   (искра, дымок, слеза) на CSS-анимациях, ни одного хука.

   Сюжет: студент сидит на полу и держит плату, переломленную пополам.
   Шелкография «404» разошлась по линии излома: «40» осталось слева,
   «4» уехала вправо. Над головой мысль «坏了…» — «сломалось…». */

import Link from "next/link";
import "./not-found.css";

function BrokenBoardStudent() {
  return (
    <svg
      className="nf-art"
      viewBox="0 0 320 260"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="A sad student sitting on the floor, holding a circuit board snapped in two"
    >
      {/* пол */}
      <path className="nf-dim" d="M24 232h272" />

      {/* мысль: три пузырька от головы и облачко */}
      <circle className="nf-dim" cx="196" cy="58" r="2.5" />
      <circle className="nf-dim" cx="206" cy="46" r="3.5" />
      <path
        className="nf-bubble"
        d="M222 38c-8 0-12-10-5-15 0-9 12-12 17-6 5-7 18-5 19 3 8 0 11 10 4 15 2 7-7 11-12 7-5 5-15 4-18-1-2 0-4-1-5-3z"
      />
      <text className="nf-think" x="238" y="34" textAnchor="middle">
        坏了…
      </text>

      {/* ноги, скрещённые по-турецки */}
      <path className="nf-fill" d="M104 216c14-22 98-22 112 0-12 14-100 14-112 0z" />
      <path className="nf-dim" d="M160 200v26" />
      <ellipse className="nf-fill" cx="104" cy="218" rx="9" ry="6" />
      <ellipse className="nf-fill" cx="216" cy="218" rx="9" ry="6" />

      {/* туловище, сутулое */}
      <path className="nf-fill" d="M126 204l2-52c0-26 14-42 32-42s32 16 32 42l2 52z" />
      <path className="nf-dim" d="M152 112l8 10 8-10" />

      {/* руки к плате */}
      <path d="M133 126c-20 14-30 34-30 50" />
      <path d="M187 126c20 14 30 34 30 50" />

      {/* плата, левая половина: «40», чип, дорожки */}
      <g className="nf-half-l">
        <path
          className="nf-board"
          d="M100 162h58l-4 7 5 6-6 6 5 6-3 9h-55z"
        />
        <rect className="nf-dim" x="108" y="168" width="16" height="12" rx="1" />
        <path className="nf-dim" d="M111 166v2M116 166v2M121 166v2M111 180v2M116 180v2M121 180v2" />
        <path className="nf-dim" d="M124 174h14l6 6h8M108 187h14" />
        <circle className="nf-via" cx="152" cy="180" r="1.6" />
        <circle className="nf-via" cx="152" cy="184" r="1.6" />
        <text className="nf-silk" x="130" y="194">
          40
        </text>
      </g>

      {/* правая половина: «4», дорожки обрываются на изломе */}
      <g className="nf-half-r">
        <path
          className="nf-board"
          d="M163 162h57v34h-56l3-9-5-6 6-6-5-6z"
        />
        <path className="nf-dim" d="M166 180h10l6-6h22M184 189h22" />
        <circle className="nf-via" cx="204" cy="174" r="1.6" />
        <circle className="nf-via" cx="206" cy="189" r="1.6" />
        <rect className="nf-dim" x="194" y="166" width="20" height="5" rx="1" />
        <text className="nf-silk" x="170" y="194">
          4
        </text>
      </g>

      {/* кисти держат плату за внешние края */}
      <ellipse className="nf-fill" cx="103" cy="180" rx="5.5" ry="7" />
      <ellipse className="nf-fill" cx="217" cy="180" rx="5.5" ry="7" />

      {/* искра и дымок над изломом */}
      <g className="nf-spark">
        <path d="M160 150v-6M160 150l-5-3M160 150l5-3M160 150l-4 4M160 150l4 4" />
      </g>
      <path className="nf-smoke" d="M161 142c-6-6 5-10 0-17s5-10 0-16" />

      {/* голова, опущена */}
      <g transform="rotate(10 160 104)">
        <circle className="nf-fill" cx="160" cy="76" r="26" />
        {/* волосы: короткая чёлка */}
        <path
          className="nf-hair"
          d="M134 74c-2-20 12-30 26-30s28 10 26 30c-6-8-12-10-18-8-6-6-16-6-22 0-6-2-10 2-12 8z"
        />
        {/* брови домиком: внутренние концы подняты */}
        <path d="M144 80l10-4M166 76l10 4" />
        {/* глаза */}
        <circle className="nf-eye" cx="150" cy="86" r="1.8" />
        <circle className="nf-eye" cx="170" cy="86" r="1.8" />
        {/* рот */}
        <path d="M153 98c4-4 10-4 14 0" />
        {/* слеза */}
        <path className="nf-tear" d="M172 91c-2 4-3 6-3 7.5a3 3 0 0 0 6 0c0-1.5-1-3.5-3-7.5z" />
      </g>
    </svg>
  );
}

export default function NotFound() {
  return (
    <div className="nf-page">
      <div className="nf-grid" aria-hidden="true" />

      <main className="nf-main">
        <BrokenBoardStudent />

        <p className="nf-code">Error 404</p>
        <h1 className="nf-title">This page was never transcribed.</h1>
        <p className="nf-zh" lang="zh-CN">
          页面未找到
        </p>
        <p className="nf-body">
          The link may be old, or the address has a typo. The lectures are still where
          you left them.
        </p>

        <div className="nf-actions">
          <Link href="/" className="nf-btn">
            Back home
          </Link>
          <Link href="/chat" className="nf-btn nf-btn-primary">
            Search lectures
          </Link>
        </div>
      </main>
    </div>
  );
}
