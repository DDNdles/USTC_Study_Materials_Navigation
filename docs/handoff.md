# 项目交接

供新对话和接手项目的 Agent 使用。这里记录项目边界、数据与构建入口、最近一次验收和已知问题；详细字段见 [开发与数据契约](development.md)。继续工作前先查工作区现状，不依赖旧对话、浏览器标签页或临时文件。完成一轮后更新本页中发生变化的状态与实测结果。

## 项目做什么

这是中国科大本科课程资料导航，不是网盘。固定课程范围为 2025 秋、2026 春、2026 夏和 2026 秋官方本科开课。课程按官方代码合并；36 个学科是项目标签，不是官方分类。暂未收录资料的课程仍在目录里，不能把「暂未收录」写成「没有资料」。

项目已提交到 [GitHub 私有仓库](https://github.com/TwinJades/UST_Study_Materials_Navigation) 的 `main` 分支，未启用 Pages。不得擅自转为公开仓库或开启公开站点。索引链接指向原站，不托管第三方文件，不保存临时签名，不绕登录。只有「教材与参考书」另要求由权利方公开发布、免费、免登录并有完整文件直链；匹配课程内容的参考书不等于学校指定教材。

## 从哪里接手

| 要改的东西 | 源文件 |
| --- | --- |
| 首页搜索与课程详情 | `site/index.html`、`site/course.html`、`site/assets/app.mjs`、`site/assets/style.css` |
| 搜索排序、过滤、资料分组、链接选取 | `site/assets/search.mjs`；对应 `tests/search.test.mjs` |
| 简洁／详细模式 | `site/assets/mode.mjs`；`body[data-mode]`、`.mode-detail`、`.mode-compact`；选择通过 `localStorage` 在三页共享 |
| 来源页、浏览器目录、每课分区、来源文档 | `scripts/build.mjs`；不要手改 `dist/`、`data/with-resources/`、`data/without-resources/`、`data/generated-files.json` 或 `docs/sources-and-search.md` |
| 官方课程、课程分类和学科关系 | `data/courses.json`、`data/course-metadata.json`、`data/tags.json`；官方采集入口 `scripts/collect-courses.mjs` |
| 资料索引、来源、核查记录 | `data/resources.json`、`data/sources.json`、`data/research-log.jsonl`；校验在 `scripts/lib/data.mjs` 和 `scripts/validate.mjs` |
| 外链健康检查 | `scripts/monitor.mjs`、`scripts/lib/link-health.mjs`、`scripts/lib/link-coverage.mjs`、`site/assets/health-evidence.mjs`；结果 `data/monitoring.json` |

没有前端框架或第三方运行依赖。浏览器读 `dist/data/catalog.json`，不直接读原始数据，也不在搜索时请求第三方站点。所有页面用相对路径，改版后仍须支持部署到子路径。GitHub Actions 配置在 `.github/workflows/`，有配置不代表已上线。

## 改版时保留什么

- 可重做视觉、布局和交互文案。普通搜索页始终显示原详细模式的课程信息：课号、课名、收录状态、课程类别、学科标签、资料总数和分类计数、试题年份（有相应数据时）。切换模式不改变这些信息、筛选结果或页码；它只改变课程详情页和来源页的信息量。
- 保留旧分享链接的含义，包括 `PHYS1008B%2B`、`status=with/without/none`、旧资料类映射到学习资料；旧 `access` 参数不参与筛选。学科组内任一选中即可，组间条件同时满足。两项收录状态都没选时显示恢复指引，不回退为全部。
- 详情只显示有内容的资料类别，完全没资料时只显示一个空态。五类正式值是 `exams/homework/study/books/projects`；小测归 `homework`。只确认到学年就显示学年，不补造公历年。纠正标签或归属时保留同一资料的 ID；判重靠实际来源、卷头或正文，不靠课程同名或年份相同。
- 「原始页面」是来源介绍或原帖；「文件页面」是某一文件的原站详情或预览页；「打开文件」直接访问外部文件 URL，可能在 Edge 中预览，不能承诺自动保存。不要靠 JS 代理、抓取外部文件或伪造下载按钮改变这一点。「我的科大」只保存稳定文件页，进入原站后可用原站下载按钮。
- 简洁模式保留首个登记的原始出处，并提供最直接的资料入口（直链优先，其次是文件页）；同一网址只展示一次。入口属于不同来源时分别标明。详细模式保留其他不同网址和核验依据。不能确认会直达文件的下载网页称「前往原站」。
- 键盘可操作，保留筛选状态反馈、窄屏换行和焦点可见。详细模式可展示更多证据，但不要把目录可访问、文件可读取、课程归属和授权混成一项。没有收到 HTTP 响应不能标记失效；确认 404/410 与认证、预检、无响应和从未检查分开。

## 当前数据与核验边界

- 最近构建：1,184 门课，219 门有资料、965 门未收录；1,383 条正式资料，比 1,290 条基线净增 93。链接修复、镜像合并、分类迁移和证据更正不直接新增资料行，不能用遍历文件数推算新增条数。
- 旧考试索引 59 份均有对账记录（`oldindex-`）；5 份候选，3 份指向 GitHub、2 份指向「我的科大」。匿名目录另走 `feixu-review-` 复核：102 个目录、754 个文件，81 个候选文件，和上述 5 份是两批记录；这两批候选 URL 无重复。遍历取得的是列表和元数据，不是 754 份本地文件。现有 526 条正式资料带「我的科大」链接，覆盖 82 门课、603 个文件页；这不是本轮新增数。
- 自动监控试跑 1,291 个 URL，全部停在 DNS／地址安全预检，0 个外链 HTTP 响应，未覆盖旧监控数据。人工复核单独记在 `data/research-log.jsonl`（可搜 `manual-public-links`、`feixu-public-inventory`），不能回填为自动 HTTP 结果。不要放宽私网阻断确认链路。
- 重点回归项：`DMA23M`、`DMA23F`、`DMA24F` 归 `229001`；`001548` 复变函数 B 指向具体文件页；线代 B1 2026 春期末 `2026SLAB1Final.pdf` 大小写不能改；Oscar Levin 教材是 `229001` 的补充参考。

## 如何验证

使用 Node.js 24 或以上。资料或数据契约有改动时运行 `npm test`、`npm run validate -- --strict-research`、`npm run build`；纯界面改动也要构建实际产物，用 `npm run serve` 打开 `http://127.0.0.1:4173/` 检查改到的页面。联网诊断用 `npm run monitor -- --dry-run`，它不会写入数据或 GitHub。

最近一轮 99 项测试通过，严格校验 0 错误、799 警告（794 条为未登记公开署名），分区互斥且覆盖 1,184 门。实际 Edge 验过首页键盘筛选、四种状态、加号课程码、三页模式、刷新、详情空态、复变文件页及三页 331 CSS px 下无横向溢出。原生 200% 缩放未验收；窄 iframe 或 DPR 模拟不能算作通过。改版后以新构建重新取证，不能沿用旧结果。
