import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedUrl, isPrivateHostname, validateTargetUrl } from "../src/api/url_guard.js";

describe("URL validation", () => {
  it("accepts ordinary public http and https URLs", () => {
    for (const url of [
      "https://example.com",
      "http://example.com/funnel?utm_source=fb",
      "https://sub.domain.example.co.uk/a/b",
    ]) {
      const check = validateTargetUrl(url);
      assert.equal(check.ok, true, `${url} should be accepted`);
    }
  });

  it("rejects non-strings and empty input", () => {
    for (const value of [undefined, null, 42, {}, [], "", "   "]) {
      const check = validateTargetUrl(value as unknown);
      assert.equal(check.ok, false, `${JSON.stringify(value)} should be rejected`);
    }
  });

  it("rejects unsupported schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "data:text/html,<h1>hi</h1>",
      "javascript:alert(1)",
      "gopher://example.com",
      "ws://example.com",
      "blob:https://example.com/x",
    ]) {
      const check = validateTargetUrl(url);
      assert.equal(check.ok, false, `${url} should be rejected`);
      if (!check.ok) assert.equal(check.code, "unsupported_scheme", `${url} -> ${check.code}`);
    }
  });

  it("rejects embedded credentials", () => {
    const check = validateTargetUrl("https://user:pass@example.com");
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.code, "credentials_not_allowed");
  });

  it("rejects absurdly long URLs", () => {
    const check = validateTargetUrl(`https://example.com/${"a".repeat(2100)}`);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.code, "url_too_long");
  });
});

describe("SSRF protection", () => {
  const blocked = [
    "http://localhost/",
    "http://localhost:3000/admin",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/x",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://10.255.255.255/",
    "http://172.16.0.1/",
    "http://172.31.255.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://printer.local/",
    "http://service.internal/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:10.0.0.1]/",
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      const check = validateTargetUrl(url);
      assert.equal(check.ok, false, `${url} must be blocked`);
      if (!check.ok) assert.equal(check.code, "private_host", `${url} -> ${check.code}`);
      assert.equal(isAllowedUrl(url), false);
    });
  }

  it("blocks obfuscated loopback forms", () => {
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/"]) {
      assert.equal(isAllowedUrl(url), false, `${url} must be blocked`);
    }
  });

  it("still allows public addresses", () => {
    for (const url of ["http://8.8.8.8/", "https://example.com", "http://172.32.0.1/", "http://11.0.0.1/"]) {
      assert.equal(isAllowedUrl(url), true, `${url} should be allowed`);
    }
  });

  it("classifies hostnames directly", () => {
    assert.equal(isPrivateHostname("localhost"), true);
    assert.equal(isPrivateHostname("127.0.0.1"), true);
    assert.equal(isPrivateHostname("192.168.0.10"), true);
    assert.equal(isPrivateHostname("example.com"), false);
  });

  it("allowPrivateHosts opens private ranges but never other protections", () => {
    assert.equal(validateTargetUrl("http://127.0.0.1:4000/x", { allowPrivateHosts: true }).ok, true);
    assert.equal(validateTargetUrl("file:///etc/passwd", { allowPrivateHosts: true }).ok, false);
    assert.equal(validateTargetUrl("https://u:p@127.0.0.1/", { allowPrivateHosts: true }).ok, false);
  });
});
