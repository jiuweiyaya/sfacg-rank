/**
 * Discovery and a full scan.
 *
 * A scan is two passes:
 *
 *   1. the "recently updated" list (`/List/?ud=7&PageIndex=1..N`) — 20 books per
 *      page, ~94 pages for the seven-day window, and the only place that says
 *      which books are worth looking at;
 *   2. one detail page per book, plus the small ticket endpoint.
 *
 * The whole thing is bounded by `Pacer`, so a scan of ~1,900 books takes about
 * six minutes at the default eight requests per second instead of hammering the
 * site with 3,800 parallel requests.
 */
import { listUrl, novelUrl, ticketUrl, parseListPage, parseNovelPage, parseTicketBody } from './parse.js'
import { fetchText, Pacer } from './http.js'
import { acquireLock } from './lock.js'

/** How many list pages to walk at most, as a guard against a broken total. */
const MAX_PAGES = 400

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Walk the recently-updated list.
 *
 * The site caps this listing at roughly 1,640 books per window (82 full pages)
 * even though it reports more, and the per-category and per-initial facets hit
 * the same ceiling — measured, see README. So one global walk is both the
 * cheapest and the most complete way to enumerate the window.
 *
 * It stops when a page returns nothing, or when two pages in a row add no new
 * book: the list is ordered by update time, so books move to page 1 while the
 * crawl is running, and a single duplicate-only page is not the end.
 */
export async function discover({ days = 7, pacer, maxPages = MAX_PAGES, onProgress, signal } = {}) {
	const seen = new Map()
	let total = null
	let pages = 0
	let emptyStreak = 0
	for (let page = 1; page <= maxPages; page += 1) {
		if (signal?.aborted) break
		let html = ''
		try {
			html = await pacer.run(() => fetchText(listUrl(days, page)))
		} catch {
			break
		}
		const parsed = parseListPage(html)
		if (parsed.total !== null) total = parsed.total
		let added = 0
		for (const item of parsed.items) {
			if (seen.has(item.id)) continue
			seen.set(item.id, item)
			added += 1
		}
		pages = page
		onProgress?.({ phase: 'discover', page, found: seen.size, total })
		if (parsed.items.length === 0) break
		emptyStreak = added === 0 ? emptyStreak + 1 : 0
		if (emptyStreak >= 2) break
	}
	return { total, pages, items: [...seen.values()] }
}

/** Fetch one book: its detail page and its monthly-ticket count. */
export async function fetchBook(id, pacer, signal) {
	if (signal?.aborted) throw new Error('cancelled')
	const html = await pacer.run(() => fetchText(novelUrl(id)))
	const page = parseNovelPage(html)
	let tickets = null
	try {
		const body = await pacer.run(() => fetchText(ticketUrl(id), { retries: 1, timeoutMs: 12000 }))
		tickets = parseTicketBody(body)
	} catch {
		tickets = null
	}
	return { ...page, tickets }
}

/**
 * Scan every book the list named.
 *
 * Failures are counted, not thrown: one dead book must not cost the whole hour's
 * snapshot. A book whose detail page fails simply keeps its previous sample and
 * shows up as "未更新" on the panel.
 */
export async function runScan(store, options = {}) {
	const settings = { ...store.settings, ...(options.settings ?? {}) }
	const { onProgress, signal } = options
	const startedAt = Date.now()

	// The panel's timer and the command line share one data directory; two
	// concurrent scans would race on the snapshot files and double the site load.
	const lock = acquireLock(store.dir)
	if (!lock.ok) {
		return {
			ok: false,
			skipped: true,
			discovered: 0,
			sampled: 0,
			failed: 0,
			scan: null,
			message: `已经有一个扫描在跑（pid ${lock.holder?.pid ?? '?'}）`
		}
	}
	try {
		return await scanLocked(store, settings, { onProgress, signal, startedAt, options })
	} finally {
		lock.release()
	}
}

