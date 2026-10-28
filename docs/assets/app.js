/* 菠萝包数据榜 · 静态站，由 build-site.js 生成，不要手改 */
(function () {
	'use strict'
	// The shell normally provides this table; here only React is needed.
	var require = function () { return window.React }
	var module = { exports: {} }
	var exports = module.exports
	//#region src/client/util.js
	/**
	 * Small helpers shared by the leaderboard fragments.
	 *
	 * The bundle is a plain script (no import/export), so everything here is one
	 * top-level `var`/`function` in a shared scope and `build.js` decides the order.
	 */
	var React = require('react')

	/** Element factory; the fragments are plain scripts, so JSX is unavailable. */
	var h = React.createElement

	/** Merge class names, dropping falsy entries. */
	function cx() {
		var out = []
		for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i])
		return out.join(' ')
	}

	/** `12345` → `12,345`. */
	function fmtInt(value) {
		var number = Number(value)
		if (value === null || value === undefined || !isFinite(number)) return '—'
		return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	}

	/** `6001000` → `600.1万`, `108197` → `10.8万`, small numbers stay exact. */
	function fmtCompact(value) {
		var number = Number(value)
		if (value === null || value === undefined || !isFinite(number)) return '—'
		var abs = Math.abs(number)
		if (abs >= 1e8) return (number / 1e8).toFixed(2).replace(/\.0+$/, '') + '亿'
		if (abs >= 1e4) return (number / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
		return fmtInt(number)
	}

	/** A signed delta: `+128`, `-3`, `—`. */
	function fmtDelta(value) {
		var number = Number(value)
		if (value === null || value === undefined || !isFinite(number)) return '—'
		if (number === 0) return '0'
		return (number > 0 ? '+' : '') + fmtInt(number)
	}

	/** `22:40` for today, `10-27 22:40` for anything older. */
	function fmtClock(ms) {
		if (!ms) return '—'
		var date = new Date(ms)
		if (isNaN(date.getTime())) return '—'
		var pad = function (n) { return (n < 10 ? '0' : '') + n }
		var time = pad(date.getHours()) + ':' + pad(date.getMinutes())
		var now = new Date()
		if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time
		return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + time
	}

	/** `2026-10-28` → `10-28`. */
	function fmtDay(day) {
		return typeof day === 'string' && day.length >= 10 ? day.slice(5) : String(day == null ? '—' : day)
	}

	/** A duration in milliseconds as `3 天` / `5 小时` / `12 分钟`. */
	function fmtSpan(ms) {
		var minutes = Math.max(0, Math.round(ms / 60000))
		if (minutes >= 1440) return Math.round(minutes / 1440) + ' 天'
		if (minutes >= 60) return Math.round(minutes / 60) + ' 小时'
		return minutes + ' 分钟'
	}

	/** Trailing debounce, used by the search box. */
	function debounce(fn, wait) {
		var timer = null
		return function () {
			var args = arguments
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(function () {
				timer = null
				fn.apply(null, args)
			}, wait)
		}
	}

	/** Read a value out of localStorage without ever throwing at the caller. */
	function storageGet(key) {
		try {
			if (typeof localStorage === 'undefined') return null
			return localStorage.getItem(key)
		} catch (error) {
			return null
		}
	}

	/** Write a value to localStorage without ever throwing at the caller. */
	function storageSet(key, value) {
		try {
			if (typeof localStorage === 'undefined') return false
			localStorage.setItem(key, String(value))
			return true
		} catch (error) {
			return false
		}
	}

	/** Copy text to the clipboard; resolves true when the copy reached the OS. */
	function copyText(text) {
		if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).then(function () { return true }, function () { return false })
		}
		return Promise.resolve(false)
	}

	/**
	 * A neutral cover, as a data URI, for books whose image cannot be loaded.
	 *
	 * The site links covers straight from the book host, so an image that 404s (a
	 * deleted book, a hotlink block) would otherwise leave a broken-image icon in
	 * the middle of the table.
	 */
	var COVER_PLACEHOLDER = (function () {
		var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 34 46">' +
			'<rect width="34" height="46" rx="4" fill="#e3e6ef"/>' +
			'<circle cx="17" cy="18" r="6" fill="#b6bccd"/>' +
			'<path d="M9 32h16M9 36h10" stroke="#b6bccd" stroke-width="2" stroke-linecap="round"/></svg>'
		return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
	})()

	/** Swap a failed cover for the placeholder, once. */
	function coverFallback(event) {
		var image = event && event.currentTarget
		if (!image) return
		if (image.dataset && image.dataset.fallback === '1') return
		if (image.dataset) image.dataset.fallback = '1'
		image.src = COVER_PLACEHOLDER
	}
	//#endregion
	//#region src/site/rank-client.js
	/**
	 * The ranking maths, in the browser.
	 *
	 * The public site is static: GitHub Actions runs the same scanner as the DSH
	 * plugin, exports the store as JSON, and publishes it. This file reproduces
	 * `lib/store.js`'s ranking and per-book series so the page can sort, filter and
	 * draw without a server — and `tools/test-site-rank.mjs` asserts that the two
	 * implementations agree number for number, so a change to one cannot silently
	 * drift from the other.
	 *
	 * Plain script fragment: no imports, no exports, shared scope (see build-site.js).
	 */

	/** Fields sampled per book, in array order (same as lib/store.js). */
	var RANK_FIELDS = ['collect', 'clicks', 'tickets', 'words']
	var RANK_FIELD_INDEX = { collect: 0, clicks: 1, tickets: 2, words: 3 }

	var rankPad = function (n) { return (n < 10 ? '0' : '') + n }

	/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
	function rankDayKey(ms) {
		var date = new Date(ms)
		return date.getFullYear() + '-' + rankPad(date.getMonth() + 1) + '-' + rankPad(date.getDate())
	}

	/** Local calendar hour of a timestamp, `YYYY-MM-DDTHH`. */
	function rankHourKey(ms) {
		return rankDayKey(ms) + 'T' + rankPad(new Date(ms).getHours())
	}

	/** Subtract two samples field by field, keeping null where either side is unknown. */
	function rankSampleDelta(current, baseline) {
		if (!current || !baseline) return null
		var out = {}
		for (var i = 0; i < RANK_FIELDS.length; i++) {
			var a = current[i]
			var b = baseline[i]
			out[RANK_FIELDS[i]] = a === null || a === undefined || b === null || b === undefined ? null : a - b
		}
		return out
	}

	/** A sample array → named object. */
	function rankFromSample(sample) {
		if (!sample) return { collect: null, clicks: null, tickets: null, words: null }
		var out = {}
		for (var i = 0; i < RANK_FIELDS.length; i++) out[RANK_FIELDS[i]] = sample[i] === undefined ? null : sample[i]
		return out
	}

	/** Every observation bucket, newest last: hourly buckets on top of daily ones. */
	function rankBuckets(data) {
		var list = []
		var key
		for (key in data.hours) if (Object.prototype.hasOwnProperty.call(data.hours, key)) {
			list.push({ at: data.hours[key].at, v: data.hours[key].v })
		}
		for (key in data.days) if (Object.prototype.hasOwnProperty.call(data.days, key)) {
			list.push({ at: data.days[key].at, v: data.days[key].v })
		}
		list.sort(function (left, right) { return left.at - right.at })
		return list
	}

	/**
	 * The baseline for one growth window — the same rule as `Store.baselineFor`:
	 * the newest candidate at or before the cutoff, else the oldest one, and never
	 * the newest observation itself ("latest minus itself" is a fake +0).
	 */
	function rankBaselineFor(data, hours) {
		var now = data.latest.at || Date.now()
		var cutoff = now - Math.max(1, Number(hours) || 1) * 3600000
		var candidates = rankBuckets(data)
		var previous = data.latest.prev
		if (previous && previous.at > 0 && previous.at < now) {
			candidates.push({ at: previous.at, v: previous.v })
			candidates.sort(function (left, right) { return left.at - right.at })
		}
		var best = null
		for (var i = 0; i < candidates.length; i++) {
			if (candidates[i].at <= cutoff) best = candidates[i]
			else break
		}
		if (best === null) best = candidates.length > 0 ? candidates[0] : null
		if (best === null || best.at >= now) return null
		return best
	}

	/** Day-over-day collection deltas for a row's mini chart. */
	function rankSparkSeries(data, id, limit) {
		var bookKey = String(id)
		var buckets = []
		var key
		for (key in data.days) if (Object.prototype.hasOwnProperty.call(data.days, key)) {
			var sample = data.days[key].v[bookKey]
			if (sample) buckets.push({ at: data.days[key].at, sample: sample })
		}
		buckets.sort(function (left, right) { return left.at - right.at })
		buckets = buckets.slice(-((limit || 14) + 1))
		var out = []
		for (var i = 1; i < buckets.length; i++) {
			var delta = rankSampleDelta(buckets[i].sample, buckets[i - 1].sample)
			out.push(delta === null || delta.collect === null ? null : delta.collect)
		}
		return out
	}

	/** Nulls sort last, numbers descending. */
	function rankCompare(a, b) {
		if (a === null && b === null) return 0
		if (a === null) return 1
		if (b === null) return -1
		return b - a
	}

	/** A category list with counts, most common first. */
	function rankCategories(data) {
		var counts = {}
		var key
		for (key in data.books) if (Object.prototype.hasOwnProperty.call(data.books, key)) {
			var category = data.books[key].category
			if (!category) continue
			counts[category] = (counts[category] || 0) + 1
		}
		var list = []
		for (key in counts) if (Object.prototype.hasOwnProperty.call(counts, key)) list.push({ name: key, count: counts[key] })
		list.sort(function (left, right) { return right.count - left.count })
		return list
	}

	/**
	 * The leaderboard — a port of `Store.ranking` with the same defaults, sorting
	 * and null discipline.
	 */
	function computeRanking(data, options) {
		var opts = options || {}
		var windowHours = Math.max(1, Math.min(24 * 60, Number(opts.windowHours) || 24))
		var sort = opts.sort || 'collectGain'
		// The host's route caps a page at 500 rows; the site has the whole catalogue in
		// memory and lets the reader pull in all of it, so only guard against absurd
		// numbers here.
		var limit = Math.max(1, Math.min(5000, Number(opts.limit) || 100))
		var offset = Math.max(0, Number(opts.offset) || 0)
		var query = String(opts.query || '').trim().toLowerCase()
		var category = opts.category || ''
		var status = opts.status || ''
		var now = data.latest.at || Date.now()
		var maxAge = (Number(opts.maxAgeDays) || 8) * 86400000
		var baseline = rankBaselineFor(data, windowHours)
		var rows = []
		var covered = 0
		var key

		for (key in data.books) {
			if (!Object.prototype.hasOwnProperty.call(data.books, key)) continue
			var book = data.books[key]
			var current = data.latest.v[key]
			if (!current) continue
			// The export already dropped books that left the window, so a record
			// without `lastSeen` is current by construction; when the field is there
			// (the parity test feeds the raw store) apply the host's rule.
			if (book.lastSeen && book.lastSeen < now - maxAge) continue
			if (query !== '') {
				var haystack = String(book.title || '') + ' ' + String(book.author || '')
				if (haystack.toLowerCase().indexOf(query) < 0) continue
			}
			if (category !== '' && book.category !== category) continue
			if (status !== '' && book.status !== status) continue
			var base = baseline && baseline.v[key] ? baseline.v[key] : null
			var gain = rankSampleDelta(current, base)
			if (gain !== null && gain.collect !== null) covered += 1
			var values = rankFromSample(current)
			var before = rankFromSample(base)
			rows.push({
				id: Number(key) || key,
				title: book.title || '',
				author: book.author || '',
				category: book.category || '',
				status: book.status || '',
				cover: book.cover || '',
				lastUpdated: book.lastUpdated || '',
				lastSeen: book.lastSeen || 0,
				collect: values.collect,
				clicks: values.clicks,
				tickets: values.tickets,
				words: values.words,
				base: before,
				gain: gain,
				perDay: gain !== null && gain.collect !== null ? Number(((gain.collect / windowHours) * 24).toFixed(2)) : null,
				percent: gain !== null && gain.collect !== null && before.collect !== null && before.collect > 0
					? Number(((gain.collect / before.collect) * 100).toFixed(2))
					: null
			})
		}

		var comparable = function (value) { return typeof value === 'number' && isFinite(value) ? value : null }
		var comparators = {
			collectGain: function (a, b) {
				return rankCompare(comparable(a.gain === null ? null : a.gain.collect), comparable(b.gain === null ? null : b.gain.collect)) || (b.collect || 0) - (a.collect || 0)
			},
			percent: function (a, b) { return rankCompare(comparable(a.percent), comparable(b.percent)) || (b.gain === null ? 0 : (b.gain.collect || 0)) - (a.gain === null ? 0 : (a.gain.collect || 0)) },
			collect: function (a, b) { return (b.collect || 0) - (a.collect || 0) },
			tickets: function (a, b) { return (b.tickets || 0) - (a.tickets || 0) },
			clicks: function (a, b) { return (b.clicks || 0) - (a.clicks || 0) },
			words: function (a, b) { return (b.words || 0) - (a.words || 0) },
			wordsGain: function (a, b) {
				return rankCompare(comparable(a.gain === null ? null : a.gain.words), comparable(b.gain === null ? null : b.gain.words)) || (b.words || 0) - (a.words || 0)
			}
		}
		rows.sort(comparators[sort] || comparators.collectGain)
		var total = rows.length
		var page = rows.slice(offset, offset + limit)
		for (var index = 0; index < page.length; index++) {
			page[index].rank = offset + index + 1
			page[index].spark = rankSparkSeries(data, page[index].id, 14)
		}
		return {
			at: now,
			windowHours: windowHours,
			sort: sort,
			total: total,
			covered: covered,
			baselineAt: baseline === null ? null : baseline.at,
			firstAt: rankBuckets(data).length === 0 ? null : rankBuckets(data)[0].at,
			rows: page,
			categories: rankCategories(data)
		}
	}

	/** One book's daily and hourly history, with deltas. */
	function computeBookSeries(data, id) {
		var bookKey = String(id)
		var days = []
		var key
		for (key in data.days) if (Object.prototype.hasOwnProperty.call(data.days, key)) {
			var daySample = data.days[key].v[bookKey]
			if (daySample) days.push({ key: key, at: data.days[key].at, sample: daySample })
		}
		days.sort(function (left, right) { return left.at - right.at })
		var dayRows = []
		var previous = null
		for (var i = 0; i < days.length; i++) {
			var values = rankFromSample(days[i].sample)
			var delta = previous === null ? null : rankSampleDelta(days[i].sample, previous.sample)
			var span = previous === null ? null : Math.max(1, Math.round((days[i].at - previous.at) / 86400000))
			dayRows.push({
				date: days[i].key,
				at: days[i].at,
				collect: values.collect,
				clicks: values.clicks,
				tickets: values.tickets,
				words: values.words,
				delta: delta,
				span: span
			})
			previous = days[i]
		}

		var hours = []
		for (key in data.hours) if (Object.prototype.hasOwnProperty.call(data.hours, key)) {
			var hourSample = data.hours[key].v[bookKey]
			if (hourSample) hours.push({ key: key, at: data.hours[key].at, sample: hourSample })
		}
		hours.sort(function (left, right) { return left.at - right.at })
		var hourRows = []
		var previousHour = null
		for (var j = 0; j < hours.length; j++) {
			var hourValues = rankFromSample(hours[j].sample)
			var hourDelta = previousHour === null ? null : rankSampleDelta(hours[j].sample, previousHour.sample)
			hourRows.push({
				key: hours[j].key,
				at: hours[j].at,
				collect: hourValues.collect,
				clicks: hourValues.clicks,
				tickets: hourValues.tickets,
				words: hourValues.words,
				delta: hourDelta
			})
			previousHour = hours[j]
		}
		return { days: dayRows, hours: hourRows, current: rankFromSample(data.latest.v[bookKey]) }
	}

	/** One book as the drawer expects it — a port of `Store.book`. */
	function computeBook(data, id) {
		var bookKey = String(id)
		var book = data.books[bookKey]
		if (!book) return null
		var series = computeBookSeries(data, bookKey)
		var windows = {}
		var current = data.latest.v[bookKey]
		if (current && current[RANK_FIELD_INDEX.collect] !== null && current[RANK_FIELD_INDEX.collect] !== undefined) {
			var sizes = [1, 6, 24, 72, 168]
			for (var i = 0; i < sizes.length; i++) {
				var baseline = rankBaselineFor(data, sizes[i])
				windows[sizes[i] + 'h'] = {
					baselineAt: baseline === null ? null : baseline.at,
					gain: rankSampleDelta(current, baseline && baseline.v[bookKey] ? baseline.v[bookKey] : null)
				}
			}
		}
		return {
			book: book,
			current: series.current,
			windows: windows,
			days: series.days,
			hours: series.hours,
			at: data.latest.at || null
		}
	}
	//#endregion
	//#region src/site/api-static.js
	/**
	 * The static site's data layer.
	 *
	 * It replaces `src/client/api.js`: same three functions (`apiGet`, `apiPost`,
	 * `coverUrl`), but reading the JSON files the exporter writes instead of calling
	 * the host route. Everything downstream — the table, the drawer, the charts —
	 * is the same code the DSH panel renders, which is the point: one UI, two
	 * deployments.
	 */
	var SITE_DATA = 'data'

	/** The loaded store, and the promise that loads it once. */
	var siteStore = null
	var siteStorePromise = null

	/** Fetch one JSON file with no-cache so a refresh shows the newest export. */
	function siteFetchJson(name) {
		return fetch(SITE_DATA + '/' + name, { cache: 'no-cache' }).then(function (response) {
			if (!response.ok) throw new Error(SITE_DATA + '/' + name + ' → HTTP ' + response.status)
			return response.json()
		})
	}

	/** Load the four data files once; every later call reuses them. */
	function loadSiteStore() {
		if (siteStorePromise !== null) return siteStorePromise
		siteStorePromise = Promise.all([
			siteFetchJson('books.json'),
			siteFetchJson('latest.json'),
			siteFetchJson('hourly.json'),
			siteFetchJson('daily.json')
		]).then(function (parts) {
			siteStore = {
				books: (parts[0] && parts[0].books) || {},
				latest: parts[1] || { at: 0, v: {} },
				hours: (parts[2] && parts[2].v) || {},
				days: (parts[3] && parts[3].v) || {}
			}
			return siteStore
		}, function (error) {
			siteStorePromise = null
			throw error
		})
		return siteStorePromise
	}

	/** The site's status card, read straight from the exported file. */
	function loadSiteStatus() {
		return siteFetchJson('status.json')
	}

	var API_BASE = SITE_DATA

	/** A neutral cover for books whose image fails, as a data URI. */
	var SITE_PLACEHOLDER = (function () {
		var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 34 46">' +
			'<rect width="34" height="46" rx="4" fill="#e6e8f0"/>' +
			'<path d="M9 30h16M9 34h10" stroke="#b6bccd" stroke-width="2" stroke-linecap="round"/>' +
			'<circle cx="17" cy="18" r="6" fill="#b6bccd"/></svg>'
		return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
	})()

	/** Answer one of the panel's reads from the static files. */
	function apiGet(path, params) {
		var query = params || {}
		if (path === '/status') return loadSiteStatus()
		if (path === '/ranking') {
			return loadSiteStore().then(function (data) {
				return computeRanking(data, {
					windowHours: query.windowHours,
					sort: query.sort,
					limit: query.limit,
					offset: query.offset,
					query: query.q,
					category: query.category,
					status: query.status
				})
			})
		}
		if (path === '/book') {
			return loadSiteStore().then(function (data) {
				var payload = computeBook(data, query.id)
				if (payload === null) throw new Error('这本书还没有被收录')
				return payload
			})
		}
		return Promise.reject(new Error('静态站点没有这个接口：' + path))
	}

	/** Scanning is a GitHub Actions job; the page cannot start one. */
	function apiPost() {
		return Promise.reject(new Error('抓取由 GitHub Actions 每小时自动运行，这里不能手动触发'))
	}

	/**
	 * The cover for one book.
	 *
	 * The site links the site's own image host directly (it answers with
	 * `access-control-allow-origin: *` and no Referer requirement), so no proxy is
	 * needed the way it is for the local host.
	 */
	function coverUrl(id) {
		var book = siteStore && siteStore.books ? siteStore.books[String(id)] : null
		var cover = book && book.cover ? book.cover : ''
		if (cover === '') return SITE_PLACEHOLDER
		return cover.replace(/^http:/, 'https:')
	}

	/** The placeholder, exported for the table's onError fallback. */
	function placeholderCover() {
		return SITE_PLACEHOLDER
	}
	//#endregion
	//#region src/client/chart.js
	/**
	 * The charts, hand-drawn as SVG.
	 *
	 * No charting dependency: the bundle ships into a shell with a frozen module
	 * table, and a 60 kB chart library for three shapes (line, bar, sparkline) is a
	 * bad trade. The shapes here are small enough to reason about and the tests can
	 * assert on the generated path strings.
	 */

	/** A linear scale from a value domain to a pixel range. */
	function makeScale(domainMin, domainMax, rangeMin, rangeMax) {
		var span = domainMax - domainMin
		if (!isFinite(span) || span === 0) span = 1
		return function (value) {
			return rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin)
		}
	}

	/** Four-ish round ticks covering `[min, max]`. */
	function niceTicks(min, max, count) {
		if (!isFinite(min) || !isFinite(max) || min === max) {
			var only = isFinite(max) ? max : 0
			return [only]
		}
		var steps = Math.max(1, count || 4)
		var raw = (max - min) / steps
		var magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10))
		var candidates = [1, 2, 2.5, 5, 10]
		var step = magnitude
		for (var i = 0; i < candidates.length; i++) {
			if (candidates[i] * magnitude >= raw) {
				step = candidates[i] * magnitude
				break
			}
		}
		var start = Math.floor(min / step) * step
		var ticks = []
		for (var value = start; value <= max + step * 0.5; value += step) {
			ticks.push(Number(value.toFixed(6)))
		}
		if (ticks.length < 2) ticks.push(start + step)
		return ticks
	}

	/**
	 * Split a series into path segments, keeping gaps for unknown points.
	 *
	 * A missing sample means "not measured", not "zero", so a gap has to break the
	 * line rather than be interpolated across.
	 */
	function splitSegments(points) {
		var segments = []
		var current = []
		for (var i = 0; i < points.length; i++) {
			var point = points[i]
			if (point.value === null || point.value === undefined || !isFinite(point.value)) {
				if (current.length > 0) segments.push(current)
				current = []
				continue
			}
			current.push(point)
		}
		if (current.length > 0) segments.push(current)
		return segments
	}

	/** Build the `d` attribute for a polyline through points. */
	function linePath(points, x, y) {
		return points.map(function (point, index) {
			return (index === 0 ? 'M' : 'L') + x(point.index).toFixed(1) + ' ' + y(point.value).toFixed(1)
		}).join(' ')
	}

	/** Build the `d` attribute for the filled area under a segment. */
	function areaPath(points, x, y, baseline) {
		if (points.length === 0) return ''
		var top = points.map(function (point, index) {
			return (index === 0 ? 'M' : 'L') + x(point.index).toFixed(1) + ' ' + y(point.value).toFixed(1)
		}).join(' ')
		var last = points[points.length - 1]
		var first = points[0]
		return top + ' L' + x(last.index).toFixed(1) + ' ' + baseline.toFixed(1) + ' L' + x(first.index).toFixed(1) + ' ' + baseline.toFixed(1) + ' Z'
	}

	/**
	 * A line chart with an optional filled area and a hover readout.
	 *
	 * `points` is `[{ label, value }]`; `label` is what the tooltip and the x axis
	 * show. The chart is drawn in a fixed viewBox and stretched by CSS, and the
	 * hover index is derived from the pointer's fraction across the element, so the
	 * readout stays correct at any panel width.
	 */
	function TrendChart(props) {
		var points = props.points || []
		var height = props.height || 210
		var width = 720
		var padding = { top: 12, right: 14, bottom: 22, left: 46 }
		var innerWidth = width - padding.left - padding.right
		var innerHeight = height - padding.top - padding.bottom
		var hoverState = React.useState(-1)
		var hover = hoverState[0]
		var setHover = hoverState[1]
		var idState = React.useState(function () { return 'dsh-sfacg-grad-' + Math.random().toString(36).slice(2, 9) })
		var gradientId = idState[0]

		var numeric = []
		for (var i = 0; i < points.length; i++) {
			var value = points[i].value
			if (value !== null && value !== undefined && isFinite(value)) numeric.push(value)
		}
		var hasData = numeric.length > 0
		var min = hasData ? Math.min.apply(null, numeric) : 0
		var max = hasData ? Math.max.apply(null, numeric) : 1
		var zeroBased = props.zeroBased === true
		if (zeroBased) min = Math.min(0, min)
		if (props.min !== undefined) min = props.min
		if (props.max !== undefined) max = props.max
		if (min === max) {
			min = zeroBased ? 0 : min - 1
			max = max + 1
		}
		if (!zeroBased && min > 0) {
			var pad = (max - min) * 0.12
			min = Math.max(0, min - pad)
			max = max + pad
		}
		var ticks = niceTicks(min, max, 4)
		min = Math.min(min, ticks[0])
		max = Math.max(max, ticks[ticks.length - 1])

		var x = function (index) {
			if (points.length <= 1) return padding.left + innerWidth / 2
			return padding.left + (index / (points.length - 1)) * innerWidth
		}
		var y = makeScale(min, max, padding.top + innerHeight, padding.top)
		var indexed = []
		for (var k = 0; k < points.length; k++) indexed.push({ index: k, label: points[k].label, value: points[k].value })
		var segments = splitSegments(indexed)
		var baseline = padding.top + innerHeight
		var color = props.color || 'var(--dsw-brand-primary,#4d6bfe)'
		var format = props.format || fmtInt
		var labelEvery = Math.max(1, Math.ceil(points.length / 6))
		var hovered = hover >= 0 && hover < points.length ? points[hover] : null

		var children = [
			h('defs', { key: 'defs' },
				h('linearGradient', { id: gradientId, x1: '0', y1: '0', x2: '0', y2: '1' },
					h('stop', { offset: '0%', stopColor: color, stopOpacity: '0.26' }),
					h('stop', { offset: '100%', stopColor: color, stopOpacity: '0.02' })
				)
			)
		]

		// horizontal grid + y labels
		ticks.forEach(function (tick) {
			var ty = y(tick)
			children.push(h('line', {
				key: 'grid-' + tick,
				x1: padding.left,
				x2: width - padding.right,
				y1: ty,
				y2: ty,
				stroke: 'currentColor',
				strokeOpacity: '0.12',
				strokeWidth: '1'
			}))
			children.push(h('text', {
				key: 'ylab-' + tick,
				x: padding.left - 8,
				y: ty + 3.5,
				textAnchor: 'end',
				fontSize: '10',
				fill: 'currentColor',
				fillOpacity: '0.5'
			}, format(tick, true)))
		})

		// x labels
		points.forEach(function (point, index) {
			if (index % labelEvery !== 0 && index !== points.length - 1) return
			children.push(h('text', {
				key: 'xlab-' + index,
				x: x(index),
				y: height - 6,
				textAnchor: index === 0 ? 'start' : (index === points.length - 1 ? 'end' : 'middle'),
				fontSize: '10',
				fill: 'currentColor',
				fillOpacity: '0.5'
			}, point.label))
		})

		// the series
		segments.forEach(function (segment, index) {
			children.push(h('path', {
				key: 'area-' + index,
				d: areaPath(segment, x, y, baseline),
				fill: 'url(#' + gradientId + ')',
				stroke: 'none'
			}))
			children.push(h('path', {
				key: 'line-' + index,
				d: linePath(segment, x, y),
				fill: 'none',
				stroke: color,
				strokeWidth: '1.8',
				strokeLinejoin: 'round',
				strokeLinecap: 'round'
			}))
			if (props.dots !== false && segment.length <= 40) {
				segment.forEach(function (point) {
					children.push(h('circle', {
						key: 'dot-' + point.index,
						cx: x(point.index),
						cy: y(point.value),
						r: '2.2',
						fill: color,
						fillOpacity: '0.85'
					}))
				})
			}
		})

		// hover crosshair
		if (hovered !== null && hovered.value !== null && hovered.value !== undefined && isFinite(hovered.value)) {
			children.push(h('line', {
				key: 'cross',
				x1: x(hover),
				x2: x(hover),
				y1: padding.top,
				y2: baseline,
				stroke: 'currentColor',
				strokeOpacity: '0.28',
				strokeDasharray: '3 3'
			}))
			children.push(h('circle', {
				key: 'hoverdot',
				cx: x(hover),
				cy: y(hovered.value),
				r: '3.6',
				fill: color,
				stroke: 'var(--dsw-alias-bg-base,#fff)',
				strokeWidth: '1.4'
			}))
		}

		var tooltip = null
		if (hovered !== null && hovered.value !== null && hovered.value !== undefined) {
			tooltip = h('div', {
				className: 'dsh-sfacg-tip',
				style: {
					left: ((x(hover) / width) * 100) + '%',
					top: Math.max(4, (y(hovered.value) / height) * 100 - 4) + '%'
				}
			},
				h('div', null, String(hovered.label)),
				h('b', null, format(hovered.value))
			)
		}

		return h('div', { className: 'dsh-sfacg-chartbox', onMouseLeave: function () { setHover(-1) } },
			h('svg', {
				className: 'dsh-sfacg-chart',
				viewBox: '0 0 ' + width + ' ' + height,
				role: 'img',
				onMouseMove: function (event) {
					var rect = event.currentTarget.getBoundingClientRect()
					if (rect.width === 0 || points.length === 0) return
					var ratio = (event.clientX - rect.left) / rect.width
					var index = Math.round(ratio * (points.length - 1))
					setHover(Math.max(0, Math.min(points.length - 1, index)))
				}
			}, children),
			hasData ? null : h('div', { className: 'dsh-sfacg-empty' }, '这一段还没有数据'),
			tooltip
		)
	}

	/**
	 * Daily-change bars: green above zero, red below.
	 *
	 * This is the chart the panel opens on, because "how much did it grow today" is
	 * the question the leaderboard is about, and a total-collection line makes a
	 * growing book look almost flat.
	 */
	function BarChart(props) {
		var points = props.points || []
		var height = props.height || 190
		var width = 720
		var padding = { top: 12, right: 14, bottom: 22, left: 46 }
		var innerWidth = width - padding.left - padding.right
		var innerHeight = height - padding.top - padding.bottom
		var hoverState = React.useState(-1)
		var hover = hoverState[0]
		var setHover = hoverState[1]
		var format = props.format || fmtDelta

		var numeric = []
		for (var i = 0; i < points.length; i++) {
			var value = points[i].value
			if (value !== null && value !== undefined && isFinite(value)) numeric.push(value)
		}
		var max = numeric.length > 0 ? Math.max.apply(null, numeric) : 1
		var min = numeric.length > 0 ? Math.min.apply(null, numeric) : 0
		max = Math.max(0, max)
		min = Math.min(0, min)
		if (max === min) max = min + 1
		var ticks = niceTicks(min, max, 4)
		min = Math.min(min, ticks[0])
		max = Math.max(max, ticks[ticks.length - 1])
		var y = makeScale(min, max, padding.top + innerHeight, padding.top)
		var zeroY = y(0)
		var slot = points.length === 0 ? innerWidth : innerWidth / points.length
		var barWidth = Math.max(2, Math.min(28, slot * 0.68))
		var labelEvery = Math.max(1, Math.ceil(points.length / 7))
		var hovered = hover >= 0 && hover < points.length ? points[hover] : null

		var children = []
		ticks.forEach(function (tick) {
			children.push(h('line', {
				key: 'grid-' + tick,
				x1: padding.left,
				x2: width - padding.right,
				y1: y(tick),
				y2: y(tick),
				stroke: 'currentColor',
				strokeOpacity: tick === 0 ? '0.35' : '0.1',
				strokeWidth: '1'
			}))
			children.push(h('text', {
				key: 'ylab-' + tick,
				x: padding.left - 8,
				y: y(tick) + 3.5,
				textAnchor: 'end',
				fontSize: '10',
				fill: 'currentColor',
				fillOpacity: '0.5'
			}, format(tick, true)))
		})
		points.forEach(function (point, index) {
			var value = point.value
			var centre = padding.left + slot * index + slot / 2
			if (value !== null && value !== undefined && isFinite(value) && value !== 0) {
				var top = value >= 0 ? y(value) : zeroY
				var bottom = value >= 0 ? zeroY : y(value)
				children.push(h('rect', {
					key: 'bar-' + index,
					x: centre - barWidth / 2,
					y: top,
					width: barWidth,
					height: Math.max(1, bottom - top),
					rx: Math.min(2, barWidth / 2),
					fill: value >= 0 ? '#3fa66a' : '#e5534b',
					fillOpacity: hover === index ? '1' : '0.72'
				}))
			}
			if (index % labelEvery === 0 || index === points.length - 1) {
				children.push(h('text', {
					key: 'xlab-' + index,
					x: centre,
					y: height - 6,
					textAnchor: 'middle',
					fontSize: '10',
					fill: 'currentColor',
					fillOpacity: '0.5'
				}, point.label))
			}
		})

		return h('div', { className: 'dsh-sfacg-chartbox', onMouseLeave: function () { setHover(-1) } },
			h('svg', {
				className: 'dsh-sfacg-chart',
				viewBox: '0 0 ' + width + ' ' + height,
				role: 'img',
				onMouseMove: function (event) {
					var rect = event.currentTarget.getBoundingClientRect()
					if (rect.width === 0 || points.length === 0) return
					var local = ((event.clientX - rect.left) / rect.width) * width
					var index = Math.floor((local - padding.left) / slot)
					setHover(Math.max(0, Math.min(points.length - 1, index)))
				}
			}, children),
			numeric.length === 0 ? h('div', { className: 'dsh-sfacg-empty' }, '还没有两天的数据，明天这时就能看到增量') : null,
			hovered === null ? null : h('div', {
				className: 'dsh-sfacg-tip',
				style: {
					left: (((padding.left + slot * hover + slot / 2) / width) * 100) + '%',
					top: '6px'
				}
			},
				h('div', null, String(hovered.label)),
				h('b', null, format(hovered.value))
			)
		)
	}

	/**
	 * The leaderboard's 96×26 trend: one tiny bar per day, in place of numbers.
	 *
	 * Bars rather than a line because a day with no gain has to look like an
	 * empty slot, not like a line dipping to zero.
	 */
	function Sparkline(props) {
		var values = props.values || []
		var width = 96
		var height = 26
		if (values.length === 0) {
			return h('svg', { className: 'dsh-sfacg-spark', viewBox: '0 0 ' + width + ' ' + height },
				h('line', { x1: 0, x2: width, y1: height - 2, y2: height - 2, stroke: 'currentColor', strokeOpacity: '0.16' })
			)
		}
		var numeric = []
		for (var i = 0; i < values.length; i++) {
			if (values[i] !== null && values[i] !== undefined && isFinite(values[i])) numeric.push(values[i])
		}
		var max = numeric.length === 0 ? 1 : Math.max.apply(null, numeric)
		var min = numeric.length === 0 ? 0 : Math.min.apply(null, numeric)
		if (max === min) max = min + 1
		var zeroY = height - 2 - ((0 - min) / (max - min)) * (height - 4)
		var slot = width / values.length
		var barWidth = Math.max(1.6, Math.min(6, slot * 0.62))
		var children = []
		for (var index = 0; index < values.length; index++) {
			var value = values[index]
			if (value === null || value === undefined || !isFinite(value) || value === 0) continue
			var top = value >= 0 ? height - 2 - ((value - min) / (max - min)) * (height - 4) : zeroY
			var bottom = value >= 0 ? zeroY : height - 2 - ((value - min) / (max - min)) * (height - 4)
			children.push(h('rect', {
				key: 's' + index,
				x: index * slot + (slot - barWidth) / 2,
				y: Math.min(top, bottom),
				width: barWidth,
				height: Math.max(1, Math.abs(bottom - top)),
				fill: value >= 0 ? '#3fa66a' : '#e5534b',
				fillOpacity: '0.82'
			}))
		}
		return h('svg', { className: 'dsh-sfacg-spark', viewBox: '0 0 ' + width + ' ' + height, 'aria-hidden': 'true' }, children)
	}
	//#endregion
	//#region src/client/style.js
	/**
	 * Stylesheet for the SF轻小说 data panel.
	 *
	 * Same contract as the other DSH panels: one owned `<style>` tag carrying
	 * `data-plugin-css`, every selector scoped under `.dsh-sfacg`, and colours read
	 * from the shell's theme tokens so the panel follows dark/light without its own
	 * palette.
	 */
	var STYLE_ID = 'dsh-sfacg-rank/panel.css'

	var CSS = [
		'.dsh-sfacg{display:flex;flex-direction:column;height:100%;min-height:0;position:relative;color:var(--dsw-alias-label-primary,#1b1b1b);font-size:14px}',
		'.dsh-sfacg *{box-sizing:border-box}',
		'.dsh-sfacg button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}',
		'.dsh-sfacg input,.dsh-sfacg select{font:inherit;color:inherit}',
		'.dsh-sfacg ::-webkit-scrollbar{width:10px;height:10px}',
		'.dsh-sfacg ::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);border-radius:6px}',
		'.dsh-sfacg ::-webkit-scrollbar-track{background:transparent}',

		// top bar
		'.dsh-sfacg-top{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));flex:none;flex-wrap:wrap}',
		'.dsh-sfacg-brand{font-weight:650;font-size:15px;letter-spacing:.2px}',
		'.dsh-sfacg-brand em{font-style:normal;font-weight:400;font-size:12px;opacity:.55;margin-left:6px}',
		'.dsh-sfacg-spacer{flex:1}',
		'.dsh-sfacg-meta{font-size:12px;opacity:.62;white-space:nowrap}',
		'.dsh-sfacg-pill{font-size:11px;opacity:.72;padding:2px 8px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));white-space:nowrap}',
		'.dsh-sfacg-pill.is-live{border-color:rgba(63,166,106,.55);color:#3fa66a}',
		'.dsh-sfacg-pill.is-warn{border-color:rgba(198,144,38,.55);color:#c69026}',
		'.dsh-sfacg-pill.is-bad{border-color:rgba(229,83,75,.55);color:#e5534b}',

		// controls
		'.dsh-sfacg-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;padding:4px 10px;font-size:12px;white-space:nowrap}',
		'.dsh-sfacg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
		'.dsh-sfacg-btn.is-primary{border-color:transparent;background:var(--dsw-brand-primary,#4d6bfe);color:#fff}',
		'.dsh-sfacg-btn.is-primary:hover{filter:brightness(1.08)}',
		'.dsh-sfacg-btn.is-on{background:rgba(127,127,127,.2);font-weight:600;border-color:var(--dsw-brand-primary,#4d6bfe)}',
		'.dsh-sfacg-btn:disabled{opacity:.45;cursor:default}',
		'.dsh-sfacg-select{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:rgba(127,127,127,.06);padding:3px 6px;font-size:12px}',
		'.dsh-sfacg-input{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:rgba(127,127,127,.06);padding:4px 8px;font-size:12.5px;width:180px}',
		'.dsh-sfacg-input:focus{outline:none;border-color:var(--dsw-brand-primary,#4d6bfe)}',
		'.dsh-sfacg-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;overflow:hidden}',
		'.dsh-sfacg-seg button{padding:3px 9px;font-size:12px;border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
		'.dsh-sfacg-seg button:last-child{border-right:none}',
		'.dsh-sfacg-seg button.is-on{background:rgba(77,107,254,.16);font-weight:600;color:var(--dsw-brand-primary,#4d6bfe)}',

		// table
		'.dsh-sfacg-body{flex:1;min-height:0;overflow:auto;position:relative}',
		'.dsh-sfacg-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}',
		'.dsh-sfacg-table thead th{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base,#fff);text-align:left;font-weight:500;font-size:11.5px;opacity:.66;padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));white-space:nowrap}',
		'.dsh-sfacg-table thead th.is-sortable{cursor:pointer;user-select:none}',
		'.dsh-sfacg-table thead th.is-sortable:hover{opacity:1}',
		'.dsh-sfacg-table thead th.is-on{opacity:1;color:var(--dsw-brand-primary,#4d6bfe);font-weight:650}',
		'.dsh-sfacg-table tbody td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.13));vertical-align:middle}',
		'.dsh-sfacg-table tbody tr{cursor:pointer}',
		'.dsh-sfacg-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
		'.dsh-sfacg-table tbody tr.is-open{background:rgba(77,107,254,.1)}',
		'.dsh-sfacg-rank{font-variant-numeric:tabular-nums;opacity:.7;font-size:12px;width:44px}',
		'.dsh-sfacg-rank.is-top{opacity:1;font-weight:700;color:var(--dsw-brand-primary,#4d6bfe)}',
		'.dsh-sfacg-cover{width:34px;height:46px;border-radius:4px;object-fit:cover;background:rgba(127,127,127,.15);display:block}',
		'.dsh-sfacg-name{font-weight:550;line-height:1.3;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dsh-sfacg-sub{font-size:11.5px;opacity:.55;line-height:1.4;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dsh-sfacg-num{font-variant-numeric:tabular-nums;white-space:nowrap}',
		'.dsh-sfacg-num.is-gain{font-weight:650;color:#3fa66a}',
		'.dsh-sfacg-num.is-up{color:#3fa66a}',
		'.dsh-sfacg-num.is-down{color:#e5534b}',
		'.dsh-sfacg-num.is-muted{opacity:.4}',
		'.dsh-sfacg-spark{display:block;width:96px;height:26px;overflow:visible}',
		'.dsh-sfacg-tag{font-size:10.5px;padding:1px 6px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));opacity:.8;white-space:nowrap}',
		'.dsh-sfacg-empty{padding:48px 24px;text-align:center;opacity:.62;line-height:1.9;font-size:13px}',
		'.dsh-sfacg-empty strong{display:block;font-size:14px;opacity:1;margin-bottom:6px}',
		'.dsh-sfacg-foot{display:flex;align-items:center;gap:10px;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));font-size:11.5px;opacity:.6;flex:none;flex-wrap:wrap}',

		// drawer
		'.dsh-sfacg-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.26);z-index:5;animation:dsh-sfacg-fade .12s ease-out}',
		'.dsh-sfacg-drawer{position:absolute;top:0;right:0;bottom:0;width:min(720px,95%);z-index:6;display:flex;flex-direction:column;background:var(--dsw-alias-bg-elevated,#fff);border-left:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));box-shadow:-18px 0 50px rgba(0,0,0,.18);animation:dsh-sfacg-slide .16s ease-out}',
		'@keyframes dsh-sfacg-fade{from{opacity:0}to{opacity:1}}',
		'@keyframes dsh-sfacg-slide{from{transform:translateX(18px);opacity:.4}to{transform:none;opacity:1}}',
		'.dsh-sfacg-drawerhead{display:flex;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));flex:none}',
		'.dsh-sfacg-drawercover{width:62px;height:84px;border-radius:6px;object-fit:cover;background:rgba(127,127,127,.15);flex:none}',
		'.dsh-sfacg-drawertitle{font-size:16px;font-weight:650;line-height:1.35}',
		'.dsh-sfacg-drawersub{font-size:12px;opacity:.6;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
		'.dsh-sfacg-drawerbody{flex:1;min-height:0;overflow:auto;padding:12px 16px 24px}',
		'.dsh-sfacg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:4px 0 14px}',
		'.dsh-sfacg-stat{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:8px;padding:7px 9px}',
		'.dsh-sfacg-stat b{display:block;font-size:16px;font-variant-numeric:tabular-nums;line-height:1.25}',
		'.dsh-sfacg-stat span{font-size:11px;opacity:.55}',
		'.dsh-sfacg-section{display:flex;align-items:center;gap:8px;margin:14px 0 6px;flex-wrap:wrap}',
		'.dsh-sfacg-section h3{font-size:12.5px;font-weight:600;margin:0;opacity:.8}',
		'.dsh-sfacg-chartbox{position:relative;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:8px;padding:8px 6px 2px;background:rgba(127,127,127,.03)}',
		'.dsh-sfacg-chart{display:block;width:100%;height:auto;overflow:visible}',
		'.dsh-sfacg-tip{position:absolute;pointer-events:none;z-index:3;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.16);padding:6px 8px;font-size:11.5px;line-height:1.6;white-space:nowrap;transform:translate(-50%,-100%)}',
		'.dsh-sfacg-tip b{font-variant-numeric:tabular-nums}',
		'.dsh-sfacg-daylist{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}',
		'.dsh-sfacg-daylist th{text-align:left;font-weight:500;opacity:.55;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
		'.dsh-sfacg-daylist td{padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));font-variant-numeric:tabular-nums}',
		'.dsh-sfacg-daylist tr:hover td{background:rgba(127,127,127,.07)}',
		'.dsh-sfacg-link{color:var(--dsw-brand-primary,#4d6bfe);text-decoration:none;font-size:12px}',
		'.dsh-sfacg-link:hover{text-decoration:underline}',

		// sidebar rail entry
		'.dsh-sfacg-rail{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;min-height:30px;border-radius:6px;font-size:13px;color:inherit;opacity:.75}',
		'.dsh-sfacg-rail:hover{background:rgba(127,127,127,.16);opacity:1}',
		'.dsh-sfacg-rail.is-active{background:rgba(127,127,127,.2);opacity:1;font-weight:600}',
		'.dsh-sfacg-rail-glyph{font-size:15px;line-height:1}'
	].join('\n')

	/** Inject the one owned style tag, leaving an existing identical tag alone. */
	function installStyle() {
		if (typeof document === 'undefined') return
		if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return
		var tag = document.createElement('style')
		tag.dataset.plugin = 'dsh-sfacg-rank'
		tag.dataset.pluginCss = STYLE_ID
		tag.textContent = CSS
		document.head.appendChild(tag)
	}
	//#endregion
	//#region src/client/panel.js
	/**
	 * The panel: the leaderboard, its controls, and the per-book drawer.
	 *
	 * The whole view is driven by two host calls — `/status` and `/ranking` — plus a
	 * third for whichever book the reader opened. Nothing is cached across reloads
	 * except the chosen window, because the numbers are meant to be the newest the
	 * scanner has.
	 */

	/** The growth windows offered in the top bar. */
	var WINDOWS = [
		{ hours: 1, label: '1 小时' },
		{ hours: 6, label: '6 小时' },
		{ hours: 24, label: '24 小时' },
		{ hours: 72, label: '3 天' },
		{ hours: 168, label: '7 天' }
	]

	/** The sort keys the table headers map onto. */
	var SORTS = [
		{ key: 'collectGain', label: '新增收藏' },
		{ key: 'percent', label: '收藏涨幅' },
		{ key: 'collect', label: '总收藏' },
		{ key: 'tickets', label: '月票' },
		{ key: 'clicks', label: '人气' },
		{ key: 'words', label: '字数' }
	]

	var WINDOW_KEY = 'dsh.sfacg.window'

	/** The window label for a number of hours. */
	function windowLabel(hours) {
		for (var i = 0; i < WINDOWS.length; i++) if (WINDOWS[i].hours === hours) return WINDOWS[i].label
		return hours + ' 小时'
	}

	/** One metric's chart point list from a book's daily history. */
	function dailyPoints(days, metric) {
		var points = []
		for (var i = 0; i < days.length; i++) {
			var day = days[i]
			var value = null
			if (metric === 'delta') value = day.delta === null ? null : day.delta.collect
			else if (metric === 'collect') value = day.collect
			else if (metric === 'clicks') value = day.clicks
			else if (metric === 'tickets') value = day.tickets
			else if (metric === 'words') value = day.words
			else if (metric === 'deltaWords') value = day.delta === null ? null : day.delta.words
			points.push({ label: fmtDay(day.date), value: value })
		}
		return points
	}

	/** Hourly points for the last `limit` hours of a book's history. */
	function hourlyPoints(hours, metric, limit) {
		var slice = hours.slice(-(limit || 72))
		var points = []
		for (var i = 0; i < slice.length; i++) {
			var hour = slice[i]
			var value = null
			if (metric === 'collect') value = hour.collect
			else if (metric === 'clicks') value = hour.clicks
			else if (metric === 'tickets') value = hour.tickets
			else if (metric === 'words') value = hour.words
			else if (metric === 'delta') value = hour.delta === null ? null : hour.delta.collect
			points.push({ label: fmtClock(hour.at), value: value })
		}
		return points
	}

	/** A single stat card. */
	function Stat(props) {
		return h('div', { className: 'dsh-sfacg-stat' },
			h('b', { className: props.accent ? 'dsh-sfacg-num ' + props.accent : null }, props.value),
			h('span', null, props.label)
		)
	}

	/**
	 * The per-book drawer.
	 *
	 * It answers three questions in order: how big is this book now, how fast is it
	 * growing, and what did each day look like. The chart opens on the daily *gain*
	 * because that is what the leaderboard ranks, but the total is one click away.
	 */
	function BookDrawer(props) {
		var state = React.useState(null)
		var payload = state[0]
		var setPayload = state[1]
		var errorState = React.useState('')
		var error = errorState[0]
		var setError = errorState[1]
		var metricState = React.useState('delta')
		var metric = metricState[0]
		var setMetric = metricState[1]
		var rangeState = React.useState('days')
		var range = rangeState[0]
		var setRange = rangeState[1]
		var copiedState = React.useState('')
		var copied = copiedState[0]
		var setCopied = copiedState[1]

		React.useEffect(function () {
			var alive = true
			setPayload(null)
			setError('')
			apiGet('/book', { id: props.id }).then(function (result) {
				if (alive) setPayload(result)
			}, function (reason) {
				if (alive) setError(String(reason && reason.message ? reason.message : reason))
			})
			return function () { alive = false }
		}, [props.id])

		React.useEffect(function () {
			function onKey(event) {
				if (event.key === 'Escape') props.onClose()
			}
			if (typeof document !== 'undefined') document.addEventListener('keydown', onKey)
			return function () {
				if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey)
			}
		}, [])

		if (error !== '') {
			return h('div', null,
				h('div', { className: 'dsh-sfacg-backdrop', onClick: props.onClose }),
				h('div', { className: 'dsh-sfacg-drawer' },
					h('div', { className: 'dsh-sfacg-drawerhead' },
						h('div', { className: 'dsh-sfacg-drawertitle' }, '读不到这本书'),
						h('div', { className: 'dsh-sfacg-spacer' }),
						h('button', { className: 'dsh-sfacg-btn', onClick: props.onClose }, '关闭')
					),
					h('div', { className: 'dsh-sfacg-drawerbody' }, h('div', { className: 'dsh-sfacg-empty' }, error))
				)
			)
		}
		if (payload === null) {
			return h('div', null,
				h('div', { className: 'dsh-sfacg-backdrop', onClick: props.onClose }),
				h('div', { className: 'dsh-sfacg-drawer' },
					h('div', { className: 'dsh-sfacg-empty' }, '正在读取…')
				)
			)
		}

		var book = payload.book || {}
		var current = payload.current || {}
		var days = payload.days || []
		var hours = payload.hours || []
		var lastGain = payload.windows && payload.windows['24h'] ? payload.windows['24h'].gain : null
		var weekGain = payload.windows && payload.windows['168h'] ? payload.windows['168h'].gain : null
		var todayDelta = days.length > 0 && days[days.length - 1].delta !== null ? days[days.length - 1].delta.collect : null
		// "Daily average" only means something once the window really spans most of a
		// week; dividing by seven while the store is an hour old would invent a number.
		var weekStart = payload.windows && payload.windows['168h'] ? payload.windows['168h'].baselineAt : null
		var weekDays = weekStart !== null && payload.at !== null ? (payload.at - weekStart) / 86400000 : 7
		var perDay = weekGain !== null && weekGain.collect !== null && weekDays >= 0.9 ? Number((weekGain.collect / weekDays).toFixed(1)) : null	// A fresh install has less than 24 hours of history: say how much the "24 小时"
		// figure actually covers instead of implying a full day.
		var dayWindow = payload.windows && payload.windows['24h'] ? payload.windows['24h'] : null
		var daySpan = dayWindow !== null && dayWindow.baselineAt !== null && payload.at !== null ? payload.at - dayWindow.baselineAt : null
		var gainLabel = '24 小时新增'
		if (daySpan !== null && daySpan < 23 * 3600000) {
			var spanMinutes = Math.max(1, Math.round(daySpan / 60000))
			gainLabel = spanMinutes >= 60 ? ('近 ' + Math.round(spanMinutes / 60) + ' 小时新增') : ('近 ' + spanMinutes + ' 分钟新增')
		}

		var metricTabs = [
			{ key: 'delta', label: '每日新增收藏' },
			{ key: 'collect', label: '收藏总量' },
			{ key: 'clicks', label: '累计人气' },
			{ key: 'tickets', label: '本月月票' },
			{ key: 'words', label: '字数' }
		]
		var points = range === 'hours'
			? hourlyPoints(hours, metric, 96)
			: dailyPoints(days, metric)
		// The bar chart is the delta view; every other metric reads as a line.
		var chart = (metric === 'delta' && range === 'days')
			? h(BarChart, { points: points, height: 200 })
			: h(TrendChart, {
				points: points,
				height: 200,
				zeroBased: metric === 'delta',
				color: metric === 'clicks' ? '#966edc' : (metric === 'tickets' ? '#c69026' : (metric === 'words' ? '#3fa66a' : undefined)),
				format: function (value, axis) {
					if (metric === 'words' || metric === 'clicks') return axis ? fmtCompact(value) : fmtInt(value) + ' 字'
					return metric === 'delta' ? fmtDelta(value) : fmtInt(value)
				}
			})

		var dayRows = days.slice(-60).reverse().map(function (day) {
			var delta = day.delta === null ? null : day.delta.collect
			return h('tr', { key: day.date },
				h('td', null, day.date),
				h('td', { className: 'dsh-sfacg-num' }, fmtInt(day.collect)),
				h('td', { className: 'dsh-sfacg-num ' + (delta === null ? 'is-muted' : (delta > 0 ? 'is-up' : (delta < 0 ? 'is-down' : ''))) }, delta === null ? '—' : fmtDelta(delta)),
				h('td', { className: 'dsh-sfacg-num' }, fmtInt(day.tickets)),
				h('td', { className: 'dsh-sfacg-num' }, fmtCompact(day.clicks)),
				h('td', { className: 'dsh-sfacg-num' }, fmtCompact(day.words))
			)
		})

		return h('div', null,
			h('div', { className: 'dsh-sfacg-backdrop', onClick: props.onClose }),
			h('div', { className: 'dsh-sfacg-drawer' },
				h('div', { className: 'dsh-sfacg-drawerhead' },
					h('img', { className: 'dsh-sfacg-drawercover', src: coverUrl(props.id), alt: '', loading: 'lazy', onError: coverFallback }),
					h('div', { style: { minWidth: 0, flex: 1 } },
						h('div', { className: 'dsh-sfacg-drawertitle' }, book.title || '未命名'),
						h('div', { className: 'dsh-sfacg-drawersub' },
							h('span', null, book.author || '佚名'),
							book.category ? h('span', { className: 'dsh-sfacg-tag' }, book.category) : null,
							book.status ? h('span', { className: 'dsh-sfacg-tag' }, book.status) : null,
							h('a', {
								className: 'dsh-sfacg-link',
								href: 'https://book.sfacg.com/Novel/' + props.id + '/',
								target: '_blank',
								rel: 'noreferrer'
							}, '打开原作 ↗')
						)
					),
					h('button', { className: 'dsh-sfacg-btn', onClick: props.onClose }, '关闭')
				),
				h('div', { className: 'dsh-sfacg-drawerbody' },
					h('div', { className: 'dsh-sfacg-stats' },
						h(Stat, { label: '收藏', value: fmtInt(current.collect) }),
						h(Stat, { label: gainLabel, value: lastGain === null ? '—' : fmtDelta(lastGain.collect), accent: lastGain !== null && lastGain.collect > 0 ? 'is-up' : null }),
						h(Stat, { label: '近 7 日日均', value: perDay === null ? '—' : fmtDelta(perDay) }),
						h(Stat, { label: '今日新增', value: todayDelta === null ? '—' : fmtDelta(todayDelta) }),
						h(Stat, { label: '本月月票', value: fmtInt(current.tickets) }),
						h(Stat, { label: '人气', value: fmtCompact(current.clicks) }),
						h(Stat, { label: '字数', value: fmtCompact(current.words) })
					),
					h('div', { className: 'dsh-sfacg-section' },
						h('h3', null, '每日数据'),
						h('div', { className: 'dsh-sfacg-spacer' }),
						h('div', { className: 'dsh-sfacg-seg' },
							metricTabs.map(function (tab) {
								return h('button', {
									key: tab.key,
									className: cx(metric === tab.key && 'is-on'),
									onClick: function () { setMetric(tab.key) }
								}, tab.label)
							})
						),
						h('div', { className: 'dsh-sfacg-seg' },
							h('button', { className: cx(range === 'days' && 'is-on'), onClick: function () { setRange('days') } }, '按天'),
							h('button', { className: cx(range === 'hours' && 'is-on'), onClick: function () { setRange('hours') } }, '按小时')
						)
					),
					chart,
					h('div', { className: 'dsh-sfacg-section' },
						h('h3', null, '逐日明细'),
						h('span', { className: 'dsh-sfacg-sub' }, days.length === 0 ? '' : '共 ' + days.length + ' 天 · 最近 60 天'),
						h('div', { className: 'dsh-sfacg-spacer' }),
						h('button', {
							className: 'dsh-sfacg-btn',
							onClick: function () {
								var lines = ['日期,收藏,新增,月票,人气,字数']
								for (var i = 0; i < days.length; i++) {
									var day = days[i]
									var delta = day.delta === null ? '' : day.delta.collect
									lines.push([day.date, day.collect, delta, day.tickets, day.clicks, day.words].join(','))
								}
								copyText(lines.join('\n')).then(function (ok) { setCopied(ok ? '已复制' : '复制失败') })
							}
						}, copied === '' ? '复制逐日表' : copied)
					),
					dayRows.length === 0
						? h('div', { className: 'dsh-sfacg-empty' }, '这本书还没有逐日数据。')
						: h('table', { className: 'dsh-sfacg-daylist' },
							h('thead', null, h('tr', null,
								h('th', null, '日期'), h('th', null, '收藏'), h('th', null, '新增'),
								h('th', null, '月票'), h('th', null, '人气'), h('th', null, '字数')
							)),
							h('tbody', null, dayRows)
						)
				)
			)
		)
	}

	/** The leaderboard table. */
	function RankTable(props) {
		var ranking = props.ranking
		var rows = ranking.rows || []
		if (rows.length === 0) {
			return h('div', { className: 'dsh-sfacg-empty' },
				h('strong', null, props.query === '' ? '还没有可排行的数据' : '没有匹配的书'),
				props.query === '' ? '第一次抓取完成后这里会出现全部书目，第二次抓取之后才会出现“新增收藏”这一列。' : '换个关键词试试，搜索的是书名和作者。'
			)
		}
		var sortKey = ranking.sort
		var header = function (key, label, right) {
			var active = sortKey === key
			return h('th', {
				key: key,
				className: cx('is-sortable', active && 'is-on'),
				style: right ? { textAlign: 'right' } : null,
				onClick: function () { props.onSort(key) }
			}, label + (active ? ' ↓' : ''))
		}
		return h('table', { className: 'dsh-sfacg-table' },
			h('thead', null,
				h('tr', null,
					h('th', { style: { width: '44px' } }, '#'),
					h('th', { style: { width: '42px' } }, ''),
					h('th', null, '书名 / 作者'),
					header('collectGain', '新增收藏 · ' + windowLabel(ranking.windowHours), true),
					header('collect', '总收藏', true),
					header('tickets', '月票', true),
					header('clicks', '人气', true),
					header('words', '字数', true),
					h('th', { style: { width: '104px' } }, '近 14 日')
				)
			),
			h('tbody', null, rows.map(function (row) {
				var gain = row.gain === null || row.gain === undefined ? null : row.gain.collect
				return h('tr', {
					key: row.id,
					className: cx(props.selectedId === row.id && 'is-open'),
					onClick: function () { props.onSelect(row.id) }
				},
					h('td', { className: cx('dsh-sfacg-rank', row.rank <= 3 && 'is-top') }, row.rank),
					h('td', null, h('img', { className: 'dsh-sfacg-cover', src: coverUrl(row.id), alt: '', loading: 'lazy', onError: coverFallback })),
					h('td', null,
						h('div', { className: 'dsh-sfacg-name', title: row.title }, row.title || '未命名'),
						h('div', { className: 'dsh-sfacg-sub' },
							(row.author || '佚名') +
							(row.category ? ' · ' + row.category : '') +
							(row.lastUpdated ? ' · 更新 ' + row.lastUpdated.slice(5, 16) : '')
						)
					),
					h('td', { className: 'dsh-sfacg-num', style: { textAlign: 'right' } },
						gain === null
							? h('span', { className: 'dsh-sfacg-num is-muted' }, '—')
							: h('span', { className: cx('dsh-sfacg-num', 'is-gain') }, fmtDelta(gain))
					),
					h('td', { className: 'dsh-sfacg-num', style: { textAlign: 'right' } }, fmtInt(row.collect)),
					h('td', { className: 'dsh-sfacg-num', style: { textAlign: 'right' } }, fmtInt(row.tickets)),
					h('td', { className: 'dsh-sfacg-num', style: { textAlign: 'right' } }, fmtCompact(row.clicks)),
					h('td', { className: 'dsh-sfacg-num', style: { textAlign: 'right' } }, fmtCompact(row.words)),
					h('td', null, h(Sparkline, { values: row.spark || [] }))
				)
			}))
		)
	}

	/**
	 * The panel itself.
	 *
	 * Polling is deliberately split: `/status` every 30 seconds (cheap, and it is
	 * what makes a running scan visible), the leaderboard only when the data stamp
	 * moved or a control changed.
	 */
	function RankPanel(props) {
		var windowState = React.useState(function () {
			var saved = Number(storageGet(WINDOW_KEY))
			return WINDOWS.some(function (item) { return item.hours === saved }) ? saved : 24
		})
		var windowHours = windowState[0]
		var setWindowHours = windowState[1]
		var sortState = React.useState('collectGain')
		var sort = sortState[0]
		var setSort = sortState[1]
		var categoryState = React.useState('')
		var category = categoryState[0]
		var setCategory = categoryState[1]
		var queryState = React.useState('')
		var query = queryState[0]
		var setQuery = queryState[1]
		var searchState = React.useState('')
		var search = searchState[0]
		var setSearch = searchState[1]
		var statusState = React.useState(null)
		var status = statusState[0]
		var setStatus = statusState[1]
		var rankingState = React.useState(null)
		var ranking = rankingState[0]
		var setRanking = rankingState[1]
		var errorState = React.useState('')
		var error = errorState[0]
		var setError = errorState[1]
		var loadingState = React.useState(false)
		var loading = loadingState[0]
		var setLoading = loadingState[1]
		var selectedState = React.useState(null)
		var selected = selectedState[0]
		var setSelected = selectedState[1]
		var stampRef = React.useRef(0)
		var mountedRef = React.useRef(true)

		React.useEffect(function () {
			mountedRef.current = true
			return function () { mountedRef.current = false }
		}, [])

		var loadRanking = React.useCallback(function () {
			setLoading(true)
			return apiGet('/ranking', {
				windowHours: windowHours,
				sort: sort,
				limit: 200,
				q: query,
				category: category
			}).then(function (result) {
				if (!mountedRef.current) return
				stampRef.current = result.at
				setRanking(result)
				setError('')
			}, function (reason) {
				if (!mountedRef.current) return
				setError(String(reason && reason.message ? reason.message : reason))
			}).then(function () {
				if (mountedRef.current) setLoading(false)
			})
		}, [windowHours, sort, query, category])

		var loadStatus = React.useCallback(function () {
			return apiGet('/status').then(function (result) {
				if (!mountedRef.current) return null
				setStatus(result)
				if (result.lastError) setError(String(result.lastError))
				return result
			}, function () {
				if (!mountedRef.current) return null
				setError('宿主接口没有响应（/sfacg-rank/api/status）。插件可能还没有被加载，重新打开窗口后再试。')
				return null
			})
		}, [])

		React.useEffect(function () {
			loadStatus().then(function (first) {
				if (first !== null && first !== undefined && first.at) stampRef.current = first.at
			})
			var timer = setInterval(function () {
				loadStatus().then(function (fresh) {
					// Only re-read the table when a scan actually produced new numbers.
					if (!mountedRef.current || !fresh || !fresh.at) return
					if (fresh.at !== stampRef.current) loadRanking()
				})
			}, 30000)
			return function () { clearInterval(timer) }
		}, [])

		React.useEffect(function () { loadRanking() }, [loadRanking])

		var commitSearch = React.useCallback(debounce(function (value) { setQuery(value) }, 260), [])
		React.useEffect(function () {
			storageSet(WINDOW_KEY, windowHours)
		}, [windowHours])

		var scanning = status !== null && status.scanning === true
		var progress = status === null ? null : status.progress
		var total = ranking === null ? 0 : ranking.total
		var covered = ranking === null ? 0 : ranking.covered
		var coverageHint = ranking !== null && covered === 0 && total > 0
			? '增长排行需要两次抓取：现在已收录 ' + fmtInt(total) + ' 本，下一轮扫描之后“新增收藏”才会出现。'
			: ''
		// Say what the window actually covers: a board that claims "24 小时" while the
		// store is twenty minutes old would be lying about its own numbers.
		var spanNote = ''
		if (ranking !== null && ranking.baselineAt !== null && ranking.at !== null) {
			var coveredMs = ranking.at - ranking.baselineAt
			if (coveredMs < ranking.windowHours * 3600000 * 0.8) {
				spanNote = '增长窗口按「' + windowLabel(ranking.windowHours) + '」计算，实际覆盖 ' + fmtSpan(coveredMs) + '（数据从 ' + fmtClock(ranking.baselineAt) + ' 开始）'
			}
		}

		return h('div', { className: 'dsh-sfacg' },
			h('div', { className: 'dsh-sfacg-top' },
				h('span', { className: 'dsh-sfacg-brand' }, '菠萝包数据榜', h('em', null, 'SF轻小说')),
				h('span', { className: 'dsh-sfacg-pill ' + (scanning ? 'is-live' : (error !== '' ? 'is-bad' : '')) },
					scanning
						? ('抓取中 ' + (progress && progress.phase === 'scan' ? (progress.scanned + '/' + progress.total) : '发现书目…'))
						: (status && status.at ? ('最近抓取 ' + fmtClock(status.at)) : '尚未抓取')
				),
				h('span', { className: 'dsh-sfacg-meta' },
					status === null
						? ''
						: ('收录 ' + fmtInt(status.books) + ' 本' + (status.nextScanAt ? ' · 下次 ' + fmtClock(status.nextScanAt) : ''))
				),
				h('span', { className: 'dsh-sfacg-spacer' }),
				h('select', {
					className: 'dsh-sfacg-select',
					value: String(windowHours),
					onChange: function (event) { setWindowHours(Number(event.target.value)) }
				}, WINDOWS.map(function (item) {
					return h('option', { key: item.hours, value: String(item.hours) }, '近 ' + item.label)
				})),
				h('select', {
					className: 'dsh-sfacg-select',
					value: sort,
					onChange: function (event) { setSort(event.target.value) }
				}, SORTS.map(function (item) {
					return h('option', { key: item.key, value: item.key }, '按' + item.label + '排')
				})),
				h('select', {
					className: 'dsh-sfacg-select',
					value: category,
					onChange: function (event) { setCategory(event.target.value) }
				},
					h('option', { value: '' }, '全部分类'),
					(ranking === null ? [] : ranking.categories || []).map(function (item) {
						return h('option', { key: item.name, value: item.name }, item.name + '（' + item.count + '）')
					})
				),
				h('input', {
					className: 'dsh-sfacg-input',
					placeholder: '搜书名或作者…',
					value: search,
					onChange: function (event) {
						setSearch(event.target.value)
						commitSearch(event.target.value)
					}
				}),
				h('button', {
					className: 'dsh-sfacg-btn',
					onClick: function () { loadRanking(); loadStatus() },
					disabled: loading
				}, loading ? '读取中…' : '刷新'),
				h('button', {
					className: 'dsh-sfacg-btn is-primary',
					disabled: scanning,
					onClick: function () {
						apiPost('/scan', {}).then(function () { loadStatus() }, function (reason) {
							setError(String(reason && reason.message ? reason.message : reason))
						})
					}
				}, scanning ? '抓取中…' : '立即抓取'),
				h('a', {
					className: 'dsh-sfacg-btn',
					href: API_BASE + '/export.csv' + queryString({ windowHours: windowHours, sort: sort, q: query, category: category }),
					download: 'sfacg-rank.csv'
				}, '导出 CSV')
			),

			error !== '' ? h('div', { className: 'dsh-sfacg-foot', style: { color: '#e5534b', opacity: 1 } }, error) : null,

			scanning && progress !== null ? h('div', { className: 'dsh-sfacg-foot' },
				h('span', null, progress.phase === 'discover'
					? ('发现书目：第 ' + (progress.page || 0) + ' 页，已找到 ' + fmtInt(progress.found || 0) + ' 本')
					: ('抓取详情：' + fmtInt(progress.scanned || 0) + ' / ' + fmtInt(progress.total || 0) + ' 本，失败 ' + fmtInt(progress.failed || 0))),
				h('span', { className: 'dsh-sfacg-spacer' }),
				h('span', { className: 'dsh-sfacg-meta' }, progress.title || '')
			) : null,

			coverageHint !== '' ? h('div', {
				className: 'dsh-sfacg-foot',
				style: { opacity: 1, color: 'var(--dsw-brand-primary,#4d6bfe)' }
			}, coverageHint) : null,

			h('div', { className: 'dsh-sfacg-body' },
				ranking === null
					? h('div', { className: 'dsh-sfacg-empty' }, h('strong', null, '正在连接宿主…'))
					: h(RankTable, {
						ranking: ranking,
						query: query,
						selectedId: selected,
						onSelect: function (id) { setSelected(id) },
						onSort: function (key) { setSort(key) }
					})
			),

			h('div', { className: 'dsh-sfacg-foot' },
				h('span', null, '数据来自 book.sfacg.com 的公开页面，每小时抓取一次；收藏为累计值，新增收藏是本窗口内的差值。'),
				spanNote !== '' ? h('span', { className: 'dsh-sfacg-pill is-warn' }, spanNote) : null,
				h('span', { className: 'dsh-sfacg-spacer' }),
				status && status.dir ? h('span', { title: status.dir }, '数据目录：' + String(status.dir).replace(/^.*[\\/]/, '')) : null
			),

			selected === null ? null : h(BookDrawer, {
				id: selected,
				onClose: function () { setSelected(null) }
			})
		)
	}
	//#endregion
	//#region src/site/app.js
	/**
	 * The public site: one page, no server.
	 *
	 * It reuses the DSH panel's table, drawer and charts, and swaps the data layer
	 * for the static export. Everything the reader can do on the panel — change the
	 * window, sort, filter, search, open a book and look at its daily chart — works
	 * here too, because the ranking maths runs in the browser (see rank-client.js).
	 */
	var SITE_WINDOW_KEY = 'dsh.sfacg.window'

	/** Rows rendered per page, and added by each "显示更多". */
	var SITE_PAGE_SIZE = 300

	/** One-line summary of when the data was collected. */
	function siteStamp(ms) {
		if (!ms) return '还没有数据'
		return fmtClock(ms)
	}

	/** The header controls, styled with the panel's own classes. */
	function SiteControls(props) {
		return h('div', { className: 'site-controls' },
			h('select', {
				className: 'dsh-sfacg-select',
				value: String(props.windowHours),
				onChange: function (event) { props.onWindow(Number(event.target.value)) }
			}, WINDOWS.map(function (item) {
				return h('option', { key: item.hours, value: String(item.hours) }, '近 ' + item.label)
			})),
			h('select', {
				className: 'dsh-sfacg-select',
				value: props.sort,
				onChange: function (event) { props.onSort(event.target.value) }
			}, SORTS.map(function (item) {
				return h('option', { key: item.key, value: item.key }, '按' + item.label + '排')
			})),
			h('select', {
				className: 'dsh-sfacg-select',
				value: props.category,
				onChange: function (event) { props.onCategory(event.target.value) }
			},
				h('option', { value: '' }, '全部分类'),
				(props.categories || []).map(function (item) {
					return h('option', { key: item.name, value: item.name }, item.name + '（' + item.count + '）')
				})
			),
			h('input', {
				className: 'dsh-sfacg-input',
				placeholder: '搜书名或作者…',
				value: props.search,
				onChange: function (event) { props.onSearch(event.target.value) }
			})
		)
	}

	/** The page. */
	function SiteShell() {
		var statusState = React.useState(null)
		var status = statusState[0]
		var setStatus = statusState[1]
		var storeState = React.useState(null)
		var store = storeState[0]
		var setStore = storeState[1]
		var rankingState = React.useState(null)
		var ranking = rankingState[0]
		var setRanking = rankingState[1]
		var windowState = React.useState(function () {
			var saved = Number(storageGet(SITE_WINDOW_KEY))
			return WINDOWS.some(function (item) { return item.hours === saved }) ? saved : 24
		})
		var windowHours = windowState[0]
		var setWindowHours = windowState[1]
		var sortState = React.useState('collectGain')
		var sort = sortState[0]
		var setSort = sortState[1]
		var categoryState = React.useState('')
		var category = categoryState[0]
		var setCategory = categoryState[1]
		var queryState = React.useState('')
		var query = queryState[0]
		var setQuery = queryState[1]
		var searchState = React.useState('')
		var search = searchState[0]
		var setSearch = searchState[1]
		var selectedState = React.useState(null)
		var selected = selectedState[0]
		var setSelected = selectedState[1]
		var errorState = React.useState('')
		var error = errorState[0]
		var setError = errorState[1]
		// How many rows are rendered. The whole catalogue is in memory, so "more" is
		// only a matter of drawing more of it — but drawing 1,600 rows up front is
		// slower than the reader needs, hence a growing window.
		var limitState = React.useState(SITE_PAGE_SIZE)
		var limit = limitState[0]
		var setLimit = limitState[1]

		var commitSearch = React.useCallback(debounce(function (value) { setQuery(value) }, 260), [])

		/** Any filter change starts the list over at one page. */
		var fromTop = function () { setLimit(SITE_PAGE_SIZE) }

		React.useEffect(function () {
			var alive = true
			loadSiteStatus().then(function (value) {
				if (alive) setStatus(value)
			}, function () {
				/* a missing status file is not fatal: the store decides */
			})
			loadSiteStore().then(function (value) {
				if (alive) setStore(value)
			}, function (reason) {
				if (alive) setError('数据还没准备好：' + String(reason && reason.message ? reason.message : reason))
			})
			return function () { alive = false }
		}, [])

		React.useEffect(function () {
			if (store === null) return
			var result = computeRanking(store, {
				windowHours: windowHours,
				sort: sort,
				limit: limit,
				query: query,
				category: category
			})
			setRanking(result)
		}, [store, windowHours, sort, category, query, limit])

		React.useEffect(function () {
			storageSet(SITE_WINDOW_KEY, windowHours)
		}, [windowHours])

		var at = ranking !== null ? ranking.at : (status !== null ? status.at : null)
		var books = status !== null && status.books ? status.books : (store !== null ? Object.keys(store.books).length : 0)
		var covered = ranking !== null ? ranking.covered : 0
		var total = ranking !== null ? ranking.total : 0

		var spanNote = ''
		if (ranking !== null && ranking.baselineAt !== null) {
			var coveredMs = ranking.at - ranking.baselineAt
			if (coveredMs < ranking.windowHours * 3600000 * 0.8) {
				spanNote = '增长窗口按「' + windowLabel(ranking.windowHours) + '」计算，实际覆盖 ' + fmtSpan(coveredMs) + '（数据从 ' + fmtClock(ranking.baselineAt) + ' 开始）'
			}
		}

		return h('div', { className: 'site-shell' },
			h('header', { className: 'site-head' },
				h('div', { className: 'site-brand' },
					h('h1', null, '菠萝包数据榜'),
					h('span', null, 'SF轻小说 · 收藏增长排行')
				),
				h('div', { className: 'site-meta' },
					h('strong', null, fmtInt(books)),
					' 本在榜',
					h('span', { className: 'site-dot' }, '·'),
					'最近抓取 ',
					h('strong', null, siteStamp(at)),
					h('span', { className: 'site-dot' }, '·'),
					'每小时自动更新'
				),
				h(SiteControls, {
					windowHours: windowHours,
					sort: sort,
					category: category,
					search: search,
					categories: ranking === null ? [] : ranking.categories,
					onWindow: function (value) { fromTop(); setWindowHours(value) },
					onSort: function (value) { fromTop(); setSort(value) },
					onCategory: function (value) { fromTop(); setCategory(value) },
					onSearch: function (value) {
						fromTop()
						setSearch(value)
						commitSearch(value)
					}
				})
			),

			error !== '' ? h('div', { className: 'site-notice is-bad' }, error) : null,

			ranking !== null && covered === 0 && total > 0
				? h('div', { className: 'site-notice' }, '增长排行需要两次抓取：现在已收录 ' + fmtInt(total) + ' 本，下一轮抓取之后「新增收藏」才会出现。')
				: null,

			spanNote !== '' ? h('div', { className: 'site-notice is-warn' }, spanNote) : null,

			// The table must live inside `.dsh-sfacg-body`: that is the element the
			// panel's own stylesheet makes the scroll container (`flex:1; min-height:0;
			// overflow:auto`). Without it the card simply clips the rows and the wheel
			// has nothing to scroll.
			h('main', { className: 'site-main dsh-sfacg' },
				h('div', { className: 'dsh-sfacg-body' },
					store === null && error === ''
						? h('div', { className: 'dsh-sfacg-empty' }, h('strong', null, '正在读取数据…'))
						: (ranking === null
							? h('div', { className: 'dsh-sfacg-empty' }, h('strong', null, '还没有可显示的数据'))
							: h(RankTable, {
								ranking: ranking,
								query: query,
								selectedId: selected,
								onSelect: function (id) { setSelected(id) },
								onSort: function (key) { fromTop(); setSort(key) }
							}))
				)
			),

			// The list scrolls inside the card, so without an explicit count the page
			// looks like it holds only the handful of rows that fit on screen.
			ranking !== null && ranking.rows.length > 0
				? h('div', { className: 'site-count' },
					h('span', null,
						'共 ' + fmtInt(total) + ' 本',
						ranking.rows.length < total
							? ' · 已显示前 ' + fmtInt(ranking.rows.length) + ' 名'
							: ' · 已全部显示'
					),
					h('span', { className: 'site-spacer' }),
					ranking.rows.length < total
						? h('button', {
							className: 'dsh-sfacg-btn is-primary',
							onClick: function () { setLimit(limit + SITE_PAGE_SIZE) }
						}, '再显示 ' + Math.min(SITE_PAGE_SIZE, total - ranking.rows.length) + ' 本')
						: null,
					h('span', { className: 'site-hint' }, '列表可滚动 · 也可以直接搜索书名或作者')
				)
				: null,

			h('footer', { className: 'site-foot' },
				h('span', null, '数据来自 book.sfacg.com 的公开页面；收藏为累计值，「新增」是本窗口内的差值。'),
				h('span', { className: 'site-spacer' }),
				status !== null && status.scans && status.scans.length > 0
					? h('span', null, '最近一次抓取：' + (status.scans[0].ok ? '成功' : '失败') + ' · ' + fmtInt(status.scans[0].books || 0) + ' 本')
					: null
			),

			selected === null ? null : h(BookDrawer, {
				id: selected,
				onClose: function () { setSelected(null) }
			})
		)
	}

	/** Mount the page. */
	function mountSite() {
		var root = document.getElementById('root')
		if (root === null || root === undefined) return
		// The panel's stylesheet is injected, not linked: without this call the page
		// renders unstyled (a column of full-size covers instead of a table).
		installStyle()
		window.ReactDOM.createRoot(root).render(h(SiteShell))
	}
	//#endregion
	// A handle for the tests and for debugging in the browser console.
	window.__SFACG_SITE__ = {
		computeRanking: computeRanking,
		computeBook: computeBook,
		SiteShell: SiteShell,
		RankTable: RankTable,
		loadSiteStore: loadSiteStore,
		mountSite: mountSite
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSite)
	else mountSite()
})();
