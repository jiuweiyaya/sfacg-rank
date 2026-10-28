/**
 * The time-series store.
 *
 * Why plain JSON files instead of an embedded database: the host process is the
 * user's desktop harness, and a plugin that drags a native module (or an
 * experimental `node:sqlite`) into it is a plugin that can stop the whole app
 * from booting after an upgrade. The data shape is small and fixed, so it is
 * kept as a handful of JSON files that are human-readable, trivially
 * back-up-able, and cannot fail to open:
 *
 *   books.json     one record per book: title, author, category, cover, intro…
 *   latest.json    the most recent scan: `{ at, v: { bookId: [collect, clicks, tickets, words] } }`
 *   hourly.json    `{ "2026-10-28T22": { at, v: {...} } }` — the last value of each hour
 *   daily.json     `{ "2026-10-28": { at, v: {...} } }`     — the last value of each day
 *   scans.json     the scan log
 *   settings.json  interval, universe, pacing
 *
 * One hour bucket and one day bucket each hold every tracked book, so "the value
 * of book X at time T" is a single object lookup and growth is a subtraction
 * between two buckets. That is what makes the leaderboard cheap enough to
 * re-render on every keystroke.
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSettings, DEFAULTS } from './config.js'

/** Fields sampled per book, in array order. */
export const FIELDS = ['collect', 'clicks', 'tickets', 'words']

/** How many daily deltas a leaderboard row carries for its mini chart. */
export const SPARK_DAYS = 14

/** The index of one field inside a sample array. */
export const FIELD_INDEX = { collect: 0, clicks: 1, tickets: 2, words: 3 }

const pad = (value) => (value < 10 ? `0${value}` : String(value))

/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
export function dayKey(ms) {
	const date = new Date(ms)
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local calendar hour of a timestamp, `YYYY-MM-DDTHH`. */
export function hourKey(ms) {
	const date = new Date(ms)
	return `${dayKey(ms)}T${pad(date.getHours())}`
}

/** Read a JSON file, or return `fallback` when it is missing or unreadable. */
function readJson(file, fallback) {
	try {
		const text = fs.readFileSync(file, 'utf8')
		if (text.trim() === '') return fallback
		return JSON.parse(text)
	} catch {
		return fallback
	}
}

/** Write a JSON file through a temporary name so a crash cannot truncate it. */
function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	const temporary = `${file}.tmp`
	fs.writeFileSync(temporary, JSON.stringify(value), 'utf8')
	fs.renameSync(temporary, file)
}

/** Subtract two samples field by field, keeping `null` when either side is unknown. */
export function sampleDelta(current, baseline) {
	if (!current || !baseline) return null
	const out = {}
	for (const field of FIELDS) {
		const a = current[FIELD_INDEX[field]]
		const b = baseline[FIELD_INDEX[field]]
		out[field] = a === null || a === undefined || b === null || b === undefined ? null : a - b
	}
	return out
}

/** A sample array from one book's numbers, normalising undefined to null. */
export function toSample(entry) {
	return FIELDS.map((field) => {
		const value = entry?.[field]
		return typeof value === 'number' && Number.isFinite(value) ? value : null
	})
}

/** Turn a sample array back into a named object for the API. */
export function fromSample(sample) {
	if (!sample) return { collect: null, clicks: null, tickets: null, words: null }
	const out = {}
	for (const field of FIELDS) out[field] = sample[FIELD_INDEX[field]] ?? null
	return out
}

export class Store {
	constructor(directory) {
		this.dir = directory
		this.books = {}
		this.latest = { at: 0, v: {} }
		this.previous = null
		this.hours = {}
		this.days = {}
		this.scans = []
		this.settings = { ...DEFAULTS }
		this.dirty = false
		this.load()
	}

	file(name) {
		return path.join(this.dir, name)
	}

