# Аудит установки и запуска LecTrack-ZH

Дата воспроизведения: 31 августа 2026 года.

Этот документ фиксирует проблемы, обнаруженные при установке проекта на чистом
рабочем окружении, фактические причины сбоев, временные исправления в текущем
working tree и требования к доработке документации. В отчёте нет паролей,
API-ключей или других секретов.

## 1. Краткий итог

Проект удалось полностью запустить и провести одну задачу через весь pipeline:

```text
upload -> transcribe -> chunk -> embed -> done
```

Контрольная запись продолжительностью 3:57 дала 116 сегментов, 2 чанка и 2
строки embeddings. API вернул для задачи статус `done`, а Python-тест завершился
успешно (`1 passed`).

Однако установка по исходному README/SETUP не была воспроизводимой. Основные
блокеры:

1. Инструкция PostgreSQL написана только для APT/Ubuntu и не покрывает
   DNF-системы.
2. Наличие NVIDIA-драйвера ошибочно создаёт впечатление готового CUDA runtime:
   проекту дополнительно нужны cuBLAS 12 и cuDNN 9.
3. Эти NVIDIA-библиотеки отсутствовали в Python-зависимостях, а их каталоги
   должны попасть в `LD_LIBRARY_PATH` до запуска Python.
4. Worker и CLI-транскрайбер независимо создают Whisper-модель; изменение
   модели в одном месте не влияет на другое.
5. Worker вызывал функции ingestion без предварительного создания
   `data/transcripts` и `data/chunks`.
6. README не описывает повторный запуск упавшей задачи, инвалидацию старых
   артефактов и обязательный перезапуск worker после смены модели.
7. Frontend не проходит текущие ESLint и npm audit проверки; production build
   зависит от доступа к Google Fonts.

## 2. Среда воспроизведения

```text
OS:            RED OS 8.0.3 (RHEL/Fedora family)
Kernel:        6.12.90-1.red80.x86_64
GPU:           NVIDIA GeForce RTX 4060, 8 GiB
NVIDIA driver: 580.95.05
Node.js:       22.17.1
npm:           11.4.2
System Python: 3.11.15
Project Python: 3.13.15, установлен uv
PostgreSQL:    16.14 из репозитория RED OS
pgvector:      0.8.0
```

В `pyproject.toml` указано `requires-python = ">=3.13"`. Без явного аргумента
`--python 3.13` uv выбрал самый новый доступный Python 3.14, хотя SETUP говорит
о Python 3.13. Для воспроизводимости использовалась команда:

```bash
uv sync --frozen --python 3.13
```

## 3. P0: блокеры установки и запуска

### 3.1. PostgreSQL: инструкция только для APT

