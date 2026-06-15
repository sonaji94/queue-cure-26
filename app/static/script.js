let ws = null;
let reconnectTimer = null;
let trackedToken = (() => {
    const val = localStorage.getItem("tracked_token");
    return val ? parseInt(val, 10) : null;
})();

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/api/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        loadQueueState();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === "queue_update") {
                handleQueueUpdate(data);
            }
        } catch (e) {
            // ignore invalid messages
        }
    };

    ws.onclose = () => {
        ws = null;
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
        ws.close();
    };
}

function handleQueueUpdate(data) {
    updateCurrentToken(data.current_token, data.waiting_patients || []);
    updateWaitingList(data.waiting_patients || []);
    updateStats(data);
    updatePatientStatus(data.patients || [], data.current_token, data.average_consultation_time);
}

function updateCurrentToken(currentToken, patients) {
    const display = document.getElementById("current-token-display");
    if (!display) return;

    if (currentToken) {
        const patient = patients.find(p => p.status === "serving")
            || { patient_name: "Patient", token_number: currentToken };
        display.innerHTML = `
            <div class="token-number">${currentToken}</div>
            <div class="token-label">Current Token Being Served</div>
            <div class="patient-name">${escapeHtml(patient.patient_name)}</div>
        `;
    } else {
        display.innerHTML = `
            <div class="token-number" style="font-size:2rem;">---</div>
            <div class="token-label">No patient being served</div>
        `;
    }
}

function updateWaitingList(patients) {
    const list = document.getElementById("waiting-list");
    if (!list) return;

    const waiting = patients.filter(p => p.status === "waiting");

    if (waiting.length === 0) {
        list.innerHTML = `<li class="empty-state">Queue is empty</li>`;
        return;
    }

    list.innerHTML = waiting.map(p => `
        <li>
            <span>
                <span class="token-tag">#${p.token_number}</span>
                <span class="name">${escapeHtml(p.patient_name)}</span>
            </span>
            <span class="status-waiting">Waiting</span>
        </li>
    `).join("");
}

function updateStats(data) {
    const waitingEl = document.getElementById("waiting-count");
    if (waitingEl) waitingEl.textContent = data.waiting_count;

    const estWaitEl = document.getElementById("est-wait");
    if (estWaitEl) estWaitEl.textContent = `${data.estimated_wait_time} min`;

    const avgTimeEl = document.getElementById("avg-time");
    if (avgTimeEl) avgTimeEl.textContent = `${data.average_consultation_time} min`;

    const completedEl = document.getElementById("completed-count");
    if (completedEl) completedEl.textContent = data.total_completed ?? "-";
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function trackToken() {
    const input = document.getElementById("token-input");
    const token = parseInt(input.value.trim(), 10);
    if (isNaN(token) || token < 1) {
        showAlert("error", "Please enter a valid token number");
        return;
    }
    trackedToken = token;
    localStorage.setItem("tracked_token", token);
    document.getElementById("track-token-btn").textContent = "Update";
    document.getElementById("clear-token-btn").style.display = "inline-block";
    loadQueueState();
}

function clearTrackedToken() {
    trackedToken = null;
    localStorage.removeItem("tracked_token");
    document.getElementById("track-token-btn").textContent = "Track";
    document.getElementById("clear-token-btn").style.display = "none";
    document.getElementById("token-input").value = "";
    document.getElementById("patient-status").style.display = "none";
    loadQueueState();
}

function updatePatientStatus(allPatients, currentToken, avgTime) {
    const statusEl = document.getElementById("patient-status");
    if (!statusEl) return;
    if (!trackedToken) {
        statusEl.style.display = "none";
        return;
    }

    const patient = allPatients.find(p => p.token_number === trackedToken);

    if (!patient) {
        statusEl.style.display = "block";
        statusEl.className = "patient-status status-not-found";
        statusEl.innerHTML = `<strong>Token #${trackedToken}</strong> not found. Please check your token number.`;
        document.getElementById("waiting-count").textContent = "—";
        document.getElementById("est-wait").textContent = "— min";
        return;
    }

    if (patient.status === "serving" || patient.token_number === currentToken) {
        statusEl.style.display = "block";
        statusEl.className = "patient-status status-serving";
        statusEl.innerHTML = `<strong>It's your turn now!</strong>`;
        document.getElementById("waiting-count").textContent = "0";
        document.getElementById("est-wait").textContent = "0 min";
        return;
    }

    if (patient.status === "completed") {
        statusEl.style.display = "block";
        statusEl.className = "patient-status status-completed";
        statusEl.innerHTML = `<strong>Consultation completed.</strong>`;
        document.getElementById("waiting-count").textContent = "—";
        document.getElementById("est-wait").textContent = "— min";
        return;
    }

    const waitingTokens = allPatients
        .filter(p => p.status === "waiting")
        .map(p => p.token_number)
        .sort((a, b) => a - b);

    const tokensAhead = waitingTokens.filter(t => t < trackedToken).length;
    const position = tokensAhead + 1;
    const estWait = tokensAhead * avgTime;

    statusEl.style.display = "block";
    statusEl.className = "patient-status status-waiting";
    statusEl.innerHTML = `Your position in queue: <strong>#${position}</strong>`;
    document.getElementById("waiting-count").textContent = tokensAhead;
    document.getElementById("est-wait").textContent = `${estWait} min`;
}

async function loadQueueState() {
    try {
        const [queueStatus, patients] = await Promise.all([
            apiGet("/api/queue-status"),
            apiGet("/api/patients"),
        ]);

        const waitingPatients = patients.filter(p => p.status !== "completed");
        const totalCompleted = patients.filter(p => p.status === "completed").length;

        handleQueueUpdate({
            current_token: queueStatus.current_token,
            waiting_count: queueStatus.waiting_count,
            estimated_wait_time: queueStatus.estimated_wait_time,
            average_consultation_time: queueStatus.average_consultation_time,
            waiting_patients: waitingPatients,
            patients: patients,
            total_completed: totalCompleted,
        });
    } catch (e) {
        // REST fallback failed — WS will deliver state when connected
    }
}

async function apiPost(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Request failed");
    }
    return res.json();
}

