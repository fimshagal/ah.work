# AhWork — план розробки

> Бібліотека для оркестрації пула Web Worker'ів з task-орієнтованим API.
> Базове ім'я: **AhWork**. Розробник мислить у термінах *tasks/jobs*, а не Worker-інстансів.

Джерело вимог: [`definition.txt`](./definition.txt).

## Статус реалізації

- ✅ **Фаза 1 — Публічний API**: типи в `src/types.ts`, `createRuntime`, `RuntimeTask` (`task(...)` + `task.run(...)`).
- ✅ **Фаза 2 — Протокол**: `src/protocol/messages.ts` (discriminated unions + `assertNever`).
- ✅ **Фаза 3 — Серіалізація + worker source**: `workerSource`, `WorkerFactory` (реюз Blob-URL), `ManagedWorker`, лінива реєстрація тасок, кореляція job↔promise, переюз воркерів. Додатково реалізовано мінімальний Scheduler/WorkerPool з on-demand scaling до `maxWorkers`, базові `stats()` та immediate `shutdown()` (щоб приклади реально виконувались).
- ✅ **Фаза 4 — Автоскейлінг**: `minWorkers` prewarm + підтримка мінімуму після краху, `idleTimeout` термінація простійних воркерів (per-worker таймери, без полінгу), ніколи нижче `minWorkers`, ніколи busy. Юніт-тести скейлінгу на фейкових воркерах + fake timers.
- ✅ **`context` опція** (передача зовнішніх/closure **даних**): `runtime.task(fn, { context })` — серіалізується один раз, передається у `REGISTER_TASK`, кешується на `ManagedWorker`, інжектиться як останній аргумент таски. Типобезпечні перевантаження `task()`. Тест на протокол.
- ✅ **Фаза 5 — map / таймаути / скасування**: `task.map()` (паралельно, порядок результатів гарантований, tuple-aware через арність), per-job `timeout` (deadline від сабміту, перекриває `taskTimeout`) → `TaskTimeoutError` + термінація воркера, `AbortSignal` (`task.run(args, { signal })`): queued → видалення з черги, running → термінація воркера, `AbortError` з `cause`; заміна воркера після скасування за потреби. Юніт-тести map (порядок/арність) та cancellation (queued/running/refill).
- ✅ **Фаза 6 — надійність / shutdown**: graceful shutdown (`wait` активних, reject черги), immediate reject і running-джобів, crash-replacement (dispatch черги + `ensureMinimum`), дружніші `ReferenceError` (closure hint) і `DataCloneError`. Авто-детект transferables — ні (явний `transfer` уже є).
- ✅ **Тести**: юніти в jsdom; browser suite (`npm run test:browser`) — Vitest + Playwright/Chromium, реальні Blob-воркери.
- ✅ **Аудити (раунди 1–3)** — див. розділи «Аудит» нижче. Р1: P1/P2/P3 (коректність/надійність/продуктивність). Р2: поліш надійності. Р3: `workerUrl` бекенд, auto-transfer, per-job retry.
- 🟡 **Розширення передачі кложурів** (раунд 4): ✅ `inject` для чистих функцій-хелперів (серіалізація `toString`, відтворення у scope воркера, валідація імен, взаємні виклики, сумісність з `context`); ⬜ module-backend для імпортів (→ раунд 9), ⬜ build-плагін для «прозорих» кложурів (→ розділ B беклогу).
- ✅ **Раунд 5 — demo як чесний бенчмарк + фікс `inject` проти мініфікації**.
- ✅ **Раунд 6 — бекенд Node `worker_threads`**: `WorkerLike`/`WorkerBackend`, `NodeWorkerFactory`, умовні експорти, `test/node`. Разом **103 тести** (55 юніт + 17 node + 31 browser).
- ✅ **Раунд 8 — пріоритети джобів**: `RunOptions.priority` (більше = раніше, FIFO всередині рівня), квота проти голодування (`fairness`, типово 4), витіснення з повної черги (`onQueueFull: "evict-lowest"`). **+19 тестів**, жоден наявний не змінено.
- ⬜ **Раунди 7 і 9 (наступні)**: кооперативне скасування → окремий файл воркера з реальними імпортами. Розгорнуті розділи нижче.

Приклади: `examples/` (запуск `npm run examples`).

---

## 0. Загальні рішення по стеку

- **Мова:** TypeScript (strict), без `any` без потреби.
- **Збірка/дев:** Vite (library mode, ESM-вихід, tree-shakeable, генерація `.d.ts` через `vite-plugin-dts`).
- **Тести:** Vitest. Для юніт-логіки — jsdom/happy-dom; для реальної поведінки Worker — browser mode (`@vitest/browser` + Playwright provider).
- **Залежності рантайму:** прагнемо до нуля. Все, що можна реалізувати всередині, реалізуємо самі.
- **Демо:** окремий Vite-застосунок (React + `tardigrade-store`), не входить у публічний бандл ліби.
- **Ім'я/структура:** публічний вхід `createRuntime`, неймспейс/бренд — `AhWork`.

Структура репозиторію (орієнтовно):

```
ah.work/
  src/                 # код бібліотеки
  test/                # vitest (unit + browser)
  demo/                # React + tardigrade-store демосторінка
  README.md            # документація
  plan.md              # цей файл
  definition.txt       # первинне ТЗ
  package.json
  tsconfig.json
  vite.config.ts       # library build
  vitest.config.ts
```

---

## Фаза 1. Публічний API (робимо ПЕРШИМ)

Мета: зафіксувати контракт до реалізації, щоб решта компонентів підлаштовувалась під нього.

### 1.1 Точка входу

```ts
function createRuntime(options?: RuntimeOptions): Runtime;
```

### 1.2 Типи опцій

```ts
interface RuntimeOptions {
  minWorkers?: number;          // default 0
  maxWorkers?: number | "auto"; // default navigator.hardwareConcurrency || 4
  idleTimeout?: number;         // default 10_000 (ms)
  taskTimeout?: number;         // default 0 (0 = без таймауту)
  // Точки розширення (закладаємо в тип одразу, реалізуємо пізніше):
  // workerUrl?: string;        // для CSP-режиму (Фаза 7)
  // backend?: WorkerBackend;   // альтернативні бекенди (Фаза 7)
}
```

### 1.3 Runtime

```ts
interface Runtime {
  task<A extends unknown[], R>(fn: (...args: A) => R): RuntimeTask<A, R>;
  stats(): RuntimeStats;
  shutdown(options?: { graceful?: boolean }): Promise<void>;
}
```

### 1.4 RuntimeTask (виклик + опції виконання)

Ключове рішення з ТЗ (розділ 13): callable-таска не може чисто відрізнити аргументи від опцій, тому даємо **обидва** інтерфейси:

```ts
interface RuntimeTask<A extends unknown[], R> {
  // Проста форма: викликається як звичайна async-функція
  (...args: A): Promise<Awaited<R>>;

  // Розширена форма з опціями виконання
  run(args: A, options?: RunOptions): Promise<Awaited<R>>;

  // Пакетне виконання зі збереженням порядку результатів
  map(inputs: A extends [infer S] ? S[] : A[], options?: RunOptions): Promise<Awaited<R>[]>;
}

interface RunOptions {
  signal?: AbortSignal;   // скасування (Фаза 5)
  timeout?: number;       // per-job таймаут, перекриває taskTimeout (Фаза 5)
  transfer?: Transferable[]; // явний transfer-list (Фаза 6, опційно)
}
```

- Типізацію `map` для мультиаргументних тасок робимо у другу чергу; спершу гарантуємо одноаргументний `map`.
- **Рішення для обговорення:** остаточна форма `map` для tuple-аргументів (`add.map([[1,2],[10,20]])`).

### 1.5 Статистика

```ts
interface RuntimeStats {
  workers: number;
  busyWorkers: number;
  idleWorkers: number;
  queuedJobs: number;
  runningJobs: number;
  completedJobs: number;
  failedJobs: number;
  averageWaitTime: number;
  averageExecutionTime: number;
}
```

**Acceptance для фази:** типи компілюються, приклад із розділу 29 ТЗ типізується без помилок (на рівні сигнатур, ще без виконання).

---

## Фаза 2. Протокол Worker ↔ Main (робимо ДРУГИМ)

Мета: ізольований типізований протокол (discriminated unions), не змішаний з логікою рантайму. Файл `src/protocol/messages.ts`.

### 2.1 Main → Worker

```ts
type MainToWorker =
  | { type: "REGISTER_TASK"; taskId: string; source: string }
  | { type: "EXECUTE"; jobId: string; taskId: string; args: unknown[] };
```

### 2.2 Worker → Main

```ts
type WorkerToMain =
  | { type: "TASK_REGISTERED"; taskId: string }
  | { type: "TASK_RESULT"; jobId: string; result: unknown }
  | { type: "TASK_ERROR"; jobId: string; error: SerializedError };

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}
```

