# interpreter

**Агент структурного перевода Markdown.** Переводит документы, работая с
*структурой*, а не с сырым текстом: каждый текстовый лист адресуем, каждая
правка проходит структурный gate, а итоговый документ собирается подстановкой
правок обратно в оригинал — поэтому таблицы, код, ссылки и frontmatter остаются
байт-в-байт.

Работает как CLI, HTTP job-API и MCP-сервер, так что **другие агенты** могут
запустить перевод и опрашивать его статус. Самодостаточен (не зависит от
родительского monorepo); обращается к любому OpenAI-совместимому
chat-completions эндпоинту.

> 🌐 This README is also available in [English](README.md).

## Зачем

Перевод Markdown «прямым» LLM-прогоном ломает вёрстку: в переведённой ячейке
таблицы появляется лишняя `|`, код «правится», ссылки переписываются. Этот
агент не даёт модели выдать документ целиком: он предоставляет адресуемые
текстовые юниты и отклоняет любую правку, меняющую структуру.

## Быстрый старт

Нужен **Node ≥ 22.18** (нативный TypeScript через `--experimental-transform-types`).

```sh
pnpm install --ignore-workspace     # зависимости: unified / remark-gfm / zod (+ typescript для typecheck)
cp .env.example .env                # затем заполните LLM_BASE_URL / LLM_MODEL / LLM_API_KEY

pnpm demo                           # офлайн-демо (MockProvider, без сети и ключа)
pnpm test                           # 15 тестов: engine + agent + pipeline + server
pnpm typecheck                      # tsc --noEmit

pnpm cli translate README.md --to ru --out /tmp/ru.md
pnpm cli translate big.md --to zh --mode pipeline     # пакетный режим (дешевле, детерминированнее)
pnpm cli status <jobId>                               # состояние задачи с диска
pnpm serve                                            # HTTP job API (запуск другим агентом)
pnpm mcp                                              # MCP-сервер (stdio)
```

> `pnpm demo` и `pnpm test` полностью офлайновые (скриптованный `MockProvider`).
> Реальные учётные данные из `.env` нужны только для боевого перевода.

## Как это работает

1. **Адресация** (`src/engine/addresses.ts`) — remark/mdast разбирает документ,
   каждый текстовый leaf получает стабильный адрес `b<блок>.u<лист>`. Inline-code
   и защищённые блоки помечаются нетранслируемыми. Контекст (тип блока, ячейка
   `cell {row,col}`, индекс списка, emphasis/strong, href ссылки) доступен переводчику.
2. **Правка** (`src/engine/session.ts`) — `translate(address, text)` меняет
   только байтовый диапазон юнита. Перед принятием блок пере-парсится, и его
   **сигнатура структуры** (типы узлов + геометрия, текст игнорируется) обязана
   совпасть; отдельно проверяются URL, inline-code и мягкий языковой гейт.
   Изобретение `|`, `` ` `` или `[ ]` в обычном тексте отвергается.
3. **Сборка** — принятые правки вставляются в оригинал от последней к первой
   (исходные офсеты ⇒ не мешают друг другу), затем `finish()` прогоняет
   целостность всего документа (последовательность блоков, байт-равенство
   защищённых блоков, геометрия таблиц, правдоподобие языка).
4. **Два режима** — `agent` (цикл tool-calling для сложных документов) и
   `pipeline` (пакетный JSON для дешёвого массового перевода).

## Структура

```
src/engine/     md.ts (разбор + сигнатуры) · addresses.ts (юниты) · session.ts (DocSession + гейты)
src/agent/      provider.ts (OpenAI-совместимый + Mock) · config.ts (TOML + env) · skills.ts ·
                session.ts (JSONL-транскрипт, A2A-статусы) · tools.ts · loop.ts · pipeline.ts · language.ts
src/server/     http.ts (job API + SSE) · jobs.ts (реестр) · mcp.ts (stdio JSON-RPC)
src/translate.ts   оркестратор, общий для CLI / HTTP / MCP
src/cli.ts · src/demo.ts
config.toml · .env.example · skills/<name>/SKILL.md · samples/ · tests/
```

## Конфигурация

Порядок разрешения: **дефолты → `config.toml` → окружение** (реальные env-переменные
приоритетнее локального `.env`). Ключи провайдера берутся только из окружения и
никогда не коммитятся.

| Переменная | Назначение |
|---|---|
| `LLM_BASE_URL` | OpenAI-совместимый эндпоинт, напр. `https://api.openai.com/v1` |
| `LLM_MODEL` | имя chat-модели |
| `LLM_API_KEY` | bearer-токен эндпоинта (храните только в `.env`) |
| `INTERPRETER_HOST` / `INTERPRETER_PORT` | адрес HTTP job API |
| `INTERPRETER_TOKEN` | если задан, HTTP/MCP-вызывающим нужен `Authorization: Bearer <token>` |
| `INTERPRETER_CONFIG` | путь к конфигу (по умолчанию `config.toml`) |

Провайдеры, файл системного промпта, режим и бюджет ходов задаются и в
`config.toml`. Скиллы — markdown-модули промптов `skills/<name>/SKILL.md`
(frontmatter `name`/`description`/`when`), подмешиваемые в системный промпт при
совпадении триггеров.

## Запуск другим агентом

- **HTTP job API** — `POST /jobs` → `{job_id}`; `GET /jobs/:id` возвращает
  состояние в A2A-стиле (`queued → running → input-required → succeeded | failed |
  cancelled`) с прогрессом и стоимостью в токенах; `GET /jobs/:id/result` —
  перевод; `GET /jobs/:id/events` — SSE-поток; `POST /jobs/:id/cancel` — отмена.
  `GET /healthz` — без авторизации.
- **MCP-сервер** (stdio) — инструменты `translate_markdown` (sync, маленькие
  документы), `start_job`, `job_status`, `job_result`.
- **CLI** — тот же kernel: `translate`, `status`, `serve`, `mcp`.

Каждая задача сохраняется в `.interpreter/jobs/<id>/` (`status.json`,
`result.md`, `session.jsonl`) для аудита и resume. Каталог gitignore'ится.

## Документация

| Файл | О чём |
|---|---|
| [architecture.ru.md](architecture.ru.md) | Дизайн: адресная модель, tool-поверхность + гейты, режимы, skills, провайдеры, HTTP/MCP ([английская версия](architecture.md)) |

Заметки исследования (инструменты Markdown↔структура, обзор agent-харнессов)
лежат в `research/`, которая намеренно gitignore'ится и не входит в публичный репозиторий.

## Лицензия

MIT (см. `LICENSE`).
