// Link health checking for registered course-resource URLs.
//
// Design notes:
// - Every hop of a redirect chain is validated (scheme, credentials, host,
//   resolved addresses) before a request is issued.
// - The validated addresses are passed to the production transport, whose
//   connection-time `lookup` can only return them, while `Host` and TLS SNI
//   keep the original hostname. This closes the DNS rebinding gap between
//   validation and connection.
// - The network is fully injectable (`transport` + `lookup`) so tests can use a
//   loopback server and a resolved-address fixture without weakening the
//   production defaults.
// - Nothing here writes or deletes data: results are reports, never decisions
//   about whether a resource exists.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const LINK_STATUSES = ['reachable', 'missing', 'unknown', 'unchecked'];
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_PER_DOMAIN = 1;
export const DEFAULT_MAX_REDIRECTS = 5;
export const BODY_SAMPLE_BYTES = 8 * 1024;

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const HEAD_FALLBACK_CODES = new Set([405, 501]);

const USER_AGENT =
  'USTC-course-navigation-link-monitor/1.0 (+https://github.com/; course resource link check)';

// ---------------------------------------------------------------------------
// URL and address policy

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link local, includes cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4],
].map(([base, prefix]) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ipv4ToInt(base) & mask) >>> 0, mask };
});

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value >>> 0;
}

export function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return BLOCKED_IPV4_RANGES.some(
    ({ network, mask }) => ((value & mask) >>> 0) === network,
  );
}