/** The body of a scan, run while holding the lock. */
async function scanLocked(store, settings, { onProgress, signal, startedAt, options }) {
	const pacer = new Pacer({
		concurrency: settings.concurrency,
		minIntervalMs: Math.max(20, Math.round(1000 / Math.max(1, settings.requestsPerSecond)))
	})

	const progress = { phase: 'discover', page: 0, found: 0, total: null, done: 0, scanned: 0, failed: 0, title: '', startedAt }
	const emit = (patch) => {
		Object.assign(progress, patch)
		onProgress?.({ ...progress })
	}
	emit({ phase: 'discover' })

	let discovered = { total: null, items: [] }
	try {
		discovered = await discover({
			days: settings.universeDays,
			pacer,
			signal,
			onProgress: (event) => emit(event)
		})
	} catch (error) {
		const scan = {
			id: startedAt,
			startedAt,
			finishedAt: Date.now(),
			ok: false,
			books: 0,
			failed: 0,
			message: `发现阶段失败：${error?.message ?? error}`
		}
		store.scans.push(scan)
		store.save({ all: false })
		return { ok: false, discovered: 0, sampled: 0, failed: 0, scan }
	}

	// `limit` exists for the smoke test and for a quick refresh of the head of
	// the list; a normal scan leaves it out.
	const limit = Number(options.limit)
	const items = Number.isFinite(limit) && limit > 0 ? discovered.items.slice(0, limit) : discovered.items
	emit({ phase: 'scan', done: 0, total: items.length, failed: 0 })

	const samples = []
	let failed = 0
	let cursor = 0
	const workers = Array.from({ length: Math.max(1, settings.concurrency) }, () => (async () => {
		for (;;) {
			if (signal?.aborted) return
			const index = cursor
			cursor += 1
			if (index >= items.length) return
			const item = items[index]
			try {
				const detail = await fetchBook(item.id, pacer, signal)
				if (detail.collect === null) throw new Error('收藏未解析')
				samples.push({
					id: item.id,
					title: detail.title || item.title,
					author: detail.author || item.author,
					category: detail.category || item.category,
					status: detail.status,
					cover: detail.cover,
					intro: detail.intro,
					lastUpdated: detail.updatedAt,
					tid: item.tid,
					score: item.score,
					collect: detail.collect,
					clicks: detail.clicks,
					tickets: detail.tickets,
					words: detail.words ?? item.words,
					likes: detail.likes
				})
			} catch (error) {
				if (signal?.aborted) return
				failed += 1
				if (failed <= 5) emit({ lastError: `${item.id}: ${error?.message ?? error}` })
			}
			emit({ done: samples.length + failed, scanned: samples.length, failed, title: item.title })
		}
	})())

	await Promise.all(workers)

	const finishedAt = Date.now()
	const cancelled = signal?.aborted === true
	const scan = {
		id: startedAt,
		startedAt,
		finishedAt,
		ok: !cancelled && samples.length > 0,
		books: samples.length,
		failed,
		message: cancelled ? '已取消' : (samples.length === 0 ? '没有抓到任何数据' : '')
	}
	const committed = store.commitScan({ at: finishedAt, samples, scan })
	emit({ phase: 'done', done: items.length, scanned: committed, failed })
	return {
		ok: scan.ok,
		discovered: items.length,
		sampled: committed,
		failed,
		scan,
		elapsedMs: finishedAt - startedAt
	}
}

/**
 * Wait until the next scan is due.
 *
 * The host plugin calls this in a loop; `intervalMinutes` therefore means "time
 * between the *starts* of two scans" rather than "sleep one hour after each
 * one", so a slow scan cannot push the schedule later and later.
 */
export async function sleepUntilDue(lastStartedAt, intervalMinutes, { chunkMs = 30000 } = {}) {
	for (;;) {
		const wait = lastStartedAt + intervalMinutes * 60000 - Date.now()
		if (wait <= 0) return
		await sleep(Math.min(wait, chunkMs))
	}
}