### 2.3 Рішення протоколу

- Реєстрація тасок — **лінива** (реєструємо на воркері при першій потребі), якщо це не ускладнює код (ТЗ розділ 7).
- Після реєстрації `EXECUTE` не пересилає source повторно (перформанс, розділ 24).
- Уся серіалізація/десеріалізація помилок — тільки тут, щоб `errors/*` та рантайм не знали про формат повідомлень.

**Acceptance:** повний набір типів повідомлень, exhaustive `switch` компілюється (перевірка через `never`).

---

## Фаза 3. Задачі, серіалізація та worker source

### 3.1 Реєстр тасок

- Кожна таска отримує унікальний `taskId` (`task_1`, ...). Утиліта `utils/ids.ts`.
- Внутрішнє представлення: `{ taskId, source }` (`source = fn.toString()`).
- Проєктуємо реєстрацію так, щоб у майбутньому module-based backend міг замінити серіалізацію функцій (ТЗ розділ 6/22).

### 3.2 Worker runtime source (`src/workers/workerSource.ts`)

- Джерело воркера зберігаємо як рядок-константу.
- Воркер: тримає `Map<string, Function>` (реєстр), обробляє `REGISTER_TASK`/`EXECUTE`, ловить помилки, серіалізує їх, підтримує sync та async таски (`await` результату).
- Реконструкція функції з source у воркері — **у центрі уваги розділу «Ризики»** нижче.

### 3.3 WorkerFactory (`src/workers/WorkerFactory.ts`)

- Один раз: `Blob([workerSource], {type:"text/javascript"})` → `URL.createObjectURL` → переюзаємо URL для всіх воркерів.
- **Не** створюємо новий Blob на кожен job.
- `revoke` URL лише при остаточному shutdown рантайму (розділ 5).

**Acceptance:** один воркер створюється динамічно, виконує одну просту таску, повертає результат (Phase 1 з ТЗ розділу 30).

---

## Фаза 4. WorkerPool та Scheduler (таски + шедулер)

### 4.1 Job-модель (`scheduler/`)

```ts
interface Job {
  id: string;
  taskId: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  createdAt: number;
  signal?: AbortSignal;
  timeout?: number;
}
```

### 4.2 WorkerInstance / WorkerPool

- `WorkerInstance`: `{ id, worker, state: "idle"|"busy"|"terminated", currentJobId?, lastUsedAt, registeredTasks: Set<string> }`.
- `WorkerPool` знає: кількість воркерів, idle/busy, чергу.
- Кореляція `jobId ↔ Promise` тримається на стороні main.

### 4.3 Scheduler (окремий компонент, не в Runtime — розділ 10)

Алгоритм:
- Job приходить → є idle воркер → призначити.
- Інакше `currentWorkers < maxWorkers` → створити воркер і призначити.
- Інакше → у `JobQueue`.
- Воркер завершив → resolve/reject → взяти наступний з черги або позначити idle.

### 4.4 Автоскейлінг (розділ 11)

- Воркери створюються on-demand (від 0).
- Idle довше за `idleTimeout` → термінувати, але **ніколи** нижче `minWorkers`.
- Не термінувати busy-воркери.
- Не поллити воркери — тільки події/повідомлення (розділ 24).

**Acceptance:** черга, дінамічне масштабування до `maxWorkers`, переюз воркерів, дотримання `minWorkers`/`idleTimeout` (Phase 3 ТЗ).

---

## Фаза 5. map, таймаути, скасування

### 5.1 map (розділ 12)

- MVP: `map()` просто сабмітить N джобів через шедулер.
- **Порядок результатів строго відповідає порядку входів**, навіть якщо воркери завершують у різному порядку.
- Закладаємо можливість авто-батчингу пізніше.

### 5.2 Таймаути (розділ 14)

- per-job `timeout` перекриває рантаймовий `taskTimeout`.
- Не встиг → термінувати воркер, `reject` з `TaskTimeoutError`, дозволити пулу підняти заміну.

### 5.3 AbortSignal (розділ 13)

- У черзі → прибрати з черги, `reject` з `AbortError`.
- Вже виконується → (для MVP допустимо) термінувати воркер, `reject` з `AbortError`, підняти заміну за потреби.
- Кооперативне скасування без вбивства воркера — майбутнє розширення (задокументувати).

**Acceptance:** ordered map, queued/running cancellation, timeout.

---

## Фаза 6. Надійність, статистика, shutdown

### 6.1 Error propagation (розділ 15)

- Помилки воркера серіалізуються (`name/message/stack`) і реконструюються на main як Error-like.
- Звичайний throw у таски **не ламає** рантайм; воркер лишається переюзабельним.
- Тільки фатальні збої → заміна воркера.

### 6.2 Crash recovery (розділ 16)

- `worker.onerror` / `worker.onmessageerror`.
- Мертвий воркер → `reject` поточного job з `WorkerCrashedError`, видалити з пула, продовжити чергу, підняти заміну.
- Один збій ≠ смерть рантайму.

### 6.3 Кастомні помилки (`src/errors/`)

`RuntimeError` (база), `TaskTimeoutError`, `WorkerCrashedError`, `RuntimeShutdownError`, `AbortError` (або переюз DOMException).

### 6.4 Статистика (розділ 17)

- Легкі лічильники + прості усереднення wait/execution time.

### 6.5 Transferables (розділ 19, опційно)

- Явний `transfer`-список → `worker.postMessage(msg, transferables)`.
- Без авто-детекту в першій версії.

### 6.6 Shutdown (розділ 18)

- Припинити приймати джоби, `reject` черги, термінувати воркери, очистити таймери, `revoke` Blob URL, зняти лісенери, звільнити посилання.
- Виклик таски після shutdown → `RuntimeShutdownError`.
- `graceful: true` — чекати поточні джоби (якщо ускладнює — спершу immediate, graceful як документована точка розширення).

**Acceptance:** повний приклад із розділу 29 ТЗ працює end-to-end.

---

## Фаза 7. Точки розширення (НЕ реалізуємо, лише не блокуємо)

Архітектурно тримаємо можливими (розділи 22/23), без передчасних абстракцій:
- CSP-режим: `workerUrl` / `backend(...)` — статичний worker entry (див. розділ «Ризики»).
- Пріоритетні черги, авто-батчинг, streaming, stateful workers, task affinity, retries, work stealing.
- Інші бекенди: Node `worker_threads`, Deno, Bun, module workers, WASM.
- Не приймати рішень, що унеможливлюють альтернативні бекенди виконання.

---

## Ризики: `fn.toString()` та безпека (окремий пріоритетний блок)

> Цей блок свідомо винесений окремо — це головні концептуальні ризики ліби.

### R1. Серіалізація через `fn.toString()` — втрата замикань

- **Проблема:** `fn.toString()` дає лише текст функції. Зовнішні змінні (closures), імпорти, `this` **не потрапляють** у realm воркера.
  - Працює: `runtime.task((x) => x * 10)`.
  - Не працює надійно: `const m = 10; runtime.task((x) => x * m)` — `m` не існує у воркері.
- **План дій:**
  - Виявляти збої виконання через відсутні зовнішні змінні (`ReferenceError`) і повертати **осмислену** помилку воркера (натяк: ймовірно closure/зовнішня залежність).
  - Не намагатись вирішувати довільну серіалізацію замикань у MVP.
  - Явно задокументувати обмеження в README (розділ 26).
  - Спроєктувати реєстрацію тасок так, щоб module-based backend міг замінити текстову серіалізацію.

### R2. Різниця realm / несеріалізовувані значення

- **Проблема:** аргументи/результати йдуть через structured clone — функції, DOM-вузли, класи з методами, символи не переносяться.
- **План:** документувати обмеження structured clone; давати зрозумілу помилку при `DataCloneError`.

### R3. Транспіляція (TS → JS) і мінімізація

- **Проблема:** `fn.toString()` віддає **транспільований/мініфікований** код у білді споживача; TS-синтаксису у рантаймі немає. Хелпери транспілятора (напр. `__awaiter`) можуть бути поза функцією й зникнути у воркері.
- **План:** документувати; async підтримувати через нативний `async` у сучасних браузерах; попередити про даунлевел-таргети.

### S1. Безпекові ризики Blob/`eval`-подібного виконання

- **Проблема:** воркер реконструює функцію з рядка (по суті динамічне виконання коду). Якщо source таски формується з недовіреного вводу — це вектор ін'єкції.
- **План:**
  - У документації прямо зазначити: **не передавати в `task()` код, зібраний з недовіреного/користувацького вводу**.
  - Виконання ізольоване у Worker-realm (немає DOM/`window`), що зменшує поверхню атаки, але не робить її безпечною для довільного коду.

### S2. Content Security Policy (CSP) (розділ 22)

