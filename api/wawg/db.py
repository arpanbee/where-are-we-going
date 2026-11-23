"""DynamoDB access. Uses the boto3 resource layer, so items are plain Python values
(numbers come back as Decimal; convert at the edges with as_int)."""

import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from .dates import utc_today
from .errors import LimitError

TABLE_NAME = os.environ.get("TABLE_NAME", "")
_resource = boto3.resource("dynamodb")
table = _resource.Table(TABLE_NAME)
# The resource's client marshals plain Python values for every operation,
# including transact_write_items.
_client = table.meta.client


def _int_env(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default


MUSE_DAILY_CALL_LIMIT = _int_env("MUSE_DAILY_CALL_LIMIT", 500)
ROUND_DRAFTS_PER_DAY = _int_env("ROUND_DRAFTS_PER_DAY", 10)


def as_int(v) -> int:
    return int(v) if isinstance(v, (int, Decimal)) and not isinstance(v, bool) else 0


def error_code(err: Exception) -> str:
    return err.response.get("Error", {}).get("Code", "") if isinstance(err, ClientError) else ""


def take_quota(pk: str, limit: int) -> bool:
    """Atomically takes one unit from a daily counter. False once it reaches `limit`.
    Counter items expire via TTL a few days later."""
    try:
        table.update_item(
            Key={"PK": pk, "SK": "COUNT"},
            UpdateExpression="ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
            ConditionExpression="attribute_not_exists(#n) OR #n < :limit",
            ExpressionAttributeNames={"#n": "n", "#ttl": "ttl"},
            ExpressionAttributeValues={":one": 1, ":limit": limit, ":ttl": int(time.time()) + 3 * 86400},
        )
        return True
    except ClientError as err:
        if error_code(err) == "ConditionalCheckFailedException":
            return False
        raise


def muse_spend_guard() -> None:
    """Global spend cap: pass as generate_clues' before_call so every HTTP attempt to
    Muse (retries included) counts against MUSE_DAILY_CALL_LIMIT (UTC day)."""
    if not take_quota(f"LIMIT#muse#{utc_today()}", MUSE_DAILY_CALL_LIMIT):
        raise LimitError(
            "Our clue writer has hit its limit for today. Try again tomorrow, or write the clues yourself."
        )


def puzzle_key(date: str) -> dict:
    return {"PK": f"PUZZLE#{date}", "SK": "META"}


def get_item(key: dict):
    return table.get_item(Key=key).get("Item")


def batch_get(keys: list) -> list:
    """BatchGet any number of keys (chunks of 100, retries unprocessed keys)."""
    items = []
    for i in range(0, len(keys), 100):
        request = {TABLE_NAME: {"Keys": keys[i : i + 100]}}
        tries = 0
        while request:
            if tries:
                if tries > 5:
                    raise RuntimeError("BatchGet: unprocessed keys after retries")
                time.sleep(0.1 * 2**tries)
            out = _resource.batch_get_item(RequestItems=request)
            items.extend(out.get("Responses", {}).get(TABLE_NAME, []))
            request = out.get("UnprocessedKeys") or None
            tries += 1
    return items


def put_if(item: dict, condition: str, values: dict | None = None) -> bool:
    """Conditional put. False if the condition failed."""
    kwargs = {"Item": item, "ConditionExpression": condition}
    if values:
        kwargs["ExpressionAttributeValues"] = values
    try:
        table.put_item(**kwargs)
        return True
    except ClientError as err:
        if error_code(err) == "ConditionalCheckFailedException":
            return False
        raise


def put_puzzle_if_absent(item: dict) -> bool:
    """Writes a puzzle only if that date has none, so a reviewed puzzle is never overwritten."""
    return put_if(item, "attribute_not_exists(PK)")


def query_between(pk: str, sk_from: str, sk_to: str) -> list:
    """All items in a partition whose SK is between the bounds (inclusive)."""
    items, kwargs = [], {"KeyConditionExpression": Key("PK").eq(pk) & Key("SK").between(sk_from, sk_to)}
    while True:
        out = table.query(**kwargs)
        items.extend(out.get("Items", []))
        if "LastEvaluatedKey" not in out:
            return items
        kwargs["ExclusiveStartKey"] = out["LastEvaluatedKey"]


class TransactionConflict(Exception):
    """A condition failed inside a transaction; `index` is the first failed item."""

    def __init__(self, index: int):
        super().__init__(f"Transaction condition failed on item {index}")
        self.index = index


def transact(items: list) -> None:
    """Runs a transaction (items use plain Python values; TableName is added)."""
    for it in items:
        next(iter(it.values()))["TableName"] = TABLE_NAME
    try:
        _client.transact_write_items(TransactItems=items)
    except ClientError as err:
        if error_code(err) == "TransactionCanceledException":
            reasons = err.response.get("CancellationReasons", [])
            for i, r in enumerate(reasons):
                if r.get("Code") == "ConditionalCheckFailed":
                    raise TransactionConflict(i) from None
        raise


def query_prefix(pk: str, sk_prefix: str, newest_first: bool = False, limit: int | None = None) -> list:
    """Items in a partition whose SK starts with the prefix."""
    kwargs = {"KeyConditionExpression": Key("PK").eq(pk) & Key("SK").begins_with(sk_prefix),
              "ScanIndexForward": not newest_first}
    items = []
    while True:
        if limit:
            kwargs["Limit"] = limit - len(items)
        out = table.query(**kwargs)
        items.extend(out.get("Items", []))
        if "LastEvaluatedKey" not in out or (limit and len(items) >= limit):
            return items
        kwargs["ExclusiveStartKey"] = out["LastEvaluatedKey"]


def update_if(key: dict, update: str, condition: str, values: dict, names: dict | None = None) -> bool:
    """Conditional update. False if the condition failed."""
    kwargs = {"Key": key, "UpdateExpression": update, "ConditionExpression": condition,
              "ExpressionAttributeValues": values}
    if names:
        kwargs["ExpressionAttributeNames"] = names
    try:
        table.update_item(**kwargs)
        return True
    except ClientError as err:
        if error_code(err) == "ConditionalCheckFailedException":
            return False
        raise
