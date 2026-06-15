# Socket Event Diagram — Queue Cure '26

> Mermaid sequence diagrams for all WebSocket event flows in the queue management system.

---

## 1. Initial Connection & State Loading

When a client (receptionist or patient) opens a dashboard, two things happen in parallel:

1. **WebSocket connection** to `/api/ws` — establishes persistent channel
2. **REST GET** to `/api/queue-status` + `/api/patients` — fallback initial state

```mermaid
sequenceDiagram
    participant C as Client (Browser)
    participant WS as WebSocket<br/>Manager
    participant DB as SQLite
    participant REST as REST API

    Note over C,REST: Page Load
    C->>WS: WebSocket connect /api/ws
    WS->>C: Accept connection
    WS->>DB: _build_queue_state_dict()
    DB->>WS: Full queue state
    WS->>C: { type: "queue_update",<br/>  current_token, waiting_count,<br/>  estimated_wait_time, patients,<br/>  waiting_patients, total_completed }

    par REST Fallback
        C->>REST: GET /api/queue-status
        REST->>C: { current_token, waiting_count,<br/>         estimated_wait_time, avg_consultation_time }
        C->>REST: GET /api/patients
        REST->>C: [ { token_number, patient_name, status }, ... ]
    end

    Note over C: Client renders full UI<br/>from first received data
```

### Key Detail: Race Condition Avoidance

Both the WebSocket message and REST response carry the same `queue_update` payload. The client's `handleQueueUpdate()` is idempotent — calling it twice with the same data is harmless. The first response received renders the UI; the second is a no-op visual update.

---

## 2. Receptionist Flow — Adding a Patient

```mermaid
sequenceDiagram
    participant R as Receptionist Dashboard
    participant S as FastAPI Server
    participant V as Patient View (Browser)
    participant DB as SQLite

    R->>R: User types name, clicks "Add to Queue"
    R->>S: POST /api/add-patient<br/>{ patient_name: "John Doe" }
    S->>S: Validate name (non-empty, ≤ 100 chars)
    S->>DB: SELECT MAX(token_number)
    DB->>S: 42
    S->>DB: INSERT patient<br/>(token=43, name="John Doe", status="waiting")
    DB->>S: OK
    S->>S: _build_queue_state_dict()
    S->>DB: Query all patients, settings
    DB->>S: Full state

    par Broadcast to All Clients
        S->>R: queue_update (full state)
        S->>V: queue_update (full state)
        Note over R,V: All connected clients<br/>receive the same payload
    end

    R->>R: Show success alert, clear input
    V->>V: Update current token, waiting list, stats
```

### Broadcast Payload (Example)

```json
{
  "type": "queue_update",
  "current_token": 40,
  "waiting_count": 4,
  "estimated_wait_time": 40,
  "average_consultation_time": 10,
  "waiting_patients": [
    { "token_number": 41, "patient_name": "Alice", "status": "waiting" },
    { "token_number": 42, "patient_name": "Bob",   "status": "waiting" },
    { "token_number": 43, "patient_name": "John Doe", "status": "waiting" }
  ],
  "patients": [
    { "token_number": 39, "patient_name": "Zara",   "status": "completed" },
    { "token_number": 40, "patient_name": "Carlos", "status": "serving"   },
    { "token_number": 41, "patient_name": "Alice",  "status": "waiting"   },
    { "token_number": 42, "patient_name": "Bob",    "status": "waiting"   },
    { "token_number": 43, "patient_name": "John Doe", "status": "waiting" }
  ],
  "total_completed": 15
}
```

---

## 3. Receptionist Flow — Calling Next Token

```mermaid
sequenceDiagram
    participant R as Receptionist Dashboard
    participant S as FastAPI Server
    participant V as Patient View (Browser)
    participant DB as SQLite

    R->>S: POST /api/call-next {}

    S->>DB: Find patient with status = "serving"
    alt Current serving exists
        DB->>S: Token #40 (Carlos)
        S->>DB: UPDATE Carlos → status = "completed"
    else No one being served
        DB->>S: null
    end

    S->>DB: Find first patient with status = "waiting"<br/>(ordered by token_number ASC)
    alt Waiting patient exists
        DB->>S: Token #41 (Alice)
        S->>DB: UPDATE Alice → status = "serving"
        S->>R: 200 OK { token_number: 41, patient_name: "Alice" }
    else Queue is empty
        DB->>S: null
        S->>R: 200 OK { token_number: null, message: "Queue is empty" }
    end

    S->>S: _build_queue_state_dict()

    par Broadcast to All Clients
        S->>R: queue_update (full state)
        S->>V: queue_update (full state)
    end

    R->>R: Show success alert or "Queue is empty"
    V->>V: Re-render current token, waiting list

    alt Patient is Tracking Token #41
        V->>V: "It's your turn now!" (status card turns green)
        V->>V: Waiting count → 0, Wait time → 0 min
    end
```

### State Transition

