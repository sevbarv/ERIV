"""ERIV calculation and registry API. Run with a single Uvicorn worker."""

from collections import deque
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore, Lock
from time import monotonic
from zipfile import BadZipFile, ZipFile

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.datastructures import Headers

from . import auth, registry


ROOT = Path(__file__).resolve().parent
MAX_WORKBOOK = 12 * 1024 * 1024
MAX_ECONOMICS = 2 * 1024 * 1024
MAX_REQUEST = MAX_WORKBOOK + MAX_ECONOMICS + 64 * 1024
COMPUTE_LIMIT = BoundedSemaphore(1)
COMPUTE_REQUESTS = deque()
COMPUTE_RATE_LOCK = Lock()


class LimitCalculationUpload:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] != 'POST' or scope['path'].rstrip('/') != '/api/cate':
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        length = headers.get('content-length', '')
        if length.isdigit() and int(length) > MAX_REQUEST:
            await JSONResponse({'detail': 'Суммарный размер файлов превышает 14 МБ.'}, status_code=413)(scope, receive, send)
            return
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get('body', b''))
            if received > MAX_REQUEST:
                raise HTTPException(413, 'Суммарный размер файлов превышает 14 МБ.')
            return message

        await self.app(scope, limited_receive, send)


def limit_calculation_rate(request):
    ip = request.client.host if request.client else 'unknown'
    with COMPUTE_RATE_LOCK:
        now = monotonic()
        while COMPUTE_REQUESTS and COMPUTE_REQUESTS[0][0] <= now - 60:
            COMPUTE_REQUESTS.popleft()
        if len(COMPUTE_REQUESTS) >= 30 or sum(host == ip for _, host in COMPUTE_REQUESTS) >= 6:
            raise HTTPException(429, 'Слишком много расчётов. Повторите через минуту.', headers={'Retry-After': '60'})
        COMPUTE_REQUESTS.append((now, ip))

app = FastAPI(title="ERIV", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(LimitCalculationUpload)
origins = [origin.strip().rstrip("/") for origin in os.getenv("ERIV_ALLOWED_ORIGINS", "").split(",") if origin.strip()]
if origins:
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type"])


@app.middleware("http")
async def response_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


class GoogleCredential(BaseModel):
    credential: str = Field(min_length=1, max_length=8192)
    nonce: str = Field(min_length=43, max_length=43)


class RegistryEntry(BaseModel):
    confirmed: bool
    record: dict


@app.get("/api/health")
def health():
    return {"service": "ERIV"}


@app.get("/api/google/challenge")
def google_challenge():
    return {"clientID": auth.client_id(), "nonce": auth.challenge()}


@app.post("/api/google/session")
def login(credentials: GoogleCredential, request: Request):
    ip = request.client.host if request.client else "unknown"
    token = auth.login(credentials.credential, credentials.nonce, ip)
    return {"token": token, "expiresIn": auth.SESSION_SECONDS, "googleReady": registry.configured(), "sheetURL": registry.spreadsheet_url()}


@app.post("/api/logout")
def logout(token=Depends(auth.authorized)):
    auth.logout(token)
    return {"ok": True}


@app.get("/api/registry")
def get_registry(_=Depends(auth.authorized)):
    rows = registry.list_rows()
    return {"rows": rows, "sheetURL": registry.spreadsheet_url()}


@app.post("/api/registry")
def add_registry(entry: RegistryEntry, _=Depends(auth.authorized)):
    if not entry.confirmed:
        raise HTTPException(422, "Подтвердите обезличивание перед сохранением.")
    row, created = registry.append_entry(entry.record)
    return {"record": row, "created": created}


def check_workbook(contents):
    if not contents or len(contents) > MAX_WORKBOOK:
        raise HTTPException(413, "Допустим размер .xlsx до 12 МБ.")
    try:
        with ZipFile(BytesIO(contents)) as archive:
            members = archive.infolist()
            if ("xl/workbook.xml" not in archive.namelist() or len(members) > 1000
                    or sum(part.file_size for part in members) > 80 * 1024 * 1024):
                raise ValueError
    except (BadZipFile, ValueError) as exc:
        raise HTTPException(422, "Загрузите обычную книгу ERIV в формате .xlsx.") from exc


@app.post("/api/cate")
def run_cate(request: Request, workbook: UploadFile = File(...),
             economics: UploadFile | None = File(None),
             budget: str = Form("", max_length=32),
             min_arm: int = Form(25, ge=6, le=100000),
             min_events: int = Form(5, ge=3, le=100000),
             min_company_arm: int = Form(5, ge=1, le=100000),
             min_uplift: float = Form(0.0, ge=0, lt=1),
             low_risk: float = Form(0.10, ge=0, lt=1),
             high_risk: float = Form(0.50, gt=0, le=1)):
    contents = workbook.file.read(MAX_WORKBOOK+1)
    check_workbook(contents)
    if low_risk >= high_risk:
        raise HTTPException(422, "Порог низкого риска должен быть ниже порога высокого риска.")
    if not COMPUTE_LIMIT.acquire(blocking=False):
        raise HTTPException(429, "Идёт другой расчёт. Повторите после его завершения.")
    try:
        limit_calculation_rate(request)
        with TemporaryDirectory(prefix="eriv-") as temp:
            folder = Path(temp)
            book = folder / "input.xlsx"
            book.write_bytes(contents)
            args = [sys.executable, str(ROOT/"eriv_retention.py"), "--workbook", str(book),
                    "--out", str(folder/"results"), "--min-arm", str(min_arm), "--min-events", str(min_events),
                    "--min-company-arm", str(min_company_arm), "--min-uplift", str(min_uplift),
                    "--low-risk", str(low_risk), "--high-risk", str(high_risk)]
            if economics is not None:
                data = economics.file.read(MAX_ECONOMICS+1)
                if len(data) > MAX_ECONOMICS:
                    raise HTTPException(413, "Допустим размер CSV экономики до 2 МБ.")
                ec = folder / "economics.csv"
                ec.write_bytes(data)
                args.extend(["--economics", str(ec)])
            if budget:
                args.extend(["--budget", budget])
            # The estimator handles user data in its own temporary directory.
            base_env = {key: os.environ[key] for key in ('PATH', 'PYTHONPATH', 'SYSTEMROOT', 'WINDIR', 'LANG') if key in os.environ}
            env = dict(base_env, PYTHONIOENCODING="utf-8", MPLCONFIGDIR=temp, TMPDIR=temp, TMP=temp, TEMP=temp,
                       OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
            result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                    timeout=180, env=env, cwd=folder, check=False)
            if result.returncode:
                reason = next((line for line in reversed(result.stderr.splitlines()) if line.startswith("Ошибка:")), None)
                raise HTTPException(422, reason or "Python завершил расчёт с ошибкой. Проверьте данные и зависимости.")
            return {"csv": (folder/"results/retention_decisions.csv").read_text(encoding="utf-8-sig"),
                    "diagnostics": json.loads((folder/"results/diagnostics.json").read_text(encoding="utf-8"))}
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "Расчёт превысил 3 минуты. Для большой когорты запустите Python из комплекта локально.") from exc
    finally:
        COMPUTE_LIMIT.release()


app.mount("/", StaticFiles(directory=ROOT.parent/"site", html=True), name="site")

