"""Request helpers shared by the API routes."""

import base64
import hashlib
import json
import re

from .errors import HttpError

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def uid_from(event: dict):
    """Anonymous identity: the client keeps a random UUID in localStorage and sends
    it as X-Device-Token. Only its SHA-256 hash is ever stored or logged."""
    token = (event.get("headers") or {}).get("x-device-token", "")
    if not _UUID_RE.match(token):
        return None
    return hashlib.sha256(token.lower().encode()).hexdigest()


def require_uid(event: dict) -> str:
    uid = uid_from(event)
    if not uid:
        raise HttpError(401, "Missing or invalid device token.")
    return uid


def parse_body(event: dict) -> dict:
    raw = event.get("body")
    if not raw:
        return {}
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    if len(raw) > 4096:
        raise HttpError(413, "Request too large.")
    try:
        v = json.loads(raw)
    except ValueError:
        raise HttpError(400, "Request body must be JSON.") from None
    return v if isinstance(v, dict) else {}
