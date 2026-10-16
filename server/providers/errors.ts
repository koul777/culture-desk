export type ProviderErrorKind = 'auth' | 'quota' | 'network' | 'schema';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const kind = (error as { kind?: ProviderErrorKind })?.kind;
  if (kind === 'auth' || kind === 'quota' || kind === 'schema' || kind === 'network') {
    return new ProviderError(kind, error instanceof Error ? error.message : String(error));
  }
  return new ProviderError('network', error instanceof Error ? error.message : String(error));
}

const SECRET_PATTERNS = [/serviceKey=[^&\s]+/gi, /service=[^&\s]+/gi, /인증키[^\s]*/gi];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

export function assertNoSecrets(value: unknown, keyMaterial?: string): void {
  const json = JSON.stringify(value);
  if (SECRET_PATTERNS.some((p) => { p.lastIndex = 0; return p.test(json); })) throw new ProviderError('schema', 'response contains secret material');
  if (keyMaterial && json.includes(keyMaterial)) throw new ProviderError('schema', 'raw contains secret material');
}
