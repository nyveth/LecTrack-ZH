"use client";

/* ─────────────────────────────────────────────────────────────────────
   Глиф ожидания.

   Круг, набранный вертикальными штрихами. Сверху вниз по ним проходит
   волна точек: центральные штрихи стартуют первыми, крайние догоняют,
   поэтому фронт читается веером. Когда точки уходят за нижнюю границу,
   круг скручивается в спираль к центру и раскручивается обратно.

   Client leaf. React рисует только неподвижную структуру; положение
   точек и повороты штрихов идут мимо состояния, прямо в атрибуты. Через
   useState это была бы перерисовка дерева на каждый кадр.

   Цвет не задан: и штрихи, и точки берут currentColor, так что глиф
   красится тем же значением, что и текст рядом с ним.
   ───────────────────────────────────────────────────────────────────── */

import { useEffect, useMemo, useRef } from "react";

type Props = {
    /** Сторона в пикселях. Геометрия внутри в единицах viewBox и не зависит от неё. */
    size?: number;
    lines?: number;
    /** Угол закрутки спирали в градусах. */
    spinDeg?: number;
    /** Отставание крайних штрихов от центральных. Это и есть веер. */
    fanMs?: number;
    /** Сколько точка идёт от верха штриха до низа. */
    travelMs?: number;
    /** Скручивание и раскручивание, поровну. */
    swirlMs?: number;
    /** Общий делитель длительностей: меньше единицы — медленнее. */
    speed?: number;
    className?: string;
};

const RADIUS = 46;
const LINE_W = 1.4;
const DOT_R = 2.6;
const PAD = LINE_W * 2 + 4;
const PAUSE_MS = 120;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const easeInOut = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export default function ThinkingGlyph({
    size = 30,
    lines = 9,
    spinDeg = 130,
    fanMs = 500,
    travelMs = 800,
    swirlMs = 560,
    speed = 0.45,
    className,
}: Props) {
    // Штрих номер i стоит на своей абсциссе, а его половинная высота —
    // полухорда круга в этой точке. 0.94 отодвигает концы от контура,
    // иначе крайние штрихи вырождаются в точки на самом ободе.
    const cells = useMemo(
        () =>
            Array.from({ length: lines }, (_, i) => {
                const x = -RADIUS + (i + 0.5) * ((2 * RADIUS) / lines);
                const h = Math.sqrt(Math.max(RADIUS * RADIUS - x * x, 1)) * 0.94;
                return { x, h, k: Math.abs(x) / RADIUS };
            }),
        [lines],
    );

    const groupRefs = useRef<(SVGGElement | null)[]>([]);
    const lineRefs = useRef<(SVGLineElement | null)[]>([]);
    const dotRefs = useRef<(SVGCircleElement | null)[]>([]);

    useEffect(() => {
        const groups = groupRefs.current;
        const strokes = lineRefs.current;
        const dots = dotRefs.current;
        if (!groups.length) return;

        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) {
            // Ни одного кадра: статичный круг, точки на середине через одну.
            strokes.forEach((el) => el?.setAttribute("opacity", "0.34"));
            dots.forEach((el, i) => {
                el?.setAttribute("cy", "0");
                el?.setAttribute("opacity", i % 3 === 1 ? "0.9" : "0");
            });
            return;
        }

        const travel = travelMs / speed;
        const fan = fanMs / speed;
        const swirl = swirlMs / speed;
        const pause = PAUSE_MS / speed;
        const total = travel + swirl * 2 + pause;
        // Ход самой точки короче фазы ровно на веер: последний штрих обязан
        // успеть добежать до низа внутри той же фазы.
        const dotSpan = Math.max(travel - fan, 120);

        // amount: 0 — развёрнуто, 1 — скручено в точку. Поворот растёт с
        // индексом штриха, поэтому сжатие читается как спираль, а не как
        // равномерное схлопывание.
        const swirlTo = (i: number, amount: number) => {
            const ang = spinDeg * amount * (0.68 + 0.62 * (i / Math.max(lines - 1, 1)));
            const sc = 1 - 0.93 * amount;
            groups[i]?.setAttribute(
                "transform",
                `rotate(${ang.toFixed(2)}) scale(${sc.toFixed(4)})`,
            );
            strokes[i]?.setAttribute(
                "opacity",
                (0.26 + 0.3 * Math.sin(Math.PI * amount)).toFixed(3),
            );
            dots[i]?.setAttribute("opacity", "0");
        };

        let raf = 0;
        let start = 0;

        const frame = (now: number) => {
            if (!start) start = now;
            const t = (now - start) % total;

            if (t < travel) {
                cells.forEach((cell, i) => {
                    groups[i]?.removeAttribute("transform");
                    const p = (t - fan * cell.k) / dotSpan;
                    if (p < 0 || p > 1) {
                        dots[i]?.setAttribute("opacity", "0");
                        strokes[i]?.setAttribute("opacity", "0.26");
                        return;
                    }
                    // Точка гаснет у обоих концов штриха, иначе она возникает
                    // и пропадает щелчком.
                    const op = clamp(Math.min(p * 7, (1 - p) * 7, 1), 0, 1);
                    dots[i]?.setAttribute("cy", (-cell.h + p * 2 * cell.h).toFixed(2));
                    dots[i]?.setAttribute("opacity", op.toFixed(3));
                    strokes[i]?.setAttribute("opacity", (0.26 + 0.34 * op).toFixed(3));
                });
            } else if (t < travel + swirl) {
                const a = easeInOut((t - travel) / swirl);
                cells.forEach((_, i) => swirlTo(i, a));
            } else if (t < travel + swirl * 2) {
                const a = 1 - easeOut((t - travel - swirl) / swirl);
                cells.forEach((_, i) => swirlTo(i, a));
            } else {
                cells.forEach((_, i) => {
                    groups[i]?.removeAttribute("transform");
                    strokes[i]?.setAttribute("opacity", "0.26");
                    dots[i]?.setAttribute("opacity", "0");
                });
            }

            raf = requestAnimationFrame(frame);
        };

        raf = requestAnimationFrame(frame);
        // Без этого цикл переживает уход со страницы и продолжает крутиться
        // на снятых из документа узлах.
        return () => cancelAnimationFrame(raf);
    }, [cells, lines, spinDeg, fanMs, travelMs, swirlMs, speed]);

    const box = RADIUS + PAD;

    return (
        <svg
            className={className}
            width={size}
            height={size}
            viewBox={`${-box} ${-box} ${box * 2} ${box * 2}`}
            style={{ display: "block", flex: "none", overflow: "visible" }}
            aria-hidden
        >
            {cells.map((cell, i) => (
                <g
                    key={i}
                    ref={(el) => {
                        groupRefs.current[i] = el;
                    }}
                >
                    <line
                        ref={(el) => {
                            lineRefs.current[i] = el;
                        }}
                        x1={cell.x}
                        x2={cell.x}
                        y1={-cell.h}
                        y2={cell.h}
                        stroke="currentColor"
                        strokeWidth={LINE_W}
                        strokeLinecap="round"
                        opacity={0.26}
                    />
                    <circle
                        ref={(el) => {
                            dotRefs.current[i] = el;
                        }}
                        cx={cell.x}
                        cy={0}
                        r={DOT_R}
                        fill="currentColor"
                        opacity={0}
                    />
                </g>
            ))}
        </svg>
    );
}