- **Проблема:** підхід Blob-Worker (`blob:` URL, worker-src) може бути заблокований суворим CSP сайту. Не приховуємо це.
- **План:**
  - Документувати вимоги CSP (`worker-src blob:` / `script-src`).
  - Закласти (без реалізації в MVP) режим статичного воркера: `createRuntime({ workerUrl })` або `backend(...)`, щоб застосунки зі строгим CSP мали шлях.
  - Не в'язати кожен компонент жорстко до Blob-воркерів.

### S3. Ресурсні ризики (DoS/leak)

- **Проблема:** неконтрольоване створення воркерів, витік `objectURL`, таймерів, лісенерів.
- **План:** `maxWorkers` як тверда межа; детермінований cleanup у shutdown; revoke URL; зняття таймерів/лісенерів; тести на відсутність витоків.

---

## Тестування (розділ 25)

Vitest, покрити мінімум:
- одиночне виконання, кілька аргументів, async-таска, повернення об'єкта;
- кинуті помилки; багато одночасних джобів; переюз воркера;
- динамічне створення воркерів; enforcement `maxWorkers`; термінація idle; enforcement `minWorkers`;
- `map()` та **впорядкованість** результатів;
- скасування у черзі / під час виконання; timeout;
- crash recovery; shutdown; виклик таски після shutdown.

Там, де потрібна реальна поведінка Worker — **browser test environment**, а не лише фейкові воркери.

---

## Документація (розділ 26) — README.md

- Installation (`npm install`), базовий приклад, паралельний приклад (`map`).
- Конфіг рантайму, скасування, таймаути, transferables (якщо є), статистика, shutdown.
- **Обмеження:** closures, structured clone, CSP, worker startup overhead, підтримка браузерів.
- Пояснити, **коли** Web Workers корисні, а коли ні (не обіцяти прискорення довільного async-коду; головна вигода — зняти CPU-важку роботу з main-потоку та паралелізм).

---

## Демосторінка (`demo/`)

- Окремий Vite + React застосунок, стан через `tardigrade-store` (як в інших проєктах).
- Сценарій: Collatz / інша CPU-важка задача, `task()` + `map()`, живий вивід `runtime.stats()`, кнопки cancel/timeout/shutdown, індикатор кількості воркерів.
- Демо **не** входить у публічний бандл ліби.

---

## Білд (розділ 27) та npm-скрипти

- Vite library mode → сучасний ESM, tree-shakeable, `.d.ts`.
- Імпорт пакета **не** спавнить воркери; воркери з'являються лише коли Runtime їх потребує (або `minWorkers` для прогріву).
- Скрипти: `build`, `test`, `typecheck`, `lint`, (`dev` для демо).

---

## Порядок виконання (підсумок)

1. **API** (Фаза 1) → 2. **Протокол** (Фаза 2) → 3. Серіалізація + worker source (Фаза 3) → 4. **Таски + Scheduler + Pool** (Фаза 4) → 5. map/timeout/abort (Фаза 5) → 6. надійність/stats/shutdown (Фаза 6) → 7. точки розширення (не реалізуємо) → тести → README → демо → білд.

Наскрізь: не реалізовувати спекулятивні фічі до того, як працює core execution pipeline.

---

## Прийняті рішення (зафіксовано)

1. **map** — tuple-aware типізація одразу: `MapInput<A> = A extends [infer S] ? S[] : A[]`. Одноаргументна таска приймає `S[]`, мультиаргументна — масив кортежів.
2. **AbortError** — власний клас `AbortError extends RuntimeError` з `cause`, куди кладемо нативний `DOMException`/`signal.reason`.
3. **Browser test provider** — Vitest browser mode з **Playwright** (chromium).
4. **graceful shutdown** — реалізуємо **обидва** режими одразу; `immediate` за замовчуванням, `graceful: true` чекає активні джоби.
5. **Transferables** — включаємо в MVP (лише явний `transfer`-список; авто-детект — пізніше).

---

## Аудит багів та оптимізацій (раунд 1) — ✅ виконано

Повний прохід по `src/`. Нижче — що знайдено і як виправлено (з тестами).

### P1 — Коректність
- **#1 Пошкодження реєстру тасок при збої `REGISTER_TASK`.** `registeredTasks.add()` тепер викликається лише *після* успішного `postMessage`, тож несеріалізовний `context` більше не «отруює» воркер (далі не було б `Task not registered`). _(`WorkerInstance.execute`)_
- **#2 Осиротілий job + сирий DOMException при збої `new Worker` (CSP).** `Scheduler.dispatch` обгортає `spawn()` у `try/catch`, реджектить job дружнім `WorkerSpawnError` (натяк на CSP/`workerUrl`) і не лишає job у черзі. `WorkerPool.spawn` конвертує будь-який збій конструктора у `WorkerSpawnError`. _(новий клас `errors/WorkerSpawnError`)_
- **#3 Хибне маркування будь-якого винятку як `DataCloneError`.** `toExecuteError` відрізняє реальні clone-помилки від решти (напр. `RuntimeError "Unknown task"` прокидається як є).
- **#4 Валідація опцій.** `resolveOptions` нормалізує: `maxWorkers ≥ 1`, `minWorkers ∈ [0, maxWorkers]`, `idleTimeout/taskTimeout/maxQueue ≥ 0`, відсікання `NaN`/дробів/від'ємних.

### P2 — Надійність
- **#9 Чесні метрики.** `recordTiming` рахує wait/exec лише для джобів, що реально стартували (`startedAt` визначено). Скасовані/черги-таймаут/queue-full більше не викривляють `averageExecutionTime`.
- **#6 Backpressure `maxQueue`.** Нова опція `RuntimeOptions.maxQueue` (0 = без ліміту). При переповненні — `QueueFullError`. `Scheduler.submit` повертає `boolean`. _(новий клас `errors/QueueFullError`)_
- **#7 Таймаут graceful shutdown.** `shutdown({ graceful: true, timeout })` — після дедлайну примусово реджектить активні джоби й термінує воркери.
- **#5 Евікція тасок.** `task.dispose()` прибирає таску з рантайму й розсилає `UNREGISTER_TASK` усім воркерам (звільняє `registry`/`contexts`). Виклик після dispose → `RuntimeError`. _(новий `UNREGISTER_TASK` у протоколі)_

### P3 — Оптимізації
- **#10/#13 O(1) пул.** `WorkerPool` тримає окремі `idle`/`busy` Set'и та `Map<jobId, worker>`; `idleCount`/`busyCount`/`findIdle`/`findByJob` більше не сканують увесь пул. `handleSettled` повертає воркер у idle *до* `dispatch`.
- **#11 O(1) черга.** `JobQueue` на head-індексі з рідкою компактизацією замість `Array.shift()`.
- **#12 Спільний Blob URL.** `WorkerFactory` використовує один `blob:` на всі рантайми з лічильником посилань (revoke лише коли звільнено останній).

### Тести
- Юніти: реєстрація після clone-краху, не-clone помилки, spawn-throw без сиріт, clamp опцій, `maxQueue`, broadcast `UNREGISTER_TASK`, «no timing for never-started».
- Browser (Playwright/Chromium): CSP-симуляція (`globalThis.Worker` кидає) → `WorkerSpawnError`; crash під навантаженням (24 ок + 6 крашів, рантайм живий); `maxQueue`; graceful timeout; `task.dispose()`.

Разом: **42 юніт + 20 browser** — зелені; typecheck/lint/build — чисті.

## Аудит — раунд 2 (поліш надійності) — ✅ виконано

- **#1 `rejectRunning` термінує одразу.** При immediate shutdown / graceful-timeout воркер із відхиленим джобом термінується й видаляється з пула негайно (а не чекає на `dispose()`), що закриває вікно пізнього `TASK_RESULT` після reject. _(`WorkerPool.rejectRunning`)_
- **#2 Захист worker-джерела.** `self.onmessage` ігнорує некоректні/чужі повідомлення (`!msg || typeof msg.type !== "string"`) — forward-compat і стійкість до сторонніх `postMessage`.
- **#3 Документований `shutdown()` + ескалація.** Перший виклик визначає режим; пізніший **immediate** (`shutdown()` / `{ graceful: false }`) **ескалює** активний graceful — примусово реджектить running-джоби замість нескінченного очікування. Поведінка задокументована в JSDoc.

Тести: Scheduler-тест на термінацію+видалення воркера при `rejectRunning`; browser-тест ескалації graceful→immediate для блокуючого джоба. Разом: **43 юніт + 21 browser** — зелені.

## Аудит — раунд 3 (бекенд / transferables / retry) — ✅ виконано

