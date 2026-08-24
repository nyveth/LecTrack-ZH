"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { registerSphere, type SphereHandle, type SphereState } from "./sphere-driver";

/* Лист. Компонент ничего не рисует сам: он отдаёт свой canvas общему
   драйверу и потом только сообщает ему смену состояния. Регистрация
   живёт в effect с пустым списком зависимостей — узел один и тот же на
   всю жизнь компонента, перерегистрация на каждой смене состояния
   сбрасывала бы фазу волны в ноль. */

export default function Sphere({
    state,
    size = 44,
}: {
    state: SphereState;
    size?: number;
}) {
    const box = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const handle = useRef<SphereHandle | null>(null);

    // state читается здесь только как начальное значение; дальше его
    // везёт второй effect
    const initial = useRef(state);

    useEffect(() => {
        if (!box.current || !canvas.current) return;
        const h = registerSphere(box.current, canvas.current, initial.current);
        handle.current = h;
        return () => {
            h.dispose();
            handle.current = null;
        };
    }, []);

    useEffect(() => {
        handle.current?.setState(state);
    }, [state]);

    return (
        <div
            ref={box}
            className="sphere"
            data-state={state}
            style={{ "--d": `${size}px` } as CSSProperties}
        >
            <canvas ref={canvas} />
        </div>
    );
}