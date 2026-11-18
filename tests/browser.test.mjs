/**
 * 真实页面浏览器回归：course.html + app.mjs + style.css + 模式按钮。
 *
 * 不引入第三方依赖：直接启动本机 Chrome/Edge 的 headless 模式，通过
 * DevTools 协议（Node 内置 WebSocket）执行页面脚本并读取计算样式。
 * 合成 catalog 只存在于内存与临时 HTTP 服务中，不写入仓库或 dist。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog } from '../scripts/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const COURSE_CODE = 'MATH1001';
const QUESTION_SHA = 'a'.repeat(64);
const SOLUTION_SHA = 'b'.repeat(64);
const QUESTION_PAGE = 'https://example.org/ustc/math1001/2024-final';
const QUESTION_URL = 'https://example.org/ustc/math1001/2024-final.pdf';
const SOLUTION_URL = 'https://example.org/ustc/math1001/2024-final-solution.pdf';
const QUESTION_BYTES = 123456;
const SOLUTION_BYTES = 7890;
const SNAPSHOT_DATE = '2026-11-18';
const MODE_STORAGE_KEY = 'ustc-course-nav.mode';

/* ------------------------------------------------------------------ */
/* 合成目录（只走正式 buildCatalog 投影，不接触 data/）                  */
/* ------------------------------------------------------------------ */

function createFixtureCatalog() {
  const dataset = {
    courses: [{ code: COURSE_CODE, name: '数学分析（浏览器回归）' }],
    courseMetadata: {
      [COURSE_CODE]: { kind: 'common', tags: ['math'] },
    },
    tags: [{ id: 'math', label: '数学' }],
    sources: [
      {
        id: 'fixture-source',
        name: '浏览器回归测试来源',
        url: 'https://example.org/ustc/math1001',
        maintainer: '合成测试',
        kind: 'website',
        github: null,
        notes: '',
      },
    ],
    resources: [
      {
        id: 'browser-fixture-exam',
        course_codes: [COURSE_CODE],
        type: 'exams',
        title: '2024 期末（含解答）',
        authors: ['测试署名'],
        notes: '',
        coverage: {
          years: [2024],
          academic_years: [],
          exam_kind: 'final',
          exam_form: 'original',
          has_solutions: true,
          evidence_url: QUESTION_PAGE,
          note: '合成测试：卷面题头与配套解答分别取样。',
        },
        locations: [
          {
            source_id: 'fixture-source',
            page_url: QUESTION_PAGE,
            download_page: null,
            download_url: QUESTION_URL,
            access: 'public',
            page_kind: 'file',
            license_note: '仅链接原页面；授权以原页面声明为准（合成测试）',
            attribution: '课程组公开署名（合成测试）',
            file_snapshot: {
              sha256: QUESTION_SHA,
              bytes: QUESTION_BYTES,
              checked_at: SNAPSHOT_DATE,
            },
          },
          {
            source_id: 'fixture-source',
            page_url: null,
            download_page: null,
            download_url: SOLUTION_URL,
            access: 'public',
            page_kind: 'file',
            license_note: '仅链接原页面；授权以原页面声明为准（合成测试）',
            attribution: '课程组公开署名（合成测试）',
            role: 'solution',
            file_snapshot: {
              sha256: SOLUTION_SHA,
              bytes: SOLUTION_BYTES,
              checked_at: SNAPSHOT_DATE,
            },
          },
        ],
        verified_at: SNAPSHOT_DATE,
      },
    ],
    monitoring: { links: [] },
    traffic: {},
  };
  return buildCatalog(dataset);
}

/* ------------------------------------------------------------------ */
/* 浏览器发现                                                          */
/* ------------------------------------------------------------------ */

function findOnPath(names) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      for (const candidate of [name, `${name}.exe`]) {
        const absolute = path.join(dir, candidate);
        if (existsSync(absolute)) return absolute;
      }
    }
  }
  return null;
}

