"use client";

/* ─────────────────────────────────────────────────────────────────────
   Поле глифов.

   Снаружи линзы ячейка рисуется символом ASCII-рампы. Внутри она
   разрешается в китайский иероглиф: неразборчивая речь превращается в
   читаемый текст ровно там, куда смотришь.

   Линза существует только пока курсор на поле. При уходе мыши она не
   выключается щелчком, а угасает, и текст растворяется обратно в шум.

   Единственный client leaf на странице вместе с Pipeline. Всё, что
   заводится в эффекте, в нём же и снимается: rAF, два слушателя на
   canvas и один на window.
   ───────────────────────────────────────────────────────────────────── */

import { useEffect, useRef } from "react";

const RAMP = " .,:;i1tfLCG08@";
const HAN =
    "开发板配套资料下载与引脚分配约束文件时序仿真接口电平转换晶振复位电源模块信号采样时钟频率分频计数器状态机综合布线约束";

const CELL_W = 10;
const CELL_H = 20;
const HAN_W = CELL_W * 2; // иероглиф квадратный, ему нужны две колонки
const R = 92; // радиус ядра линзы
const BAND = 18; // полоса, где шум и текст меняются местами
const FOLLOW = 0.045; // насколько лениво линза тянется за курсором
const HAN_MAX = 0.55; // потолок яркости иероглифов