```
Before:
┌──────────┬──────────┐
│ Token 40 │ serving  │  ← Carlos being seen
│ Token 41 │ waiting  │  ← Alice next in line
│ Token 42 │ waiting  │
└──────────┴──────────┘

After:
┌──────────┬───────────┐
│ Token 40 │ completed │  ← Carlos done
│ Token 41 │ serving   │  ← Alice called in
│ Token 42 │ waiting   │
└──────────┴───────────┘
```

---

## 4. Patient Flow — Tracking a Token

Patients do **not** send any WebSocket message to track their token. The tracking is handled entirely client-side.

```mermaid
sequenceDiagram
    participant P as Patient (Browser)
    participant JS as Client JS (script.js)
    participant WS as WebSocket<br/>Manager (Server)

    Note over P,WS: No server interaction for tracking

    P->>JS: Enters token number "42", clicks "Track"
    JS->>JS: Store in localStorage<br/>(persists across page reloads)
    JS->>JS: Filter all_patients from last<br/>queue_update by token === 42

    alt Token Not Found
        JS->>P: Show red error card:<br/>"Token #42 not found"
    else Token is "serving"
        JS->>P: Show green card:<br/>"It's your turn now!"
        JS->>P: Waiting count → 0, Wait time → 0 min
    else Token is "completed"
        JS->>P: Show purple card:<br/>"Consultation completed."
        JS->>P: Waiting count → —, Wait time → — min
    else Token is "waiting"
        JS->>JS: Count tokens ahead =<br/>waiting_tokens.filter(t < 42).length
        JS->>JS: est_wait = tokens_ahead × avg_time
        JS->>P: Show blue card:<br/>"Your position: #3"<br/>"Tokens ahead: 2"<br/>"Est. wait: 20 min"
    end

    Note over P,WS: Next queue_update from server<br/>automatically re-evaluates the status
```

### Local Calculation Logic for Token Position

```
tokens_ahead = all_patients
    .filter(p => p.status === "waiting")
    .map(p => p.token_number)
    .filter(t => t < my_token)
    .length

position = tokens_ahead + 1
est_wait  = tokens_ahead × average_consultation_time
```

---

## 5. WebSocket Broadcast Flow (Internal)

```mermaid
sequenceDiagram
    participant EP as API Endpoint<br/>(add-patient / call-next)
    participant BQ as _broadcast_queue_status()
    participant BS as _build_queue_state_dict()
    participant DB as SQLite
    participant WM as WebSocketManager
    participant C1 as Client 1
    participant C2 as Client 2
    participant C3 as Client 3 (stale)

    EP->>BQ: Trigger after DB mutation
    BQ->>BS: Build full state
    BS->>DB: Query patients, settings
    DB->>BS: Result set
    BS->>BQ: dict (full queue state)
    BQ->>WM: broadcast(state)

    loop For each connection
        WM->>C1: send_text(json.dumps(state))
        WM->>C2: send_text(json.dumps(state))
        WM->>C3: send_text(json.dumps(state))
        WM->>WM: Exception from C3
        WM->>WM: Remove C3 from active_connections
    end

    Note over WM: Stale connections cleaned up<br/>automatically during broadcast
```

### Stale Connection Cleanup

The `WebSocketManager.broadcast()` method handles disconnections gracefully:

```python
async def broadcast(self, data: dict[str, Any]) -> None:
    message = json.dumps(data)
    stale: list[WebSocket] = []
    for connection in self.active_connections:
        try:
            await connection.send_text(message)
        except Exception:
            stale.append(connection)
    for conn in stale:
        self.disconnect(conn)
```

No separate heartbeat or ping/pong is needed — a disconnected socket raises an exception on `send_text()`, which triggers cleanup.

---

## 6. Auto-Reconnection Flow

```mermaid
sequenceDiagram
    participant C as Client (Browser)
    participant WS as WebSocket Manager

    C->>WS: WebSocket connect /api/ws
    WS->>C: Connected
    Note over C,WS: Normal operation...

    WS-->>C: Connection lost (close / error)
    C->>C: ws.onclose() fires
    C->>C: Set reconnectTimer = setTimeout(3000ms)
    Note over C: 3-second delay

    C->>WS: WebSocket connect /api/ws
    alt Connection succeeds
        WS->>C: Connected
        C->>C: Clear reconnectTimer
        C->>C: loadQueueState() via REST fallback
        WS->>C: queue_update (full state)
        Note over C: Full state restored
    else Connection fails
        WS-->>C: Close again
        C->>C: Set reconnectTimer = setTimeout(3000ms)
        Note over C: Retry indefinitely<br/>every 3 seconds
    end
```

---

## Summary of All WebSocket Events

| Direction | Event Type | Trigger | Payload |
|-----------|-----------|---------|---------|
| Server → Client | `queue_update` | Patient added, token called, settings changed | Full queue state (current token, waiting list, stats, all patients) |
| Client → Server | *(none)* | — | Clients are receive-only; all mutations happen via REST |

The WebSocket is used exclusively for **server-to-client broadcast**. All mutations use REST endpoints. This separation of concerns keeps the protocol simple and predictable.