`docs/SETUP.md` предлагает:

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt install -y postgresql-18 postgresql-18-pgvector
```

На RED OS, Fedora, RHEL, Rocky и AlmaLinux этих пакетов и скрипта нет. Имена
RPM-пакетов также зависят от источника:

- в штатном Fedora/RED OS репозитории: `postgresql-server`, `pgvector`;
- в PGDG RPM: `postgresql18-server`, `pgvector_18`;
- systemd unit может называться `postgresql` или `postgresql-18`;
- команды инициализации отличаются (`postgresql-setup --initdb` против
  `/usr/pgsql-18/bin/postgresql-18-setup initdb`).

На тестовой машине уже работал PostgreSQL 16. Простая установка PostgreSQL 18
поверх живого кластера опасна: каталог данных major-версии 16 нельзя запускать
сервером 18 без `pg_upgrade` или dump/restore.

Рекомендации:

- разделить SETUP на Ubuntu/Debian, Fedora и RHEL-compatible варианты;
- явно указать, действительно ли 18 является жёстким требованием, или проект
  поддерживает 16+;
- добавить процедуру проверки версии сервера через SQL, а не только
  `psql --version` (клиент и сервер могут различаться);
- отдельно документировать миграцию существующего кластера;
- добавить проверяемый скрипт bootstrap либо контейнер PostgreSQL+pgvector.

### 3.2. PostgreSQL TCP authentication не учтена

На RED OS локальные TCP-правила `pg_hba.conf` использовали `ident`. В результате
URL с логином и паролем не работал:

```text
пользователь "ragbot" не прошёл проверку подлинности (Ident)
```

Создания роли и пароля недостаточно. Для подключения приложения через
`localhost` понадобилась настройка `scram-sha-256` и reload PostgreSQL.

Рекомендации:

- добавить в SETUP диагностику `SHOW hba_file` и `pg_hba_file_rules`;
- показать безопасное добавление узких правил только для базы/роли `ragbot`;
- всегда делать резервную копию `pg_hba.conf`;
- после изменения проверять реальное соединение по `DATABASE_URL`;
- не предлагать глобальный `trust` как способ быстрого исправления.

### 3.3. Отсутствовали cuBLAS 12 и cuDNN 9

`nvidia-smi` успешно видел RTX 4060, kernel modules были загружены, а
`ctranslate2.get_cuda_device_count()` возвращал один GPU. Тем не менее первая
транскрибация завершилась ошибкой:

```text
RuntimeError: Library libcublas.so.12 is not found or cannot be loaded
```

Это ожидаемо: NVIDIA driver предоставляет `libcuda`, но не обязательно
предоставляет cuBLAS и cuDNN. Актуальный CTranslate2 требует CUDA 12 и cuDNN 9.

Понадобились Python-пакеты:

```text
nvidia-cublas-cu12
nvidia-cudnn-cu12==9.*
```

Они добавляют около 1.3 GiB загрузок. Одной установки недостаточно: каталоги
`nvidia/cublas/lib` и `nvidia/cudnn/lib` должны находиться в
`LD_LIBRARY_PATH` до старта Python.

В текущем working tree:

- пакеты добавлены в `pyproject.toml` и `uv.lock`;
- создан `scripts/run_worker.sh`, вычисляющий каталоги библиотек и запускающий
  worker с корректным `LD_LIBRARY_PATH`;
- README и SETUP переключены на `./scripts/run_worker.sh`.

Рекомендации:

- оформить GPU-зависимости как документированный optional dependency group,
  если проект должен устанавливаться и на CPU-only машинах;
- добавить startup-check с понятным сообщением о недостающих `.so`;
- проверить Linux x86_64 platform markers: NVIDIA wheels не должны ломать
  установку на macOS, Windows или ARM;
- добавить smoke test, который делает хотя бы один encoder pass, поскольку
  простое создание `WhisperModel` не обнаружило отсутствие `libcublas.so.12`;
- описать разницу между driver, CUDA runtime, cuBLAS и cuDNN.

### 3.4. Whisper-модель настроена в двух независимых местах

CLI создаёт модель в `app/ingestion/transcribe.py`, а GUI worker отдельно — в
`app/worker.py`. Изменение `small/int8` на `large-v3/float16` только в CLI не
меняет обработку загрузок из GUI.

Дополнительная сложность: уже запущенный worker продолжает использовать модель,
загруженную в память. Редактирование исходника без перезапуска процесса ничего
не меняет.

Рекомендации:

- вынести `WHISPER_MODEL`, `WHISPER_DEVICE` и `WHISPER_COMPUTE_TYPE` в единый
  конфигурационный объект;
- использовать одну factory-функцию и в CLI, и в worker;
- валидировать сочетание model/device/compute type при старте;
- логировать выбранную модель, compute type и GPU;
- документировать обязательный restart worker после изменения;
- добавить модель/версию в метаданные транскрипта.

Последний пункт критичен для корректной инвалидации данных. Сейчас по JSON или
строкам embeddings нельзя надёжно определить, какой Whisper-моделью они созданы.

### 3.5. Выходные каталоги не создавались worker-функциями

После исправления CUDA транскрибация прошла целиком, но запись результата упала:

```text
FileNotFoundError: .../data/transcripts/<video>.json.tmp
```

`main()` CLI создавал каталог, но worker вызывает `transcribe_file()` напрямую,
минуя `main()`. Аналогичная проблема существовала у `chunk_file()`.

В текущем working tree функции самостоятельно вызывают:

```python
output_dir.mkdir(parents=True, exist_ok=True)
```

Рекомендации:

- оставить создание каталогов внутри публичных функций, а не только CLI;
- добавить тесты вызова `transcribe_file()` и `chunk_file()` с пустым `tmp_path`;
- проверить аналогичный контракт у всех pipeline stages.

### 3.6. Нет пользовательского механизма retry

После ошибки job остаётся в `failed`. Worker выбирает только `queued`, поэтому
исправление окружения само по себе не повторяет задачу. Для проверки пришлось
вручную выполнить:

```sql
UPDATE jobs
SET status = 'queued', stage = NULL, error = NULL
WHERE id = 1 AND status = 'failed';
```

Рекомендации:

- добавить API `POST /jobs/{id}/retry` и кнопку Retry в GUI;
- явно определить политику удаления/переиспользования частичных артефактов;
- хранить `updated_at`, количество попыток и классифицированный код ошибки;
- не заставлять пользователя изменять таблицу вручную;
- добавить обработку jobs, оставшихся в `running` после падения процесса.

## 4. P1: проблемы воспроизводимости и эксплуатации

### 4.1. Смена модели не инвалидирует старые результаты

Идемпотентность основана на существовании файла транскрипта, mtime чанков и
наличии embeddings для `video_id`. Название Whisper-модели, параметры decoding,
embedding model revision и версия chunking algorithm в ключ не входят.

Следствия:

- смена `small` на `large-v3` не пересчитает существующий JSON;
- удаление JSON не удаляет embeddings;
- worker может пропустить старые embeddings после повторной подготовки;
- одинаковые имена могут смешивать результаты разных конфигураций.

Рекомендации:

- вычислять pipeline fingerprint из моделей, revisions и параметров;
- сохранять fingerprint вместе с каждым артефактом/job;
- реализовать явную команду `reprocess --from transcribe`;
- сделать очистку зависимых стадий транзакционной и безопасной.

### 4.2. DeepSeek-ключ требуется даже нерелевантным стадиям

`app/core/config.py` читает `DEEPSEEK_API_KEY` через `os.environ[...]` при
импорте. Поэтому без ключа нельзя даже выполнить локальный chunking, хотя он не
обращается к DeepSeek.

README признаёт это deliberate trade-off, но на практике это ухудшает setup,
тестирование и разделение компонентов.

Рекомендации:

- разделить DB, ingestion и generation settings;
- проверять DeepSeek-ключ только при создании LLM-клиента;
- добавить команду диагностики конфигурации без внешних запросов;
- отдельно и опционально проверять `/user/balance`.

### 4.3. Тяжёлые модели загружаются при старте процессов

API загружает BGE-M3 при импорте модуля. Worker при старте загружает Whisper,
BGE-M3 и tokenizer. Это приводит к долгому периоду без readiness и большому
числу HTTP HEAD/GET запросов Hugging Face даже при наличии кэша.

Рекомендации:

- использовать FastAPI lifespan и явные стадии startup;
- добавить `/health/live` и `/health/ready`;
- логировать download/load progress и время каждой модели;
- документировать prefetch-команды для BGE-M3 и Whisper;
- после prefetch поддержать `HF_HUB_OFFLINE=1`;
- закрепить Hugging Face revision, а не полагаться на плавающий `main`.

### 4.4. Python minor version не закреплена

Условие `>=3.13` позволило uv автоматически выбрать Python 3.14, хотя
документация ожидает 3.13. Это создаёт ненужную вариативность бинарных wheels.

Рекомендации:

- добавить `.python-version` с поддерживаемой версией;
- либо ограничить диапазон `>=3.13,<3.14` до прохождения CI на 3.14;
- запускать CI-матрицу на всех объявленных версиях.

### 4.5. Нет единого orchestration entrypoint

Для приложения нужны PostgreSQL, API, worker и frontend в трёх терминалах.
Нет `compose.yaml`, systemd user units, Procfile, Makefile/Justfile или единого
dev command. Также нет автоматической проверки, что worker запущен: без него GUI
оставляет upload в `queued`.

Рекомендации:

- добавить `make dev`/`just dev` либо Compose profile;
- предусмотреть корректное завершение всех дочерних процессов;
- вывести состояние worker в API/GUI;
- добавить лог-файлы или структурированный supervisor output.

### 4.6. Схема БД без миграций

`db/schema.sql` намеренно неидемпотентен. Это помогает заметить повторный запуск,
но не решает обновление уже существующей базы при изменении схемы.

Рекомендации:

- подключить Alembic или другой механизм версионированных миграций;
- хранить schema version;
- разделить bootstrap новой базы и upgrade существующей;
- добавить интеграционный тест миграции.

## 5. P1: frontend

### 5.1. Неверное определение workspace root

На тестовой машине Next.js нашёл дополнительный `package-lock.json` выше
репозитория и выбрал `/home/mch_electronics` корнем workspace. Dev server начал
следить за большой частью домашнего каталога и получил:

```text
Too many open files (os error 24)
```

В текущем working tree в `frontend/next.config.ts` добавлены
`turbopack.root` и `outputFileTracingRoot`.

Для ограниченной среды также понадобился fallback:

```bash
WATCHPACK_POLLING=true npm exec next dev -- --webpack -H 127.0.0.1
```

Рекомендации:

- сохранить явный root в Next config;
- решить, должен ли `npm run dev` использовать Turbopack или стабильный
  documented fallback;
- добавить smoke test, ожидающий HTTP 200 от `/`.

### 5.2. Production build зависит от Google Fonts

`next/font/google` скачивает IBM Plex Sans/Mono во время build. При недоступном
Google production build падает. Дополнительно `theme.css` содержит runtime
`@import` Noto Sans SC с `fonts.googleapis.com`.

В dev режиме Next.js смог использовать fallback, но `npm run build` завершился
ошибкой загрузки шрифтов.

Рекомендации:

- self-host необходимые `.woff2` через `next/font/local`;
- удалить внешний CSS `@import`;
- проверить лицензию и закоммитить только необходимые subsets/weights;
- добавить offline production build в CI.

### 5.3. ESLint не проходит

`npm run lint` возвращает 5 ошибок:

- `frontend/app/_home/Pipeline.tsx:117` — synchronous `setState` in effect;
- `frontend/app/chat/page.tsx:297` — synchronous `setState` in effect;
- `frontend/app/chat/page.tsx:432` — `Date.now()` during render;
- `frontend/app/upload/page.tsx:84` — изменение ref во время render;
- `frontend/app/upload/page.tsx:96` — synchronous `setState` in effect.

Это не просто formatting warnings: правила указывают на потенциально
нестабильные render/effect циклы React 19.

### 5.4. npm audit не проходит

Актуальная production-проверка `npm audit --omit=dev --audit-level=high`
обнаружила 4 high severity уязвимости:

- `nanoid < 3.3.18`;
- несколько advisories в `postcss <= 8.5.22`;
- `sharp < 0.35.0` / уязвимости libvips;
- затронута текущая зависимость Next.js.

Полное исправление, предложенное npm, обновляет Next до 16.3.3 за пределами
текущего диапазона. Нельзя без проверки запускать `npm audit fix --force`.

Рекомендации:

- обновить Next/lockfile осознанным PR;
- повторно выполнить lint, build, audit и UI smoke tests;
- включить Dependabot/Renovate и audit в CI.

### 5.5. Установка npm нестабильна при медленной сети

`npm ci` дважды падал на маленьких tarball (`yallist`, `word-wrap`) с
`ETIMEDOUT`. Установка завершилась после заполнения кэша, увеличения timeout и
ограничения `maxsockets=1`.

Это преимущественно инфраструктурная проблема, но SETUP стоит дополнить
диагностикой proxy/registry и рекомендацией использовать `npm ci`, а не
`npm install`, для воспроизводимой установки из lockfile.

## 6. P2: качество кода и тестов

### 6.1. Ruff не проходит

`uv run ruff check .` возвращает 18 `E501`:

- 17 длинных строк в `app/generation/prompts.py`;
- 1 длинная строка в `scripts/eval_queries.py:73`.

Для prompt strings разумно либо оформить многострочные константы так, чтобы не
менять содержимое, либо добавить узкое per-file ignore с объяснением. CI не
должен оставаться постоянно красным.

### 6.2. Почти отсутствуют автоматические тесты

В репозитории фактически выполняется один unit test chunking. Не покрыты:

- создание каталогов;
- обработка и retry jobs;
- транзакционность embed;
- API upload/status/search;
- SSE stream;
- DeepSeek error mapping;
- PostgreSQL schema/pgvector;
- CUDA library discovery;
- frontend smoke/e2e сценарий.

Рекомендация: добавить быстрые unit tests и отдельный opt-in integration profile
с PostgreSQL+pgvector. GPU smoke test можно запускать только на self-hosted
runner, но CPU/mock тест конфигурации должен быть обычным.

### 6.3. README противоречит текущей конфигурации модели

README подробно утверждает, что `small`, `int8` и конкретная видеокарта на 3 GiB
являются осознанными решениями. В текущем working tree пользователь переключил
CLI и worker на `large-v3`, `float16`, а реальная машина имеет RTX 4060 8 GiB.

Рекомендации:

- не хранить оперативный выбор модели в архитектурном тексте как неизменный;
- документировать supported presets и их требования к VRAM;
- привести README, config и worker к одному источнику истины;
- добавить таблицу `small/int8`, `large-v3/float16`, CPU fallback.

### 6.4. Форматирование текущего изменения worker требует исправления

Текущий `app/worker.py` содержит закомментированную старую строку и вручную
отформатированный блок новой модели. Перед merge его следует привести к стилю
проекта и заменить конфигурационной factory-функцией, а не просто поправить
отступы.

## 7. Безопасность конфигурации

Во время setup пользователь может по ошибке заменить значения непосредственно
в `.env.example`. Этот файл отслеживается Git и не должен содержать реальные
секреты. Рабочие значения должны находиться только в `.env`, который игнорируется
Git и имеет права `0600`.

Рекомендации:

- добавить pre-commit/secret scanning (например, gitleaks);
- проверить `.env` в `.gitignore` автоматическим тестом;
- добавить явное предупреждение рядом с командой копирования;
- не выводить `DATABASE_URL` и Authorization headers в логи;
- при попадании ключа в commit немедленно перевыпускать его.

## 8. Что уже изменено в текущем working tree

Эти изменения ещё следует проверить, отревьюить и закоммитить разработчику:

1. `nvidia-cublas-cu12` и `nvidia-cudnn-cu12==9.*` добавлены в
   `pyproject.toml`/`uv.lock`.
2. Добавлен `scripts/run_worker.sh` для корректного `LD_LIBRARY_PATH`.
3. `transcribe_file()` создаёт `transcripts_dir`.
4. `chunk_file()` создаёт `chunks_dir`.
5. README/SETUP используют новый worker launcher.
6. Next config явно ограничивает workspace root каталогом frontend.
7. Whisper изменён на `large-v3/float16` в CLI и worker, но пока дублируется.

Успешная ручная проверка после этих изменений:

```text
Whisper/CUDA:     OK
Transcription:    116 segments
Chunking:         2 chunks
Embedding:        2 rows
Job status:       done
API /status/1:    HTTP 200, error=null
pytest:           1 passed
```

Не проходят:

```text
ruff check:       18 errors
frontend lint:    5 errors
npm production audit: 4 high severity vulnerabilities
offline Next build: Google Fonts download failure
```

## 9. Предлагаемый порядок исправлений

### P0

1. Централизовать Whisper config и добавить pipeline fingerprint.
2. Довести GPU dependency/launcher решение до поддерживаемого вида.
3. Добавить DNF/PostgreSQL authentication инструкции или Compose setup.
4. Добавить retry/recovery для jobs.
5. Добавить тесты выходных каталогов и end-to-end job lifecycle.

### P1

1. Убрать build-time зависимость от Google Fonts.
2. Исправить ESLint errors и npm high vulnerabilities.
3. Добавить health/readiness endpoints и единый dev launcher.
4. Разделить конфигурацию ingestion и generation.
5. Добавить миграции БД.

### P2

1. Закрепить Python minor version.
2. Починить Ruff baseline.
3. Расширить CI и тестовое покрытие.
4. Добавить prefetch/offline/model monitoring документацию.

## 10. Чек-лист приёмки исправленного setup

Исправление можно считать завершённым, когда на чистой поддерживаемой машине
выполняется следующее:

- [ ] инструкции не требуют угадывать пакетный менеджер или имена пакетов;
- [ ] `uv sync --frozen` выбирает документированную версию Python;
- [ ] GPU startup-check подтверждает driver, cuBLAS и cuDNN;
- [ ] `npm ci` воспроизводимо устанавливает lockfile;
- [ ] schema/migrations создают новую базу и обновляют существующую;
- [ ] одна команда запускает API, worker и frontend;
- [ ] health endpoint отличает loading models от ready;
- [ ] upload тестового MP4 доходит до `done` без ручного SQL;
- [ ] retry failed job доступен через API/GUI;
- [ ] смена Whisper-модели пересчитывает зависимые артефакты;
- [ ] `pytest`, Ruff и ESLint проходят;
- [ ] production frontend build работает без доступа к Google Fonts;
- [ ] npm audit не содержит high/critical уязвимостей;
- [ ] документация проверяется CI на Ubuntu и одной DNF-системе.

