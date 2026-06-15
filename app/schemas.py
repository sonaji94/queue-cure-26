from datetime import datetime

from pydantic import BaseModel


class PatientCreate(BaseModel):
    patient_name: str


class PatientOut(BaseModel):
    id: int
    token_number: int
    patient_name: str
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class QueueSettingsOut(BaseModel):
    average_consultation_time: int

    model_config = {"from_attributes": True}


class QueueStatus(BaseModel):
    current_token: int | None = None
    waiting_count: int
    estimated_wait_time: int  # minutes
    average_consultation_time: int
