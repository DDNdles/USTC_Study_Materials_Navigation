#!/usr/bin/env node
/**
 * 离线构建：先验证数据，再生成
 *   data/with-resources/<code>.json、data/without-resources/<code>.json
 *   data/generated-files.json（本构建自己的产物清单）
 *   docs/sources-and-search.md（来源、检索记录与致谢）
 *   data/agent/（课程名索引与逐课资料；同时发布到 dist/data/agent/）
 *   dist/（站点、catalog.json、sources.html）
 *
 * 只更新清单列出的自有文件；不联网、不抓取资料、不执行来源项目代码。
 */
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCESS_LABELS,
  ACCESS_LEVELS,
  COURSE_KIND_LABELS,
  COURSE_KINDS,
  computeResearchCoverage,
  EXAM_FORM_LABELS,
  EXAM_FORMS,
  EXAM_KIND_LABELS,
  EXAM_KINDS,
  formatAcademicYearLabel,
  generatePartitionFiles,
  LINK_STATUS_LABELS,
  LINK_STATUSES,
  loadGeneratedManifest,
  loadRepository,
  normalizePageKind,
  RESEARCH_OUTCOME_LABELS,
  RESOURCE_TYPE_LABELS,
  RESOURCE_TYPES,
  ROOT,
  SOURCE_KIND_LABELS,
  validateRepository,
} from './lib/data.mjs';
import {
  HEALTH_METHOD_NOTE,
  healthCountsText,
  healthEvidenceNotes,
  healthScopeText,
  monitoringLinkMap,
  normalizedHttpUrl,
  summarizeLinkCoverage,
} from './lib/link-coverage.mjs';
import {
  safeExternalUrl,
  sortResources,
} from '../site/assets/search.mjs';


// 外链证据分类由站点、构建与校验共用同一套纯函数。
import {
  HEALTH_EVIDENCE_LABELS,
  classifyHealth,
} from '../site/assets/health-evidence.mjs';

const SITE_DIR = path.join(ROOT, 'site');
const DIST_DIR = path.join(ROOT, 'dist');
const DOCS_RELATIVE = 'docs/sources-and-search.md';
const MANIFEST_RELATIVE = 'data/generated-files.json';
// data.mjs 只导出 RESEARCH_CHANNELS（ID）；渠道中文名仅用于本文件的可读报告。
const CHANNEL_LABELS = {
  github: 'GitHub',
  icourse: '评课社区',
  web: '公开网页',
  catalog: '官方开课目录',
};

