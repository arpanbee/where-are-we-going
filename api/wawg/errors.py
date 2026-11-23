"""Errors the API maps to HTTP responses. Messages are safe to show players."""


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class LimitError(HttpError):
    """A daily cap was hit (global Muse spend cap or per-couple draft cap)."""

    def __init__(self, message: str):
        super().__init__(429, message)
