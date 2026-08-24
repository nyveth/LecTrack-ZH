"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Warning, X } from "@phosphor-icons/react";
import Sphere from "./Sphere";
import "./upload.css";

/* ─────────────────────────────────────────────────────────────────────
   /upload

   Очередь живёт в localStorage, а не только в состоянии страницы,
   потому что в шапке написано «эту страницу можно закрыть». Если после
   перезагрузки список пуст, обещание оказывается ложью.

   Хранится job_id, хотя в интерфейсе он не показан нигде, кроме ссылки
   на поиск: /status принимает id, спросить по имени файла нельзя.
   ───────────────────────────────────────────────────────────────────── */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

const POLL_MS = 2000;
const STORE = "lectrack.jobs";

// Бэкенд принимает только это. Держать здесь список пошире значит
// обещать пользователю то, что отвергнется с 400 после загрузки всего
// файла на сервер.
const ACCEPT = ".mp4";

/* sending — единственный статус, которого нет в БД: он покрывает окно
   между выбором файла и ответом /upload, когда id ещё не существует. */
type JobStatus = "sending" | "queued" | "running" | "done" | "failed";
type JobStage = "transcribe" | "chunk" | "embed";

type Job = {
    key: string;        // локальный, для React и для удаления строки
    jobId: number | null; // из БД, появляется после ответа /upload
    name: string;
    size: number;
    status: JobStatus;
    stage: JobStage | null;
    error: string | null;
};

const STAGE_LABEL: Record<JobStage, string> = {
    transcribe: "transcribing",
    chunk: "chunking",
    embed: "embedding",
};

function mb(bytes: number) {
    return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
}

/* Правая половина подписи отвечает на «сколько это», пока работа идёт.
   После готовности размер файла не значит ничего, а числа чанков
   /status не отдаёт, поэтому справа не остаётся ничего. */
function subline(job: Job): readonly [string, string | null] {
    switch (job.status) {
        case "failed":
            return [job.error ?? "failed", null];
        case "done":
            return ["ready", null];
        case "sending":
            return ["uploading", mb(job.size)];
        case "queued":
            return ["queued", mb(job.size)];
        default:
            return [job.stage ? STAGE_LABEL[job.stage] : "running", mb(job.size)];
    }
}

const isOpen = (j: Job) =>
    j.jobId !== null && (j.status === "queued" || j.status === "running");

