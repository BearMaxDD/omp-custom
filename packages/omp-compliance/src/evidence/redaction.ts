/**
 * Sensitive information redaction for evidence logs.
 *
 * Removes API keys, authorization headers, tokens, cookies, and
 * other credential-like patterns before persisting evidence records.
 *
 * Each pattern replaces the matched value with [REDACTED] while
 * preserving the structure (parameter name / header name) so that
 * logs remain auditable without exposing secrets.
 */

interface RedactRule {
	pattern: RegExp;
	replacement: string;
}

const REDACT_RULES: RedactRule[] = [
	// Private key block — multiline, order-sensitive (must run first)
	{
		pattern: /(-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)[\s\S]*?(-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/g,
		replacement: "$1\n[REDACTED]\n$2",
	},
	// Authorization header value
	{
		pattern: /(Authorization:\s*)\S+/gi,
		replacement: "$1[REDACTED]",
	},
	// Bearer token
	{
		pattern: /(\b[Bb]earer\s+)\S+/g,
		replacement: "$1[REDACTED]",
	},
	// API key patterns (sk-*, pk-*, rk-* prefixed)
	{
		pattern: /(\b(?:sk-|pk-|rk-|test-|live-)\s*)[A-Za-z0-9]{20,}/g,
		replacement: "$1[REDACTED]",
	},
	// api_key / apikey / api-key = value
	{
		pattern: /(\b(?:api[_-]?key|apikey|api_key)\s*[:=]\s*['"]?)\S+/gi,
		replacement: "$1[REDACTED]",
	},
	// token / access_token / refresh_token / secret_token
	{
		pattern: /(\b(?:token|access_token|refresh_token|secret_token)\s*[:=]\s*['"]?)\S+/gi,
		replacement: "$1[REDACTED]",
	},
	// Session / cookie value
	{
		pattern: /(\b(?:session|connect\.sid|auth_token|cookie|xsrf-token|x-csrf-token)\s*[:=]\s*['"]?)\S+/gi,
		replacement: "$1[REDACTED]",
	},
	// JWT pattern (eyJ prefixed base64url triple)
	{
		pattern: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
		replacement: "[REDACTED]",
	},
	// password / passwd / secret = value
	{
		pattern: /(\b(?:password|passwd|secret)\s*[:=]\s*['"]?)\S+/gi,
		replacement: "$1[REDACTED]",
	},
];

/**
 * Redact sensitive information from a string.
 * Returns a new string with sensitive content replaced by [REDACTED].
 *
 * Preserves the context around the redacted value so the structure
 * of the log line remains visible.
 */
export function redact(content: string): string {
	let result = content;
	for (const rule of REDACT_RULES) {
		result = result.replace(rule.pattern, rule.replacement);
	}
	return result;
}
