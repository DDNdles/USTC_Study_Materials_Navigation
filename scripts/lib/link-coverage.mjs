/**
 * 外链健康覆盖：把 data/monitoring.json 的记录投影到站点实际引用的网址上。
 *
 * 构建报告、来源页与离线校验共用这里的口径，避免各自解释 status/reason：
 * - 统计分母是站点引用的网址（资料位置与来源主页），不是监控文件的行数；
 * - 监控文件里未被引用的条目是历史/过期条目，单列而不计入；
 * - 未监控的网址算“从未检查”，未收到 HTTP 响应的检查不能写成“可访问”。
 */
import {
  HEALTH_EVIDENCE_LABELS,
  summarizeHealth,
} from '../../site/assets/health-evidence.mjs';

/** 只保留可解析的 http(s) 网址，用于与监控记录对齐。 */
export function normalizedHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** 监控记录按原网址与规范化网址双向索引。 */
export function monitoringLinkMap(dataset) {
  const map = new Map();
  for (const link of dataset.monitoring?.links ?? []) {
    if (!link || typeof link.url !== 'string') continue;
    map.set(link.url, link);
    const normalized = normalizedHttpUrl(link.url);
    if (normalized && normalized !== link.url) map.set(normalized, link);
  }
  return map;
}

/** 站点实际引用的网址：资料位置（页面/下载页/直链）与来源主页。 */
function siteUrlUniverse(dataset) {
  const urls = new Set();
  for (const resource of dataset.resources) {
    for (const location of resource.locations ?? []) {
      for (const url of [location.page_url, location.download_page, location.download_url]) {
        if (url) urls.add(url);
      }
    }
  }
  for (const source of dataset.sources) {
    if (source.url) urls.add(source.url);
  }
  return urls;
}

/**
 * 覆盖与证据汇总：证据分类计数 + 统计范围（引用/已监控/未监控/历史条目）+ 预检结论。
 * 每个引用网址按它的监控记录（没有记录即 null）归入一类，六类合计等于引用网址数。
 */
export function summarizeLinkCoverage(dataset) {
  const universe = siteUrlUniverse(dataset);
  const monitoringLinks = monitoringLinkMap(dataset);
  const monitoredEntries = [];
  let monitored = 0;
  for (const url of [...universe].sort()) {
    const entry = monitoringLinks.get(url) ?? monitoringLinks.get(normalizedHttpUrl(url)) ?? null;
    if (entry) monitored += 1;
    monitoredEntries.push(entry);
  }
  let stale = 0;
  for (const link of dataset.monitoring?.links ?? []) {
    if (!link || typeof link.url !== 'string') continue;
    if (universe.has(link.url)) continue;
    const normalized = normalizedHttpUrl(link.url);
    if (normalized && universe.has(normalized)) continue;
    stale += 1;
  }
  const summary = summarizeHealth(monitoredEntries);
  return {
    ...summary,
    universe: universe.size,
    monitored,
    unmonitored: universe.size - monitored,
    stale,
    checkedAt: dataset.monitoring?.checked_at ?? null,
    // 所有已监控网址都停在 DNS/私网地址预检，且没有任何条目收到过 HTTP 响应：
    // 本次检查确实没有向任何服务器发出请求。
    preflightOnly:
      monitored > 0 &&
      summary.preflight === monitored &&
      (summary.httpResponses ?? 0) === 0 &&
      (summary.no_response ?? 0) === 0,
  };
}

/** 证据分类计数的可读文本；六类互斥，httpResponses 与类别计数有重叠，不相加。 */
export function healthCountsText(health) {
  const count = (key) => health?.[key] ?? 0;
  const labels = HEALTH_EVIDENCE_LABELS;
  return [
    `实际收到过 HTTP 响应的条目 ${count('httpResponses')}（${labels.responded} ${count('responded')}、${labels.auth} ${count('auth')}、${labels.missing} ${count('missing')}）`,
    `${labels.preflight} ${count('preflight')}`,
    `${labels.no_response} ${count('no_response')}`,
    `${labels.unchecked} ${count('unchecked')}`,
  ].join('；');
}

/**
 * 检查范围说明。统计分母是站点实际引用的网址，监控文件只覆盖其中一部分；
 * 具体分类计数（含“从未检查”）由 healthCountsText 给出，这里不重复。
 * 监控文件里未被引用的条目是历史条目，单列且不参与计数。
 */
export function healthScopeText(health) {
  const stale =
    health.stale > 0 ? `；监控文件另有 ${health.stale} 个当前未被引用的历史条目（不计入统计）` : '';
  return `统计分母是站点引用的 ${health.universe} 个网址，监控文件覆盖其中 ${health.monitored} 个${stale}`;
}

/** 环境与判定口径说明：没有响应时不得写成“已检查”。 */
export function healthEvidenceNotes(health) {
  const notes = [];
  if (health.preflightOnly) {
    notes.push(
      '本次检查没有收到任何 HTTP 响应：已检查的网址全部在 DNS/私网地址安全预检阶段被拦截，请求没有发出，因此既不能证明链接可访问，也不能据此判为失效。',
    );
  } else if ((health.httpResponses ?? 0) === 0 && (health.no_response ?? 0) > 0) {
    notes.push(
      '本次检查发起过连接尝试，但没有收到 HTTP 响应（超时或连接失败）；这只代表当次网络结果，不能据此判为失效。',
    );
  }
  if (health.unmonitored > 0) {
    notes.push('从未检查的网址没有监控记录，与“已检查但无法确认”不同。');
  }
  return notes;
}

export const HEALTH_METHOD_NOTE =
  '只有确认的 404/410 计为“无法找到”。需登录/认证说明服务器有响应但要求身份验证；目录列表页、软错误页、超时与预检拦截都不证明文件可下载或不存在。重定向中前一跳已收到响应、最终目标被预检拦截的条目归入预检中止，但仍计入“实际收到过 HTTP 响应”的条目。';