- **`workerUrl` бекенд (Phase 7).** Нова опція `RuntimeOptions.workerUrl` — замість `blob:` використовує статично захостаний файл воркера (escape hatch для суворого CSP). Експортовано `workerSourceCode` — вміст, який треба захостити. `WorkerFactory` підтримує обидва бекенди (blob із refcount / зовнішній URL без revoke). _(`WorkerFactory`, `index.ts`)_
- **Авто-детект transferables (opt-in).** `RuntimeOptions.autoTransfer` + per-call `RunOptions.autoTransfer`. Рекурсивний детектор (`utils/transferables.ts`) знаходить `ArrayBuffer`, буфери typed-array/`DataView`, `MessagePort`/`ImageBitmap`/`OffscreenCanvas`/streams; обережний (не залазить у class-інстанси, пропускає `SharedArrayBuffer`). Зливається з явним `transfer`. Переміщення **detach-ить** буфер на main-потоці (zero-copy).
- **Per-job retry.** `RuntimeOptions.retries` + per-call `RunOptions.retries`. Повтор **лише** на інфраструктурних помилках (`WorkerCrashedError`, `WorkerSpawnError`); таск-помилки/таймаут/abort/queue-full **ніколи** не повторюються. `submitJob` переписано на оркестратор: один дедлайн таймауту та один `AbortSignal` на всі спроби; проміжні невдалі спроби не інкрементять `failedJobs`. _(`Runtime.submitJob`/`resolveTransfer`)_

Тести: юніт на детектор transferables (6); browser — `workerUrl` бекенд, auto-transfer (detach) + off-кейс, retry успіх (транзієнтний spawn-fail через підміну `globalThis.Worker` + return з конструктора), вичерпання retry, «таск-помилки не повторюються». Разом: **49 юніт + 27 browser** — зелені; build чистий (23.69 kB / gzip 7.32 kB).

### Ще відкрито (майбутні раунди)
- **Раунд 4 (частково зроблено):** розширення передачі кложурів.
  - ✅ **`inject`** — функції-хелпери: `runtime.task(fn, { inject: { astar, heuristic } })` (і разом із `context`). Серіалізуються через `fn.toString()` і відтворюються у scope воркера `new Function`-обгорткою перед таскою, тож таска кличе їх за іменем; хелпери можуть викликати одне одного. Валідація імен (JS-ідентифікатор) і типу (функція) — синхронний `RuntimeError`. Типи: 3-тє перевантаження `task()` + `InjectOptions`/`InjectMap`, експортовані з `index.ts`. Тести: 3 юніт (валідація) + 4 browser (виклик хелпера, взаємні виклики, inject+context, осмислений ReferenceError). Разом: **55 юніт + 31 browser** — зелені; build чистий.
    - ✅ Докі + приклади оновлено під `inject`: README (статус, приклад «Sharing helper functions via `inject`», розділ обмежень), сторінка `docs` (рядок API `task(fn, { inject })`, `TaskOptions.inject`/`InjectOptions` + пояснення), `tutorial` (крок 2), нова runnable-картка **18. Injected helper functions** у каталозі прикладів.
  - ⬜ module-backend для імпортів, build-плагін для «прозорих» кложурів.
- **Раунд 5 (частково зроблено):**
  - ✅ README + сторінки прикладів (docs/tutorial) оновлено під усі можливості раундів 1–3: `maxQueue`, `retries`, `autoTransfer`, `workerUrl`/`workerSourceCode`, `task.dispose()`, `shutdown({ timeout })`, ескалація, валідація опцій, нові помилки. Додано 5 нових runnable-карток (13–17) на сторінці прикладів.
  - ✅ **Інтерактивна Demo-сторінка** (`/demo.html`): боти-пакмани шукають цукор, A* кожного бота рахується паралельно у воркерах через AhWork, рендер на Canvas 2D (static-maze в offscreen-канвас), статус-рядок із FPS/workers/avg plan. Нова візуальна картка (`createVisualCard`) у тому ж стилі (опис + код + Run → canvas). Сітка передається у воркери раз через `context`. Додано `examples/tsconfig.json` для type-check прикладів.
  - ✅ **Аудит документації** (README / tutorial / docs / home): виправлено фактичні розсинхрони — суперечливий блок «Status» (`inject` значився одночасно зробленим і незробленим), «Four pages» замість п'яти (бракувало Demo в таблиці, списку URL і в описі `npm run examples`), відсутнє 3-тє перевантаження `task()` в інтерфейсі `Runtime` на сторінці API, `Record<string, Function>` замість реального `InjectMap`, відсутні `InjectOptions`/`InjectMap` у блоці Exports, відсутнє посилання на Demo в CTA головної та в кінці туторіалу. Тон зроблено теплішим: README отримав вступ «проблема → що робиш натомість» і rule-of-thumb, «Limitations» — пояснювальний інтро-абзац, API-сторінка — дружній lead із посиланням на туторіал, туторіал — новий практичний розділ **«Common first-time mistakes»** (closure, structured clone, «один джоб не швидший», забутий `shutdown()`, detach буфера).
  - ✅ **Сайт прикладів переписано на React.** Увесь `examples/` тепер один React-застосунок замість ручного DOM: `Layout` (навігація + оболонка), `CodeBlock`, `RunnableCard` (стан виводу/running), `VisualCard` (Run/Stop, запуск canvas-демо з `useEffect`, щоб stage уже був у DOM і мав реальну ширину; cleanup зупиняє демо й на unmount). Сторінки `Home`/`Examples`/`Demo`/`Tutorial`/`Docs` — `.tsx`. Збережено **MPA**: 5 HTML-входів → `src/entries/*.tsx`, тож URL і навігація не змінились. Стилі винесено з інжекту рядком у справжній `src/styles.css`; підсвітка — `src/highlight.ts`; типи прикладів — `src/types.ts`; імперативна логіка ботів — `src/demos/botDemo.ts` (не React, бо це canvas + rAF). React/`@vitejs/plugin-react` v4 (сумісний з Vite 5) — **лише devDependencies**, сама ліба лишається zero-dep. Видалено `common.ts`, `runnable.ts` і старі `pages/*.ts`. Також виправлено ігнори ESLint (`**/dist/**`, `**/node_modules/**`) — раніше лінтер чіпав зібраний бандл у `examples/dist`.
  - ✅ **Demo-сторінку перетворено на чесний бенчмарк.** Додано живий перемикач **main thread / worker pool** і пресети навантаження (60 / 200 / 450 ботів). Перемикач не перезапускає демо (`VisualExample` тепер має `controls` + `mount()` повертає `VisualHandle { stop, apply }`), тож це справжній A/B на тому самому лабіринті. Ключова метрика в статус-рядку — **main-thread planning (ms/s)**: скільки мілісекунд із кожної секунди головний потік реально витрачає на планування. Заміряно в headless Chromium (8 потоків): 60 ботів — 60 FPS / 17 vs 113 ms/s; 200 — 60 FPS / 21 vs 56 FPS / 367 ms/s; 450 — 60 FPS / 14 vs **29 FPS / 769 ms/s**. У main-режимі діє стеля 40 ms/кадр на планування (інакше сторінка перестає реагувати), а пропущені плани показані окремим лічильником — це чесна ціна «дропнути кадри / дропнути плани / винести роботу».
    - **Навантаження зроблено реальним, а не накрученим.** Заміряно бенчмарком: вартість A* упирається не в пошук, а в O(n) ініціалізацію типізованих масивів (~0.18 ms на 99×61 незалежно від щільності цілей). Тому одиниця роботи — **маршрут із 4 цукерок за один виклик** (~0.85 ms), а не один хоп: менше, але «товстіших» джобів, бо кожен джоб платить за круговку повідомлень.
    - **Виправлено масове викидання маршрутів.** План тепер анкерується на **2 клітинки вперед** по вже обраному маршруту (~300 ms запасу) і результат **чекає**, поки бот туди дійде, а не відкидається при розбіжності. До фіксу в режимі пулу викидалось ~2/3 маршрутів (`skipped` 505–632/s), після — **0/s** на всіх пресетах.
    - **Підпис метрики виправлено на правдивий:** `averageExecutionTime` у рантаймі міряється на головному потоці від диспатчу до відповіді, тобто це **латентність круговки** (дві структурні копії + очікування черги повідомлень), а не CPU воркера. У пулі показується як `round trip` (~5 ms), у main-режимі — `route cost` (~0.85 ms CPU).
  - ✅ **Знайдено й задокументовано пастку: `inject` + мініфікація.** Тіло таски їде текстом, тому бандлер перейменовує виклик усередині неї (`astar(...)` → `xt(...)`), а ключ в `inject` лишається `"astar"` — у проді воркер падає з `ReferenceError`, у dev усе працює. Перевірено на реальному бандлі `examples/dist`. Безпечні патерни: писати хелпер **інлайном** в об'єкті `inject` (тоді в тілі таски це вільний ідентифікатор, який мініфікатор не чіпає; для TS — `declare const`), або вкласти хелпер **усередину** таски. Demo переведено на другий варіант. Додано попередження в README (біля прикладу `inject` і в «Limitations»), на сторінку API та в туторіал. Радикальне рішення — build-плагін із розділу B нижче.
  - ✅ **Виправлено в самій лібі (`serializeInject`), а не лише в доках.** Дві лінії захисту, щоб тихого падіння в проді не існувало взагалі: **(1)** кожен хелпер публікується ще й під власним `fn.name` — мініфікатор перейменовує його синхронно з місцем виклику, тож таска знаходить хелпер попри розбіжність із ключем; **(2)** хелпер, якого **не згадує** ні таска, ні інший хелпер (за жодним зі своїх імен), відхиляється синхронним `RuntimeError` прямо в `task(...)`. Друга перевірка коректна за побудовою: інжектовані хелпери існують як `var` у згенерованій функції воркера, тому літеральна згадка імені — єдиний спосіб до них дістатись, і незгаданий хелпер доказово недосяжний. Залишковий випадок (`keepNames: true`, коли `fn.name` зберігається, а виклик перейменовано) тепер теж ловиться — голосно й на етапі реєстрації. Тести: 4 юніт (відхилення недосяжного хелпера, аліас за `fn.name`, відхилення коли не збігаються обидва імені, оновлений «accepts valid»). Разом: **55 юніт + 31 browser** — зелені.
  - ✅ **Раунд 6: бекенд Node `worker_threads`** — див. окремий розділ нижче.
  - ⬜ авто-емісія `dist/ahwork.worker.js`; доля заготовки `demo/` (порожній React-скелет, дублює Demo-сторінку сайту — кандидат на видалення).

