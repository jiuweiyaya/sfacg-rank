/**
 * Scan once from the command line.
 *
 * The same scan the panel runs, with no harness around it. Two uses:
 *
 *   - a smoke test while developing (`--limit 40` takes seconds);
 *   - a scheduler-free cron: point Windows Task Scheduler (or Task Scheduler's
 *     "at logon / every hour") at this script when the DSH window is not
 *     expected to be open, and the data keeps filling in anyway.
 *
 * Usage: node tools/scan.mjs [--limit N] [--days 7|15|30] [--dir PATH] [--rps N]
 */
import path from 'node:path'
import { Store } from '../lib/store.js'
import { runScan } from '../lib/scan.js'
import { dataDir } from '../lib/config.js'

const argv = process.argv.slice(2)
function flag(name, fallback = null) {
	const index = argv.indexOf(`--${name}`)
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const directory = path.resolve(flag('dir', dataDir()))
const store = new Store(directory)
const settings = { ...store.settings }
if (flag('days') !== null) settings.universeDays = Number(flag('days'))
if (flag('rps') !== null) settings.requestsPerSecond = Number(flag('rps'))

console.log(`data: ${directory}`)
console.log(`settings:`, settings)

const started = Date.now()
let lastPrint = 0
const result = await runScan(store, {
	settings,
	limit: flag('limit') !== null ? Number(flag('limit')) : undefined,
	onProgress(event) {
		if (event.phase === 'discover') {
			process.stdout.write(`\r发现中：第 ${event.page} 页，${event.found} 本${event.total === null ? '' : ` / 共 ${event.total} 本`}`)
			return
		}
		// One line every ten seconds: enough to see the rate, quiet enough to read.
		if (event.phase === 'scan' && Date.now() - lastPrint > 10000) {
			lastPrint = Date.now()
			const elapsed = (Date.now() - started) / 1000
			const rate = event.done > 0 ? (event.done / elapsed).toFixed(2) : '0'
			process.stdout.write(`\r抓取中：${event.scanned}/${event.total} 本，失败 ${event.failed}，${rate} 本/秒`)
		}
	}
})
process.stdout.write('\n')
console.log(JSON.stringify(result, null, 2))
console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`)

const ranking = store.ranking({ windowHours: 24, limit: 5 })
console.log(`tracked ${ranking.total} books, ${ranking.covered} with a 24h baseline`)
for (const row of ranking.rows) {
	console.log(`  #${row.rank} ${row.title} — 收藏 ${row.collect} 新增 ${row.gain?.collect ?? '—'}`)
}

// A failed scan is a red run in Actions, which is what makes a silent block by
// the site visible instead of a site that quietly stops updating.
if (!result.ok) {
	console.error(`\n抓取失败：${result.message || result.scan?.message || '没有抓到数据'}`)
	process.exitCode = 1
}
