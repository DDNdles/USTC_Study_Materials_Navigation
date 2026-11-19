import { writeFile } from 'node:fs/promises';

const { GITHUB_REPOSITORY, GOATCOUNTER_SITE } = process.env;
const token = process.env.TRAFFIC_TOKEN || process.env.GITHUB_TOKEN;
const collected_at = new Date().toISOString();
const site_views_date_utc = collected_at.slice(0, 10);
const repo_views_date_utc = new Date(Date.parse(`${site_views_date_utc}T00:00:00Z`) - 86_400_000)
  .toISOString().slice(0, 10);

async function readStats(label, url, parse, headers) {
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parse(await response.json());
  } catch (error) {
    console.warn(`${label} unavailable: ${error.message}`);
    return null;
  }
}

if (GOATCOUNTER_SITE && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(GOATCOUNTER_SITE)) {
  throw new Error('GOATCOUNTER_SITE must be a GoatCounter subdomain, not a URL');
}
if (token && !/^[\w.-]+\/[\w.-]+$/u.test(GITHUB_REPOSITORY ?? '')) {
  throw new Error('GITHUB_REPOSITORY must be owner/repo');
}

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const goatCount = ({ count: value }) => {
  if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(value)) return null;
  return count(Number(value.replaceAll(',', '')));
};
const counter = GOATCOUNTER_SITE ? `https://${GOATCOUNTER_SITE}.goatcounter.com/counter/TOTAL.json` : null;
// TOTAL uses UTC. Omit end: a date-only end in GoatCounter means midnight.
const [repo, site_total_views, site_views_today] = await Promise.all([
  token ? readStats('Repository traffic', `https://api.github.com/repos/${GITHUB_REPOSITORY}/traffic/views`,
    ({ count: total, views }) => ({
      repo_views_14d: count(total),
      repo_views_yesterday: Array.isArray(views)
        ? count(views.find(({ timestamp }) => timestamp?.slice(0, 10) === repo_views_date_utc)?.count)
        : null,
    }), { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }) : null,
  counter ? readStats('Site traffic total', counter, goatCount) : null,
  counter ? readStats('Site traffic today', `${counter}?start=${site_views_date_utc}`, goatCount) : null,
]);

await writeFile('data/traffic.local.json', JSON.stringify({
  repo_views_date_utc, site_views_date_utc, collected_at,
  repo_views_yesterday: repo?.repo_views_yesterday ?? null,
  repo_views_14d: repo?.repo_views_14d ?? null, site_total_views, site_views_today,
}, null, 2) + '\n');
