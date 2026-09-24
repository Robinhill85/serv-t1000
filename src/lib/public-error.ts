// Error text that is safe to send to a browser. viem's full error message carries the RPC URL, and Alchemy URLs hold
// the API key in their path (/v2/<key>): a Robinhood Chain RPC failure could echo the key to any caller (audit, 24 Sep).
// Clients get viem's short message (or the error's own message) with any keyed RPC URL redacted.
const KEYED_URL = /(\/v2\/|\/v3\/)[A-Za-z0-9_-]{8,}/g;

export function redactUrls(text: string): string {
  return text.replace(KEYED_URL, "$1<redacted>");
}

export function publicError(e: unknown, fallback: string, max = 300): string {
  if (!(e instanceof Error)) return fallback;
  const short = (e as { shortMessage?: string }).shortMessage;
  return redactUrls(short ?? e.message).slice(0, max) || fallback;
}
