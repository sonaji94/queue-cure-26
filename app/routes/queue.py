from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Patient, QueueSettings
from app.schemas import PatientCreate, PatientOut, QueueStatus
from app.websocket_manager import manager

router = APIRouter()


def _get_queue_settings(db: Session) -> QueueSettings:
    settings = db.query(QueueSettings).first()
    if settings is None:
        settings = QueueSettings(average_consultation_time=10)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


def _build_queue_state_dict(db: Session) -> dict:
    settings = _get_queue_settings(db)
    current = db.query(Patient).filter(Patient.status == "serving").first()
    waiting = db.query(Patient).filter(Patient.status == "waiting").order_by(Patient.token_number).all()
    completed = db.query(Patient).filter(Patient.status == "completed").count()
    all_patients = db.query(Patient).order_by(Patient.token_number).all()

    current_token = current.token_number if current else None
    waiting_count = len(waiting)
    est_wait = waiting_count * settings.average_consultation_time

    def _patient_dict(p):
        return {
            "token_number": p.token_number,
            "patient_name": p.patient_name,
            "status": p.status,
        }

    return {
        "type": "queue_update",
        "current_token": current_token,
        "waiting_count": waiting_count,
        "estimated_wait_time": est_wait,
        "average_consultation_time": settings.average_consultation_time,
        "waiting_patients": [_patient_dict(p) for p in waiting],
        "patients": [_patient_dict(p) for p in all_patients],
        "total_completed": completed,
    }


async def _broadcast_queue_status(db: Session) -> None:
    state = _build_queue_state_dict(db)
    await manager.broadcast(state)


@router.post("/add-patient", response_model=PatientOut)
async def add_patient(payload: PatientCreate, db: Session = Depends(get_db)):
    name = payload.patient_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Patient name cannot be empty")

    if len(name) > 100:
        raise HTTPException(status_code=400, detail="Patient name too long")

    max_token = db.query(Patient.token_number).order_by(Patient.token_number.desc()).first()
    next_token = (max_token[0] + 1) if max_token else 1

    patient = Patient(token_number=next_token, patient_name=name, status="waiting")
    db.add(patient)
    db.commit()
    db.refresh(patient)

    await _broadcast_queue_status(db)

    return patient


@router.get("/patients", response_model=list[PatientOut])
def list_patients(db: Session = Depends(get_db)):
    return db.query(Patient).order_by(Patient.token_number).all()


@router.post("/call-next")
async def call_next(db: Session = Depends(get_db)):
    current = db.query(Patient).filter(Patient.status == "serving").first()
    if current:
        current.status = "completed"

    next_patient = (
        db.query(Patient)
        .filter(Patient.status == "waiting")
        .order_by(Patient.token_number)
        .first()
    )

    if not next_patient:
        db.commit()
        await _broadcast_queue_status(db)
        return {"message": "Queue is empty", "token_number": None}

    next_patient.status = "serving"
    db.commit()

    await _broadcast_queue_status(db)

    return {
        "message": f"Token {next_patient.token_number} - {next_patient.patient_name} is now being served",
        "token_number": next_patient.token_number,
        "patient_name": next_patient.patient_name,
    }


@router.get("/current-token")
def current_token(db: Session = Depends(get_db)):
    current = db.query(Patient).filter(Patient.status == "serving").first()
    if current:
        return {"token_number": current.token_number, "patient_name": current.patient_name}
    return {"token_number": None, "patient_name": None}


@router.get("/queue-status", response_model=QueueStatus)
def queue_status(db: Session = Depends(get_db)):
    settings = _get_queue_settings(db)
    current = db.query(Patient).filter(Patient.status == "serving").first()
    waiting_count = db.query(Patient).filter(Patient.status == "waiting").count()

    current_token = current.token_number if current else None
    estimated_wait = waiting_count * settings.average_consultation_time

    return QueueStatus(
        current_token=current_token,
        waiting_count=waiting_count,
        estimated_wait_time=estimated_wait,
        average_consultation_time=settings.average_consultation_time,
    )


@router.get("/queue-settings")
def get_settings(db: Session = Depends(get_db)):
    settings = _get_queue_settings(db)
    return {"average_consultation_time": settings.average_consultation_time}


@router.post("/queue-settings")
async def update_settings(payload: dict, db: Session = Depends(get_db)):
    time_val = payload.get("average_consultation_time")
    if time_val is None or not isinstance(time_val, int) or time_val < 1:
        raise HTTPException(status_code=400, detail="Must be a positive integer (minutes)")

    settings = _get_queue_settings(db)
    settings.average_consultation_time = time_val
    db.commit()
    db.refresh(settings)

    await _broadcast_queue_status(db)

    return {"average_consultation_time": settings.average_consultation_time}


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, db: Session = Depends(get_db)):
    await manager.connect(websocket)
    try:
        state = _build_queue_state_dict(db)
        await websocket.send_json(state)

        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
