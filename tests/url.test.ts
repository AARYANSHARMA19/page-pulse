import { describe, expect, it } from "vitest";
import { assertPublicHostname, isBlockedAddress, normalizeAuditUrl } from "../src/url.js";

describe("URL safety and normalization", () => {
  it("canonicalizes fragments and default ports", () => {
    expect(normalizeAuditUrl("HTTPS://Example.com:443/path#section")).toBe("https://example.com/path");
    expect(normalizeAuditUrl("http://Example.com:80")).toBe("http://example.com/");
  });

  it("rejects unsupported protocols and credentials", () => {
    expect(() => normalizeAuditUrl("ftp://example.com/file")).toThrowError(/Only http/);
    expect(() => normalizeAuditUrl("https://user:pass@example.com")).toThrowError(/user information/);
  });

  it("blocks common private and special-use address ranges", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.0.0.2")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("rejects hostnames that resolve to a private address", async () => {
    await expect(assertPublicHostname("internal.example", async () => [{ address: "192.168.1.4", family: 4 }])).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });
});
