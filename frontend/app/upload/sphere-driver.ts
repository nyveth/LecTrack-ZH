/* ─────────────────────────────────────────────────────────────────────
   Драйвер сфер.

   Один цикл requestAnimationFrame на всю страницу. Каждый компонент
   Sphere регистрирует свой canvas и получает обратно дескриптор; цикл
   стартует, когда зарегистрирована первая сфера, и останавливается,
   когда снята последняя. Альтернатива — свой цикл в каждом компоненте:
   пять задач в очереди дали бы пять независимых будильников на 60 Гц.

   Модуль трогает document только внутри register(), то есть уже после
   монтирования компонента. На сервере он просто не выполняется.
   ───────────────────────────────────────────────────────────────────── */

export type SphereState = "idle" | "loading" | "success";

const N = 8;          // широтных полос
const CYCLE = 2.4;    // секунд на полный проход волны
const STAGGER = 0.105; // секунд между соседними полосами
const FILL = 0.4;     // толщина полосы как доля её широтного слота
const TILT = 0.3;     // наклон взгляда; 0 — смотрим точно вдоль экватора
const SETTLE = 0.45;  // секунд на переход loading → success

const BREATHE = 3.4;          // секунд на один вдох готовой сферы
const BR_O: [number, number] = [0.7, 1];    // размах непрозрачности вдоха
const BR_S: [number, number] = [0.9, 1.08]; // размах толщины вдоха

const STEP = Math.PI / N;

type Node = {
    el: HTMLElement;
    cv: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    size: number;
    dpr: number;
    state: SphereState;
    settleAt: number;
};

export type SphereHandle = {
    setState: (s: SphereState) => void;
    dispose: () => void;
};

const nodes = new Set<Node>();

let raf = 0;
let last = 0;
let clock = 0;
let lit = "#f4f6f6";
let body = "#17191a";
let reduce = false;
let ro: ResizeObserver | null = null;
let wired = false;

const easeInOut = (x: number) => x * x * (3 - 2 * x);
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/* Профиль волны: четыре опорные точки, между ними сглаженная
   интерполяция. o — непрозрачность полосы, s — множитель толщины.
   Гребень (u = .35) шире и ярче спокойной полосы, поэтому волна
   читается как утолщение, а не как бегущая подсветка. */
const KEYS = [
    { u: 0, o: 0.12, s: 0.55 },
    { u: 0.35, o: 1, s: 1.15 },
    { u: 0.7, o: 0.45, s: 0.9 },
    { u: 1, o: 0.12, s: 0.55 },
];

function wave(u: number) {
    for (let i = 0; i < KEYS.length - 1; i++) {
        const a = KEYS[i];
        const b = KEYS[i + 1];
        if (u <= b.u) {
            const k = easeInOut((u - a.u) / (b.u - a.u));
            return { o: mix(a.o, b.o, k), s: mix(a.s, b.s, k) };
        }
    }
    return { o: KEYS[0].o, s: KEYS[0].s };
}

/* Одна широтная полоса между двумя эллиптическими дугами. Полосы —
   настоящие сечения шара: их высота на экране сжимается к полюсам,
   поэтому волна читается как движение по поверхности, а не по стопке
   одинаковых плашек. */