function parseIpv6(ip) {
  if (!net.isIPv6(ip)) return null;
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2]);
    if (v4 === null) return null;
    text =
      dotted[1] +
      `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const v = parseInt(group, 16);
    bytes.push((v >> 8) & 255, v & 255);
  }
  return bytes;
}

export function isBlockedIpv6(ip) {
  const bytes = parseIpv6(ip);
  if (!bytes) return true;
  const allZero = bytes.every((b) => b === 0);
  if (allZero) return true;
  const loopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (loopback) return true;
  // IPv4-mapped ::ffff:0:0/96
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (bytes[0] === 0xff) return true; // multicast
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return true; // 2001:db8::/32 documentation
  }
  return false;
}

export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

function normalizeHostname(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.home.arpa',
  '.lan',
];

export function isBlockedHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === 'localhost') return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // Single-label names are resolved by local search domains, never by public DNS.
  if (!host.includes('.') && !host.includes(':') && net.isIP(host) === 0) return true;
  return false;
}

/**
 * Parse and reject URLs that can never be checked safely.
 * Returns `{ok: true, url}` or `{ok: false, reason}` where reason is a stable
 * machine-readable code used in monitoring reports.
 */
export function parsePublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials_in_url' };
  }
  if (!url.hostname) return { ok: false, reason: 'invalid_url' };
  url.hash = '';
  return { ok: true, url };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry ? entry[1] : null;
}

// ---------------------------------------------------------------------------
// Address validation for one hop

function normalizeAddressList(value) {
  const list = Array.isArray(value) ? value : [value];
  const addresses = [];
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    const family = net.isIP(address ?? '');
    if (!family) continue;
    addresses.push({ address, family });
  }
  return addresses;
}

async function validateHop(url, { lookup, allowPrivate }) {
  const parsed = parsePublicHttpUrl(url);
  if (!parsed.ok) return parsed;

  const host = normalizeHostname(parsed.url.hostname);
  if (!allowPrivate && isBlockedHostname(host)) {
    return { ok: false, reason: 'private_host' };
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (!allowPrivate && isBlockedIp(host)) return { ok: false, reason: 'private_host' };
    return {
      ok: true,
      url: parsed.url,
      addresses: [{ address: host, family: literalFamily }],
    };
  }

  let resolved;
  try {
    resolved = await lookup(host);
  } catch (error) {
    if (allowPrivate) return { ok: true, url: parsed.url, addresses: null };
    return {
      ok: false,
      reason: 'dns_error',
      detail: error?.code ?? error?.message ?? 'lookup failed',
    };
  }
  const addresses = normalizeAddressList(resolved);
  if (addresses.length === 0) {
    if (allowPrivate) return { ok: true, url: parsed.url, addresses: null };
    return { ok: false, reason: 'dns_error' };
  }
  if (!allowPrivate && addresses.some((entry) => isBlockedIp(entry.address))) {
    return { ok: false, reason: 'private_host' };
  }
  return { ok: true, url: parsed.url, addresses };
}

// ---------------------------------------------------------------------------
// Classification

export function classifyTransportError(error) {
  const name = error?.name ?? '';
  const code = error?.code ?? error?.cause?.code ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { reason: 'timeout', detail: name };
  }
  if (typeof code === 'string' && code.startsWith('EAI_')) {
    return { reason: 'dns_error', detail: code };
  }
  if (code === 'ENOTFOUND') return { reason: 'dns_error', detail: code };
  if (code === 'ECONNREFUSED') return { reason: 'connection_refused', detail: code };
  if (code === 'ECONNRESET') return { reason: 'connection_reset', detail: code };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { reason: 'timeout', detail: code };
  }
  return {
    reason: 'network_error',
    detail: code || error?.message || 'request failed',
  };
}

const LOGIN_PATH = /\/(?:login|log-in|signin|sign-in|sign_in|auth|cas|sso|oauth|passport)(?:[/?#._-]|$)/i;
const LOGIN_BODY =
  /(?:<title>\s*(?:sign in|log in|登录|统一身份认证)|please (?:sign in|log in)|请先登录|统一身份认证)/i;
const ERROR_PAGE_BODY =
  /(?:<title>\s*(?:404|not found|page not found|页面不存在|找不到页面)|the page you(?:'| a)re looking for|页面不存在|找不到该页面)/i;

function looksLikeLogin(originalUrl, finalUrl, text) {
  let finalUrlObject;
  let originalUrlObject;
  try {
    finalUrlObject = new URL(finalUrl);
    originalUrlObject = new URL(originalUrl);
  } catch {
    return false;
  }
  if (
    finalUrlObject.href !== originalUrlObject.href &&
    (LOGIN_PATH.test(finalUrlObject.pathname + finalUrlObject.search) ||
      /^(?:login|passport|signin|sso|auth|cas)\./i.test(finalUrlObject.hostname))
  ) {
    return true;
  }
  return LOGIN_BODY.test(text ?? '');
}

export function classifyResponse({ status, originalUrl, finalUrl, text = '' }) {
  if (status >= 200 && status < 300) {
    if (looksLikeLogin(originalUrl, finalUrl, text)) {
      return { status: 'unknown', reason: 'login_required' };
    }
    if (ERROR_PAGE_BODY.test(text ?? '')) {
      return { status: 'unknown', reason: 'error_page' };
    }
    return { status: 'reachable', reason: 'ok' };
  }
  if (status === 401 || status === 403) {
    return { status: 'unknown', reason: 'auth_required' };
  }
  if (status === 404 || status === 410) {
    return { status: 'missing', reason: 'not_found' };
  }
  if (status === 429) {
    return { status: 'unknown', reason: 'rate_limited' };
  }
  if (status >= 500 && status <= 599) {
    return { status: 'unknown', reason: 'server_error' };
  }
  return { status: 'unknown', reason: `http_${status}` };
}

// ---------------------------------------------------------------------------
// Transport

/**
 * Real HTTP transport with DNS pinning.
 *
 * `checkLinks` validates a hop and passes the approved address list; the
 * connection then uses a custom `lookup` that can only return those addresses,
 * while `Host`/TLS SNI keep the original hostname. This closes the
 * validate-then-resolve (DNS rebinding) gap. Callers without `addresses`
 * (the GitHub API client on its fixed origin) use the platform resolver.
 *
 * Redirects are returned to the caller (`redirect: manual` semantics), so
 * every hop is re-validated and re-pinned by `checkLinks`.
 */
export function createHttpTransport() {
  return async function transport({
    url,
    method = 'HEAD',
    headers = {},
    body = null,
    signal,
    maxBytes = BODY_SAMPLE_BYTES,
    addresses = null,
  }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError(`unsupported protocol: ${parsed.protocol}`);
    }
    const secure = parsed.protocol === 'https:';
    const library = secure ? https : http;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!hostname) throw new TypeError('URL has no hostname');

    const options = {
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: { ...headers, host: parsed.host },
      agent: false,
      signal,
    };
    if (body !== null && body !== undefined) {
      options.headers['content-length'] = Buffer.byteLength(body);
    }
    if (secure && net.isIP(hostname) === 0) {
      options.servername = hostname;
    }
    if (Array.isArray(addresses) && addresses.length > 0) {
      const pinned = addresses.map((entry) => ({
        address: entry.address,
        family: entry.family ?? net.isIP(entry.address),
      }));
      options.lookup = (lookupHostname, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) {
          callback(null, pinned);
        } else {
          callback(null, pinned[0].address, pinned[0].family);
        }
      };
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        handler(value);
      };

      const request = library.request(options, (response) => {
        const status = response.statusCode ?? 0;
        const responseHeaders = response.headers;
        if (method === 'HEAD') {
          response.resume();
          response.on('end', () => finish(resolve, { status, headers: responseHeaders, text: '' }));
          response.on('error', (error) => finish(reject, error));
          return;
        }

        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          if (received >= maxBytes) return;
          const take = chunk.length > maxBytes - received
            ? chunk.subarray(0, maxBytes - received)
            : chunk;
          chunks.push(take);
          received += take.length;
          if (received >= maxBytes) {
            finish(resolve, {
              status,
              headers: responseHeaders,
              text: Buffer.concat(chunks).toString('utf8'),
            });
            response.destroy();
          }
        });
        response.on('end', () => finish(resolve, {
          status,
          headers: responseHeaders,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
        response.on('error', (error) => finish(reject, error));
      });

      request.on('error', (error) => finish(reject, error));
      request.end(body ?? undefined);
    });
  };
}

// ---------------------------------------------------------------------------
// Checking

function createLimiter(max) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    if (active >= max) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

async function checkOne(originalUrl, ctx) {
  const checkedAt = new Date(ctx.now()).toISOString();
  let current = originalUrl;
  let method = 'HEAD';
  let httpStatus = null;
  let redirects = 0;

  for (;;) {
    const hop = await validateHop(current, ctx);
    if (!hop.ok) {
      return {
        url: originalUrl,
        status: 'unknown',
        http_status: httpStatus,
        reason: hop.reason,
        checked_at: checkedAt,
        final_url: current,
      };
    }

    let response;
    try {
      const requestDomain = normalizeHostname(hop.url.hostname);
      response = await ctx.withDomain(requestDomain, () =>
        ctx.globalLimit(() => ctx.transport({
          url: current,
          method,
          headers: {
            'user-agent': USER_AGENT,
            accept: '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
          },
          signal: AbortSignal.timeout(ctx.timeoutMs),
          maxBytes: BODY_SAMPLE_BYTES,
          addresses: hop.addresses ?? null,
        })));
    } catch (error) {
      const classified = classifyTransportError(error);
      return {
        url: originalUrl,
        status: 'unknown',
        http_status: httpStatus,
        reason: classified.reason,
        checked_at: checkedAt,
        final_url: current,
      };
    }

    httpStatus = response.status;
    const location = headerValue(response.headers, 'location');

    if (REDIRECT_CODES.has(response.status)) {
      if (!location) {
        return {
          url: originalUrl,
          status: 'unknown',
          http_status: httpStatus,
          reason: 'redirect_without_location',
          checked_at: checkedAt,
          final_url: current,
        };
      }
      if (redirects >= ctx.maxRedirects) {
        return {
          url: originalUrl,
          status: 'unknown',
          http_status: httpStatus,
          reason: 'too_many_redirects',
          checked_at: checkedAt,
          final_url: current,
        };
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        return {
          url: originalUrl,
          status: 'unknown',
          http_status: httpStatus,
          reason: 'invalid_redirect',
          checked_at: checkedAt,
          final_url: current,
        };
      }
      next.hash = '';
      current = next.href;
      redirects += 1;
      continue;
    }

    if (HEAD_FALLBACK_CODES.has(response.status) && method === 'HEAD') {
      // Some static hosts reject HEAD; GET with a tiny body sample is the
      // documented fallback, still bounded by the same timeout.
      method = 'GET';
      continue;
    }

    const classified = classifyResponse({
      status: response.status,
      originalUrl: hop.url.href,
      finalUrl: current,
      text: response.text,
    });
    return {
      url: originalUrl,
      status: classified.status,
      http_status: httpStatus,
      reason: classified.reason,
      checked_at: checkedAt,
      final_url: current,
    };
  }
}

export async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

/**
 * Check a list of URLs. Results follow the input order after exact-string
 * dedupe. Checks never throw for a single bad URL; they return `unknown`.
 */
export async function checkLinks(urls, options = {}) {
  const {
    transport = createHttpTransport(),
    lookup = defaultLookup,
    now = Date.now,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    perDomain = DEFAULT_PER_DOMAIN,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    allowPrivate = false,
  } = options;

  const unique = [...new Set(urls.map((url) => String(url)))];
  const resultByUrl = new Map();
  const globalLimit = createLimiter(Math.max(1, concurrency));
  const domainLimiters = new Map();

  function withDomain(domain, fn) {
    let limiter = domainLimiters.get(domain);
    if (!limiter) {
      limiter = createLimiter(Math.max(1, perDomain));
      domainLimiters.set(domain, limiter);
    }
    return limiter(fn);
  }

  const ctx = {
    transport,
    lookup,
    now,
    timeoutMs,
    maxRedirects,
    allowPrivate,
    globalLimit,
    withDomain,
  };

  await Promise.all(
    unique.map(async (url) => {
      resultByUrl.set(url, await checkOne(url, ctx));
    }),
  );

  return unique.map((url) => resultByUrl.get(url));
}

export function summarizeLinks(links) {
  const summary = { reachable: 0, missing: 0, unknown: 0, unchecked: 0, total: links.length };
  for (const link of links) {
    if (Object.hasOwn(summary, link.status)) summary[link.status] += 1;
  }
  return summary;
}
