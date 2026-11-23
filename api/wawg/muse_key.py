"""Loads the Muse API key from Secrets Manager once per Lambda container and caches it.
Never log the key or anything derived from it."""

import json
import os
import threading

DEFAULT_SECRET_ID = "where-are-we-going/muse-api-key"
_lock = threading.Lock()
_cached = None


def get_muse_api_key() -> str:
    """The API key, fetched on first use and cached. A failed fetch isn't cached.

    Outside Lambda (local scripts only) MUSE_API_KEY from the environment wins, so
    prompt testing doesn't need Secrets Manager. Inside Lambda it's ignored: a key
    set as a Lambda env var would end up in Terraform state."""
    global _cached
    if _cached:
        return _cached
    with _lock:
        if not _cached:
            _cached = _load()
    return _cached


def prime() -> None:
    """Call at module import in handlers so the fetch happens during cold start.
    Errors are swallowed here and surface again on first real use."""
    try:
        get_muse_api_key()
    except Exception:  # noqa: BLE001
        pass


def _load() -> str:
    in_lambda = bool(os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))
    if not in_lambda and os.environ.get("MUSE_API_KEY"):
        return os.environ["MUSE_API_KEY"].strip()

    import boto3  # imported lazily: not needed when MUSE_API_KEY is set locally

    secret_id = os.environ.get("MUSE_SECRET_ID") or DEFAULT_SECRET_ID
    out = boto3.client("secretsmanager").get_secret_value(SecretId=secret_id)
    key = _extract_key(out.get("SecretString"))
    if not key:
        raise RuntimeError(f"Secret {secret_id} has no usable API key value")
    return key


def _extract_key(secret_string) -> str:
    """Accept a plain-text secret or a JSON object with a conventional field name."""
    s = (secret_string or "").strip()
    if not s.startswith("{"):
        return s
    try:
        o = json.loads(s)
    except ValueError:
        return ""
    return str(o.get("api_key") or o.get("apiKey") or o.get("key") or o.get("MUSE_API_KEY") or "").strip()
