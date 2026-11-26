"""Google identity verification and short-lived registry sessions."""

from collections import deque
import os
import secrets
from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request
from google.auth import exceptions
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token


SESSION_SECONDS = 60 * 60
CHALLENGE_SECONDS = 5 * 60
sessions = {}
challenges = {}
attempts = deque()
lock = Lock()


def client_id():
    return os.getenv("ERIV_GOOGLE_CLIENT_ID", "").strip()


def allowed_emails():
    return {email.strip().casefold() for email in os.getenv("ERIV_GOOGLE_ALLOWED_EMAILS", "").split(",") if email.strip()}


def prune(records, now):
    for key, expires in list(records.items()):
        if expires <= now:
            del records[key]


def challenge():
    if not client_id() or not allowed_emails():
        raise HTTPException(503, "Вход через Google для реестра ещё не настроен.")
    with lock:
        now = monotonic()
        prune(challenges, now)
        if len(challenges) >= 256:
            raise HTTPException(429, "Слишком много запросов. Повторите вход позже.")
        nonce = secrets.token_urlsafe(32)
        challenges[nonce] = now + CHALLENGE_SECONDS
        return nonce


def verify_google_token(credential, audience):
    transport = GoogleRequest()

    def google_request(*args, **kwargs):
        return transport(*args, **{**kwargs, "timeout": 8})

    return id_token.verify_oauth2_token(credential, google_request, audience)


def login(credential, nonce, ip):
    audience = client_id()
    allowed = allowed_emails()
    if not audience or not allowed:
        raise HTTPException(503, "Вход через Google для реестра ещё не настроен.")
    with lock:
        now = monotonic()
        prune(challenges, now)
        while attempts and attempts[0][0] <= now - 60:
            attempts.popleft()
        if len(attempts) >= 60 or sum(host == ip for _, host in attempts) >= 10:
            raise HTTPException(429, "Слишком много попыток входа. Повторите через минуту.")
        if challenges.pop(nonce, None) is None:
            raise HTTPException(401, "Срок запроса на вход истёк. Откройте окно заново.")
        attempts.append((now, ip))
    try:
        claims = verify_google_token(credential, audience)
    except exceptions.TransportError as exc:
        raise HTTPException(503, "Не удалось связаться с Google. Попробуйте ещё раз.") from exc
    except (ValueError, exceptions.GoogleAuthError) as exc:
        raise HTTPException(401, "Google не подтвердил вход. Попробуйте ещё раз.") from exc

    email = str(claims.get("email", "")).casefold()
    if (claims.get("nonce") != nonce or claims.get("email_verified") is not True
            or email not in allowed or not (email.endswith("@gmail.com") or claims.get("hd"))):
        raise HTTPException(403, "Этот Google-аккаунт не разрешён для доступа к реестру.")
    with lock:
        now = monotonic()
        prune(sessions, now)
        if len(sessions) >= 64:
            sessions.pop(next(iter(sessions)))
        token = secrets.token_urlsafe(32)
        sessions[token] = now + SESSION_SECONDS
        return token


def authorized(request: Request):
    prefix, _, token = request.headers.get("authorization", "").partition(" ")
    if prefix.lower() != "bearer":
        token = ""
    with lock:
        expiry = sessions.get(token)
        if expiry and expiry > monotonic():
            return token
        sessions.pop(token, None)
    raise HTTPException(401, "Войдите через Google, чтобы открыть реестр.")


def logout(token):
    with lock:
        sessions.pop(token, None)
