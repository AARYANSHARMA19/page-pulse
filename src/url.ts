import dns from "node:dns/promises";
import net from "node:net";
import { AppError } from "./errors.js";

const allowedProtocols = new Set(["http:", "https:"]);

export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export function normalizeAuditUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(400, "INVALID_URL", "url must be a non-empty string.");
  }

  if (value.length > 2048) {
    throw new AppError(400, "INVALID_URL", "url must be 2048 characters or fewer.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError(400, "INVALID_URL", "url must be an absolute HTTP(S) URL.");
  }

  if (!allowedProtocols.has(parsed.protocol)) {
    throw new AppError(400, "INVALID_URL", "Only http:// and https:// URLs are supported.");
  }

  if (parsed.username || parsed.password) {
    throw new AppError(400, "INVALID_URL", "URLs containing user information are not supported.");
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
    parsed.port = "";
  }
  if (parsed.pathname.length === 0) {
    parsed.pathname = "/";
  }

  return parsed.href;
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((result, octet) => (result * 256) + Number(octet), 0) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const ranges: Array<[number, number]> = [
    [ipv4ToNumber("0.0.0.0"), ipv4ToNumber("0.255.255.255")],
    [ipv4ToNumber("10.0.0.0"), ipv4ToNumber("10.255.255.255")],
    [ipv4ToNumber("100.64.0.0"), ipv4ToNumber("100.127.255.255")],
    [ipv4ToNumber("127.0.0.0"), ipv4ToNumber("127.255.255.255")],
    [ipv4ToNumber("169.254.0.0"), ipv4ToNumber("169.254.255.255")],
    [ipv4ToNumber("172.16.0.0"), ipv4ToNumber("172.31.255.255")],
    [ipv4ToNumber("192.0.0.0"), ipv4ToNumber("192.0.0.255")],
    [ipv4ToNumber("192.0.2.0"), ipv4ToNumber("192.0.2.255")],
    [ipv4ToNumber("192.168.0.0"), ipv4ToNumber("192.168.255.255")],
    [ipv4ToNumber("198.18.0.0"), ipv4ToNumber("198.19.255.255")],
    [ipv4ToNumber("198.51.100.0"), ipv4ToNumber("198.51.100.255")],
    [ipv4ToNumber("203.0.113.0"), ipv4ToNumber("203.0.113.255")],
    [ipv4ToNumber("224.0.0.0"), ipv4ToNumber("255.255.255.255")],
  ];
  return ranges.some(([start, end]) => value >= start && value <= end);
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const mappedIpv4 = normalized.slice(normalized.lastIndexOf(":") + 1);
    if (net.isIP(mappedIpv4) === 4) {
      return isBlockedIpv4(mappedIpv4);
    }
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:");
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 4 ? isBlockedIpv4(address) : family === 6 ? isBlockedIpv6(address) : true;
}

export async function assertPublicHostname(
  hostname: string,
  lookup: DnsLookup = dns.lookup as DnsLookup,
): Promise<void> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    throw new AppError(400, "UNSAFE_URL", "Private and local network targets are not allowed.");
  }

  const literalFamily = net.isIP(normalized);
  const addresses = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await lookup(normalized, { all: true, verbatim: true }).catch(() => {
        throw new AppError(502, "DNS_LOOKUP_FAILED", "The target hostname could not be resolved.");
      });

  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new AppError(400, "UNSAFE_URL", "Private and local network targets are not allowed.");
  }
}