/* ------------------------------ 小工具 ------------------------------ */

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'));
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function md(value) {
  return oneLine(value).replace(/\|/g, '\\|');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function enumItems(values, labels) {
  const list = Array.isArray(values) ? values : [];
  return list.map((value) => {
    const id = typeof value === 'string' ? value : value?.id;
    const label =
      typeof value === 'object' && value?.label
        ? value.label
        : (labels?.[id] ?? id);
    return { id, label };
  });
}

function issueLine(issue) {
  const location = [issue?.file, issue?.path].filter(Boolean).join(' ');
  return `${location ? `${location}: ` : ''}${issue?.message ?? String(issue)}`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function listSiteFiles(dir = SITE_DIR, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listSiteFiles(path.join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function isOwnedGeneratedPath(relativePath) {
  return (
    relativePath === DOCS_RELATIVE ||
    relativePath.startsWith('data/with-resources/') ||
    relativePath.startsWith('data/without-resources/') ||
    relativePath.startsWith('data/agent/') ||
    relativePath.startsWith('dist/')
  );
}

/* ------------------------------ 数据整理 ------------------------------ */

function projectResource(resource) {
  return {
    id: resource.id,
    type: resource.type,
    title: resource.title,
    authors: [...(resource.authors ?? [])],
    notes: resource.notes ?? '',
    coverage: {
      years: [...(resource.coverage?.years ?? [])],
      academic_years: [...(resource.coverage?.academic_years ?? [])],
      exam_kind: resource.coverage?.exam_kind ?? null,
      exam_form: resource.coverage?.exam_form ?? null,
      has_solutions: resource.coverage?.has_solutions ?? null,
      evidence_url: resource.coverage?.evidence_url ?? null,
      note: resource.coverage?.note ?? '',
    },
    locations: (resource.locations ?? []).map((location) => ({
      source_id: location.source_id,
      page_url: location.page_url,
      download_page: location.download_page ?? null,
      download_url: location.download_url ?? null,
      access: location.access,
      license_note: location.license_note ?? null,
      attribution: location.attribution ?? null,
      page_kind: location.page_kind ?? null,
    })),
    verified_at: resource.verified_at,
  };
}

/* 外链覆盖与证据分类见 scripts/lib/link-coverage.mjs（构建、来源页与校验共用）。 */

function buildCatalog(dataset) {
  const metadata = dataset.courseMetadata ?? {};
  const resourcesByCode = new Map();
  for (const resource of dataset.resources) {
    for (const code of resource.course_codes ?? []) {
      if (!resourcesByCode.has(code)) resourcesByCode.set(code, []);
      resourcesByCode.get(code).push(resource);
    }
  }

  const courses = dataset.courses.map((course) => {
    const meta = metadata[course.code];
    if (!meta) {
      throw new Error(`课程 ${course.code} 缺少 data/course-metadata.json 条目`);
    }
    const ownResources = sortResources(resourcesByCode.get(course.code) ?? []).map(projectResource);
    return {
      code: course.code,
      name: course.name,
      kind: meta.kind,
      tags: [...meta.tags],
      has_resources: ownResources.length > 0,
      resources: ownResources,
    };
  });
  courses.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const tagCounts = new Map();
  for (const course of courses) {
    for (const tag of course.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const tags = dataset.tags
    .filter((tag) => tagCounts.has(tag.id))
    .map((tag) => ({ id: tag.id, label: tag.label, course_count: tagCounts.get(tag.id) }));

  const usedSourceIds = new Set();
  const usedUrls = new Set();
  for (const resource of dataset.resources) {
    for (const location of resource.locations ?? []) {
      if (location.source_id) usedSourceIds.add(location.source_id);
      for (const url of [location.page_url, location.download_page, location.download_url]) {
        if (url) usedUrls.add(url);
      }
    }
  }
  const sources = dataset.sources
    .filter((source) => usedSourceIds.has(source.id))
    .map((source) => {
      if (source.url) usedUrls.add(source.url);
      return {
        id: source.id,
        name: source.name,
        url: source.url,
        maintainer: source.maintainer,
        kind: source.kind,
        notes: source.notes,
      };
    });

  const monitoringLinks = monitoringLinkMap(dataset);
  const linkEntries = new Map();
  for (const url of usedUrls) {
    const entry = monitoringLinks.get(url) ?? monitoringLinks.get(normalizedHttpUrl(url));
    if (!entry) continue;
    const projected = {
      url: entry.url,
      status: entry.status,
      // 证据分类：区分响应、预检拦截、无响应、需认证、确认缺失与未检查。
      evidence: classifyHealth(entry),
      http_status: entry.http_status ?? null,
      reason: entry.reason ?? null,
      checked_at: entry.checked_at ?? null,
      final_url: entry.final_url ?? null,
    };
    linkEntries.set(url, projected);
    const normalized = normalizedHttpUrl(url);
    if (normalized && normalized !== url) linkEntries.set(normalized, projected);
  }
  const links = {};
  for (const url of [...linkEntries.keys()].sort()) {
    links[url] = linkEntries.get(url);
  }

  const withResources = courses.filter((course) => course.has_resources).length;

  return {
    schema_version: 1,
    checked_at: dataset.monitoring?.checked_at ?? null,
    counts: {
      courses: courses.length,
      with_resources: withResources,
      without_resources: courses.length - withResources,
      resources: dataset.resources.length,
    },
    kinds: enumItems(COURSE_KINDS, COURSE_KIND_LABELS),
    resource_types: enumItems(RESOURCE_TYPES, RESOURCE_TYPE_LABELS),
    exam_kinds: enumItems(EXAM_KINDS, EXAM_KIND_LABELS),
    exam_forms: enumItems(EXAM_FORMS, EXAM_FORM_LABELS),
    access: enumItems(ACCESS_LEVELS, ACCESS_LABELS),
    link_statuses: enumItems(LINK_STATUSES, LINK_STATUS_LABELS),
    health_evidence: enumItems(Object.keys(HEALTH_EVIDENCE_LABELS), HEALTH_EVIDENCE_LABELS),
    tags,
    sources,
    links,
    courses,
  };
}

/* ------------------------------ 报告模型 ------------------------------ */

function sourceNameMap(dataset) {
  return new Map(dataset.sources.map((source) => [source.id, source.name]));
}

function resourceSourceNames(resource, names) {
  const result = [];
  for (const location of resource.locations ?? []) {
    const name = names.get(location.source_id) ?? location.source_id ?? '来源未登记';
    if (!result.includes(name)) result.push(name);
  }
  return result.length > 0 ? result.join('、') : '来源未登记';
}

function resourceYearText(resource) {
  const years = (resource.coverage?.years ?? []).filter((year) => Number.isInteger(year));
  if (years.length > 0) return years.map((year) => `${year} 年`).join('、');
  // 只有学年的资料只显示学年，不折算成公历年。
  return (resource.coverage?.academic_years ?? [])
    .map(formatAcademicYearLabel)
    .filter(Boolean)
    .join('、');
}

function isDirectPdf(downloadUrl) {
  const normalized = normalizedHttpUrl(downloadUrl);
  if (!normalized) return false;
  const url = new URL(normalized);
  return `${url.pathname}${url.search}`.toLowerCase().includes('.pdf');
}

function resourceUrlText(resource) {
  const location = (resource.locations ?? [])[0];
  if (!location) return '';
  // 优先具体文件，等价 URL 只显示一次；目录不能冒充文件。
  const url = location.download_url ?? location.page_url;
  const kind = normalizePageKind(location.page_kind);
  const suffix = kind === 'directory' ? '（资料目录）' : kind === 'file' ? '（文件页）' : '';
  return url ? ` ${url}${suffix}` : '';
}

function resourceLine(resource, names) {
  const sources = resourceSourceNames(resource, names);
  const urlText = resourceUrlText(resource);
  const isQuiz = resource.type === 'homework' && resource.coverage?.exam_kind === 'quiz';
  if (resource.type === 'exams' || isQuiz) {
    const yearText = resourceYearText(resource) || '年份待确认';
    const kind = EXAM_KIND_LABELS[resource.coverage?.exam_kind] ?? '卷别不明';
    const form = EXAM_FORM_LABELS[resource.coverage?.exam_form] ?? '形式不明';
    const solutions =
      resource.coverage?.has_solutions === true
        ? '含解答'
        : resource.coverage?.has_solutions === false
          ? '无解答'
          : '解答情况不明';
    return `${yearText}（${kind}、${form}、${solutions}）：${resource.title} —— ${sources}${urlText}`;
  }
  const verified = resource.verified_at ? `；核验于 ${resource.verified_at}` : '';
  const yearPrefix = resourceYearText(resource);
  const label = yearPrefix ? `${yearPrefix}：${resource.title}` : resource.title;
  if (resource.type === 'books') {
    const direct = (resource.locations ?? []).some(
      (location) => location.access === 'public' && isDirectPdf(location.download_url),
    );
    const fullText = direct ? '；免登录公开全文 PDF' : '';
    return `${label} —— ${sources}${fullText}${verified}${urlText}`;
  }
  return `${label} —— ${sources}${verified}${urlText}`;
}

function buildReport(dataset, catalog, partitions) {
  const courseByCode = new Map(dataset.courses.map((course) => [course.code, course]));
  const names = sourceNameMap(dataset);
  const tagLabels = new Map(dataset.tags.map((tag) => [tag.id, tag.label]));
  const log = dataset.researchLog ?? [];

  const coverage = [];
  for (const course of catalog.courses) {
    if (course.resources.length === 0) continue;
    const byType = new Map();
    for (const resource of course.resources) {
      if (!byType.has(resource.type)) byType.set(resource.type, []);
      byType.get(resource.type).push(resource);
    }
    const groups = RESOURCE_TYPES.filter((type) => byType.has(type)).map((type) => ({
      type,
      label: RESOURCE_TYPE_LABELS[type] ?? type,
      lines: byType.get(type).map((resource) => resourceLine(resource, names)),
    }));
    coverage.push({
      code: course.code,
      name: course.name,
      kind: COURSE_KIND_LABELS[course.kind] ?? course.kind,
      tags: course.tags.map((tag) => tagLabels.get(tag) ?? tag),
      lines: groups,
    });
  }

  const courseLogs = new Map();
  const generalLogs = [];
  const unmappedLogs = [];
  const blocked = [];

  for (const entry of log) {
    const codes = (entry.course_codes ?? []).filter(Boolean);
    const isExcluded = ['blocked', 'tool', 'stub', 'candidate', 'duplicate'].includes(entry.outcome);
    if (isExcluded) {
      blocked.push({ ...entry, codes });
    }
    if (codes.length === 0) {
      generalLogs.push(entry);
      continue;
    }
    const knownCodes = codes.filter((code) => courseByCode.has(code));
    if (knownCodes.length === 0) {
      unmappedLogs.push(entry);
      continue;
    }
    for (const code of knownCodes) {
      if (!courseLogs.has(code)) courseLogs.set(code, []);
      courseLogs.get(code).push(entry);
    }
  }

  for (const entries of courseLogs.values()) {
    entries.sort(compareLogEntries);
  }
  generalLogs.sort(compareLogEntries);
  unmappedLogs.sort(compareLogEntries);
  blocked.sort((a, b) => {
    const codeA = a.codes[0] ?? '';
    const codeB = b.codes[0] ?? '';
    return codeA.localeCompare(codeB) || compareLogEntries(a, b);
  });

  const incomplete = computeResearchCoverage(dataset).missing.map((course) => course.code);

  const health = summarizeLinkCoverage(dataset);

  const sourceUsage = new Map();
  for (const resource of dataset.resources) {
    for (const location of resource.locations ?? []) {
      sourceUsage.set(location.source_id, (sourceUsage.get(location.source_id) ?? 0) + 1);
    }
  }

  return {
    dataset,
    catalog,
    partitions,
    coverage,
    sources: dataset.sources.map((source) => ({
      ...source,
      usage: sourceUsage.get(source.id) ?? 0,
    })),
    generalLogs,
    courseLogs: [...courseLogs.entries()]
      .map(([code, entries]) => ({
        code,
        name: courseByCode.get(code)?.name ?? '',
        entries,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    unmappedLogs,
    blocked,
    incomplete,
    health,
    checkedAt: dataset.monitoring?.checked_at ?? null,
    withResources: catalog.counts.with_resources,
    withoutResources: catalog.counts.without_resources,
    resources: dataset.resources.length,
    courseCount: dataset.courses.length,
    sourceCount: dataset.sources.length,
    usedSourceCount: catalog.sources.length,
    logCount: log.length,
  };
}

function compareLogEntries(a, b) {
  const dateA = String(a?.date ?? '');
  const dateB = String(b?.date ?? '');
  if (dateA !== dateB) return dateB.localeCompare(dateA);
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function logEntryLines(entry) {
  const lines = [];
  const channel = CHANNEL_LABELS[entry.channel] ?? entry.channel ?? '渠道未记录';
  const outcome = RESEARCH_OUTCOME_LABELS[entry.outcome] ?? entry.outcome ?? '结果未记录';
  const url = entry.url ? `<${entry.url}>` : '（未记录 URL）';
  lines.push(`- ${md(entry.date ?? '日期未记录')} · ${md(channel)} · ${md(outcome)} · ${md(url)}`);
  if (entry.query) lines.push(`  - 查询：${md(entry.query)}`);
  if (entry.checked_scope) lines.push(`  - 检查范围：${md(entry.checked_scope)}`);
  if (entry.notes) lines.push(`  - 说明：${md(entry.notes)}`);
  if (Array.isArray(entry.source_ids) && entry.source_ids.length > 0) {
    lines.push(`  - 来源 ID：${md(entry.source_ids.join('、'))}`);
  }
  if (Array.isArray(entry.course_codes) && entry.course_codes.length > 0) {
    lines.push(`  - 课程代码：${md(entry.course_codes.join('、'))}`);
  }
  return lines;
}

/* ------------------------------ Markdown ------------------------------ */

function renderDocs(report) {
  const lines = [];
  lines.push('# 来源、检索记录与致谢', '');
  lines.push(
    '> 本文件由 `npm run build` 从 `data/sources.json`、`data/research-log.jsonl`、`data/resources.json` 生成，请勿手工编辑。',
    '',
  );

  lines.push('## 概览', '');
  lines.push(`- 课程：${report.courseCount} 门（已收录资料 ${report.withResources} 门，暂未收录 ${report.withoutResources} 门）。`);
  lines.push(`- 资料：${report.resources} 条（按资料类型与试题年份的覆盖见下一节）。`);
  lines.push(`- 来源：${report.sourceCount} 个登记来源，其中 ${report.usedSourceCount} 个被正式资料引用。`);
  lines.push(`- 检索记录：${report.logCount} 条，覆盖 ${report.courseLogs.length} 门课程。`);
  lines.push(
    `- 查缺记录：${report.incomplete.length} 门课程尚未记录全部 GitHub / 评课社区 / 公开网页三条检索路径；未记录不等于没有资料，只表示本文件未覆盖。`,
  );
  if (report.incomplete.length > 0) {
    const sample = report.incomplete.slice(0, 20).join('、');
    lines.push(
      `  - 未齐全示例：${sample}${report.incomplete.length > 20 ? ` 等 ${report.incomplete.length} 门` : ''}。`,
    );
  }
  if (report.checkedAt) {
    lines.push(`- 外链检查：${report.checkedAt}；${healthScopeText(report.health)}。`);
    lines.push(`- 检查结果：${healthCountsText(report.health)}。`);
    for (const note of healthEvidenceNotes(report.health)) lines.push(`- ${note}`);
  } else {
    lines.push('- 外链检查：尚未运行；所有链接在站点上显示“从未检查”。');
  }
  lines.push('');

  lines.push('## 课程 × 资料类型 × 试题年份覆盖', '');
  lines.push(
    '只列出已有已确认资料的课程；未列出的课程属于“暂未收录”，清单见 `data/without-resources/`。一个资料条目可能被多门课程共用，但其归属须有课程代码证据。资料分为五类：试题与解析、作业/习题与小测、学习资料、教材与参考书、大作业与考核作品；小测归入作业类并保留原卷/回忆版等标记。只记录到学年的资料显示为“2025—2026 学年”一类学年区间，不折算成公历年。教材与参考书只列权利方公开、免登录、免费且直达完整 PDF 的全文。',
    '',
  );
  if (report.coverage.length === 0) {
    lines.push('（当前没有任何课程具备已确认资料。）', '');
  }
  for (const course of report.coverage) {
    lines.push(`### ${course.code} ${course.name}`, '');
    const meta = [course.kind, ...course.tags].filter(Boolean).join(' · ');
    if (meta) lines.push(`${meta}`, '');
    for (const group of course.lines) {
      lines.push(`- **${group.label}**`);
      for (const line of group.lines) lines.push(`  - ${md(line)}`);
    }
    lines.push('');
  }

  lines.push('## 来源清单与声明', '');
  lines.push(
    '第三方资料的具体授权以各来源与文件页面的声明为准，不因根目录的 MIT/CC 声明自动覆盖试卷、课件或教材。本站只导航公开页面，不转载文件。',
    '',
  );
  for (const source of report.sources) {
    lines.push(`### ${source.name}`, '');
    lines.push(`- 类型：${SOURCE_KIND_LABELS[source.kind] ?? source.kind}`);
    lines.push(`- 地址：${source.url ? `<${source.url}>` : '（未登记）'}`);
    if (source.maintainer) lines.push(`- 维护者：${md(source.maintainer)}`);
    if (source.github) {
      lines.push(
        `- GitHub：${md(source.github.owner)}/${md(source.github.repo)}（分支 ${md(source.github.branch)}）`,
      );
    }
    if (source.notes) lines.push(`- 说明：${md(source.notes)}`);
    lines.push(`- 被正式资料引用：${source.usage} 处`);
    lines.push('');
  }

  lines.push('## 检索记录', '');
  lines.push('记录的是实际打开或检查过的页面、目录与文件，不是机械拼接的查询 URL。受阻不等于没有资料。', '');

  if (report.generalLogs.length > 0) {
    lines.push('### 通用来源检索', '');
    for (const entry of report.generalLogs) {
      lines.push(...logEntryLines(entry));
    }
    lines.push('');
  }

  for (const course of report.courseLogs) {
    lines.push(`### ${course.code} ${course.name}`, '');
    for (const entry of course.entries) {
      lines.push(...logEntryLines(entry));
    }
    lines.push('');
  }

  if (report.unmappedLogs.length > 0) {
    lines.push('### 未映射到当前课程清单的记录', '');
    for (const entry of report.unmappedLogs) {
      lines.push(...logEntryLines(entry));
    }
    lines.push('');
  }

  lines.push('## 受阻、未核验候选与排除项', '');
  if (report.blocked.length === 0) {
    lines.push('（当前没有登记受阻或排除项。）');
  } else {
    for (const entry of report.blocked) {
      const channel = CHANNEL_LABELS[entry.channel] ?? entry.channel ?? '渠道未记录';
      const outcome = RESEARCH_OUTCOME_LABELS[entry.outcome] ?? entry.outcome;
      const scope = entry.codes.length > 0 ? `课程 ${entry.codes.join('、')}` : '通用来源';
      const url = entry.url ? `<${entry.url}>` : '（未记录 URL）';
      const note = entry.notes ? `：${md(entry.notes)}` : '';
      lines.push(`- ${md(scope)} · ${md(channel)} · ${md(outcome)} · ${md(url)}${note}`);
    }
  }
  lines.push('');

  lines.push('## 外链健康检查', '');
  if (report.checkedAt) {
    lines.push(`- 最近一次检查：${report.checkedAt}`);
    lines.push(`- 统计范围：${healthScopeText(report.health)}。`);
    lines.push(`- 结果：${healthCountsText(report.health)}。`);
    for (const note of healthEvidenceNotes(report.health)) lines.push(`- ${note}`);
    lines.push(`- 判定口径：${HEALTH_METHOD_NOTE}`);
    lines.push(
      '- 匿名检查只代表当次网络访问结果，不代表资料内容、课程归属、年份或授权已确认；失败不会自动删除资料或改变“是否收录”的分区。',
    );
  } else {
    lines.push('- 尚未执行检查，站点上所有外链均显示“从未检查”，不显示全绿状态。');
  }
  lines.push('');

  return `${lines.join('\n').trimEnd()}\n`;
}

/* ------------------------------ sources.html ------------------------------ */

function htmlLink(url, label) {
  const safe = safeExternalUrl(url);
  if (!safe) return escapeHtml(label ?? url ?? '');
  return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow">${escapeHtml(label ?? safe)}</a>`;
}

function renderHtmlLogEntry(entry) {
  const channel = CHANNEL_LABELS[entry.channel] ?? entry.channel ?? '渠道未记录';
  const outcome = RESEARCH_OUTCOME_LABELS[entry.outcome] ?? entry.outcome ?? '结果未记录';
  const parts = [
    `<li class="log-entry"><p class="meta-line"><span>${escapeHtml(entry.date ?? '日期未记录')}</span><span>${escapeHtml(channel)}</span><span>${escapeHtml(outcome)}</span>${entry.url ? `<span>${htmlLink(entry.url, entry.url)}</span>` : ''}</p>`,
  ];
  const details = [];
  if (entry.query) details.push(`<li>查询：${escapeHtml(oneLine(entry.query))}</li>`);
  if (entry.checked_scope) details.push(`<li>检查范围：${escapeHtml(oneLine(entry.checked_scope))}</li>`);
  if (entry.notes) details.push(`<li>说明：${escapeHtml(oneLine(entry.notes))}</li>`);
  if (Array.isArray(entry.source_ids) && entry.source_ids.length > 0) {
    details.push(`<li>来源 ID：${escapeHtml(entry.source_ids.join('、'))}</li>`);
  }
  if (details.length > 0) parts.push(`<ul>${details.join('')}</ul>`);
  parts.push('</li>');
  return parts.join('');
}

function renderSourcesHtml(report) {
  const parts = [];
  parts.push(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light dark">
    <meta name="description" content="课程资料导航的来源、检索记录、受阻项与致谢。">
    <title>来源、检索记录与致谢 · 中科大本科课程资料导航</title>
    <link rel="stylesheet" href="assets/style.css">
    <script type="module" src="assets/mode.mjs"></script>
  </head>
  <body data-page="sources">
    <a class="skip-link" href="#main">跳到主要内容</a>
    <header class="site-header">
      <div class="wrap header-inner">
        <p class="brand"><a href="./">中科大本科课程资料导航</a></p>
        <p class="site-note">只收录并导航公开课程资料，不转载第三方文件。</p>
        <button type="button" class="secondary mode-switch" data-mode-toggle aria-pressed="false" hidden>详细模式</button>
      </div>
    </header>
    <main id="main" class="wrap" tabindex="-1">
      <p class="breadcrumb"><a href="./">← 返回课程目录</a></p>
      <h1>来源、检索记录与致谢</h1>
      <p class="intro">本页由构建脚本从来源与检索记录生成。资料版权归原作者；具体授权以各来源和文件页面的声明为准。</p>
`);

  parts.push(`      <section aria-labelledby="overview-heading">
        <h2 id="overview-heading">概览</h2>
        <ul>
          <li>课程：${report.courseCount} 门（已收录资料 ${report.withResources} 门，暂未收录 ${report.withoutResources} 门）。</li>
          <li>资料：${report.resources} 条。</li>
          <li>来源：${report.sourceCount} 个登记来源，其中 ${report.usedSourceCount} 个被正式资料引用。</li>
          <li>检索记录：${report.logCount} 条，覆盖 ${report.courseLogs.length} 门课程。</li>
          <li>${report.incomplete.length} 门课程尚未记录全部 GitHub / 评课社区 / 公开网页三条检索路径；未记录不等于没有资料。</li>
          <li>${report.checkedAt ? `外链最近检查：${escapeHtml(report.checkedAt)}；${escapeHtml(healthScopeText(report.health))}。逐类证据与判定口径见“外链健康检查”。` : '尚未运行外链检查，所有链接显示“从未检查”。'}</li>
        </ul>
        <p class="mode-detail">详细模式显示逐条覆盖、来源备注、检索范围、受阻与排除项。</p>
      </section>
`);

  parts.push('      <section aria-labelledby="sources-heading">\n        <h2 id="sources-heading">来源清单与声明</h2>\n        <ul class="source-list" role="list">');
  for (const source of report.sources) {
    const meta = [
      `<span>类型：${escapeHtml(SOURCE_KIND_LABELS[source.kind] ?? source.kind ?? '未登记')}</span>`,
      source.maintainer ? `<span>维护者：${escapeHtml(source.maintainer)}</span>` : '',
      `<span>被资料引用 ${source.usage} 处</span>`,
    ]
      .filter(Boolean)
      .join('');
    const github = source.github
      ? `<p class="meta-line mode-detail">GitHub：${escapeHtml(source.github.owner)}/${escapeHtml(source.github.repo)}（分支 ${escapeHtml(source.github.branch)}）</p>`
      : '';
    parts.push(`          <li class="source-entry">
            <h3>${escapeHtml(source.name)}</h3>
            <p class="meta-line">${meta}</p>
            <p class="meta-line">${source.url ? htmlLink(source.url, source.url) : '（未登记地址）'}</p>
            ${github}
            ${source.notes ? `<p class="source-note mode-detail">${escapeHtml(oneLine(source.notes))}</p>` : ''}
          </li>`);
  }
  parts.push('        </ul>\n      </section>\n');

  parts.push(`      <section aria-labelledby="coverage-heading">
        <h2 id="coverage-heading">课程 × 资料类型 × 试题年份覆盖</h2>
        <p>以下 ${report.coverage.length} 门课程有已确认资料；逐条资料及年份可在详细模式查看。</p>
        <p class="mode-detail">试题按实际年份保留，学年区间不自动拆成两年，同年不同卷不去重。</p>
`);
  if (report.coverage.length === 0) {
    parts.push('        <p>当前没有任何课程具备已确认资料。</p>\n');
  }
  for (const course of report.coverage) {
    const meta = [course.kind, ...course.tags].filter(Boolean).join(' · ');
    parts.push(`        <div class="mode-detail"><h3>${escapeHtml(course.code)} ${escapeHtml(course.name)}</h3>`);
    if (meta) parts.push(`        <p class="meta-line">${escapeHtml(meta)}</p>`);
    parts.push('        <ul>');
    for (const group of course.lines) {
      parts.push(`          <li><strong>${escapeHtml(group.label)}</strong><ul>`);
      for (const line of group.lines) parts.push(`            <li>${escapeHtml(line)}</li>`);
      parts.push('          </ul></li>');
    }
    parts.push('        </ul></div>');
  }
  parts.push('      </section>\n');

  parts.push(`      <section class="mode-detail" aria-labelledby="logs-heading">
        <h2 id="logs-heading">检索记录</h2>
        <p>记录实际打开或检查过的页面、目录与文件，不是机械拼接的查询 URL。受阻不等于没有资料。</p>
`);
  if (report.generalLogs.length > 0) {
    parts.push('        <h3>通用来源检索</h3>\n        <ul class="log-list" role="list">');
    for (const entry of report.generalLogs) parts.push(`          ${renderHtmlLogEntry(entry)}`);
    parts.push('        </ul>');
  }
  for (const course of report.courseLogs) {
    parts.push(`        <details>
          <summary>${escapeHtml(course.code)} ${escapeHtml(course.name)}（${course.entries.length} 条）</summary>
          <ul class="log-list" role="list">`);
    for (const entry of course.entries) parts.push(`            ${renderHtmlLogEntry(entry)}`);
    parts.push('          </ul>\n        </details>');
  }
  if (report.unmappedLogs.length > 0) {
    parts.push('        <h3>未映射到当前课程清单的记录</h3>\n        <ul class="log-list" role="list">');
    for (const entry of report.unmappedLogs) parts.push(`          ${renderHtmlLogEntry(entry)}`);
    parts.push('        </ul>');
  }
  parts.push('      </section>\n');

  parts.push('      <section class="mode-detail" aria-labelledby="blocked-heading">\n        <h2 id="blocked-heading">受阻、未核验候选与排除项</h2>');
  if (report.blocked.length === 0) {
    parts.push('        <p>当前没有登记受阻或排除项。</p>');
  } else {
    parts.push('        <ul>');
    for (const entry of report.blocked) {
      const channel = CHANNEL_LABELS[entry.channel] ?? entry.channel ?? '渠道未记录';
      const outcome = RESEARCH_OUTCOME_LABELS[entry.outcome] ?? entry.outcome;
      const scope = entry.codes.length > 0 ? `课程 ${entry.codes.join('、')}` : '通用来源';
      const link = entry.url ? htmlLink(entry.url, entry.url) : '（未记录 URL）';
      const note = entry.notes ? `：${escapeHtml(oneLine(entry.notes))}` : '';
      parts.push(`          <li>${escapeHtml(scope)} · ${escapeHtml(channel)} · ${escapeHtml(outcome)} · ${link}${note}</li>`);
    }
    parts.push('        </ul>');
  }
  parts.push('      </section>\n');

  parts.push(`      <section aria-labelledby="health-heading">
        <h2 id="health-heading">外链健康检查</h2>
        ${
          report.checkedAt
            ? `<p>最近一次检查：${escapeHtml(report.checkedAt)}。</p>
        <ul>
          <li>统计范围：${escapeHtml(healthScopeText(report.health))}。</li>
          <li>结果：${escapeHtml(healthCountsText(report.health))}。</li>
          ${healthEvidenceNotes(report.health)
            .map((note) => `<li>${escapeHtml(note)}</li>`)
            .join('\n          ')}
        </ul>`
            : '<p>尚未执行检查，所有外链显示“从未检查”。</p>'
        }
        <p class="mode-detail">判定口径：${escapeHtml(HEALTH_METHOD_NOTE)}</p>
        <p class="mode-detail">自动检查按固定频率匿名运行，只覆盖已登记的外部网址；逐 URL 的检查日期、状态与原因显示在各课程详情页。</p>
        <p>匿名检查只代表当次网络访问结果，不代表资料内容、课程归属、年份或授权已确认；失败不会删除资料或改变收录分区。</p>
      </section>
`);

  parts.push(`    </main>
    <footer class="site-footer">
      <div class="wrap">
        <p>资料版权归原作者所有；本站只提供导航链接，不托管、不转载第三方文件。</p>
        <p>仓库内同时保留可读版 <code>docs/sources-and-search.md</code>（构建生成）。</p>
      </div>
    </footer>
  </body>
</html>
`);
  return parts.join('\n');
}

/* ------------------------------ 构建流程 ------------------------------ */

function fail(message) {
  console.error(`构建失败：${message}`);
  process.exitCode = 1;
}

/**
 * 构建级规则：工具、空壳来源只能出现在检索记录中，不能被正式资料引用。
 * 数据验证已检查来源存在性；这里阻止把工具/空壳充作学习资料。
 */
function findBuildRuleErrors(dataset) {
  const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
  const messages = [];
  for (const resource of dataset.resources) {
    for (const location of resource.locations ?? []) {
      const source = sourceById.get(location.source_id);
      if (!source) continue;
      if (source.kind === 'tool' || source.kind === 'stub') {
        messages.push(
          `资料 ${resource.id} 的 location 引用了${SOURCE_KIND_LABELS[source.kind] ?? source.kind}来源“${source.id}”；工具/空壳只能记入检索记录，不能作为正式学习资料。`,
        );
      }
    }
  }
  return messages;
}

async function main() {
  const dataset = await loadRepository(ROOT);

  const validation = validateRepository(dataset);
  const errors = validation.errors ?? [];
  const warnings = validation.warnings ?? [];
  if (errors.length > 0) {
    console.error(`数据验证失败，共 ${errors.length} 条错误：`);
    for (const issue of errors.slice(0, 50)) console.error(`  - ${issueLine(issue)}`);
    if (errors.length > 50) console.error(`  …另有 ${errors.length - 50} 条错误。`);
    fail('请先修复数据，再重新构建。未写入任何生成文件。');
    return;
  }
  if (warnings.length > 0) {
    console.warn(`数据验证通过，但有 ${warnings.length} 条警告：`);
    for (const issue of warnings.slice(0, 20)) console.warn(`  - ${issueLine(issue)}`);
    if (warnings.length > 20) console.warn(`  …另有 ${warnings.length - 20} 条警告。`);
  }

  if (dataset.courses.length === 0) {
    fail('课程主清单为空，拒绝生成站点。');
    return;
  }

  const ruleErrors = findBuildRuleErrors(dataset);
  if (ruleErrors.length > 0) {
    console.error(`构建规则检查失败，共 ${ruleErrors.length} 条：`);
    for (const message of ruleErrors.slice(0, 20)) console.error(`  - ${message}`);
    if (ruleErrors.length > 20) console.error(`  …另有 ${ruleErrors.length - 20} 条。`);
    fail('工具/空壳来源不能作为正式资料；未写入任何生成文件。');
    return;
  }

  const partitions = generatePartitionFiles(dataset);
  const codes = partitions.entries.map((entry) => entry.code);
  if (codes.length !== dataset.courses.length || new Set(codes).size !== codes.length) {
    fail('分区结果与课程主清单不一致（数量或代码重复）。');
    return;
  }

  const catalog = buildCatalog(dataset);
  const report = buildReport(dataset, catalog, partitions);
  const docs = renderDocs(report);
  const sourcesHtml = renderSourcesHtml(report);

  const agentFiles = [
    ['data/agent/index.json', {
      schema_version: 1,
      courses: catalog.courses.map(({ code, name, has_resources }) => ({ code, name, has_resources })),
    }],
  ];
  const sourceNames = new Map(catalog.sources.map(({ id, name }) => [id, name]));
  for (const course of catalog.courses) {
    const sources = Object.fromEntries(course.resources.flatMap(({ locations }) =>
      locations.map(({ source_id }) => [source_id, sourceNames.get(source_id)]),
    ));
    agentFiles.push([`data/agent/courses/${encodeURIComponent(course.code)}.json`, {
      schema_version: 1,
      ...course,
      sources,
    }]);
  }

  const siteFiles = await listSiteFiles();
  const generated = [
    ...partitions.files.map((file) => toPosix(file.path)),
    ...agentFiles.flatMap(([file]) => [file, `dist/${file}`]),
    DOCS_RELATIVE,
    'dist/data/catalog.json',
    'dist/sources.html',
    'dist/.nojekyll',
    ...siteFiles.map((file) => `dist/${file}`),
  ].sort();

  const oldManifest = await loadGeneratedManifest(ROOT);
  const stale = oldManifest.filter(
    (relativePath) =>
      typeof relativePath === 'string' &&
      isOwnedGeneratedPath(relativePath) &&
      !generated.includes(relativePath),
  );
  for (const relativePath of stale) {
    await rm(absolute(relativePath), { force: true });
  }
  const unsafeOld = oldManifest.filter(
    (relativePath) => typeof relativePath === 'string' && !isOwnedGeneratedPath(relativePath),
  );
  if (unsafeOld.length > 0) {
    console.warn(
      `清单中有 ${unsafeOld.length} 条不属于构建产物的路径，已忽略、未删除：${unsafeOld.slice(0, 5).join('、')}`,
    );
  }

  for (const file of partitions.files) {
    await writeJson(absolute(toPosix(file.path)), file.data);
  }
  for (const [file, data] of agentFiles) {
    await writeJson(absolute(file), data);
    const target = absolute(`dist/${file}`);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(absolute(file), target);
  }


  await writeText(absolute(DOCS_RELATIVE), docs);

  for (const relativePath of siteFiles) {
    const target = path.join(DIST_DIR, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(SITE_DIR, ...relativePath.split('/')), target);
  }
  await writeJson(path.join(DIST_DIR, 'data', 'catalog.json'), catalog);
  await writeText(path.join(DIST_DIR, 'sources.html'), sourcesHtml);
  await writeFile(
    path.join(DIST_DIR, '.nojekyll'),
    '',
    'utf8',
  );

  await writeJson(absolute(MANIFEST_RELATIVE), { files: generated });

  console.log('构建完成：');
  console.log(`  课程 ${catalog.counts.courses} 门（有资料 ${catalog.counts.with_resources}，无资料 ${catalog.counts.without_resources}）`);
  console.log(`  资料 ${catalog.counts.resources} 条；实际引用来源 ${catalog.sources.length} 个；标签 ${catalog.tags.length} 个`);
  console.log(`  检索记录 ${report.logCount} 条；三路径未齐 ${report.incomplete.length} 门`);
  console.log(`  分区文件 ${partitions.files.length} 个；站点文件 ${siteFiles.length} 个；dist/data/catalog.json 与 dist/sources.html 已生成`);
  console.log(`  外链证据：${report.checkedAt ?? '未运行'}；${healthScopeText(report.health)}；${healthCountsText(report.health)}`);
  if (report.health.preflightOnly) {
    console.log('  本次检查未收到 HTTP 响应：请求全部停在 DNS/私网地址预检，未发出。');
  }
  console.log(`  清理过期自有产物 ${stale.length} 个`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    fail(error?.message ?? '未知错误');
  });
}

export { buildCatalog, buildReport, renderDocs, renderSourcesHtml };