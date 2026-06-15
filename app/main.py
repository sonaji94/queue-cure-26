from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.responses import RedirectResponse

from app.database import Base, engine
from app.routes.queue import router as queue_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Queue Cure '26", lifespan=lifespan)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

templates = Jinja2Templates(directory="app/templates")

app.include_router(queue_router, prefix="/api")


@app.get("/")
def root():
    return RedirectResponse(url="/receptionist")


@app.get("/receptionist")
def receptionist_page(request: Request):
    return templates.TemplateResponse("receptionist.html", {"request": request})


@app.get("/patient")
def patient_page(request: Request):
    return templates.TemplateResponse("patient.html", {"request": request})
