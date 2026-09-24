# Архитектура: агент-переводчик (interpreter)

Самодостаточный проект-агент для структурного перевода Markdown (и в перспективе
других форматов). Не зависит от родительского monorepo; интегрируется через
HTTP/MCP либо используется напрямую из CLI.

> 🌐 English version: [architecture.md](architecture.md).

## Принципы

1. **Агент работает со структурой, не с сырым текстом.** Документ открывается
   как набор адресуемых юнитов (блок → строка таблицы/элемент списка → inline-
   узел → ячейка). LLM никогда не отдаёт документ целиком.
2. **Lossless by construction.** Непереводимый контент (код, HTML, URL, inline
   code, фронтматтер) физически не попадает в editable-payload; финальная
   сборка — подстановка отредактированных срезов в оригинал (паттерн
   byte-slice), с identity-проверкой.
3. **Каждая правка проходит структурный gate** (тип, геометрия, URL, code
   spans, язык, длина) до принятия; gate возвращает агенту человекочитаемую
   ошибку — агент итеративно чинит (diagnose→fix loop).
4. **Тонкое ядро.** Агентный loop — несколько сотен строк TS: provider-абстракция,
   tools, skills, session JSONL, turn budget. Без тяжёлых фреймворков.

## Компоненты (as-built)

```
interpreter/
├── src/
│   ├── engine/            # структура документа (без LLM)
│   │   ├── md.ts          # парсер remark+gfm, frontmatter, сигнатуры (структура/URL/code/язык)
│   │   ├── addresses.ts   # mdast → адресуемые юниты (Unit/BlockInfo/Document), контекст ячейки
│   │   ├── session.ts     # DocSession: edits map + assemble + validateOne + finish (integrity gate)
│   │   └── index.ts       # ре-экспорт
│   ├── agent/             # harness
│   │   ├── provider.ts    # OpenAI-совместимый chat+tools; MockProvider для тестов
│   │   ├── config.ts      # TOML-subset + env overrides (AppConfig)
│   │   ├── skills.ts      # skills/<name>/SKILL.md → system prompt по триггерам `when:`
│   │   ├── session.ts     # A2A-статусы + append-only JSONL (status.json/result.md/session.jsonl)
│   │   ├── tools.ts       # TranslatorTools: list/get/translate/batch/skip/progress/finish/abort
│   │   ├── loop.ts        # агентный цикл observe→tool→observe, turn budget
│   │   ├── pipeline.ts    # пакетный режим (JSON-массив, без tool-цикла)
│   │   └── language.ts    # детект исходного языка по письменности
│   ├── server/
│   │   ├── http.ts        # job API для запуска ДРУГИМИ агентами (+ SSE)
│   │   ├── jobs.ts        # реестр живых задач (submit/status/result/cancel)
│   │   └── mcp.ts         # агент как MCP server (stdio JSON-RPC)
│   ├── translate.ts       # оркестратор (config→provider→prompt→engine→agent/pipeline)
│   ├── cli.ts             # translate / status / serve / mcp
│   └── demo.ts            # офлайн-демо на MockProvider
├── skills/                # скиллы-промпты (пример: markdown-tables)
├── config.toml            # provider(s), model, режим, toggles
├── tests/                 # engine + agent(mock) + pipeline(mock) + server(HTTP)
└── samples/               # фикстуры: README с таблицами/кодом/фронтматтером
```

## Адресная модель (ядро «работы со структурой»)

Editable-гранула — **текстовый leaf** mdast. Адрес стабилен между правками и
выглядит так (as-built):

| Адрес | Что адресует | Контекст в юните |
|---|---|---|
| `b3.u0` | текстовый leaf №0 внутри top-level блока №3 | `blockType`, `container` |
| `b7.u2` | leaf таблицы b7 | `cell: {row, col}` (row 0 — header; GFM delimiter-строка не является `tableRow`) |
| `b5.u1` | leaf пункта списка | `listIndex` |
| `b1.u0` | leaf внутри emphasis/strong/link | `emphasis`/`strong`/`linkHref` |

- inline-code (`code`) и содержимое защищённых блоков (`code`-fence, HTML,
  frontmatter, …) получают адрес, но `translatable: false` — в payload не уходит.
- Правка меняет только байтовый диапазон текстового содержимого узла в
  исходнике; сборка вставляет правки от `end` к `start`, поэтому офсеты соседей
  не съезжают, а разметка (`|`, `-`, `[]()`, `**`) остаётся нетронутой.
- Нумерация листьев (а не «сырой» путь `b7.r2c1`) выбрана потому, что нумерация
  не меняется, пока правка не трогает структуру — а это и гарантирует structural
  gate: совпала сигнатура структуры блока ⇒ адреса стабильны.

## Инструменты агента (tool surface, as-built)

Реестр — `src/agent/tools.ts` (схемы на Zod). LLM не видит и не отдаёт документ
целиком — только вызовы над открытым DocSession:

Read:
- `list_units({block?, limit?})` — pending-юниты: адрес + source + контекст
  (`cell rNcM`, `keepUrl`, `emphasis`/`strong`)
