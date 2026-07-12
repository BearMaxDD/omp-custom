import { describe, expect, it } from "bun:test";
import { redact } from "../../src/evidence/redaction";

describe("redact — private key block", () => {
	it("redacts RSA private key block", () => {
		const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const result = redact(input);
		expect(result).toContain("-----BEGIN RSA PRIVATE KEY-----");
		expect(result).toContain("-----END RSA PRIVATE KEY-----");
		expect(result).toContain("[REDACTED]");
		expect(result).not.toContain("MIIEpAIBAAKCAQEA");
	});

	it("redacts plain PRIVATE KEY block", () => {
		const input = "-----BEGIN PRIVATE KEY-----\nMEQx\n-----END PRIVATE KEY-----";
		const result = redact(input);
		expect(result).toContain("[REDACTED]");
		expect(result).not.toContain("MEQx");
	});

	it("does not alter text without private key blocks", () => {
		const input = "some ordinary text without keys";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — Authorization header", () => {
	it("redacts Authorization header value", () => {
		const input = "Authorization: Bearer abc123";
		const result = redact(input);
		expect(result).toBe("Authorization: [REDACTED]");
	});

	it("redacts lowercase authorization header", () => {
		const input = "authorization: secret-token-123";
		const result = redact(input);
		expect(result).toBe("authorization: [REDACTED]");
	});

	it("does not alter a line without Authorization", () => {
		const input = "Content-Type: application/json";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — Bearer token", () => {
	it("redacts token after Bearer prefix", () => {
		const input = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
		const result = redact(input);
		expect(result).toMatch(/Bearer\s+\[REDACTED\]/);
		expect(result).not.toContain("eyJhbGci");
	});

	it("redacts token after lowercase bearer prefix", () => {
		const input = "bearer some-token-value-here";
		const result = redact(input);
		expect(result).toBe("bearer [REDACTED]");
	});

	it("does not alter text without Bearer", () => {
		const input = "just some normal text";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — API key patterns (sk-/pk-/rk-/test-/live-)", () => {
	it("redacts sk- prefixed key with alphanumeric suffix", () => {
		const input = "sk-abc123def456ghi789jkl0";
		const result = redact(input);
		expect(result).toBe("sk-[REDACTED]");
	});

	it("redacts pk- prefixed key", () => {
		const input = "pk-test12345678901234567890";
		const result = redact(input);
		expect(result).toBe("pk-[REDACTED]");
	});

	it("redacts rk- prefixed key", () => {
		const input = "rk-abcdefabcdefabcdefabcdef12";
		const result = redact(input);
		expect(result).toBe("rk-[REDACTED]");
	});

	it("redacts test- prefixed key", () => {
		const input = "test-123456789012345678901234";
		const result = redact(input);
		expect(result).toBe("test-[REDACTED]");
	});

	it("redacts live- prefixed key", () => {
		const input = "live-abcdefabcdefabcdefabcdef12";
		const result = redact(input);
		expect(result).toBe("live-[REDACTED]");
	});

	it("does not alter ordinary text", () => {
		const input = "sk- (short) is not a key";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — api_key / apikey / api-key fields", () => {
	it("redacts api_key= value", () => {
		const input = "api_key=sk-abc123def456";
		const result = redact(input);
		expect(result).toBe("api_key=[REDACTED]");
	});

	it("redacts apikey: value", () => {
		const input = 'apikey: "my-secret-key-here"';
		const result = redact(input);
		expect(result).toBe('apikey: "[REDACTED]');
	});

	it("redacts api-key = value", () => {
		const input = "api-key = supersecret";
		const result = redact(input);
		expect(result).toBe("api-key = [REDACTED]");
	});

	it("does not alter text without api_key", () => {
		const input = "username = admin";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — token / access_token / refresh_token / secret_token", () => {
	it("redacts token= value", () => {
		const input = "token=ghp_abc123def456ghi789";
		const result = redact(input);
		expect(result).toBe("token=[REDACTED]");
	});

	it("redacts access_token: value", () => {
		const input = "access_token: my-access-token-here";
		const result = redact(input);
		expect(result).toBe("access_token: [REDACTED]");
	});

	it("redacts refresh_token= value", () => {
		const input = "refresh_token=some-refresh-token";
		const result = redact(input);
		expect(result).toBe("refresh_token=[REDACTED]");
	});

	it("redacts secret_token value", () => {
		const input = "secret_token: the-secret-token-value";
		const result = redact(input);
		expect(result).toBe("secret_token: [REDACTED]");
	});

	it("does not alter ordinary text mentioning 'token' in context", () => {
		const input = "the token was not returned";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — session / cookie / auth_token / xsrf-token", () => {
	it("redacts session= value", () => {
		const input = "session=abc123def456";
		const result = redact(input);
		expect(result).toBe("session=[REDACTED]");
	});

	it("redacts connect.sid value", () => {
		const input = "connect.sid=s%3Aabc123.def456";
		const result = redact(input);
		expect(result).toBe("connect.sid=[REDACTED]");
	});

	it("redacts auth_token value", () => {
		const input = "auth_token=my-auth-token-here";
		const result = redact(input);
		expect(result).toBe("auth_token=[REDACTED]");
	});

	it("redacts cookie: value", () => {
		const input = "cookie: sessionid=abc123";
		const result = redact(input);
		expect(result).toBe("cookie: [REDACTED]");
	});

	it("redacts xsrf-token value", () => {
		const input = "xsrf-token=abc123def456ghi789";
		const result = redact(input);
		expect(result).toBe("xsrf-token=[REDACTED]");
	});

	it("does not alter ordinary text", () => {
		const input = "cookie was not present in the response";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — JWT (eyJ...)", () => {
	it("redacts a complete JWT", () => {
		const input = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456";
		const result = redact(input);
		expect(result).toBe("[REDACTED]");
	});

	it("does not alter non-JWT eyJ text (too short)", () => {
		const input = "eyJ-short";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — password / passwd / secret", () => {
	it("redacts password= value", () => {
		const input = "password=hunter2";
		const result = redact(input);
		expect(result).toBe("password=[REDACTED]");
	});

	it("redacts passwd: value", () => {
		const input = 'passwd: "correct-horse-battery-staple"';
		const result = redact(input);
		expect(result).toBe('passwd: "[REDACTED]');
	});

	it("redacts secret = value", () => {
		const input = "secret = my-super-secret-key";
		const result = redact(input);
		expect(result).toBe("secret = [REDACTED]");
	});

	it("does not alter ordinary text", () => {
		const input = "whats the secret sauce?";
		expect(redact(input)).toBe(input);
	});
});

describe("redact — multiple patterns in one string", () => {
	it("redacts all sensitive content in a combined log line", () => {
		const input = [
			"POST /api/data",
			"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123456",
			"api_key=sk-abc123def456ghi789",
			"connect.sid=abc123def456",
		].join("\n");
		const result = redact(input);
		expect(result).toContain("Authorization: [REDACTED]");
		expect(result).toContain("api_key=[REDACTED]");
		expect(result).toContain("connect.sid=[REDACTED]");
		expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(result).not.toContain("sk-abc123def456");
		expect(result).not.toContain("abc123def456");
	});
});