	/** Load every file; any one of them may be missing on first run. */
	load() {
		const books = readJson(this.file('books.json'), null)
		if (books && typeof books === 'object' && books.books && typeof books.books === 'object') this.books = books.books
		const latest = readJson(this.file('latest.json'), null)
		if (latest && typeof latest.at === 'number' && latest.v && typeof latest.v === 'object') {
			this.latest = { at: latest.at, v: latest.v }
			if (latest.prev && typeof latest.prev.at === 'number' && latest.prev.v) this.previous = latest.prev
		}
		const hours = readJson(this.file('hourly.json'), null)
		if (hours && typeof hours === 'object' && hours.v && typeof hours.v === 'object') this.hours = hours.v
		const days = readJson(this.file('daily.json'), null)
		if (days && typeof days === 'object' && days.v && typeof days.v === 'object') this.days = days.v
		const scans = readJson(this.file('scans.json'), null)
		if (scans && Array.isArray(scans.v)) this.scans = scans.v
		const settings = readJson(this.file('settings.json'), null)
		this.settings = normalizeSettings(settings)
		return this
	}

	/** Persist the snapshot files. Called once per scan, not per book. */
	save({ all = true } = {}) {
		writeJson(this.file('books.json'), { version: 1, books: this.books })
		writeJson(this.file('latest.json'), { at: this.latest.at, v: this.latest.v, prev: this.previous })
		writeJson(this.file('hourly.json'), { v: this.hours })
		writeJson(this.file('daily.json'), { v: this.days })
		writeJson(this.file('scans.json'), { v: this.scans })
		if (all) writeJson(this.file('settings.json'), this.settings)
		this.dirty = false
	}

	/** Change settings and persist them. */
	updateSettings(patch) {
		this.settings = normalizeSettings({ ...this.settings, ...(patch ?? {}) })
		writeJson(this.file('settings.json'), this.settings)
		return this.settings
	}

	/**
	 * Apply one finished scan.
	 *
	 * `samples` is a list of `{ id, collect, clicks, tickets, words }` plus the
	 * optional metadata each detail page carries. A book whose numbers are all
	 * null is skipped: a failed fetch must not look like a book that lost every
	 * collection it had.
	 */
	commitScan({ at, samples, meta = {}, scan = null }) {
		const stamp = Number(at) || Date.now()
		const values = {}
		for (const entry of samples) {
			if (!entry || !Number.isFinite(Number(entry.id))) continue
			if (entry.collect === null || entry.collect === undefined) continue
			values[entry.id] = toSample(entry)
			const existing = this.books[entry.id] ?? { id: entry.id, firstSeen: stamp }
			const next = { ...existing }
			const fields = ['title', 'author', 'category', 'status', 'cover', 'intro', 'lastUpdated', 'tid', 'score']
			for (const field of fields) {
				const value = entry[field]
				if (value !== undefined && value !== null && value !== '') next[field] = value
			}
			next.id = entry.id
			next.firstSeen = existing.firstSeen ?? stamp
			next.lastSeen = stamp
			this.books[entry.id] = next
		}
		// Merge page metadata for books whose detail page failed but which still
		// showed up in the list: the title and category are better than nothing.
		for (const [id, patch] of Object.entries(meta)) {
			const existing = this.books[id]
			if (!existing || patch === null) continue
			for (const [field, value] of Object.entries(patch)) {
				if (value !== undefined && value !== null && value !== '' && !existing[field]) existing[field] = value
			}
			existing.lastSeen = existing.lastSeen ?? stamp
		}
		// Keep the snapshot this scan replaces: it is the only thing that can serve
		// as a baseline while two scans still share one hour bucket.
		if (this.latest.at > 0 && this.latest.at < stamp) this.previous = { at: this.latest.at, v: this.latest.v }
		// Merge rather than replace: a scan can be limited (`--limit`, or a scan
		// that was cancelled), and the books it did not reach must keep their last
		// known numbers instead of vanishing from the leaderboard.
		this.latest = { at: stamp, v: { ...this.latest.v, ...values } }
		const hour = hourKey(stamp)
		const day = dayKey(stamp)
		this.hours[hour] = { at: stamp, v: { ...(this.hours[hour]?.v ?? {}), ...values } }
		this.days[day] = { at: stamp, v: { ...(this.days[day]?.v ?? {}), ...values } }
		if (scan !== null) {
			this.scans.push(scan)
			const limit = this.settings.scanLogLimit
			if (this.scans.length > limit) this.scans = this.scans.slice(-limit)
		}
		this.prune(stamp)
		this.save()
		return Object.keys(values).length
	}

