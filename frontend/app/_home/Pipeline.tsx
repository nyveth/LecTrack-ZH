"use client";

/* ─────────────────────────────────────────────────────────────────────
   Аккордеон пайплайна. Открыт ровно один шаг.

   Переключение прокруткой считает долю пройденной дорожки, а не
   положение шапок: шапки стоят в 88px друг от друга, потому что всё
   выше открытой плашки сжато, и на них все четыре шага умещались в
   треть экрана — раскрытие длиной .7s не успевало доиграть.

   Прокрутка читается через useScroll из motion, а не через
   window.addEventListener("scroll"): слушатель на scroll срабатывает на
   каждом кадре и не батчится.

   Нумерация [01]..[04] законна: порядок стадий настоящий, третья не
   может идти раньше второй.
   ───────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValueEvent, useScroll } from "motion/react";

type Step = {
    ix: string;
    title: string;
    sum: string;
    note: string;
    svg: React.ReactNode;
};

const STEPS: Step[] = [
    {
        ix: "01",
        title: "Ingest & Extract",
        sum: "The file lands on disk and a row appears in the queue.",
        note: "An upload is written to disk under a name built from its own job id, then a row goes into the jobs table with status queued. Nothing runs yet. A worker on a machine with a GPU polls that table and claims the row inside a transaction, so two workers can never take the same job.",
        svg: (
            <svg viewBox="0 0 260 90" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="8" y="22" width="46" height="46" rx="2" />
                <path d="M18 34h26M18 42h26M18 50h16" opacity=".45" />
                <path d="M62 45h40" opacity=".35" />
                <path d="M110 45h4l4-16 5 30 5-22 4 14 5-24 4 20 5-10 4 8h96" />
            </svg>
        ),
    },
    {
        ix: "02",
        title: "Whisper ASR",
        sum: "Speech becomes a timed transcript, segment by segment.",
        note: "faster-whisper reads the audio and returns segments, each carrying its own start and end in seconds. Those timecodes survive every stage that follows, which is why an answer can point at the minute a claim was made instead of at a file.",
        svg: (
            <svg viewBox="0 0 260 90" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M4 45h4l4-14 5 26 5-20 4 12 5-22 4 18 5-9 4 9h8" />
                <path d="M60 45h30" opacity=".35" />
                <rect x="98" y="18" width="154" height="54" rx="2" opacity=".5" />
                <path d="M110 32h96M110 41h130M110 50h112M110 59h64" opacity=".7" />
            </svg>
        ),
    },
    {
        ix: "03",
        title: "Semantic Chunking",
        sum: "The transcript is cut into passages that overlap.",
        note: "Segments are merged up to a token target rather than split on a fixed character count, and neighbouring passages share a tail. Without the overlap a thought that straddles the boundary is lost to both sides. Each passage inherits the start of its first segment and the end of its last.",
        svg: (
            <svg viewBox="0 0 260 90" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M8 28h244" opacity=".3" />
                <rect x="8" y="38" width="86" height="20" rx="2" />
                <rect x="80" y="38" width="86" height="20" rx="2" />
                <rect x="152" y="38" width="86" height="20" rx="2" />
                <path d="M80 62v8M94 62v8M152 62v8M166 62v8" opacity=".45" />
                <path d="M80 70h14M152 70h14" opacity=".45" />
            </svg>
        ),
    },
    {
        ix: "04",
        title: "BGE-M3 Vectorization",
        sum: "Meaning becomes coordinates that can be compared.",
        note: "Every passage is embedded with BGE-M3 and stored in pgvector. A question is embedded the same way, so retrieval measures distance in that space rather than matching words. This is what lets a Russian question find a Mandarin passage that shares no vocabulary with it.",
        svg: (
            <svg viewBox="0 0 260 90" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="8" y="30" width="58" height="16" rx="2" opacity=".55" />
                <rect x="8" y="52" width="58" height="16" rx="2" opacity=".55" />
                <path d="M74 45h26" opacity=".35" />
                <circle cx="150" cy="34" r="2.5" />
                <circle cx="176" cy="52" r="2.5" />
                <circle cx="142" cy="60" r="2.5" />
                <circle cx="204" cy="30" r="2.5" opacity=".4" />
                <circle cx="222" cy="62" r="2.5" opacity=".4" />
                <circle cx="196" cy="48" r="2.5" opacity=".4" />
                <path d="M150 34l26 18M150 34l-8 26M176 52l-34 8" opacity=".3" strokeDasharray="2 3" />
            </svg>
        ),
    },
];

const HEAD_H = 80;
const LINE = 0.36;

export default function Pipeline() {
    const trackRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const leftRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

    const [current, setCurrent] = useState(0);
    const [sum, setSum] = useState(STEPS[0].sum);
    const [swapping, setSwapping] = useState(false);
    const [revealed, setRevealed] = useState(-1); // индекс последней проявленной плашки

    const { scrollY } = useScroll();

    /* Текст слева меняется не мгновенно: он гаснет, подменяется и
       возвращается, иначе подмена читается как дёрганье. */
    useEffect(() => {
        setSwapping(true);
        const id = setTimeout(() => {
            setSum(STEPS[current].sum);
            setSwapping(false);
        }, 280);
        return () => clearTimeout(id);
    }, [current]);

    /* Высота меряется по содержимому: у шагов разный объём текста, и при
       фиксированной высоте скорость раскрытия зависела бы от него. */
    const applyHeights = useCallback(() => {
        cardRefs.current.forEach((el, k) => {
            if (!el) return;
            const body = el.querySelector<HTMLElement>(".h-cbody");
            el.style.height =
                k === current && body ? `${HEAD_H + body.scrollHeight}px` : `${HEAD_H}px`;
        });
    }, [current]);

    /* Шаг считается из шапки и gap, а не из offsetTop плашки. offsetTop,
       прочитанный сразу после смены height, отдаёт геометрию ДО анимации:
       предыдущая плашка в этот момент ещё раскрыта, и блок улетал вниз на
       высоту её тела. Открыта всегда одна плашка, все выше неё сжаты, так
       что расстояние до i-й ровно i * (80 + gap). */
    useEffect(() => {
        applyHeights();

        const host = hostRef.current;
        const left = leftRef.current;
        if (!host || !left) return;

        const gap = parseFloat(getComputedStyle(host).rowGap) || 8;
        left.style.transform = `translateY(${current * (HEAD_H + gap)}px)`;
    }, [current, applyHeights]);

    useEffect(() => {
        window.addEventListener("resize", applyHeights);
        return () => window.removeEventListener("resize", applyHeights);
    }, [applyHeights]);

    /* Появление стопки. Плашки проявляются по очереди, задержка ставится
       таймером, а не transition-delay: делей на элементе достался бы и
       height, и раскрытие поехало бы вслед за ним. */
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const timers: ReturnType<typeof setTimeout>[] = [];
        const obs = new IntersectionObserver(
            (entries, o) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    o.unobserve(e.target);
                    STEPS.forEach((_, k) => {
                        timers.push(setTimeout(() => setRevealed(k), k * 90));
                    });
                }
            },
            { rootMargin: "0px 0px -14% 0px", threshold: 0 },
        );
        obs.observe(host);

        return () => {
            obs.disconnect();
            timers.forEach(clearTimeout);
        };
    }, []);

    const pick = useCallback(() => {
        const track = trackRef.current;
        const stick = stickRef.current;
        if (!track || !stick) return;

        if (window.matchMedia("(max-width:900px)").matches) {
            // Приколотого блока нет, дорожки тоже: активен последний шаг, чья
            // шапка прошла линию на 36% экрана.
            const line = window.innerHeight * LINE;
            let i = -1;
            cardRefs.current.forEach((el, k) => {
                const head = el?.querySelector<HTMLElement>(".h-chead");
                if (head && head.getBoundingClientRect().top <= line) i = k;
            });
            if (i >= 0) setCurrent(i);
            return;
        }

        const usable = track.offsetHeight - stick.offsetHeight;
        if (usable <= 0) return;
        const p = -track.getBoundingClientRect().top / usable;
        const i = Math.floor(p * STEPS.length);
        setCurrent(Math.max(0, Math.min(STEPS.length - 1, i)));
    }, []);

    useMotionValueEvent(scrollY, "change", pick);

    /* Клик по плашке, до которой ещё не долистали, раскрывал её, а первое
       движение колеса выбор перебивало. Поэтому клик подводит шапку к той
       же высоте, на которой прокрутка считает шаг активным. */
    const bring = useCallback((i: number) => {
        const track = trackRef.current;
        const stick = stickRef.current;
        if (!track || !stick) return;

        if (window.matchMedia("(max-width:900px)").matches) {
            const head = cardRefs.current[i]?.querySelector<HTMLElement>(".h-chead");
            if (!head) return;
            const y =
                head.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.36;
            window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
            return;
        }

        // Середина окна, а не его край: у края округление прокрутки на пиксель
        // роняло шаг на предыдущий, и клик по [03] отдавал [02].
        const usable = track.offsetHeight - stick.offsetHeight;
        const top = track.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({
            top: top + (i + 0.5) * (usable / STEPS.length),
            behavior: "smooth",
        });
    }, []);

    function activate(i: number) {
        setCurrent(i);
        bring(i);
    }

    return (
        <section className="h-pipeline" id="pipeline">
            <div className="h-track" ref={trackRef}>
                <div className="h-stick" ref={stickRef}>
                    <div className="h-plin">
                        <div className={`h-left${revealed >= 0 ? " is-in" : ""}`} ref={leftRef}>
                            <h2 className="h-plh">How it works</h2>
                            <p className={`h-sum${swapping ? " is-swap" : ""}`}>{sum}</p>
                        </div>

                        <div className="h-right" ref={hostRef}>
                            {STEPS.map((s, i) => (
                                <div
                                    key={s.ix}
                                    ref={(el) => {
                                        cardRefs.current[i] = el;
                                    }}
                                    className={[
                                        "h-card",
                                        i === current ? "is-open" : "",
                                        i <= revealed ? "is-in" : "",
                                    ]
                                        .filter(Boolean)
                                        .join(" ")}
                                    role="button"
                                    tabIndex={0}
                                    aria-expanded={i === current}
                                    onClick={() => activate(i)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            activate(i);
                                        }
                                    }}
                                >
                                    <div className="h-chead">
                                        <span className="h-cix">[{s.ix}]</span>
                                        <span className="h-ct">{s.title}</span>
                                    </div>
                                    <div className="h-cbody">
                                        <div className="h-csvg">{s.svg}</div>
                                        <div className="h-cnote">
                                            <p>{s.note}</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}