---

## Раунд 6 (✅ ЗРОБЛЕНО): бекенд Node `worker_threads`

> Мета: той самий публічний API працює і в браузері, і в Node. Ядро (шедулер,
> пул, автоскейлінг, retry, backpressure, таймаути, статистика, shutdown) не
> змінюється взагалі — це робота з адаптером і пакуванням, а не переписування.
>
> **Прогноз справдився:** жодного рядка шедулера, пулу чи черги не чіпали.
> Уся зміна — новий шов `WorkerLike`/`WorkerBackend`, адаптер на 90 рядків,
> Node-вхід і пакування. Node-набір виконання (17 тестів) пройшов **з першого
> запуску**, без жодної правки спільного коду, — це і є доказ, що ядро справді
> було платформонезалежне.

### Що саме прив'язане до браузера (повний список — їх рівно три)

1. **`WorkerFactory`** — `new Blob(...)` + `URL.createObjectURL` + глобальний `Worker`. У Node `worker_threads` не вміє вантажити `blob:`; натомість є простіший еквівалент — `new Worker(workerSource, { eval: true })`, який бере код напряму.
2. **`ManagedWorker`** — підписка через DOM-властивості `onmessage` / `onerror` / `onmessageerror` і DOM-тип `Worker`. У Node `Worker` — це EventEmitter (`.on("message" | "error" | "exit")`).
3. **`workerSource`** — усередині воркера `self.onmessage` / `self.postMessage`. У Node `self` не існує, там `parentPort`.

### Що вже портабельне (перевірено читанням коду)

- **Протокол** — звичайні об'єкти з дискримінованим union, нуль платформи.
- **Структурне клонування** — Node `worker_threads` використовує той самий алгоритм, тож усі правила для `context`/аргументів/результатів ідентичні.
- **Transferables** — `postMessage(value, transferList)` має ту саму сигнатуру; детектор у `utils/transferables.ts` уже ховає **кожен** платформозалежний конструктор за `typeof` (`MessagePort`, `ImageBitmap`, `OffscreenCanvas`, стріми), а `ArrayBuffer`/`ArrayBuffer.isView` універсальні.
- **`utils/timing.ts`** — `performance.now()` із фолбеком на `Date.now()`; у Node глобальний із v16.
- **`isDataCloneError`** — перевірка `DOMException` уже за `typeof`, друга гілка ловить звичайний `Error` з `name === "DataCloneError"`, який і кидає Node.
- **`navigator.hardwareConcurrency`** — уже за `typeof`; у Node 21+ існує, у старіших буде фолбек `4` (опційно замінити на `os.cpus().length`).

### Файли (фактично зроблене)

