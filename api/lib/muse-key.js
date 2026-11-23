// Loads the Muse API key from Secrets Manager once per Lambda container and caches it.
// Never log the key or anything derived from it.

const DEFAULT_SECRET_ID = "where-are-we-going/muse-api-key";
let cached;

/**
 * Resolves to the API key. The first call starts the fetch; later calls share the
 * same promise. A failed fetch is not cached, so the next call retries.
 *
 * Outside Lambda (local scripts only) MUSE_API_KEY from the environment wins, so
 * prompt testing doesn't need Secrets Manager access. Inside Lambda it is ignored:
 * a key set as a Lambda env var would end up in Terraform state.
 */
export function getMuseApiKey() {
  if (!cached) {
    cached = load().catch((err) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

/** Call at module top level in handlers so the fetch happens during cold start. */
export function primeMuseApiKey() {
  getMuseApiKey().catch(() => {}); // surfaced again on first real use
}

async function load() {
  const inLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (!inLambda && process.env.MUSE_API_KEY) return process.env.MUSE_API_KEY.trim();

  const secretId = process.env.MUSE_SECRET_ID || DEFAULT_SECRET_ID;
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const out = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const key = extractKey(out.SecretString);
  if (!key) throw new Error(`Secret ${secretId} has no usable API key value`);
  return key;
}

// Accept either a plain-text secret or a JSON object with a conventional field name.
function extractKey(secretString) {
  const s = (secretString ?? "").trim();
  if (!s.startsWith("{")) return s;
  try {
    const o = JSON.parse(s);
    return String(o.api_key ?? o.apiKey ?? o.key ?? o.MUSE_API_KEY ?? "").trim();
  } catch {
    return "";
  }
}