async function apiGet(url) {
    const res = await fetch(url);
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Request failed");
    }
    return res.json();
}

function showAlert(type, message) {
    const container = document.getElementById("alert-container");
    if (!container) return;
    container.innerHTML = `<div class="alert alert-${type}">${escapeHtml(message)}</div>`;
    setTimeout(() => { container.innerHTML = ""; }, 5000);
}

async function addPatient() {
    const input = document.getElementById("patient-name-input");
    const name = input.value.trim();
    if (!name) {
        showAlert("error", "Please enter a patient name");
        return;
    }
    const btn = document.getElementById("add-patient-btn");
    btn.disabled = true;
    try {
        await apiPost("/api/add-patient", { patient_name: name });
        input.value = "";
        showAlert("success", `Patient "${name}" added successfully`);
    } catch (e) {
        showAlert("error", e.message);
    } finally {
        btn.disabled = false;
    }
}

async function callNext() {
    const btn = document.getElementById("call-next-btn");
    btn.disabled = true;
    try {
        const result = await apiPost("/api/call-next", {});
        if (result.token_number) {
            showAlert("success", `Now serving: Token #${result.token_number} - ${result.patient_name}`);
        } else {
            showAlert("info", "Queue is empty");
        }
    } catch (e) {
        showAlert("error", e.message);
    } finally {
        btn.disabled = false;
    }
}

async function updateConsultationTime() {
    const input = document.getElementById("consultation-time-input");
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 1) {
        showAlert("error", "Enter a positive number");
        return;
    }
    try {
        const result = await apiPost("/api/queue-settings", { average_consultation_time: val });
        showAlert("success", `Consultation time set to ${result.average_consultation_time} min`);
    } catch (e) {
        showAlert("error", e.message);
    }
}

async function loadConsultationTime() {
    try {
        const data = await apiGet("/api/queue-settings");
        const input = document.getElementById("consultation-time-input");
        if (input) input.value = data.average_consultation_time;
    } catch (e) {
        // ignore
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (trackedToken) {
        const input = document.getElementById("token-input");
        if (input) {
            input.value = trackedToken;
            document.getElementById("track-token-btn").textContent = "Update";
            document.getElementById("clear-token-btn").style.display = "inline-block";
        }
    }
    connectWebSocket();
    loadQueueState();
    loadConsultationTime();
});
