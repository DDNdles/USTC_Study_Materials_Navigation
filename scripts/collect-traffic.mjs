import { writeFile } from 'node:fs/promises';

const { GITHUB_REPOSITORY, TRAFFIC_TOKEN, GOATCOUNTER_SITE } = process.env;

async function readCount(label, url, parse, headers) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const count = parse(await response.json());
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid count');
    return count;
  } catch (error) {
    console.warn(`${label} unavailable: ${error.message}`);
    return null;
  }
}

if (GOATCOUNTER_SITE && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(GOATCOUNTER_SITE)) {
  throw new Error('GOATCOUNTER_SITE must be a GoatCounter subdomain, not a URL');
}
if (TRAFFIC_TOKEN && !/^[\w.-]+\/[\w.-]+$/u.test(GITHUB_REPOSITORY ?? '')) {
  throw new Error('GITHUB_REPOSITORY must be owner/repo');
}

const [repo_views_14d, site_total_views] = await Promise.all([
  TRAFFIC_TOKEN ? readCount('Repository traffic', `https://api.github.com/repos/${GITHUB_REPOSITORY}/traffic/views`,
    ({ count }) => count, { Authorization: `Bearer ${TRAFFIC_TOKEN}`, Accept: 'application/vnd.github+json' }) : null,
  GOATCOUNTER_SITE ? readCount('Site traffic', `https://${GOATCOUNTER_SITE}.goatcounter.com/counter/TOTAL.json`,
    ({ count }) => {
      if (typeof count !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(count)) return null;
      return Number(count.replaceAll(',', ''));
    }) : null,
]);

await writeFile('data/traffic.local.json', JSON.stringify({ repo_views_14d, site_total_views }, null, 2) + '\n');