	/** Drop buckets older than the retention windows. */
	prune(now = Date.now()) {
		const hourCutoff = now - this.settings.hourlyRetentionHours * 3600000
		const dayCutoff = now - this.settings.dailyRetentionDays * 86400000
		for (const [key, bucket] of Object.entries(this.hours)) {
			if (bucket.at < hourCutoff) delete this.hours[key]
		}
		for (const [key, bucket] of Object.entries(this.days)) {
			if (bucket.at < dayCutoff) delete this.days[key]
		}
	}

	/** Every observation bucket, newest last: hourly on top of daily. */
	bucketList() {
		const list = []
		for (const [key, bucket] of Object.entries(this.hours)) list.push({ key, kind: 'hour', at: bucket.at, v: bucket.v })
		for (const [key, bucket] of Object.entries(this.days)) list.push({ key, kind: 'day', at: bucket.at, v: bucket.v })
		list.sort((left, right) => left.at - right.at)
		return list
	}

	/**
	 * The observation a growth figure is measured against.
	 *
	 * Normally the closest observation from before `cutoff` — for a 24-hour
	 * window that is yesterday's hourly bucket, for a 30-day window it is the day
	 * bucket from a month ago. When the history is younger than the window (the
	 * first days of a fresh install), the oldest observation stands in for it and
	 * the caller reports the shorter span, instead of showing an empty board until
	 * a week has gone by.
	 */
	observationAtOrBefore(cutoff) {
		let best = null
		for (const bucket of this.bucketList()) {
			if (bucket.at <= cutoff) best = bucket
			else break
		}
		if (best !== null) return best
		const oldest = this.bucketList()[0]
		return oldest ?? null
	}

	/** The current numbers for one book, or null when it has never been scanned. */
	current(id) {
		return this.latest.v[id] ?? null
	}

	/**
	 * The baseline for one growth window, or null when there is nothing to compare.
	 *
	 * Candidates are the hour/day buckets plus the snapshot from the scan before
	 * this one. The extra snapshot matters on the first day: two scans inside the
	 * same hour collapse into one bucket, and without it the panel would insist
	 * there is no growth for an hour after the numbers visibly moved.
	 *
	 * The chosen baseline is the newest candidate at or before the cutoff; when
	 * the history is younger than the window, the oldest candidate stands in, and
	 * the caller reports the shorter span. A baseline has to be strictly older
	 * than the newest observation — "latest minus itself" is a fake `+0` that
	 * would make a one-scan install look like a site where nothing ever grows.
	 */
	baselineFor(hours) {
		const now = this.latest.at || Date.now()
		const cutoff = now - Math.max(1, Number(hours) || 1) * 3600000
		const candidates = this.bucketList()
		if (this.previous !== null && this.previous.at > 0 && this.previous.at < now) {
			candidates.push({ key: 'previous-scan', kind: 'previous', at: this.previous.at, v: this.previous.v })
			candidates.sort((left, right) => left.at - right.at)
		}
		let best = null
		for (const candidate of candidates) {
			if (candidate.at <= cutoff) best = candidate
			else break
		}
		if (best === null) best = candidates[0] ?? null
		if (best === null || best.at >= now) return null
		return best
	}

