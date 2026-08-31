/* Главная. Серверный компонент: разметка статична, вся работа с DOM
   вынесена в два листа — GlyphField и Pipeline, оба с 'use client'.
   Здесь ни одного хука и ни одного обращения к window. */

import Link from "next/link";
import GlyphField from "./_home/GlyphField";
import Pipeline from "./_home/Pipeline";
import "./_home/home.css";

const REPO = "https://github.com/nyveth/LecTrack-ZH";

export default function Home() {
  return (
    <>
      <div className="h-grid" aria-hidden="true" />

      <div className="h-shell">
        <nav className="h-nav">
          <div className="h-brand">
            {/* Три штриха плюс вертикальный тик: расшифровка и её край.
                Тем же весом, что линии фоновой сетки. */}
            <svg className="h-mark" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <line x1="1" y1="6" x2="17" y2="6" />
              <line x1="1" y1="11" x2="11" y2="11" />
              <line x1="1" y1="16" x2="14" y2="16" />
              <line className="h-tick" x1="20" y1="4" x2="20" y2="18" />
            </svg>
            <span className="h-wordmark">LecTrack-ZH</span>
          </div>

          <div className="h-navlinks">
            <Link href="/chat">Search</Link>
            <Link href="/upload">Upload</Link>
            <a href="#pipeline">Pipeline</a>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>

        </nav>

        {/* Заголовок разорван на месте превращения: слева вход, справа
            выход, машина посередине. */}
        <main className="h-hero">
          <h1 className="h-head">
            Spoken
            <br />
            Chinese
          </h1>
          <div className="h-stage">
            <GlyphField />
          </div>
          <h1 className="h-head h-head-r">
            made
            <br />
            searchable
          </h1>
        </main>

        <section className="h-about" id="about">
          <p className="h-lead">
            Lecture video goes in. What comes back is the passage that answers you,{" "}
            <span className="h-dim">and the minute it was said.</span>
          </p>
          <p className="h-abody">
            Recorded engineering lectures in Mandarin are transcribed, cut into passages
            and indexed by meaning rather than by keyword, so a question finds the right
            moment even when it shares no words with the transcript. Ask in Russian,
            English or Chinese. The answer is written from the retrieved passages and
            nothing else, and every passage it used stays on screen with its timecode.
          </p>
          <div className="h-pipe">
            <b>Audio</b>
            <span className="h-arrow">&rarr;</span>
            <b>Transcript</b>
            <span className="h-arrow">&rarr;</span>
            <b>Passages</b>
            <span className="h-arrow">&rarr;</span>
            <b>Vectors</b>
            <span className="h-arrow">&rarr;</span>
            <b>Answer</b>
          </div>
        </section>

        <Pipeline />

        <footer className="h-tail">
          <span>LecTrack-ZH</span>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </footer>
      </div>
    </>
  );
}