function findBrowser() {
  const absoluteCandidates = [];
  if (process.platform === 'win32') {
    absoluteCandidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    );
  } else if (process.platform === 'darwin') {
    absoluteCandidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    absoluteCandidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }

  const candidates = [
    process.env.CHROME_PATH,
    ...absoluteCandidates,
    findOnPath(['google-chrome', 'google-chrome-stable', 'chrome', 'chromium', 'chromium-browser']),
    process.env.EDGE_PATH,
  ];
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    candidates.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable');
  }
  candidates.push(findOnPath(['msedge', 'microsoft-edge', 'microsoft-edge-stable']));

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const BROWSER_PATH = findBrowser();

/* ------------------------------------------------------------------ */
/* 临时静态服务                                                        */
/* ------------------------------------------------------------------ */

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

function sendText(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

/** 只读服务 site/，并用内存中的合成 catalog 覆盖 data/catalog.json。 */
async function startSiteServer(catalog) {
  const catalogBody = JSON.stringify(catalog);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      sendText(response, 400, 'bad request');
      return;
    }
    if (pathname === '/data/catalog.json') {
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(catalogBody),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      response.writeHead(200, headers);
      if (request.method === 'HEAD') response.end();
      else response.end(catalogBody);
      return;
    }

    const segments = pathname.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (pathname.includes('\0') || pathname.includes('\\') || segments.includes('..')) {
      sendText(response, 403, 'forbidden');
      return;
    }
    let absolute = path.resolve(SITE_DIR, ...segments);
    if (absolute !== SITE_DIR && !absolute.startsWith(SITE_DIR + path.sep)) {
      sendText(response, 403, 'forbidden');
      return;
    }
    let info;
    try {
      info = await stat(absolute);
      if (info.isDirectory()) {
        absolute = path.join(absolute, 'index.html');
        info = await stat(absolute);
      }
    } catch {
      sendText(response, 404, 'not found');
      return;
    }
    if (!info.isFile()) {
      sendText(response, 404, 'not found');
      return;
    }
    const headers = {
      'content-type': MIME_TYPES.get(path.extname(absolute).toLowerCase()) ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(absolute).pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

/* ------------------------------------------------------------------ */
/* Headless 浏览器与最小 CDP 客户端                                    */
/* ------------------------------------------------------------------ */

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function launchBrowser(executable, userDataDir) {
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-search-engine-choice-screen',
      '--disable-dev-shm-usage',
      '--metrics-recording-only',
      '--no-sandbox',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  let launchError = null;
  child.on('error', (error) => {
    launchError = error;
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  return {
    child,
    launchError: () => launchError,
    stderr: () => stderr,
  };
}

async function waitForDevToolsPort(portFile, browser) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (browser.launchError()) {
      throw new Error(`浏览器启动失败：${browser.launchError().message}（${browser.stderr()}）`);
    }
    if (browser.child.exitCode !== null) {
      throw new Error(`浏览器提前退出（code=${browser.child.exitCode}）：${browser.stderr()}`);
    }
    try {
      const content = await readFile(portFile, 'utf8');
      const [portLine] = content.trim().split(/\r?\n/u);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // 端口文件尚未生成。
    }
    await delay(50);
  }
  throw new Error(`等待 DevTools 端口超时：${browser.stderr()}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
  return response.json();
}

async function waitForPageTarget(port, browser) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 浏览器尚未就绪。
    }
    if (browser.launchError()) {
      throw new Error(`浏览器启动失败：${browser.launchError().message}`);
    }
    if (browser.child.exitCode !== null) {
      throw new Error(`浏览器提前退出（code=${browser.child.exitCode}）：${browser.stderr()}`);
    }
    await delay(50);
  }
  throw new Error(`等待页面 target 超时：${browser.stderr()}`);
}

function createCdpClient(webSocket) {
  let nextId = 0;
  const pending = new Map();

  webSocket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${message.error.message}（code=${message.error.code}）`));
    } else {
      entry.resolve(message.result);
    }
  });

  webSocket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('CDP 连接已关闭。'));
    pending.clear();
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, { resolve, reject });
      webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? '未知异常';
      throw new Error(`页面脚本执行失败：${description}`);
    }
    return result.result?.value;
  }

  async function waitFor(expression, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(`等待页面状态超时：${expression}${lastError ? `（最后一次错误：${lastError.message}）` : ''}`);
  }

  return { send, evaluate, waitFor, close: () => webSocket.close() };
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url);
    webSocket.addEventListener('open', () => resolve(webSocket), { once: true });
    webSocket.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)), {
      once: true,
    });
  });
}

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

