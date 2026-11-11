/**
 * Host/Origin guard for the local HTTP servers (`lotl mcp --http`,
 * `lotl memory serve`). Blocks DNS rebinding: a web page that rebinds its own
 * name to 127.0.0.1 sends `Host: attacker.example`, and browsers always send
 * `Origin` on cross-site fetches.
 *
 * Policy: Host must be a loopback name (or the configured bind host, or listed
 * in LOTL_HTTP_ALLOWED_HOSTS). Origin, when present, must be a loopback origin
 * (or listed in LOTL_HTTP_ALLOWED_ORIGINS). A missing Origin is fine: CLI and
 * agent clients do not send one.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type HttpGuardOptions = {
  /** Host the server was told to bind; accepted in addition to loopback. */
  bindHost?: string;
};

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Split a Host header value into name and optional port. null = malformed. */
function parseHostHeader(value: string): { name: string; port: string } | null {
  const v = value.trim().toLowerCase();
  const m = v.startsWith("[")
    ? /^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(v)
    : /^([a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(v);
  return m ? { name: m[1]!, port: m[2] ?? "" } : null;
}

function bracket(name: string): string {
  return name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
}

function hostAllowed(header: string | undefined, opts: HttpGuardOptions): boolean {
  if (!header) return false;
  const parsed = parseHostHeader(header);
  if (!parsed) return false;
  if (LOOPBACK_HOSTS.has(parsed.name)) return true;
  if (opts.bindHost && parsed.name === bracket(opts.bindHost.toLowerCase())) return true;
  const full = parsed.port ? `${parsed.name}:${parsed.port}` : parsed.name;
  // An env entry without a port admits any port; with a port it must match.
  return csvEnv("LOTL_HTTP_ALLOWED_HOSTS").some((e) => e === full || e === parsed.name);
}

function originAllowed(header: string | undefined, opts: HttpGuardOptions): boolean {
  if (header === undefined) return true;
  const origin = header.trim().toLowerCase();
  if (csvEnv("LOTL_HTTP_ALLOWED_ORIGINS").includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== origin) return false; // reject paths, userinfo, odd forms
  if (LOOPBACK_HOSTS.has(url.hostname)) return true;
  return !!opts.bindHost && url.hostname === bracket(opts.bindHost.toLowerCase());
}

/** Returns an error message when the request must be refused, else null. */
export function checkHostOrigin(headers: IncomingHttpHeaders, opts: HttpGuardOptions = {}): string | null {
  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (!hostAllowed(host, opts)) return "Forbidden: invalid Host header";
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (!originAllowed(origin, opts)) return "Forbidden: invalid Origin header";
  return null;
}

/** Answers 403 and returns true when refused. Call before reading any body. */
export function rejectForbiddenRequest(req: IncomingMessage, res: ServerResponse, opts: HttpGuardOptions = {}): boolean {
  const error = checkHostOrigin(req.headers, opts);
  if (!error) return false;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
  return true;
}
