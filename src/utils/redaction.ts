const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

const SENSITIVE_QUERY_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'session',
  'sid',
  'jwt',
];

const SENSITIVE_JSON_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'credit_card',
  'cardnumber',
  'cvv',
  'ssn',
]);

const TOKEN_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function redactHeaders(
  headers: Record<string, string> | undefined,
  enabled = true
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (!enabled) return headers;

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lower) || lower.includes('secret') || lower.includes('token')) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = redactString(value);
    }
  }
  return sanitized;
}

export function redactUrl(rawUrl: string, enabled = true): string {
  if (!enabled) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    let modified = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (SENSITIVE_QUERY_KEYS.some((sensitive) => lower.includes(sensitive))) {
        parsed.searchParams.set(key, '[REDACTED]');
        modified = true;
      }
    }
    return modified ? parsed.toString() : rawUrl;
  } catch {
    return redactString(rawUrl);
  }
}

export function redactString(input: string): string {
  let output = input;
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, '[REDACTED_TOKEN]');
  }
  return output;
}

function redactObjectDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(redactObjectDeep);
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (SENSITIVE_JSON_KEYS.has(lower) || lower.includes('password') || lower.includes('secret') || lower.includes('token')) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactObjectDeep(v);
      }
    }
    return out;
  }
  if (typeof obj === 'string') {
    return redactString(obj);
  }
  return obj;
}

export function redactBody(rawBody: string | undefined, maxBytes = 256 * 1024, redactEnabled = true): string | undefined {
  if (!rawBody) return undefined;
  const truncated =
    rawBody.length > maxBytes
      ? `${rawBody.slice(0, maxBytes)}
...[TRUNCATED (${rawBody.length} chars)]`
      : rawBody;

  if (!redactEnabled) return truncated;

  try {
    const parsed = JSON.parse(truncated);
    return JSON.stringify(redactObjectDeep(parsed), null, 2);
  } catch {
    return redactString(truncated);
  }
}

export function isDomainBlocked(url: string, blockedDomains: string[]): boolean {
  if (!blockedDomains.length) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return blockedDomains.some((domain) => {
      const clean = domain.trim().toLowerCase();
      return clean && (hostname === clean || hostname.endsWith(`.${clean}`));
    });
  } catch {
    return false;
  }
}