async function stopBrowser(browser) {
  if (!browser || !browser.child.pid || browser.child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(browser.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    });
    return;
  }
  await new Promise((resolve) => {
    browser.child.once('exit', resolve);
    browser.child.kill('SIGKILL');
    setTimeout(resolve, 5000).unref?.();
  });
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

test(
  'course.html 在详细模式展示题面与解答的完整文件摘要，简洁模式隐藏摘要并保留链接',
  {
    skip: BROWSER_PATH
      ? false
      : '未找到 Chrome/Edge 可执行文件；设置 CHROME_PATH 或 EDGE_PATH 后运行。',
    timeout: 90000,
  },
  async (t) => {
    const catalog = createFixtureCatalog();
    const { server, origin } = await startSiteServer(catalog);
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'ustc-nav-browser-'));
    let browser = null;
    let cdp = null;

    t.after(async () => {
      try {
        cdp?.close();
      } catch {
        // 已关闭。
      }
      await stopBrowser(browser);
      await new Promise((resolve) => server.close(resolve));
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        () => {},
      );
    });

    browser = launchBrowser(BROWSER_PATH, userDataDir);
    const port = await waitForDevToolsPort(path.join(userDataDir, 'DevToolsActivePort'), browser);
    const target = await waitForPageTarget(port, browser);
    const webSocket = await connectWebSocket(target.webSocketDebuggerUrl);
    cdp = createCdpClient(webSocket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const courseUrl = `${origin}/course.html?code=${encodeURIComponent(COURSE_CODE)}`;
    await cdp.send('Page.navigate', { url: courseUrl });
    try {
      await cdp.waitFor(
        `document.readyState === 'complete'
          && document.querySelector('#course-content')
          && !document.querySelector('#course-content').hidden
          && document.querySelector('li.location .file-snapshot') !== null`,
        20000,
      );
    } catch (error) {
      const loadError = await cdp
        .evaluate(`document.querySelector('#load-error')?.textContent ?? ''`)
        .catch(() => '');
      throw new Error(`${error.message}${loadError ? `；页面错误：${loadError}` : ''}`);
    }

    assert.equal(await cdp.evaluate('document.title.includes("数学分析（浏览器回归）")'), true);

    const questionUrlLiteral = JSON.stringify(QUESTION_URL);
    const solutionUrlLiteral = JSON.stringify(SOLUTION_URL);

    const readableState = `(() => {
      const isVisible = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return node.getClientRects().length > 0;
      };
      const links = [...document.querySelectorAll('a')];
      const visibleLinkTexts = (href) => links
        .filter((link) => link.href === href && isVisible(link))
        .map((link) => link.textContent.trim());
      const snapshots = [...document.querySelectorAll('.file-snapshot')];
      const codeNodes = [...document.querySelectorAll('.file-snapshot code')];
      const toggle = document.querySelector('[data-mode-toggle]');
      return {
        mode: document.body.dataset.mode ?? null,
        pressed: toggle?.getAttribute('aria-pressed') ?? null,
        toggleHidden: toggle?.hidden ?? null,
        toggleVisible: isVisible(toggle),
        snapshotCount: snapshots.length,
        snapshotVisible: snapshots.map(isVisible),
        snapshotTexts: snapshots.map((node) => node.textContent),
        codeTexts: codeNodes.map((node) => node.textContent),
        questionLinkTexts: visibleLinkTexts(${questionUrlLiteral}),
        solutionLinkTexts: visibleLinkTexts(${solutionUrlLiteral}),
        bodyText: document.body.innerText,
        storage: localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)}),
      };
    })()`;

    const compact = await cdp.evaluate(readableState);
    assert.equal(compact.mode, null);
    assert.equal(compact.pressed, 'false');
    assert.equal(compact.toggleHidden, false);
    assert.equal(compact.toggleVisible, true);
    assert.equal(compact.snapshotCount, 2, '题面与解答各有一个取样摘要节点');
    assert.deepEqual(compact.snapshotVisible, [false, false], '简洁模式必须隐藏文件摘要');
    assert.equal(compact.codeTexts.includes(QUESTION_SHA), true);
    assert.equal(compact.codeTexts.includes(SOLUTION_SHA), true);
    assert.equal(compact.bodyText.includes(QUESTION_SHA), false);
    assert.equal(compact.bodyText.includes(SOLUTION_SHA), false);
    assert.equal(compact.storage, null);
    assert.equal(
      compact.questionLinkTexts.some((text) => text.includes('题目')),
      true,
      '简洁模式保留可点击的题面链接',
    );
    assert.equal(
      compact.solutionLinkTexts.some((text) => text.includes('配套解答')),
      true,
      '简洁模式保留可点击的配套解答链接',
    );

    await cdp.evaluate(`document.querySelector('[data-mode-toggle]').click()`);
    await cdp.waitFor(`document.body.dataset.mode === 'detailed'`);

    const detailed = await cdp.evaluate(`(() => {
      const isVisible = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return node.getClientRects().length > 0;
      };
      const toggle = document.querySelector('[data-mode-toggle]');
      const rows = [...document.querySelectorAll('li.location')].map((row) => {
        const snapshot = row.querySelector('.file-snapshot');
        return {
          hrefs: [...row.querySelectorAll('a')].map((link) => link.href),
          snapshotVisible: isVisible(snapshot),
          snapshotText: snapshot?.textContent ?? '',
          codeText: snapshot?.querySelector('code')?.textContent ?? '',
        };
      });
      return {
        mode: document.body.dataset.mode ?? null,
        pressed: toggle?.getAttribute('aria-pressed') ?? null,
        toggleVisible: isVisible(toggle),
        snapshotCount: document.querySelectorAll('.file-snapshot').length,
        rows,
        bodyText: document.body.innerText,
        storage: localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)}),
      };
    })()`);

    assert.equal(detailed.mode, 'detailed');
    assert.equal(detailed.pressed, 'true');
    assert.equal(detailed.toggleVisible, true);
    assert.equal(detailed.storage, 'detailed');
    assert.equal(detailed.snapshotCount, 2);

    const questionRow = detailed.rows.find((row) => row.hrefs.includes(QUESTION_URL));
    const solutionRow = detailed.rows.find((row) => row.hrefs.includes(SOLUTION_URL));
    assert.ok(questionRow, '详细模式必须列出题面文件入口');
    assert.ok(solutionRow, '详细模式必须把配套解答作为独立位置列出');
    assert.notEqual(questionRow, solutionRow);

    assert.equal(questionRow.snapshotVisible, true);
    assert.equal(solutionRow.snapshotVisible, true);
    assert.equal(questionRow.codeText, QUESTION_SHA, '题面摘要必须是完整 64 位 SHA-256');
    assert.equal(solutionRow.codeText, SOLUTION_SHA, '解答摘要必须是完整 64 位 SHA-256');
    assert.match(questionRow.snapshotText, /直链文件取样/u);
    assert.match(questionRow.snapshotText, new RegExp(`${SNAPSHOT_DATE}.*123,456 字节`, 'u'));
    assert.match(solutionRow.snapshotText, /直链文件取样/u);
    assert.match(solutionRow.snapshotText, new RegExp(`${SNAPSHOT_DATE}.*7,890 字节`, 'u'));
    assert.equal(detailed.bodyText.includes(QUESTION_SHA), true);
    assert.equal(detailed.bodyText.includes(SOLUTION_SHA), true);

    await cdp.evaluate(`document.querySelector('[data-mode-toggle]').click()`);
    await cdp.waitFor(
      `!document.body.dataset.mode
        && document.querySelector('[data-mode-toggle]').getAttribute('aria-pressed') === 'false'`,
    );

    const compactAgain = await cdp.evaluate(readableState);
    assert.equal(compactAgain.mode, null);
    assert.equal(compactAgain.pressed, 'false');
    assert.deepEqual(compactAgain.snapshotVisible, [false, false]);
    assert.equal(compactAgain.bodyText.includes(QUESTION_SHA), false);
    assert.equal(compactAgain.bodyText.includes(SOLUTION_SHA), false);
    assert.equal(compactAgain.storage, null);
    assert.equal(compactAgain.questionLinkTexts.some((text) => text.includes('题目')), true);
    assert.equal(compactAgain.solutionLinkTexts.some((text) => text.includes('配套解答')), true);
  },
);
