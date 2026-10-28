# 菠萝包数据榜

SF轻小说（[book.sfacg.com](https://book.sfacg.com/)）的**收藏增长排行榜**：
每小时抓取「七日内更新」的全部书目，记录每本书的收藏、月票、人气、字数，
按最近增量排名，并且每本书都能点开看逐日增长曲线。

站点由这个仓库自己发布：抓取在 GitHub Actions 里跑，数据提交回 `docs/data/`，
GitHub Pages 直接把 `docs/` 当作静态站点。

## 数据

| 文件 | 内容 |
| --- | --- |
| `docs/data/books.json` | 书目元信息：书名、作者、分类、状态、封面、最近更新 |
| `docs/data/latest.json` | 每本书最新一次读数（收藏、人气、月票、字数） |
| `docs/data/hourly.json` | 每小时一个桶，保留约 96 小时 |
| `docs/data/daily.json` | 每天一个桶，是本页所有曲线背后的历史 |
| `docs/data/status.json` | 最近抓取时间与抓取日志 |

浏览器里用同一套规则重新算排名（`site/assets/app.js`），所以排序、窗口切换、
搜索、分类筛选都不需要服务器。

## 更新时间

- `.github/workflows/rank.yml` 每小时第 7 分钟跑一次（UTC），GitHub 的高峰期会延迟几分钟到十几分钟。
- 一轮抓取约 **1,650 本书 / 3,300 个请求**，大约 8 分钟，速率固定 8 请求/秒。
- 想去手动触发一次：仓库的 **Actions → rank → Run workflow**。
- 一次抓取失败不会让站点变空：`docs/data` 保持上一次的内容，状态文件里会记下失败。

## 第一次发布（3 步）

1. 新建一个**公开**仓库（Actions 的免费额度对公开仓库不限量；私有仓库每月 2,000 分钟，撑不住每小时一次）。
2. 把这个文件夹里的全部内容传上去，注意 `.github/workflows/rank.yml` 这个路径不能少，否则定时任务不会存在。
3. 仓库 **Settings → Pages → Source: Deploy from a branch → Branch: main / `/docs`**，保存。几十秒后站点就在 `https://<你的用户名>.github.io/<仓库名>/`。

之后不用管：每次 Actions 提交数据，Pages 会自动重新发布。

## 本地跑一次

```bash
node tools/scan.mjs                              # 抓一轮，数据落在 .data/
node tools/export-site.mjs --dir .data --out docs/data
npx serve docs                                   # 或者任意静态服务器
```

## 说明与边界

- 数据来自站点公开页面，本仓库只做聚合与展示，不存储正文。
- 站点的「七日内更新」列表最多只能翻到第 83 页，所以**收录约 1,640 / 1,875 本**，边缘的冷门书会缺席。
- 月票是「本月」值，每月 1 日清零；人气是站点缩写值（`600.1万`），还原后有量化误差。
- 一次完整抓取约 8 分钟，每小时一次属于正常访问强度；如果站点开始限流（Actions 变红），把 `.github/workflows/rank.yml` 的 cron 改成 `7 */2 * * *` 或调低 `requestsPerSecond`。
- 仓库体积：每小时的提交主要是 `latest.json` / `hourly.json` / `daily.json`，约几十 KB，一年几百 MB；体积真成问题时，把 `docs/data/daily.json` 的历史换成按月归档即可。