| Файл | Що зроблено |
| --- | --- |
| `src/workers/WorkerBackend.ts` | **новий** — `WorkerLike` (те, що реально використовує `ManagedWorker`) + `WorkerBackend` (`create()` / `dispose()`). Назва відрізняється від плану: інтерфейс бекенда логічно живе поруч із інтерфейсом воркера |
| `src/workers/NodeWorkerFactory.ts` | **новий** — `NodeWorkerAdapter` (EventEmitter → властивості) + `NodeWorkerFactory`. `.on("exit")` як додаткова детекція падіння; прапорець `settled`, щоб `error` + `exit` не відрапортували крах двічі |
| `src/index.node.ts` | **новий** — Node-вхід; підставляє Node-бекенд і резолвить `"auto"` через `os.availableParallelism()` |
| `src/api.ts` | **новий** — спільні типи/помилки/`workerSourceCode`, які реекспортують обидва входи |
| `src/workers/WorkerFactory.ts` | `implements WorkerBackend`, повертає `WorkerLike` |
| `src/workers/WorkerInstance.ts` | тип поля `worker` → `WorkerLike`; плюс `ref`/`unref` навколо джоба (див. нижче) |
| `src/workers/WorkerPool.ts` | тип фабрики → `WorkerBackend`; таймер простою `unref`-иться |
| `src/scheduler/Scheduler.ts` | тип фабрики → `WorkerBackend` |
| `src/runtime/Runtime.ts` | другий (необов'язковий) аргумент конструктора — бекенд; за замовчуванням браузерний |
| `src/workers/workerSource.ts` | `nodeWorkerPrelude` — трирядковий шим зі спайка; саме **джерело воркера не змінене жодним символом** |
| `src/utils/timing.ts` | `unrefTimer()` — no-op у браузері, `.unref()` у Node |
| `src/types.ts` | `TransferableValue` замість DOM-типу `Transferable` у публічній поверхні (див. нижче) |
| `package.json` | умовні експорти `"node"` / `"browser"` / `"default"` + явні підшляхи `ahwork/node`, `ahwork/browser`; скрипт `test:node`; `@types/node` у devDeps (раніше тягнувся транзитивно) |
| `vite.config.ts` | два входи (`ahwork`, `ahwork.node`), `external: [/^node:/]` |
| `tsconfig.json` | `"types": ["node"]` |
| `vitest.node.config.ts` | **новий** — `environment: "node"`, `fileParallelism: false` |
| `test/node/execution.test.ts` | **новий** — 17 тестів виконання на справжніх `worker_threads` |
| README + сторінка API | розділ «Backends» і матриця підтримки в обох

### ✅ Спайк проведено (Node v22.17.0) — усі невідомі зняті

Справжній `workerSource` із `src/` запущено в `worker_threads` через реальний
протокол. **Джерело воркера не змінюється взагалі** — достатньо трирядкового
шима попереду, тож окремий `workerSourceNode.ts` **не потрібен**:

```js
if (typeof self === "undefined") {
  globalThis.self = require("node:worker_threads").parentPort;
}
```

Шим свідомо **не оголошує `var self`**: таке оголошення зробило б `typeof self`
у власному ініціалізаторі `undefined` і в браузері теж.

Перевірено й пройдено (12/12): спавн через `{ eval: true }`; `self.onmessage`
**працює** на `parentPort` і стартує порт автоматично; `require()` усередині
доступний (код справді обгортається як CJS); round trip; `context` останнім
аргументом; `inject` через `new Function`; помилка зберігає `name`/`message`/
`stack`; async-таска; `postMessage(value, transferList)` із тією ж сигнатурою
і **реальним detach** буфера; неклоноване значення кидає саме `DataCloneError`
(тобто наш `isDataCloneError` працює як є); `UNREGISTER_TASK`; невідомий тип
повідомлення ігнорується; `terminate()` резолвиться і процес виходить чисто.

Глобали в Node 22: `navigator.hardwareConcurrency` = 8 (тобто автоскейлінг
працює без правок), `performance.now`, `MessagePort`, `ReadableStream`/
`WritableStream`/`TransformStream`, `DOMException`, `Blob` — усі є.
`ImageBitmap`/`OffscreenCanvas`/`Worker` відсутні, але перші два вже за
`typeof`-гардами, а третій і є те, що підміняє бекенд.

### Як закрились передбачені ризики

- **Конфлікт типів DOM + Node** (найбільший ризик пакування) — **не справдився**:
  `"types": ["node"]` поряд із `lib: ["ES2022", "DOM", "DOM.Iterable"]` дає нуль
  конфліктів глобалів. Єдина реальна колізія — `Transferable` проти
  `TransferListItem` у `postMessage`; розв'язано виведенням типу з самого
  методу (`Parameters<NodeWorker["postMessage"]>[1]`), а не імпортом за іменем,
  бо `@types/node` цю назву переносив між мажорами.
- **Умовні експорти** — зібрано два входи, спільне ядро виїхало в окремий чанк.
  Перевірено: браузерний бандл **не містить** `import "node:worker_threads"`
  (єдина згадка `node:` — всередині рядка-прелюда, тобто дані, не імпорт), а
  Node-бандл містить рівно один такий імпорт. Smoke-тест зроблено **на
  справжньому пакеті**: `npm pack` → встановлення тарболу в чистий проєкт →
  `import { createRuntime } from "ahwork"` резолвиться в Node-білд, підшляхи
  `ahwork/node` і `ahwork/browser` працюють, і браузерний білд коректно **не
  має** `nodeWorkerPrelude`.
- **Типи теж перевірено на справжньому пакеті, і там знайшовся реальний баг.**
  `.d.ts` посилались на DOM-тип `Transferable`, тож чистий Node-споживач
  (`lib: ["es2022"]`, без `dom`) не компілювався: `Cannot find name
  'Transferable'`. Замінено на власний `TransferableValue` (публічний тип) —
  портабельної спільної унії просто не існує: DOM має `Transferable`, Node має
  `TransferListItem`, перетин — `ArrayBuffer` і `MessagePort`. Тепер
  компілюються обидві конфігурації споживача: `module: node16` без `dom` і
  `moduleResolution: bundler` з `dom`.
- **Примітка про `moduleResolution: bundler`:** TS у цьому режимі не застосовує
  умову `node`, тому бере `default`, тобто браузерні типи. Для рантайму це
  нешкідливо (публічна поверхня ідентична, окрім `nodeWorkerPrelude`), а кому
  треба точно — є явний підшлях `ahwork/node`.
- **`Blob` існує в Node**, тож авто-детект бекенда за рантайм-перевіркою був би
  хибним — бекенд обирають **експорти**, рантайм нічого не вгадує.

### Що знайшли вже під час реалізації (у плані цього не було)

- **`unref()` назавжди — це був би мовчазний баг.** Перша версія адаптера
  тримала воркер `unref`-нутим постійно, щоб теплий пул не блокував вихід
  процесу. Наслідок: у звичайному скрипті `await task()` міг **ніколи не
  зарезолвитись** — якщо більше ніщо не тримає event loop, Node вийшов би
  раніше за відповідь воркера. Виправлено динамічним ref/unref: `ManagedWorker`
  робить `ref()` при видачі джоба і `unref()` при `settle`/краху, таймер
  простою теж `unref`-нутий. Тепер правильні обидві властивості одразу —
  `await` не програє гонку виходу, і забутий `shutdown()` не підвішує процес.
  Перевірено smoke-скриптом: 4 теплих воркери + таймер простою на 60 с, без
  `shutdown()` — процес вийшов сам за 261 ms із коректним результатом.
  `ref`/`unref` у `WorkerLike` — **опційні**: у браузера такого поняття немає.
- **`"auto"` на сервері має інше правильне значення.** `navigator.hardware
  Concurrency` з'явився лише в Node 21 і **ігнорує cgroup-ліміти**: у контейнері
  з 2 CPU він покаже 64 ядра хоста. Node-вхід резолвить `"auto"` через
  `os.availableParallelism()`, який ліміти враховує.
- **Node дає те, чого браузер не може:** воркер, що помер **без винятку** (OOM,
  чужий `process.exit()`), емітить `exit` — джоб падає з `WorkerCrashedError`
  замість вічного зависання. Є окремий тест.

### Побічна вигода (справдилась)

Найбільший виграш тут навіть не Node як платформа, а **тести**: раніше весь набір виконання вимагав браузера через Playwright. Тепер та сама логіка ганяється у звичайному `vitest` без браузера — швидше й придатніше для CI. Підсумок: **55 юніт + 17 node + 31 browser = 103 зелені**.

---

# Раунди 7–9

> Обґрунтування початкового порядку: раунд 7 — єдине місце, де ми **позаду**
> конкурентів, і водночас найцінніше для ігрової ніші; раунд 8 дешевий і
> доповнює 7 до повної історії «що робити під перевантаженням»; раунд 9 великий
> і потребує дизайн-рішення **до** коду.
>
> **Фактично спершу зробили раунд 8** — свідомо: він не змінює інваріантів і
> жодного наявного тесту, тож це був дешевий спосіб закрити відставання за
> фічами, не чіпаючи автомат станів. Раунд 7 лишається наступним.

## Раунд 7 (ПЛАН): кооперативне скасування

### Що зараз і скільки це коштує

`Scheduler.cancelJob` на **запущеному** джобі робить `pool.remove(worker)` +
`worker.terminate()`. Тобто **скасування = вбивство воркера**. Справжня ціна не
в запуску нового потоку, а в тому, що разом із воркером помирають його
`registeredTasks` і **весь закешований `context`**: наступний джоб мусить
заново прийняти джерело таски й заново склонувати контекст. У демці з ботами,
де контекст — це вся карта, один `abort` коштує повторного клонування карти.

### Чому не можна просто надіслати «скасуй»

Воркер однопотоковий. Якщо таска — щільний `while`, вона не віддає керування,
`postMessage` лежить у черзі повідомлень і **не буде прочитаний ніколи**. Саме
тому термінація й стала MVP: це єдине, що працює проти незговірливого циклу.

Але: `self.onmessage` у нас `async` і робить `await task.apply(...)`. Поки таска
чекає на будь-який `await`, воркер **повертається в цикл подій і обробляє вхідні
повідомлення**. Тобто для **асинхронних** тасок скасування повідомленням працює
вже зараз, без жодної спільної пам'яті.

### Конструкція: триступенева ескалація

1. **Прапорець у `SharedArrayBuffer`.** Головний потік пише `1` в `Int32Array`,
   таска читає `Atomics.load` усередині свого циклу. Єдиний спосіб достукатись
   до синхронного коду. `Atomics.wait` не потрібен — звичайне читання дешеве.
2. **Повідомлення `CANCEL`.** Для асинхронних тасок цього досить, і воно нічого
   не вимагає від середовища.
3. **Термінація.** Якщо за `cancelGrace` (умовно 50–100 мс) джоб не завершився
   сам — робимо те, що робимо сьогодні.

Ключова властивість: схема **не може стати регресією** — найгірший випадок
дорівнює поточній поведінці. У `workerpool` це влаштовано так само
(`abortListenerTimeout: 1000`), тобто конструкція перевірена ринком.

### Де справжні ускладнення

- **Cross-origin isolation.** `SharedArrayBuffer` у браузері доступний лише за
  `COOP: same-origin` + `COEP: require-corp`. Багато сайтів цього не мають і не
  можуть мати. Тож ступінь 1 — **опційний**, із детекцією `crossOriginIsolated`,
  а не вимога. На Node обмежень немає, тому **Node-тести стають основним
  полігоном** для цієї фічі.
- **Як таска бачить сигнал** — головне API-рішення. Наша сигнатура `(...args, ctx)`
  має строге правило «контекст останній»; третій слот його ламає і дає дивну
  арність у тасок без контексту. Пропозиція: за аналогією з `inject` воркер
  оголошує в згенерованій області вільний ідентифікатор, таска пише
  `if (ahSignal.aborted) return;`, TS-користувач — `declare const ahSignal`.
  Це вже знайомий із цієї ж ліби патерн, а не новий механізм.
- **Бухгалтерія.** Сьогодні `cancelJob` виносить воркер із пулу повністю. У
  кооперативному шляху воркер **лишається живим**: треба повернути його в `idle`,
  не зламати `busyCount` і `whenRunningDone()` (від нього залежить graceful
  shutdown) і вирішити, чи рахується скасований джоб у `failedJobs`.
- **Протокол.** `CANCEL` у `MainToWorker` + відповідь, що відрізняє «я зупинився
  сам» від звичайної помилки. Воркер мусить **ігнорувати запізнілий `CANCEL`**
  для вже завершеного `jobId`.
- **Брудний стан.** Перервана на півдорозі таска могла змінити стан рівня
  воркера. Приймаємо (таски й так мають бути чистими), але документуємо явно.

### Перший крок — вимірювання, а не код

Заміряти, **скільки реально коштує термінація воркера з прогрітим контекстом**
(спавн + ре-реєстрація таски + повторне клонування контексту). Без цього числа
ми не знатимемо, наскільки виграли, і повторимо помилку «заявлено, а не
заміряно», яку вже один раз виправляли в раунді 5.

### Чому це найцінніше для нашої ніші

«Дешево викинути застарілу роботу» — це і є ігровий сценарій. У демці ми зараз
**не** скасовуємо застарілі плани саме тому, що це дорого, і замість цього
стоїть якір на 2 клітинки вперед плюс очікування. З дешевим скасуванням та
проблема розв'язується прямо, а не обхідним маневром.

---

## Раунд 8 (✅ ЗРОБЛЕНО): пріоритети джобів

### Шов уже є

`JobQueue` написаний під це з самого початку (там стоїть коментар «kept
deliberately small so it can later be swapped for a priority queue without
touching the scheduler»). Шедулер торкається черги рівно в чотирьох місцях —
`enqueue`, `dequeue`, `remove`, `drain` — тож заміна реалізації нікуди далі не
протікає. **Структура даних тут — найлегша частина.**

### Відра, а не купа

Класична відповідь — бінарна купа, O(log n). Для нас кращі **кілька FIFO-черг за
рівнями** (`Map<level, JobQueue>`): лишається O(1) і, що важливіше, **всередині
рівня зберігається FIFO**. Купа цього не гарантує і дає непередбачуваний порядок
серед рівних — для `task.map()`, який кидає сотню однакових джобів, це помітно
гірше.

### Справжнє рішення — голодування, а не структура

Строгий пріоритет означає, що під постійним навантаженням низькопріоритетні
джоби **не виконаються ніколи**. Два варіанти:

- **Старіння** — пріоритет росте з часом очікування. Чесно, але потребує таймера
  або перерахунку на кожному `dequeue`.
- **Квота** — кожен N-ий диспатч ігнорує пріоритет і бере **найстаріший** джоб.
  Тупіше, але O(1), передбачуване й тривіально тестується.

Узято **квоту**: проста й пояснювана поведінка тут цінніша за елегантну.

### ✅ Реалізовано

Три рішення, ухвалені перед кодом: пріоритет — **число, більше = раніше,
типово 0**; захист від голодування — **квота, увімкнена за замовчуванням**;
повна черга — **опція `onQueueFull`, типово поточна поведінка**.

| Файл | Що зроблено |
| --- | --- |
| `src/scheduler/PriorityQueue.ts` | **новий** — `Map<level, JobQueue>` + відсортований список активних рівнів + квота справедливості + `evictLowerThan()` |
| `src/scheduler/JobQueue.ts` | **логіка не змінена**; додано `peek()` і `pop()`, яких вимагають квота й витіснення |
| `src/scheduler/Job.ts` | `priority?: number` і `seq?: number` |
| `src/scheduler/Scheduler.ts` | `PriorityQueue` замість `JobQueue`; `submit()` вміє витісняти; опції `fairness`, `onQueueFull` |
| `src/types.ts` | `RunOptions.priority`, `RuntimeOptions.onQueueFull`/`fairness`, публічний тип `QueueFullPolicy` |
| `src/runtime/Runtime.ts` | нормалізація нових опцій; пріоритет переживає ретраї |
| `test/priority.test.ts` | **новий** — 15 юніт-тестів |
| `test/node`, `test/browser` | по 2 наскрізні тести через публічний API |

**Ключова властивість, що зробила раунд безпечним:** при пріоритеті за
замовчуванням існує рівно одне відро, тож структура вироджується в той самий
FIFO. Тому **жоден наявний тест не довелося правити** — на відміну від раунду 7,
де вони гарантовано впадуть.

**Чому `seq`, а не `createdAt`.** Квоті потрібен глобальний порядок надходження.
`createdAt` для цього не годиться: це показник `performance.now()`, тож два
джоби з одного тіку можуть збігтися, а **ретрай зберігає початковий час**.
Тому черга проставляє власний монотонний лічильник.

**Чому витісняється найновіший, а не найстаріший.** Інакше квота справедливості
стала б фікцією: джоб, який вона намагається врятувати, першим би й викидався.

**Чому порівняння строге (`incoming > lowest`).** Інакше потік джобів однакового
пріоритету витісняв би сам себе по колу, і замість backpressure черга б
молотила вхолосту. Джоб, який не перевершує найслабшого в черзі, не має підстав
на його місце — відмовляємо новачку.

### Чесне застереження (винесене в README і на сторінку API)

Пріоритети працюють **лише коли пул насичений і черга непорожня**. При
достатньому `maxWorkers` і коротких джобах черга майже завжди порожня і
пріоритет — no-op. Це фіча не для «швидше», а для «передбачувано під
перевантаженням»; подавати треба саме так, інакше люди вмикатимуть її й не
бачитимуть ефекту. Є окремий тест, який це фіксує («is a no-op when nothing has
to wait»).

---

## Раунд 9 (ПЛАН): окремий файл воркера з реальними імпортами

### Чого насправді немає

Назва `workerUrl` вводить в оману: вона дозволяє **хостити наше ж generic-джерело
воркера**, і тільки. Це обхід для строгого CSP, а не спосіб покласти свій код у
воркер. Обмеження стоїть у повний зріст: **не можна** використати всередині
таски важку бібліотеку, `node:crypto` чи wasm-модуль. У всіх конкурентів це є, і
`inject` цього **не замінює** — він возить ваші ж функції текстом, а не чужі
модулі.

Це **найбільша з трьох і єдина архітектурна**. Складність не в реалізації, а в
тому, що тут три різні дизайни і вибрати треба **до** написання коду.

### Варіант A: модульний воркер з іменованими тасками

```ts
// tasks.ts — звичайний файл, звичайні імпорти
import { createHash } from "node:crypto";
export function sha(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

// головний потік
const tasks = runtime.tasksFrom<typeof import("./tasks")>(
  new URL("./tasks.ts", import.meta.url),
);
await tasks.sha("hello"); // типи виводяться з модуля
```

Модель `workerpool` і `poolifier`; трюк `typeof import(...)` для типів — з
`comlink`, і він працює дуже добре.

- **Плюси:** справжні імпорти, справжній бандлінг, і разом з ними зникають
  **усі** наші родові болячки одразу — ні `toString()`, ні замикань, ні
  мініфікації.
- **Мінус:** втрата інлайн-ергономіки, тобто того єдиного, що ми визначили як
  реальну перевагу (розділ A). Тому це **другий режим поруч**, а не заміна.
  Позиціонування: «інлайн за замовчуванням; модуль — коли треба залежність».

### Варіант C: імпорти як дані, по аналогії з `context`

```ts
const sha = runtime.task((s: string) => hash(s).digest("hex"), {
  imports: { hash: "node:crypto#createHash" },
});
```

Воркер один раз робить `await import(spec)` і кешує результат — **тим самим
механізмом, яким зараз кешується `context`**. Специфікатор їде рядком, тобто
даними, тож мініфікатор його не зачепить **за побудовою** (та сама логіка, що й
у фіксі `inject` з раунду 5).

Напрочуд гарна середина, лягає в наявну архітектуру майже без швів. Слабке
місце: бандлер не бачить динамічний специфікатор, модуль має резолвитись у
рантаймі. На Node безкоштовно, у браузері потрібен справжній URL.

### Варіант B: build-плагін

Розділ B беклогу: плагін статично аналізує `runtime.task(...)` і сам підтягує
імпорти в серіалізоване джерело. Дає інлайн-DX **і** імпорти одночасно — найкраща
відповідь у принципі. Але вимагає етапу збірки, не працює в тестах і REPL без
плагіна, і це окремий пакет на кожен бандлер. **Довга гра, не наступний крок.**

### Що це робить з архітектурою

- **Протокол стає union.** Замість одного `REGISTER_TASK` із текстом джерела
  з'являється другий варіант — реєстрація за URL модуля й іменем експорту.
  `TaskRegistration` теж стає union. Зміна реальна, але локалізована:
  `protocol/messages.ts`, `workerSource`, `ManagedWorker.execute`.
- **Модульний воркер — інший спосіб запуску.** `new Worker(url, { type: "module" })`
  у браузері **не** сумісний із поточним `blob:`-шляхом як є: або два джерела
  воркера, або прапорець у бекенді.
- **Тут окупається раунд 6.** Рішення «модульний чи класичний воркер» — це рівно
  `WorkerBackend.create()`, той самий шов, який уже зроблено. Шедулер, пул,
  черга й автоскейлінг знову не змінюються. На Node це взагалі безкоштовно:
  `new Worker(path)` уже працює, резолвінг модулів дається задарма.

---

## Екосистема, плагіни та позиціонування (ПЛАН — нічого з цього не реалізовано)

> Це свідомо лише план/беклог ідей, а не зобов'язання. Порядок — за співвідношенням
> «цінність / вартість». Нічого з розділу не впливає на поточний код.

### A. Позиціонування (звірено з реальними конкурентами, не з пам'яті)

> ⚠️ Попередня редакція цього розділу містила **три хибні твердження**. Їх
> виправлено нижче. Висновок із цього методологічний: конкурентний аналіз із
> пам'яті — це вигадка, його треба робити по README конкурентів.

**Хто насправді на ринку**

| Проєкт | Платформи | Чим є | Тижневих завантажень |
| --- | --- | --- | --- |
| `piscina` | **тільки Node** | пул від команди Node; resource limits, AbortController, статистика | ~3M |
| `tinypool` | **тільки Node** | мінімальний форк piscina; на ньому працює Vitest | ~8M |
| `workerpool` | браузер + Node | **найближчий конкурент**, див. нижче | ~3M |
| `poolifier-web-worker` | браузер / Deno / Bun | пул із пріоритетами, task stealing, worker affinity | мало |
| `comlink` | браузер | RPC-проксі до **одного** воркера, не пул | багато |
| `comlink-worker-pool` | браузер | новий; типізований пул поверх comlink, bounded queue, пріоритети, graceful shutdown | мало |
| `partytown` | браузер | інша задача (3rd-party скрипти) | — |

**Виправлення #1: `workerpool` — не «без типів».** Він постачає `.d.ts`. Але
`Pool.exec(method, params): Promise<any>` — типів **не виводить**: ні аргументів,
ні результату. Правильне формулювання не «без типів», а «типи є, виведення немає».

**Виправлення #2: у `workerpool` є майже весь наш «список надійності».**
`minWorkers`/`maxWorkers` (автоскейлінг), `maxQueueSize` (backpressure),
`terminate(force, timeout)` (graceful shutdown із дедлайном), статистика,
обробка крахів, таймаути, transferables, хуки `onCreateWorker`/`onTerminateWorker`
і навіть **кооперативне скасування** через `addAbortListener` — те, чого в нас
**немає** (ми вбиваємо воркер). Теза «ні в кого немає цього одночасно» —
неправдива. Єдине з того списку, чого я в нього не знайшов, — автоматичний
**retry** на інфраструктурних збоях.

**Виправлення #3: розмір і zero-deps — не перевага.** `workerpool` теж має
**0 залежностей** і важить **9 kB** min+gzip. У нас **6.8 kB** min+gzip (заміряно
після раунду 8; до нього було 6.2 kB). Трохи менше, але це не той розрив, щоб на
ньому будувати позиціонування. Так само й Node-бекенд (раунд 6): `workerpool`
підтримує Node з коробки давно — це нас **вирівнює**, а не відриває.

> ⚠️ **Як правильно міряти (раніше міряли неправильно).** Vite у lib-режимі
> свідомо **не** мінімізує пробіли й коментарі в ESM-виході: споживач усе одно
> переганяє бібліотеку через свій бандлер. Тому `dist/*.js` важить ~10 kB gzip,
> і саме це число помилково потрапило в документацію як «8.5 kB». Реальне
> число, яке бачить користувач у своєму бандлі, — **6.8 kB gzip**. Міряти треба
> повністю мінімізований бандл, а не вміст `dist`. Наш код навмисно щедрий на
> коментарі, тож різниця між двома числами в нас більша, ніж у середньої ліби.

**Що справді наше (і я цього більше ні в кого не бачив)**

1. **Інлайн-функція з повним виведенням типів.** `const sq = runtime.task((n: number) => n * n)` дає `(n: number) => Promise<number>`. У `workerpool` це `Promise<any>`, у `poolifier` треба окремий файл воркера з класом `ThreadWorker`, у `comlink` типи є, але це проксі до модуля, а не пул інлайн-тасок.
2. **`context` + `inject`.** Усі, хто серіалізує функцію через `toString()`, мають ту саму проблему замикань — і просто пишуть про неї в «Limitations», пропонуючи перейти на окремий файл воркера. Ми єдині, хто дає обхід, **не відмовляючись від інлайн-функцій**: дані кешуються на воркері, хелпери доїжджають тим самим `toString()`.
3. **Захист від мініфікації для `inject`.** Аліас за `fn.name` + відмова реєструвати недосяжний хелпер. Ця проблема взагалі існує лише в того, хто робить п.2, тож конкуренція тут порожня за побудовою.
4. **Автоматичний retry** на `WorkerCrashedError`/`WorkerSpawnError` із гарантією, що помилки таски, таймаути й аборти не ретраяться.

Чесне одне речення: _«A typed task runtime for workers — write a normal
function, get a typed async one. Browser and Node, zero deps, under 7 kB.»_
Наголос на **DX і типах**, а не на списку фіч надійності: за фічами ми врівні
з `workerpool`, за ергономікою — попереду.

**Ніша, яка проявилась із demo: ігри та симуляції.** Бенчмарк на 450 агентах
(60 FPS проти ~30 на головному потоці) — це не абстрактний «CPU-bound», а
конкретний сценарій: багато дрібних незалежних задач на кадр, pathfinding,
AI агентів, процедурна генерація, фізика. Для нього наш профіль підходить
краще за всіх: таска описується інлайн поруч із ігровою логікою, `context`
кешує статичну карту один раз на воркер, а `maxQueue` + відкидання застарілих
планів — це рівно те, що потрібно під кадровий бюджет. Жоден із конкурентів не
позиціонується в ігри. Варто зробити це головним прикладом, а не одним із.

### B. Плагіни збірки (найбільший важіль, закриває головне обмеження)

- **`@ahwork/vite-plugin`** — статично аналізує місця виклику `runtime.task(...)`,
  підтягує referenced-імпорти/хелпери у серіалізоване джерело. Це робить
  «прозорі кложури» реальністю і прибирає обмеження №1 (`fn.toString()`), тобто
  знімає потребу вручну писати `inject`. Це і є раунд-4 build-plugin, але як окремий пакет.
- Той самий плагін авто-емітить `dist/ahwork.worker.js` і сам підставляє `workerUrl`,
  тож строгий CSP починає працювати **без ручних кроків**.
- **`@ahwork/babel-plugin`** / SWC-варіант — те саме для не-Vite збірок (Next.js, CRA, webpack).

### C. Фреймворк-адаптери (найбільша аудиторія)

- **`@ahwork/react`** — `useTask(fn, deps)`, `<AhWorkProvider>` зі спільним рантаймом
  на застосунок, авто-`abort` на unmount, Suspense-сумісний варіант. React — найбільший ринок.
- **`@ahwork/vue`** — composable `useTask`; **`@ahwork/svelte`** — store-обгортка.
- Ключ: адаптер має сам викликати `shutdown()`/`dispose()`, бо це помилка №1 у новачків.

### D. Розширення рантайму

- ✅ ~~**Node-бекенд на `worker_threads`**~~ — зроблено в раунді 6.
- **Кооперативне скасування** — відставання від `workerpool` (`addAbortListener`)
  і `piscina`/`poolifier` (`AbortController`). Винесено в **раунд 7**, розгорнуто вище.
- ✅ ~~**Пріоритети джобів**~~ — зроблено в раунді 8.
- **Окремий файл воркера з реальними `import`-ами** — є в **усіх** конкурентів і
  лишається єдиним способом затягнути важку залежність у воркер. Винесено в
  **раунд 9**, розгорнуто вище.
- **Пріоритети джобів** і чесність черги (зараз FIFO).
- **`task.memo()`** — кеш результатів на боці воркера + дедуплікація однакових
  джобів, що вже в польоті.
- **Стрімінг результатів** (`task.stream()` як async-iterable) для прогресивних задач.
- **WASM-хук ініціалізації** — завантажити wasm-модуль один раз на воркер
  (аналогічно до того, як зараз кешується `context`).

### E. DX і спостережуваність

- **`runtime.on(event)`** — події життєвого циклу (job queued/started/settled, worker spawned/died).
- **`@ahwork/devtools`** — панель із живою візуалізацією пулу: воркери, глибина черги,
  таймлайн джобів, розподіл тривалостей. Дуже добре «продається» скріншотами.

### F. Контент і просування

- **Demo-сторінка — головний гачок.** Боти з A* у воркерах — це готовий вірусний
  матеріал: GIF/відео «12 паралельних A* і стабільні 60 FPS». Винести як
  окремий StackBlitz/CodeSandbox-шаблон.
- **Чесні бенчмарки** проти raw workers / comlink / workerpool — включно з розділом
  «коли воно НЕ допомагає». Чесність тут сильніше продає, ніж графіки.
- **Cookbook рецептів**: обробка зображень, парсинг CSV, хешування, пошуковий індекс,
  diff великих структур.
- **Стартові шаблони**: Vite + AhWork, Next.js приклад.
- **Гігієна репозиторію перед першою публікацією** (зараз відсутнє): файлу
  `LICENSE` немає, хоча `package.json` заявляє MIT; немає CI (`.github/workflows`),
  хоча є три набори тестів, які просяться в матрицю; версія досі `0.0.0`;
  заготовка `demo/` — мертвий код. Це дешево, але без цього пакет виглядає
  покинутим ще до першого релізу.
- **Статті**: «Чому `fn.toString()` ламає замикання і що з цим робити»,
  «Пул воркерів на 300 рядків», «Backpressure у браузері».
- **npm/README**: бейджі розміру бандла і «zero dependencies» — це сильний сигнал.