export default function GlyphField() {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        /* next/font выдаёт гарнитуре сгенерированное имя, поэтому строковый
           литерал "IBM Plex Mono" в ctx.font промахнулся бы мимо неё и упал
           в системный monospace. Настоящее имя лежит в переменной, которую
           ставит layout.tsx; ctx.font принимает её значение как есть. */
        const css = getComputedStyle(document.documentElement);
        const MONO = css.getPropertyValue("--font-mono").trim() || "monospace";
        const CJK = css.getPropertyValue("--font-cjk").trim() || "sans-serif";

        let cols = 0;
        let rows = 0;
        let W = 0;
        let H = 0;
        let seeds: Float32Array = new Float32Array(0);
        let rowOffset: Uint16Array = new Uint16Array(0);

        function layout() {
            const box = canvas!.getBoundingClientRect();
            W = Math.max(200, box.width);
            H = Math.max(200, box.height);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas!.width = W * dpr;
            canvas!.height = H * dpr;
            ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx!.textBaseline = "top";

            cols = Math.floor(W / CELL_W);
            rows = Math.floor(H / CELL_H);
            seeds = new Float32Array(cols * rows);
            for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();

            // Своя точка входа в текст на каждую строку: строки не повторяют
            // друг друга, но каждая сама по себе связна и читается.
            rowOffset = new Uint16Array(rows);
            for (let r = 0; r < rows; r++) {
                rowOffset[r] = Math.floor(Math.random() * HAN.length);
            }
        }

        const lens = { x: 0, y: 0 };
        let target: { x: number; y: number } | null = null;
        let lensK = 0; // сила линзы, отдельно от положения

        function onMove(e: PointerEvent) {
            const box = canvas!.getBoundingClientRect();
            target = { x: e.clientX - box.left, y: e.clientY - box.top };
        }

        function onLeave() {
            target = null;
        }

        function draw(t: number) {
            if (target) {
                lens.x += (target.x - lens.x) * FOLLOW;
                lens.y += (target.y - lens.y) * FOLLOW;
            }
            lensK += ((target ? 1 : 0) - lensK) * 0.055;

            ctx!.clearRect(0, 0, W, H);

            const phase = ((t / 5200) % 1) * 2.8 - 1.4;
            const noise: number[] = [];
            const han: number[] = [];

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const px = c * CELL_W;
                    const py = r * CELL_H;

                    // Круг с размытым краем. Радиус в пикселях, поэтому форма не
                    // растягивается вслед за пропорциями блока.
                    const ox = px + CELL_W / 2 - W / 2;
                    const oy = py + CELL_H / 2 - H / 2;
                    const rr = Math.sqrt(ox * ox + oy * oy) / (Math.min(W, H) * 0.46);
                    const shape = Math.exp(-rr * rr * 1.25);
                    if (shape < 0.004) continue;

                    const nx = ox / (W / 2);
                    const wave = Math.exp(-Math.pow((nx - phase) / 0.2, 2));
                    const i = r * cols + c;
                    const v = shape * (0.42 + 0.8 * wave) * (0.32 + 0.95 * seeds[i]);

                    // Порог низкий: символ истончается до пробела сам, через рампу,
                    // а не срезается границей.
                    if (v <= 0.012) continue;

                    const dx = lens.x - px;
                    const dy = lens.y - py;
                    const d = Math.sqrt(dx * dx + dy * dy);

                    let k = 0;
                    if (d < R) k = 1;
                    else if (d < R + BAND) {
                        const u = 1 - (d - R) / BAND;
                        k = u * u * (3 - 2 * u);
                    }
                    k *= lensK;

                    if (k < 0.995) {
                        const idx = Math.min(RAMP.length - 1, Math.floor(v * RAMP.length));
                        const fade = (1 - k) * (1 - k);
                        if (RAMP[idx] !== " " && fade > 0.02) {
                            noise.push(px, py, idx, Math.min(0.85, v) * fade);
                        }
                    }

                    // Иероглиф живёт ровно там, где виден шум: огибающая тянется
                    // шире видимой части, и без этого порога знаки вылезали в пустоту.
                    if (k > 0.02 && c % 2 === 0 && v > 0.085) {
                        const a = k * Math.min(HAN_MAX, 0.16 + 0.95 * v);
                        han.push(px, py, a, (rowOffset[r] + c / 2) % HAN.length);
                    }
                }
            }

            // Два прохода: смена ctx.font сбрасывает внутренний кеш отрисовки,
            // поэтому переключаемся дважды за кадр, а не на каждой ячейке.
            ctx!.font = `500 13px ${MONO}`;
            for (let k = 0; k < noise.length; k += 4) {
                ctx!.fillStyle = `rgba(242,243,242,${noise[k + 3].toFixed(3)})`;
                ctx!.fillText(RAMP[noise[k + 2]], noise[k], noise[k + 1]);
            }

            // Кегль равен ширине пары ячеек, иначе между знаками зияют дыры и
            // сквозь них виден шум.
            ctx!.font = `400 ${HAN_W - 2}px ${CJK}`;
            for (let k = 0; k < han.length; k += 4) {
                ctx!.fillStyle = `rgba(242,243,242,${han[k + 2].toFixed(3)})`;
                ctx!.fillText(HAN[han[k + 3]], han[k], han[k + 1]);
            }
        }

        let raf = 0;
        let alive = true;

        function loop(t: number) {
            if (!alive) return;
            draw(t);
            raf = requestAnimationFrame(loop);
        }

        function start() {
            if (!alive) return;
            layout();
            cancelAnimationFrame(raf);
            lens.x = W / 2;
            lens.y = H / 2;
            if (reduce) {
                draw(1300);
                return;
            }
            raf = requestAnimationFrame(loop);
        }

        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerleave", onLeave);
        window.addEventListener("resize", start);

        start();
        // Промис может не разрешиться; первый кадр уже нарисован выше, так
        // что поле не остаётся пустым, а этот вызов только перерисовывает
        // его настоящей гарнитурой.
        document.fonts.ready.then(() => {
            if (alive) start();
        });

        return () => {
            alive = false;
            cancelAnimationFrame(raf);
            canvas.removeEventListener("pointermove", onMove);
            canvas.removeEventListener("pointerleave", onLeave);
            window.removeEventListener("resize", start);
        };
    }, []);

    return <canvas ref={ref} className="h-field" aria-hidden="true" />;
}