	/**
	 * The leaderboard.
	 *
	 * Growth is `latest - baseline`. Both sides must exist and both numbers must
	 * be known: a book added in the last hour has no baseline and sorts last with
	 * a null gain, which the panel renders as "数据积累中" instead of a fake "+0".
	 */
	ranking(options = {}) {
		const {
			windowHours = 24,
			sort = 'collectGain',
			limit = 100,
			offset = 0,
			query = '',
			category = '',
			status = ''
		} = options
		const hours = Math.max(1, Math.min(24 * 60, Number(windowHours) || 24))
		const now = this.latest.at || Date.now()
		// Books that stopped being updated fall out of the site's window; keep them
		// in the history, but off the board, one day after they stop showing up.
		const maxAge = (Number(options.maxAgeDays) || this.settings.universeDays + 1) * 86400000
		const baseline = this.baselineFor(hours)
		const needle = String(query ?? '').trim().toLowerCase()
		const rows = []
		let covered = 0
		for (const [id, book] of Object.entries(this.books)) {
			const current = this.latest.v[id]
			if (!current) continue
			if ((book.lastSeen ?? 0) < now - maxAge) continue
			if (needle !== '') {
				const haystack = `${book.title ?? ''} ${book.author ?? ''}`.toLowerCase()
				if (!haystack.includes(needle)) continue
			}
			if (category !== '' && book.category !== category) continue
			if (status !== '' && book.status !== status) continue
			const base = baseline?.v?.[id] ?? null
			const gain = sampleDelta(current, base)
			if (gain !== null && gain.collect !== null) covered += 1
			const values = fromSample(current)
			const before = fromSample(base)
			rows.push({
				id: Number(id),
				title: book.title ?? '',
				author: book.author ?? '',
				category: book.category ?? '',
				status: book.status ?? '',
				cover: book.cover ?? '',
				lastUpdated: book.lastUpdated ?? '',
				lastSeen: book.lastSeen ?? 0,
				...values,
				base: before,
				gain,
				perDay: gain !== null && gain.collect !== null ? Number(((gain.collect / hours) * 24).toFixed(2)) : null,
				percent: gain !== null && gain.collect !== null && before.collect !== null && before.collect > 0
					? Number((((gain.collect / before.collect) * 100).toFixed(2)))
					: null
			})
		}
		const comparable = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
		const comparators = {
			// Nulls always sink: an unknown gain is not a zero gain.
			collectGain: (a, b) => compare(comparable(a.gain?.collect), comparable(b.gain?.collect)) || (b.collect ?? 0) - (a.collect ?? 0),
			percent: (a, b) => compare(comparable(a.percent), comparable(b.percent)) || (b.gain?.collect ?? 0) - (a.gain?.collect ?? 0),
			collect: (a, b) => (b.collect ?? 0) - (a.collect ?? 0),
			tickets: (a, b) => (b.tickets ?? 0) - (a.tickets ?? 0),
			clicks: (a, b) => (b.clicks ?? 0) - (a.clicks ?? 0),
			words: (a, b) => (b.words ?? 0) - (a.words ?? 0),
			wordsGain: (a, b) => compare(comparable(a.gain?.words), comparable(b.gain?.words)) || (b.words ?? 0) - (a.words ?? 0)
		}
		rows.sort(comparators[sort] ?? comparators.collectGain)
		const total = rows.length
		const page = rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(500, limit)))
		page.forEach((row, index) => {
			row.rank = Math.max(0, offset) + index + 1
		})
		return {
			at: now,
			windowHours: hours,
			sort,
			total,
			covered,
			baselineAt: baseline?.at ?? null,
			firstAt: this.firstObservationAt() ?? null,
			rows: page,
			categories: this.categories()
		}
	}

	/** The oldest observation the store still holds. */
	firstObservationAt() {
		const list = this.bucketList()
		return list.length === 0 ? null : list[0].at
	}

	/** Category names with the tracked-book counts, most common first. */
	categories() {
		const counts = new Map()
		for (const book of Object.values(this.books)) {
			if (!book.category) continue
			counts.set(book.category, (counts.get(book.category) ?? 0) + 1)
		}
		return [...counts.entries()]
			.sort((left, right) => right[1] - left[1])
			.map(([name, count]) => ({ name, count }))
	}

	/**
	 * One book's full history, as days and as recent hours.
	 *
	 * Day deltas are `this day - previous day`, so a book that sat still for a
	 * week shows a flat line of zeros and then a spike, which is the honest
	 * picture. `span` records how many days a delta actually covers, so a gap in
	 * the history cannot be mistaken for a one-day jump.
	 */
	series(id) {
		const bookKey = String(id)
		const days = []
		const buckets = Object.entries(this.days)
			.map(([dayKeyValue, bucket]) => ({ key: dayKeyValue, at: bucket.at, sample: bucket.v[bookKey] }))
			.filter((entry) => entry.sample)
			.sort((left, right) => left.at - right.at)
		let previous = null
		for (const entry of buckets) {
			const values = fromSample(entry.sample)
			const delta = previous === null ? null : sampleDelta(entry.sample, previous.sample)
			const span = previous === null ? null : Math.max(1, Math.round((entry.at - previous.at) / 86400000))
			days.push({ date: entry.key, at: entry.at, ...values, delta, span })
			previous = entry
		}
		const hours = []
		const hourBuckets = Object.entries(this.hours)
			.map(([hourKeyValue, bucket]) => ({ key: hourKeyValue, at: bucket.at, sample: bucket.v[bookKey] }))
			.filter((entry) => entry.sample)
			.sort((left, right) => left.at - right.at)
		let previousHour = null
		for (const entry of hourBuckets) {
			const values = fromSample(entry.sample)
			const delta = previousHour === null ? null : sampleDelta(entry.sample, previousHour.sample)
			hours.push({ key: entry.key, at: entry.at, ...values, delta })
			previousHour = entry
		}
		const current = this.current(bookKey)
		return { days, hours, current: fromSample(current) }
	}

	/**
	 * Day-over-day collection deltas for the leaderboard's mini chart.
	 *
	 * A row's sparkline is "how much did this book gain each day", not "what was
	 * its total" — the totals of a big book and a small one are not comparable on
	 * a 40-pixel chart, their daily gains are.
	 */
	sparkSeries(id, limit = SPARK_DAYS) {
		const key = String(id)
		const buckets = Object.entries(this.days)
			.map(([dayKeyValue, bucket]) => ({ at: bucket.at, sample: bucket.v[key] }))
			.filter((entry) => entry.sample)
			.sort((left, right) => left.at - right.at)
			.slice(-(limit + 1))
		const out = []
		for (let index = 1; index < buckets.length; index += 1) {
			const delta = sampleDelta(buckets[index].sample, buckets[index - 1].sample)
			out.push(delta === null || delta.collect === null ? null : delta.collect)
		}
		return out
	}

	/** One book with its metadata, its current numbers and a few growth windows. */
	book(id) {
		const key = String(id)
		const book = this.books[key] ?? null
		const series = this.series(key)
		const windows = {}
		if (series.current.collect !== null && series.current.collect !== undefined) {
			for (const hours of [1, 6, 24, 72, 168]) {
				const baseline = this.baselineFor(hours)
				windows[`${hours}h`] = {
					baselineAt: baseline?.at ?? null,
					gain: sampleDelta(this.current(key), baseline?.v?.[key] ?? null)
				}
			}
		}
		return {
			book,
			current: series.current,
			windows,
			days: series.days,
			hours: series.hours,
			at: this.latest.at || null
		}
	}

	/** Everything the panel's status line needs. */
	status() {
		const list = this.bucketList()
		return {
			at: this.latest.at || null,
			books: Object.keys(this.books).length,
			sampled: Object.keys(this.latest.v).length,
			firstAt: list.length === 0 ? null : list[0].at,
			buckets: { hours: Object.keys(this.hours).length, days: Object.keys(this.days).length },
			scans: this.scans.slice(-20).reverse(),
			lastScan: this.scans.length === 0 ? null : this.scans[this.scans.length - 1],
			settings: this.settings,
			dir: this.dir
		}
	}
}

/** Compare two numbers with nulls last. */
function compare(a, b) {
	if (a === null && b === null) return 0
	if (a === null) return 1
	if (b === null) return -1
	return b - a
}

/** Escape one CSV cell. */
function csvCell(value) {
	const text = value === null || value === undefined ? '' : String(value)
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The leaderboard as CSV text. */
export function rankingToCsv(ranking) {
	const header = ['排名', '书名', '作者', '分类', '状态', '新增收藏', '日均新增', '收藏', '月票', '人气', '字数', '最近更新']
	const lines = [header.join(',')]
	for (const row of ranking.rows) {
		lines.push([
			row.rank,
			row.title,
			row.author,
			row.category,
			row.status,
			row.gain?.collect ?? '',
			row.perDay ?? '',
			row.collect,
			row.tickets,
			row.clicks,
			row.words,
			row.lastUpdated
		].map(csvCell).join(','))
	}
	return `${lines.join('\n')}\n`
}
