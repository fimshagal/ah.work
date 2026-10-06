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
- 🟡 **Розширення передачі кложурів** (раунд 4): ✅ `inject` для чистих функцій-хелперів (серіалізація `toString`, відтворення у scope воркера, валідація імен, взаємні виклики, сумісність з `context`); ⬜ module-backend для імпортів, ⬜ build-плагін для «прозорих» кложурів.

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
  - ⬜ авто-емісія `dist/ahwork.worker.js`; доля заготовки `demo/` (порожній React-скелет, дублює Demo-сторінку сайту — кандидат на видалення).

---

## Екосистема, плагіни та позиціонування (ПЛАН — нічого з цього не реалізовано)

> Це свідомо лише план/беклог ідей, а не зобов'язання. Порядок — за співвідношенням
> «цінність / вартість». Нічого з розділу не впливає на поточний код.

### A. Позиціонування

Конкуренти: `comlink` (RPC-проксі до одного воркера), `workerpool` (пул, але
без типів і без task-first API), `threads.js`, `partytown` (інша задача — 3rd-party скрипти).

Ніша AhWork, яку варто підкреслювати: **task-first API + типи + надійність з коробки**.
Ні в кого з перелічених немає одночасно retry на крахах, backpressure (`maxQueue`),
graceful shutdown з дедлайном і автоскейлінгу пулу. Плюс **нуль залежностей і ~8 kB gzip**.
Одне речення для README/npm: _«A typed task runtime for Web Workers — retries,
backpressure and graceful shutdown included. Zero deps, under 8 kB.»_

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

- **Node-бекенд на `worker_threads`** з тим самим API — відкриває SSR, CLI, build-тули.
  Протокол уже ізольований у `protocol/messages.ts` саме під це.
- **Кооперативне скасування** через `SharedArrayBuffer` + `Atomics` замість термінації
  воркера (зараз MVP вбиває воркер). Справжній диференціатор проти конкурентів.
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
- **Статті**: «Чому `fn.toString()` ламає замикання і що з цим робити»,
  «Пул воркерів на 300 рядків», «Backpressure у браузері».
- **npm/README**: бейджі розміру бандла і «zero dependencies» — це сильний сигнал.