function band(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    tLo: number,
    tHi: number,
) {
    const geo = (t: number) => {
        const rx = R * Math.cos(t);
        return { y: cy - R * Math.sin(t), rx, ry: rx * TILT };
    };
    const hi = geo(tHi);
    const lo = geo(tLo);
    ctx.beginPath();
    ctx.ellipse(cx, hi.y, hi.rx, hi.ry, 0, 0, Math.PI);
    ctx.ellipse(cx, lo.y, lo.rx, lo.ry, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fill();
}

function render(n: Node, now: number) {
    if (!n.size) return;

    const { ctx, size } = n;
    const R = size / 2 - 1;
    const cx = size / 2;
    const cy = size / 2;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = body;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = lit;

    // один вдох на всю сферу: полосы тускнеют и утончаются вместе
    const b = 0.5 + 0.5 * Math.sin((now * 2 * Math.PI) / BREATHE);
    const bO = mix(BR_O[0], BR_O[1], b);
    const bS = mix(BR_S[0], BR_S[1], b);

    for (let k = 0; k < N; k++) {
        // k = 0 — верхняя полоса; каждая нижняя отстаёт, волна идёт вниз
        const tC = Math.PI / 2 - STEP * (k + 0.5);

        let o: number;
        let s: number;

        if (n.state === "idle") {
            o = 0.22;
            s = 0.8;
        } else if (reduce) {
            o = n.state === "success" ? 1 : 0.55;
            s = 1;
        } else {
            let u = (now / CYCLE - k * (STAGGER / CYCLE)) % 1;
            if (u < 0) u += 1;
            const w = wave(u);
            o = w.o;
            s = w.s;

            if (n.state === "success") {
                const e = easeInOut(Math.min((now - n.settleAt) / SETTLE, 1));
                o = mix(o, bO, e);
                s = mix(s, bS, e);
            }
        }

        const hh = STEP * FILL * s;
        ctx.globalAlpha = o;
        band(
            ctx,
            cx,
            cy,
            R,
            Math.max(tC - hh, -Math.PI / 2),
            Math.min(tC + hh, Math.PI / 2),
        );
    }

    ctx.globalAlpha = 1;

    // объём: край уходит в тень, иначе диск остаётся плоским
    const g = ctx.createRadialGradient(
        cx - R * 0.3,
        cy - R * 0.35,
        R * 0.1,
        cx,
        cy,
        R,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.72, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    ctx.restore();
}

/* Размер пересчитывается только по событию ResizeObserver. Читать
   clientWidth внутри кадра — значит заставлять браузер пересчитывать
   раскладку по разу на каждую сферу каждый кадр. */
function resize(n: Node) {
    const size = n.el.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!size || (size === n.size && dpr === n.dpr)) return;
    n.size = size;
    n.dpr = dpr;
    n.cv.width = size * dpr;
    n.cv.height = size * dpr;
    n.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render(n, clock);
}

function frame(t: number) {
    clock += Math.min((t - last) / 1000, 0.05);
    last = t;
    for (const n of nodes) render(n, clock);
    raf = requestAnimationFrame(frame);
}

function start() {
    if (raf || reduce) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
}

function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
}

/* Вкладка в фоне продолжала бы крутить цикл вхолостую: браузер душит
   rAF, но не гарантированно, а на мобильном это прямой расход батареи. */
function onVisibility() {
    if (document.hidden) stop();
    else if (nodes.size) start();
}

function wire() {
    if (wired) return;
    wired = true;

    const css = getComputedStyle(document.documentElement);
    lit = css.getPropertyValue("--sphere-lit").trim() || lit;
    body = css.getPropertyValue("--sphere-body").trim() || body;
    reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    ro = new ResizeObserver((entries) => {
        for (const e of entries) {
            for (const n of nodes) if (n.el === e.target) resize(n);
        }
    });

    document.addEventListener("visibilitychange", onVisibility);
}

export function registerSphere(
    el: HTMLElement,
    cv: HTMLCanvasElement,
    state: SphereState,
): SphereHandle {
    wire();

    const ctx = cv.getContext("2d");
    if (!ctx) {
        return { setState: () => { }, dispose: () => { } };
    }

    const n: Node = {
        el,
        cv,
        ctx,
        size: 0,
        dpr: 0,
        state,
        // не в текущий момент, а на SETTLE назад: сфера, смонтированная
        // сразу готовой, должна стоять в готовом виде, а не доезжать
        settleAt: state === "success" ? clock - SETTLE : -SETTLE,
    };

    nodes.add(n);
    resize(n);
    ro?.observe(el);

    if (reduce) render(n, clock);
    else start();

    return {
        setState(s) {
            if (s === n.state) return;
            // момент перехода нужен запомнить один раз: от него отсчитывается
            // морф волны в дыхание, и повторная запись дёргала бы его назад
            if (s === "success") n.settleAt = clock;
            n.state = s;
            if (reduce) render(n, clock);
        },
        dispose() {
            ro?.unobserve(el);
            nodes.delete(n);
            if (!nodes.size) stop();
        },
    };
}