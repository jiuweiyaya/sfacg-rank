/**
 * Export the store for the static site.
 *
 * The public site has no server, so it gets the same numbers the DSH panel reads
 * from its route — just as files:
 *
 *   site/data/books.json    one record per book (no intro, no lastSeen)
 *   site/data/latest.json   the newest sample per book, plus the previous snapshot
 *   site/data/hourly.json   the last few days of hourly buckets
 *   site/data/daily.json    the daily buckets (the history behind the charts)
 *   site/data/status.json   the card in the header and the scan log
 *
 * The browser recomputes the ranking from these (src/site/rank-client.js), so
 * the export is a straight dump and growth, sorting and search stay live inside
 * the page.
 *
 * Books that fell out of the site's update window are left out of `books.json`
 * and `latest.json` (the same rule the host applies), which is also what keeps
 * the committed files from churning for every book on every run — and it is why
 * the export does not need `lastSeen`: what is here is by definition current.
 *
 * Usage: node tools/export-site.mjs [--dir <store dir>] [--out <site/data>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../lib/store.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`)
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const storeDir = path.resolve(flag('dir', process.env.DSH_SFACG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sfacg-rank')))
const outDir = path.resolve(flag('out', path.join(root, 'site', 'data')))

if (!fs.existsSync(path.join(storeDir, 'books.json'))) {
	console.error(`没有找到数据：${storeDir}`)
	console.error('先跑一次 node tools/scan.mjs，或者让 DSH 插件抓一次。')
	process.exit(1)
}

const store = new Store(storeDir)

/** Write one JSON file, skipping the rewrite when nothing changed. */
function write(name, value) {
	const file = path.join(outDir, name)
	fs.mkdirSync(outDir, { recursive: true })
	const body = JSON.stringify(value)
	const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
	if (previous === body) return { name, bytes: body.length, changed: false }
	fs.writeFileSync(file, body)
	return { name, bytes: body.length, changed: true }
}

/** The fields the site actually renders; drops intro/firstSeen/tid/score/lastSeen. */
function slimBook(book) {
	return {
		id: book.id,
		title: book.title || '',
		author: book.author || '',
		category: book.category || '',
		status: book.status || '',
		cover: book.cover || '',
		lastUpdated: book.lastUpdated || ''
	}
}

// The host's own rule: a book that stopped updating falls off the board a day
// after it leaves the site's window. Filtering here means the page never shows a
// stale row, and `lastSeen` does not have to travel at all. A record without the
// field is one restored from an earlier export that never got re-scanned, and is
// kept rather than silently dropped.
const now = store.latest.at || Date.now()
const maxAge = (store.settings.universeDays + 1) * 86400000
const alive = (book) => !book.lastSeen || book.lastSeen >= now - maxAge

const books = {}
const sampled = {}
for (const [id, book] of Object.entries(store.books)) {
	if (!alive(book)) continue
	books[id] = slimBook(book)
	if (store.latest.v && store.latest.v[id]) sampled[id] = store.latest.v[id]
}

const results = []
results.push(write('books.json', { at: store.latest.at || null, books }))
results.push(write('latest.json', { at: store.latest.at || null, v: sampled, prev: store.latest.prev || null }))
results.push(write('hourly.json', { v: store.hours }))
results.push(write('daily.json', { v: store.days }))
results.push(write('status.json', {
	at: store.latest.at || null,
	books: Object.keys(books).length,
	sampled: Object.keys(sampled).length,
	firstAt: store.firstObservationAt(),
	universeDays: store.settings.universeDays,
	intervalMinutes: store.settings.intervalMinutes,
	scans: store.scans.slice(-10).reverse().map((scan) => ({
		startedAt: scan.startedAt,
		finishedAt: scan.finishedAt,
		ok: scan.ok,
		books: scan.books,
		failed: scan.failed
	}))
}))

const total = results.reduce((sum, entry) => sum + entry.bytes, 0)
for (const entry of results) {
	console.log(`  ${entry.changed ? '写出' : '未变'} ${entry.name.padEnd(14)} ${(entry.bytes / 1024).toFixed(1)} KB`)
}
console.log(`共 ${Object.keys(books).length} 本，${(total / 1024 / 1024).toFixed(2)} MB → ${outDir}`)
if (total > 6 * 1024 * 1024) {
	console.warn('提示：导出体积超过 6 MB，页面首次加载会变慢；可以调小 dailyRetentionDays。')
}
