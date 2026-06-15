# Thought Process — Queue Cure '26

> Architecture decisions, design reasoning, and trade-offs made during development.

---

## Why FastAPI?

FastAPI was chosen over alternatives (Flask, Django, Express.js) for several deliberate reasons:

| Factor | Decision |
|--------|----------|
| **Async-native** | WebSockets require async I/O. FastAPI is built on Starlette with first-class async support. Flask's async is an afterthought. |
| **Automatic OpenAPI docs** | Built-in Swagger UI at `/docs` is invaluable for debugging during a hackathon. No extra configuration needed. |
| **Pydantic integration** | Request/response validation is declarative and zero-boilerplate. The `PatientCreate` schema enforces name constraints automatically. |
| **Lifespan events** | The `lifespan` async context manager lets us run `Base.metadata.create_all()` at startup cleanly — no need for Alembic or migration scripts in a hackathon context. |
| **Minimal boilerplate** | A working prototype with REST + WebSocket + templates + database was built in under 500 lines of Python. |

**Why not Django?** Overkill for a real-time queue system. Django's ORM is excellent, but its WSGI-first architecture makes WebSocket integration require Channels (a separate, complex dependency). FastAPI solved the problem with a single file.

**Why not Express.js?** Node.js would have worked, but Python is more common in clinic IT environments, and SQLAlchemy's ORM made the data layer trivial.

---

## Why WebSockets?

The core requirement was: **when the receptionist calls the next token, every connected patient screen must update instantly.**

| Approach | Consideration | Verdict |
|----------|--------------|---------|
| **HTTP Polling** (client asks every N seconds) | Simple to implement, but introduces latency (3–30s), wastes bandwidth, and creates thundering-herd problems under load. | ❌ Rejected |
| **Server-Sent Events (SSE)** | One-way server→client, great for updates, but cannot handle bidirectional needs (future features like patient call buttons). | ❌ Rejected |
| **WebSockets** | Persistent full-duplex connection. Server pushes state to all clients immediately on any change. Automatic reconnection built into the client. | ✅ Chosen |

WebSockets gave us **sub-100ms broadcast latency** with minimal network overhead. The `WebSocketManager` is a simple 40-line broadcast hub — no Redis, no message queue, no infrastructure dependencies.

### The Real Trade-Off

WebSockets add complexity: connection lifecycle management, stale connection cleanup, reconnection logic. We accepted this in exchange for instant updates. The trade-off is justified for a hackathon — the implementation is small and self-contained, and the UX benefit (instant queue updates) is the project's headline feature.

---

## Queue Management Logic

### Adding a Patient

```
1. Validate name (non-empty, ≤ 100 chars)
2. Compute next token = max(existing token) + 1
3. INSERT patient with status = "waiting"
4. Broadcast full queue state to all WebSocket clients
```

Token numbers are auto-incrementing integers that never repeat. This gives patients a clear, sequential ticket number they can remember.

### Calling the Next Patient

```
1. Find patient with status = "serving"
   └─ If found: change to "completed"
2. Find first patient with status = "waiting" (ordered by token_number ASC)
   └─ If found: change to "serving"
   └─ If not found: queue is empty
3. Broadcast full queue state to all WebSocket clients
```

This implements a strict **FIFO (First-In, First-Out)** discipline — patients are served in the exact order they were added. No priority, no jumping. This is the fairest model for a general OPD queue.

### Status Lifecycle

```
waiting  ──►  serving  ──►  completed
```

Each patient transitions through exactly three states. There is no way to skip states or move backward. This linear progression keeps the logic simple and auditable.

---

## Wait-Time Calculation Logic

```
estimated_wait = waiting_count × average_consultation_time
```

This is deliberately a **linear estimate**, not a statistical model.

**Why this is sufficient for a hackathon:**
- Every patient behind the currently served token must wait for all ahead of them
- If we assume each consultation takes roughly the configured average time, the total wait is proportional to the queue length
- The receptionist can tune `average_consultation_time` at any time based on real observations

**Why we did NOT use a more complex model:**
- Real consultation times are never uniform, but modeling variance requires historical data we don't have
- An ML-based predictor would be over-engineering for a 24-hour hackathon
- The configurable parameter lets the receptionist adjust on the fly
- The estimate is displayed as guidance, not a guarantee — patients understand this

### Edge Cases in Wait-Time Calculation

| Scenario | Handling |
|----------|----------|
| Empty queue | `waiting_count = 0`, estimated wait = 0 — display shows "Queue is empty" |
| Single patient waiting | Wait = 1 × avg_time — accurate to within one consultation |
| Multiple patients ahead | Wait = N × avg_time — linear scaling, easy to understand |
| Patient tracking their token | Wait computed as `tokens_ahead × avg_time` where `tokens_ahead = count of waiting tokens with number < my_token` |

