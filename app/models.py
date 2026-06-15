from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime

from app.database import Base


class Patient(Base):
    __tablename__ = "patients"

    id = Column(Integer, primary_key=True, index=True)
    token_number = Column(Integer, unique=True, nullable=False, index=True)
    patient_name = Column(String, nullable=False)
    status = Column(String, default="waiting")  # waiting | serving | completed
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class QueueSettings(Base):
    __tablename__ = "queue_settings"

    id = Column(Integer, primary_key=True, index=True)
    average_consultation_time = Column(Integer, default=10)  # minutes
