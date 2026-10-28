/**
 * HTTP access to book.sfacg.com.
 *
 * Two concerns live here and nowhere else:
 *
 *   - a browser-ish request shape, because the site answers a bare fetch
 *     differently (it serves UTF-8 HTML to a normal UA, and an error page to
 *     scripts that look like scrapers);
 *   - politeness. A full scan is ~1,900 books, and each book costs two requests,
 *     so the pacer keeps the whole process under a requests-per-second ceiling
 *     with a small worker pool instead of firing everything at once.
 */

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEFAULT_HEADERS = {
	'User-Agent': USER_AGENT,
	'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
	'Referer': 'https://book.sfacg.com/'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A small error type so callers can tell a 404 from a network failure. */
export class FetchError extends Error {
	constructor(message, status) {
		super(message)
		this.name = 'FetchError'
		this.status = status
	}
}

/**
 * Fetch one URL as text.
 *
 * `retries` covers transient failures only (network errors, 5xx, 429); a 404 is
 * a permanent answer and is thrown immediately, because the scan treats it as
 * "this book is gone" rather than "try again later".
 */
export async function fetchText(url, options = {}) {
	const { timeoutMs = 20000, retries = 2, headers = {}, method = 'GET', body = null } = options
	let attempt = 0
	let lastError = null
	while (attempt <= retries) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetch(url, {
				method,
				body,
				headers: { ...DEFAULT_HEADERS, ...headers },
				redirect: 'follow',
				signal: controller.signal
			})
			clearTimeout(timer)
			if (response.ok) return await response.text()
			const status = response.status
			if (status === 404) throw new FetchError(`404 ${url}`, 404)
			if (status === 429 || status >= 500) {
				lastError = new FetchError(`HTTP ${status} ${url}`, status)
				await sleep(700 * (attempt + 1))
				attempt += 1
				continue
			}
			throw new FetchError(`HTTP ${status} ${url}`, status)
		} catch (error) {
			clearTimeout(timer)
			if (error instanceof FetchError) {
				if (error.status === 404) throw error
				lastError = error
			} else {
				lastError = new FetchError(`${error?.name === 'AbortError' ? 'timeout' : 'network'}: ${url}`, 0)
			}
			attempt += 1
			if (attempt <= retries) await sleep(500 * attempt)
		}
	}
	throw lastError ?? new FetchError(`failed ${url}`, 0)
}

/** Fetch one URL as bytes (used for the cover proxy). */
export async function fetchBuffer(url, options = {}) {
	const { timeoutMs = 20000, headers = {} } = options
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(url, { headers: { ...DEFAULT_HEADERS, ...headers }, redirect: 'follow', signal: controller.signal })
		if (!response.ok) throw new FetchError(`HTTP ${response.status} ${url}`, response.status)
		const buffer = Buffer.from(await response.arrayBuffer())
		return { buffer, contentType: response.headers.get('content-type') || 'image/jpeg' }
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Rate limit + worker pool.
 *
 * `minIntervalMs` is the spacing between two request starts *across the whole
 * process*, which is what keeps a four-worker scan from looking like a small
 * flood: the workers only decide how many requests are in flight, the pacer
 * decides how fast they leave.
 */
export class Pacer {
	constructor({ concurrency = 4, minIntervalMs = 120 } = {}) {
		this.concurrency = Math.max(1, Math.floor(concurrency))
		this.minIntervalMs = Math.max(0, Math.floor(minIntervalMs))
		this.active = 0
		this.nextStart = 0
	}

	async acquire() {
		for (;;) {
			const now = Date.now()
			if (this.active < this.concurrency && now >= this.nextStart) {
				this.active += 1
				this.nextStart = now + this.minIntervalMs
				return
			}
			const wait = this.active >= this.concurrency ? 15 : Math.max(5, this.nextStart - now)
			await sleep(Math.min(wait, 120))
		}
	}

	release() {
		this.active -= 1
	}

	/** Run `task` inside a worker slot, counting the request against the rate. */
	async run(task) {
		await this.acquire()
		try {
			return await task()
		} finally {
			this.release()
		}
	}
}