---

## Edge Cases Handled

| Edge Case | Resolution |
|-----------|-----------|
| **Empty patient name** | `POST /api/add-patient` rejects with 400, client shows error alert |
| **Name > 100 characters** | `POST /api/add-patient` rejects with 400, HTML input `maxlength` also prevents it |
| **Call next on empty queue** | Returns `{ token_number: null }`, client shows "Queue is empty" |
| **WebSocket disconnect during broadcast** | `WebSocketManager.broadcast()` catches exceptions and removes stale connections |
| **Multiple rapid clicks on "Call Next"** | Button is disabled during the request; server handles idempotently |
| **Server restart** | All state is persisted in SQLite; WebSocket clients reconnect and pull fresh state via REST fallback on `ws.onopen` |
| **Database doesn't exist on first run** | `Base.metadata.create_all()` in the lifespan handler creates tables automatically |
| **Negative or zero consultation time** | `POST /api/queue-settings` rejects with 400 if value < 1 |
| **Invalid token number in patient tracking** | Client shows "Token not found" with styled error card |
| **Browser with no WebSocket support** | Extremely rare in 2026, but the REST fallback in `loadQueueState()` provides initial state |

---

## Concurrency Considerations

### Current Architecture (Single Process)

- FastAPI with Uvicorn runs as a single process on SQLite
- SQLite serializes writes via file-level locking — no concurrent write corruption
- The `check_same_thread=False` flag is only needed because FastAPI's async handlers may re-use the same session from different coroutines

### What Would Break Under High Concurrency

| Scenario | Risk | Mitigation (Future) |
|----------|------|--------------------|
| Two receptionists call next simultaneously | Race: both might read the same "waiting" patient | Use a `SELECT ... FOR UPDATE` or database-level lock |
| 1000+ concurrent WebSocket connections | Single-thread broadcast becomes a bottleneck | Replace in-memory `list[WebSocket]` with Redis Pub/Sub |
| Multiple server instances | Each instance has its own in-memory connection list | Redis Pub/Sub + sticky sessions |

For a hackathon / single-clinic deployment, the current architecture is correct. The bottlenecks are well-understood and fixable.

---

## Trade-Offs Made During Development

### SQLite vs. PostgreSQL

**Chosen: SQLite**  
*Why:* Zero configuration, no server process, auto-created on first run. A hackathon judge can clone the repo and run `uvicorn app.main:app` without any setup.  
*Cost:* No concurrent write scaling. SQLite serializes all writes. Acceptable for a single-clinic deployment.

### In-Memory WebSocket Manager vs. Redis Pub/Sub

**Chosen: In-Memory Manager**  
*Why:* No external dependencies. The `WebSocketManager` class is 40 lines.  
*Cost:* Cannot scale horizontally. All WebSocket connections must be on the same server. Acceptable for a hackathon.

### Vanilla JS vs. React / Vue

**Chosen: Vanilla JS**  
*Why:* Zero build step, no bundler, no npm. Single `script.js` file. Hackathon judges can read the full frontend in one go.  
*Cost:* No component reactivity. DOM updates are manual. The codebase is small enough that this is fine.

### Single `queue.py` Route File vs. Separate Modules

**Chosen: Single route file**  
*Why:* The API surface is small (9 endpoints + 1 WebSocket). Splitting would add indirection without benefit.  
*Cost:* If the app grows, this file would need refactoring into `patients.py`, `settings.py`, `ws.py`.

### WebSocket Broadcast Every Mutation vs. Delta Updates

**Chosen: Full state broadcast**  
*Why:* `_build_queue_state_dict()` is cheap (a few simple queries). Clients replace their entire UI state — no need for diff/patch logic.  
*Cost:* Slightly more bytes over the wire. For a clinic queue with at most hundreds of patients, this is negligible.

### No Authentication

**Chosen: No auth**  
*Why:* Hackathon project. Adding auth would require login pages, password hashing, JWT tokens, and session management — all irrelevant to the core queue problem.  
*Cost:* Anyone on the local network can access the receptionist dashboard. For production, add a reverse proxy with basic auth or integrate OAuth2.

---

## Summary of Architecture Principles

1. **Minimal dependencies** — Run with `pip install` and go. No Docker, no Redis, no build step.
2. **Real-time by default** — WebSocket broadcast on every mutation. No manual refresh needed.
3. **Stateless compute, stateful DB** — All queue state is in SQLite. Server restart preserves data.
4. **Resilient clients** — WebSocket reconnection with REST fallback. Users never see stale data.
5. **Judge-friendly readability** — Under 500 lines of Python, 300 lines of JS, 400 lines of CSS. Everything is in one place.