export default function UploadPage() {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [over, setOver] = useState(false);
    const [ready, setReady] = useState(false);

    // Опрос читает список отсюда, а не из замыкания: иначе цикл нужно
    // пересоздавать на каждое изменение очереди, а он асинхронный.
    const live = useRef<Job[]>([]);
    live.current = jobs;

    // localStorage читается после монтирования: на сервере его нет, и
    // чтение в инициализаторе useState развалило бы гидратацию
    useEffect(() => {
        try {
            const raw = localStorage.getItem(STORE);
            if (raw) {
                const saved = JSON.parse(raw) as Job[];
                // Файл при перезагрузке теряется, а значит незавершённая
                // отправка не возобновится никогда. Строка, оставшаяся в
                // sending, врала бы бесконечно.
                setJobs(
                    saved.map((j) =>
                        j.status === "sending"
                            ? { ...j, status: "failed", error: "upload interrupted" }
                            : j,
                    ),
                );
            }
        } catch {
            // испорченная запись — не повод падать, начинаем с пустого
        }
        setReady(true);
    }, []);

    useEffect(() => {
        if (!ready) return;
        localStorage.setItem(STORE, JSON.stringify(jobs));
    }, [jobs, ready]);

    const patch = useCallback((key: string, next: Partial<Job>) => {
        setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, ...next } : j)));
    }, []);

    /* ── отправка ────────────────────────────────────────────────────
       Файл уходит одним запросом на файл: /upload принимает ровно один
       UploadFile. Строка появляется до запроса, чтобы выбор файла давал
       отклик сразу, а не через минуту молчания на 400-мегабайтном mp4. */
    const send = useCallback(
        async (key: string, file: File) => {
            const form = new FormData();
            form.append("file", file);

            try {
                const res = await fetch(`${API}/upload`, { method: "POST", body: form });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(body?.detail ?? `upload failed with ${res.status}`);
                }
                const { job_id } = (await res.json()) as { job_id: number };
                patch(key, { jobId: job_id, status: "queued" });
            } catch (e) {
                patch(key, {
                    status: "failed",
                    error: e instanceof Error ? e.message : "upload failed",
                });
            }
        },
        [patch],
    );

    const accept = useCallback(
        (files: FileList | null) => {
            if (!files?.length) return;

            for (const file of Array.from(files)) {
                const key = crypto.randomUUID();
                const ok = file.name.toLowerCase().endsWith(ACCEPT);

                setJobs((prev) => [
                    {
                        key,
                        jobId: null,
                        name: file.name,
                        size: file.size,
                        status: ok ? "sending" : "failed",
                        stage: null,
                        error: ok ? null : "only .mp4 is accepted",
                    },
                    ...prev,
                ]);

                // Проверка на клиенте, потому что тот же отказ с сервера
                // приходит уже после того, как файл целиком уехал по сети.
                if (ok) void send(key, file);
            }
        },
        [send],
    );

    /* ── опрос ───────────────────────────────────────────────────────
       Цепочка setTimeout, а не setInterval: следующий запрос ставится
       только после того, как вернулся предыдущий. setInterval на медленной
       сети накапливает наложенные запросы, и очередь начинает мигать
       ответами, пришедшими не в том порядке. */
    useEffect(() => {
        if (!ready) return;

        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;

        const tick = async () => {
            const open = live.current.filter(isOpen);

            if (open.length) {
                const seen = await Promise.all(
                    open.map(async (j) => {
                        try {
                            const res = await fetch(`${API}/status/${j.jobId}`);
                            if (!res.ok) return null;
                            const d = (await res.json()) as {
                                status: JobStatus;
                                stage: JobStage | null;
                                error: string | null;
                            };
                            return { key: j.key, ...d };
                        } catch {
                            // сеть моргнула или сервер лежит: строка остаётся
                            // как была, следующий тик попробует снова
                            return null;
                        }
                    }),
                );

                if (stopped) return;

                setJobs((prev) =>
                    prev.map((j) => {
                        const u = seen.find((s) => s?.key === j.key);
                        return u ? { ...j, status: u.status, stage: u.stage, error: u.error } : j;
                    }),
                );
            }

            if (!stopped) timer = setTimeout(tick, POLL_MS);
        };

        timer = setTimeout(tick, POLL_MS);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [ready]);

    const dismiss = (key: string) => setJobs((prev) => prev.filter((j) => j.key !== key));

    const drag = (e: React.DragEvent, next: boolean) => {
        e.preventDefault();
        setOver(next);
    };

    return (
        <div className="shell">
            <nav className="bar">
                <Link href="/" className="brand-link">
                    LecTrack-ZH
                </Link>
                <Link href="/chat">
                    <ArrowLeft size={14} />
                    back to search
                </Link>
            </nav>

            <header className="head">
                <h1>Upload a lecture</h1>
                <p>
                    The file joins a queue. Processing runs on a separate machine and takes
                    a few minutes: transcription, chunking, embedding. You can close this
                    page.
                </p>
            </header>

            <label
                className="drop"
                data-over={over}
                onDragEnter={(e) => drag(e, true)}
                onDragOver={(e) => drag(e, true)}
                onDragLeave={(e) => drag(e, false)}
                onDrop={(e) => {
                    drag(e, false);
                    accept(e.dataTransfer.files);
                }}
            >
                <input
                    type="file"
                    accept={ACCEPT}
                    multiple
                    onChange={(e) => {
                        accept(e.target.files);
                        // один и тот же файл, выбранный дважды подряд, не даёт
                        // события change, пока значение поля не сброшено
                        e.target.value = "";
                    }}
                />
                <div className="drop-icon">
                    <Plus size={20} />
                </div>
                <div className="drop-lead">
                    drag and drop or <b>browse your disk</b>
                </div>
                <div className="drop-note">mp4</div>
            </label>

            <section className="queue">
                <div className="queue-head">
                    <h2>queue</h2>
                    <span className="queue-count">{jobs.length}</span>
                </div>

                {ready && jobs.length === 0 && (
                    <div className="empty">nothing uploaded yet</div>
                )}

                {jobs.map((job) => {
                    const [left, right] = subline(job);
                    const failed = job.status === "failed";

                    return (
                        <div className="job" key={job.key} data-failed={failed}>
                            <div className="job-glyph">
                                {failed ? (
                                    <Warning size={22} />
                                ) : (
                                    <Sphere state={job.status === "done" ? "success" : "loading"} />
                                )}
                            </div>

                            <div>
                                <div className="job-name" title={job.name}>
                                    {job.name}
                                </div>
                                <div className="job-sub">
                                    {left}
                                    {right && (
                                        <>
                                            <span className="sep">/</span>
                                            {right}
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="job-act">
                                {job.status === "done" && job.jobId !== null && (
                                    <Link className="job-link" href="/chat">
                                        search it
                                    </Link>
                                )}
                                <button
                                    className="job-dismiss"
                                    aria-label={`Remove ${job.name} from list`}
                                    onClick={() => dismiss(job.key)}
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </section>
        </div>
    );
}