import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LimitError } from "./errors.js";
import { utcToday } from "./dates.js";

export const TABLE = process.env.TABLE_NAME;
export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const intEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const MUSE_DAILY_CALL_LIMIT = intEnv("MUSE_DAILY_CALL_LIMIT", 500);
export const ROUND_DRAFTS_PER_DAY = intEnv("ROUND_DRAFTS_PER_DAY", 10);

export const isConditionFailed = (err) => err?.name === "ConditionalCheckFailedException";

/**
 * Atomically takes one unit from a daily counter. Returns false once the counter
 * has reached `limit`. Counter items expire via TTL a few days later.
 */
export async function takeQuota(pk, limit) {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: "COUNT" },
        UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
        ExpressionAttributeNames: { "#n": "n", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":limit": limit,
          ":ttl": Math.floor(Date.now() / 1000) + 3 * 86_400,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

/**
 * Global spend cap: pass as generateClues' beforeCall so every HTTP attempt to
 * Muse (including retries) is counted against MUSE_DAILY_CALL_LIMIT (UTC day).
 */
export async function museSpendGuard() {
  const ok = await takeQuota(`LIMIT#muse#${utcToday()}`, MUSE_DAILY_CALL_LIMIT);
  if (!ok) {
    throw new LimitError(
      "Our clue writer has hit its limit for today. Try again tomorrow, or write the clues yourself.",
    );
  }
}

export const puzzleKey = (date) => ({ PK: `PUZZLE#${date}`, SK: "META" });

export async function getItem(key) {
  const out = await doc.send(new GetCommand({ TableName: TABLE, Key: key }));
  return out.Item ?? null;
}

/** BatchGet any number of keys (chunks of 100, retries unprocessed keys). */
export async function batchGet(keys) {
  const items = [];
  for (let i = 0; i < keys.length; i += 100) {
    let request = { [TABLE]: { Keys: keys.slice(i, i + 100) } };
    for (let tries = 0; request && Object.keys(request).length; tries++) {
      if (tries > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** tries));
      if (tries > 5) throw new Error("BatchGet: unprocessed keys after retries");
      const out = await doc.send(new BatchGetCommand({ RequestItems: request }));
      items.push(...(out.Responses?.[TABLE] ?? []));
      request = out.UnprocessedKeys;
    }
  }
  return items;
}

/** Writes a puzzle only if that date has none, so a reviewed puzzle is never overwritten. */
export async function putPuzzleIfAbsent(item) {
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}