- `get_unit({address})` — юнит + сырой срез enclosing-блока (контекст-окно)
- `progress()` — translated / skipped / pending / rejected

Write (каждая проходит `canTranslate` — dry-run gate, ошибка → в ответ агенту):
- `translate_unit({address, text})` — перевод одного текстового юнита
- `batch_translate({rows:[{address,text}]})` — атомарно: сначала dry-run всех
  строк, коммит только если все прошли; иначе — `failedIndex` + причина
- `skip_unit({address, reason?})` — легально оставить как есть (brand, код-лексика)

Control:
- `finish()` — сборка + полный документ QC (`validateDocumentIntegrity`);
  возвращает markdown или причину провала (останавливает цикл)
- `abort({reason})` — остановить без результата

Замечание: `translate_cell` из первоначального плана — это частный случай
`translate_unit` на юните с контекстом `cell`; отдельного инструмента не нужен,
безопасность ячейки обеспечивает тот же structural gate (введение `|` ⇒ отказ).

System prompt = база (`translate.ts`) + активные скиллы (по `when:`). Правила
preserving живут в gate'ах (жёстко), а не только в промпте (мягко).

## Skills

Markdown-файлы `skills/<name>/SKILL.md` с frontmatter `name/description/when`
(тот же формат, что Qoder/Claude skills — переносимость). Примеры скиллов:
`readme-tone` (стиль README, императивы), `tables-<lang>` (правила переносов в
ячейках), `glossary-<domain>` (фиксированные соответствия терминов), `qc-repair`
(как чинить правки, отклонённые gate'ом). `skills/markdown-tables/` приложен как
рабочий пример.

## Провайдеры

`provider.ts` — один OpenAI-compatible chat-completions клиент с параметрами
`baseURL/model/apiKey/temperature`. Можно объявить несколько секций
`[providers.*]` и выбирать через `activeProvider`. Реальные значения приходят из
окружения (`LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`, см. `.env.example`) — в
публичные дефолты шлюз не зашит, а `makeProvider()` бросает явную ошибку при
ненастроенном провайдере. Расход токенов (prompt/completion) пишется в сессию
для учёта стоимости.

## Внешний интерфейс (запуск другим агентом + статус)

Семантика состояний — A2A-like: `queued → running → input-required →
succeeded | failed | cancelled`.

1. **HTTP job API** (`server/http.ts`, дефолт `127.0.0.1:4100`, опциональный
   Bearer-token):
   - `POST /jobs {text|file_b64, source?, target, mode?}` → `{job_id, state}`
     (авто-детект исходного языка; асинхронно)
   - `GET /jobs/:id` → `{state, progress:{units_total,translated,skipped,rejected},
     cost:{prompt_tokens,completion_tokens}, last_error?}`
   - `GET /jobs/:id/result` → переведённый markdown
   - `GET /jobs/:id/events` (SSE) — поток tool-call'ов (отладка/наблюдение)
   - `POST /jobs/:id/cancel`
2. **MCP server** (`mcp.ts`, stdio JSON-RPC 2.0): tools `translate_markdown`
   (sync, маленькие документы), `start_job`, `job_status`, `job_result`. Это
   «родной» интерфейс для агентов-операторов через их MCP-конфиг.
3. **CLI** (`cli.ts`): `interpreter translate <file> --to <lang> [--from] [--mode
   agent|pipeline] [--out]`, `interpreter status <id>`, `interpreter serve`,
   `interpreter mcp` — тот же kernel, что и сервер.

Сессия каждого job'а — JSONL-транскрипт в `./.interpreter/jobs/<id>/` (аудит,
resume; отката нет — все правки идемпотентны относительно gate'ов). Каталог
gitignore'ится.

## Статус реализации (v0 — готово)

1. ✅ `engine/` — remark/mdast-адресация до текстового листа + structural/integrity
   гейты + тесты (address/cell-edit/pipe-guard/language/finish).
2. ✅ `agent/` — loop + provider (+ Mock) + tools + skills + config + session JSONL.
3. ✅ Mock-provider тесты: полный прогон документа с таблицей (agent-режим) и
   pipeline-режим.
4. ✅ `server/http.ts` job-API (+SSE+bearer) и `server/mcp.ts`; CLI `translate`/
   `status`/`serve`/`mcp`; офлайн-`demo.ts`.

Дальше (не в v0): Q&A-раунд `input-required` (`POST /jobs/:id/answer`), resources
`job://{id}` в MCP, вычленение общего пакета `md-translate-engine`, интеграция с
существующей очередью перевода.

## Риски

- Стабильность адресов при bulk-операциях — митигируется тем, что правки не меняют
  структуру (gate), а перепарс после каждой правки сверяет схему.
- Малые модели портят «непереводимые» слова — gate по language ratio +
  glossary-скилл; batch-инструмент даёт дешёвый путь для простых абзацев.
- Вложенные таблицы/HTML в md — честно отказываем (integrity не проходит ⇒
  fallback на whole-block режим или ручную разметку), не портим молча.
