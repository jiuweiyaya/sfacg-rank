/**
 * Parsers for the two pages this plugin reads.
 *
 * `book.sfacg.com` serves plain HTML (UTF-8) with no JSON API for book stats, so
 * the numbers come from two places:
 *
 *   - the "recently updated" list (`/List/?ud=<days>&PageIndex=<n>`) — the only
 *     page that says *which* books were touched lately, 20 per page;
 *   - one detail page per book (`/Novel/<id>/`) — collection count, likes,
 *     popularity, word count, status and the last update time.
 *
 * Monthly tickets are the one number the detail page renders as `0` for
 * everyone, so they come from the site's own ticket endpoint instead
 * (`/ajax/ashx/GetTicketNum.ashx?nid=<id>`, a bare integer).
 *
 * Everything here is a pure function of the HTML text so the tests can feed it
 * saved fixtures.
 */

/** Decode the handful of entities that turn up in titles and intros. */
function decodeEntities(text) {
	return String(text ?? '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&')
}

/** Strip every tag and collapse whitespace — for intros and titles. */
function stripTags(text) {
	return decodeEntities(String(text ?? '').replace(/<[^>]*>/g, ' '))
		.replace(/[\s\u3000]+/g, ' ')
		.trim()
}

/**
 * Turn the site's abbreviated counters into integers.
 *
 * Popularity is abbreviated ("600.1万", "8098.2万"), collection counts are plain
 * ("44590", "108,197"), and a very large book can reach "亿". Anything that is
 * not a number reads as null so a layout change shows up as missing data rather
 * than as a zero.
 */
export function parseCount(value) {
	if (value === null || value === undefined) return null
	const text = String(value).replace(/[,，\s]/g, '').trim()
	if (text === '') return null
	const match = /^(\d+(?:\.\d+)?)(万|亿)?$/.exec(text)
	if (match === null) return null
	const base = Number(match[1])
	if (!Number.isFinite(base)) return null
	const scale = match[2] === '亿' ? 1e8 : match[2] === '万' ? 1e4 : 1
	return Math.round(base * scale)
}

/** The total a category list reports ("现在有<span>1875</span>部小说"), or 0. */
export function parseListTotal(html) {
	const match = /现在有<span>(\d+)<\/span>部小说/.exec(html) ?? /现在共<span>(\d+)<\/span>部小说/.exec(html)
	return match === null ? null : Number(match[1])
}

/**
 * One list page.
 *
 * Each book is an `<ul class="Comic_Pic_List">`; the list columns are exactly
 * what the leaderboard needs to know before it has ever fetched a detail page,
 * so a failed detail fetch still leaves a usable row (title, author, category,
 * update date, word count).
 */
export function parseListPage(html) {
	const items = []
	const blockPattern = /<ul class="Comic_Pic_List">([\s\S]*?)<\/ul>/g
	let block
	while ((block = blockPattern.exec(html)) !== null) {
		const chunk = block[1]
		const id = /\/Novel\/(\d+)\//.exec(chunk)
		if (id === null) continue
		const title = /style="font-size: 14px; color: #FF6600;">([^<]*)<\/a>/.exec(chunk)
		const author = /作\s*者：\s*<a href="\/Club\/(\d+)\/"[^>]*>([^<]*)<\/a>/.exec(chunk)
		const meta = /综合信息：\s*<span class="font_red">([\d.]+)分<\/span>\s*\/\s*<a href="\/List\/\?tid=(\d+)">([^<]*)<\/a>\s*\/\s*([\d/]+)\s*\/\s*([\d,]+)字/.exec(chunk)
		items.push({
			id: Number(id[1]),
			title: title === null ? '' : stripTags(title[1]),
			author: author === null ? '' : stripTags(author[2]),
			authorId: author === null ? null : Number(author[1]),
			score: meta === null ? null : Number(meta[1]),
			tid: meta === null ? null : Number(meta[2]),
			category: meta === null ? '' : stripTags(meta[3]),
			updateDate: meta === null ? '' : meta[4],
			words: meta === null ? null : parseCount(meta[5])
		})
	}
	return { total: parseListTotal(html), items }
}

/**
 * The cover image URL, which the site keeps in two different places.
 *
 * Books added since roughly 2022 have a `summary-pic` block holding an <img>.
 * Older ones have no such block at all: their cover is the banner's background
 * image, carrying a cache-busting `?2026/10/28` query that is stripped so our own
 * cache can hold it for a day.
 */
function findCover(html) {
	const block = /<div class="summary-pic">\s*<img src="([^"]+)"/.exec(html)
	if (block !== null) return block[1].trim()
	const banner = /class="d-banner"[^>]*style="[^"]*url\(['"]?([^)'"]+)/.exec(html)
	if (banner !== null) return banner[1].trim().replace(/\?.*$/, '')
	const anywhere = /<img[^>]+src="([^"]*NovelCover[^"]*)"/.exec(html)
	return anywhere === null ? '' : anywhere[1].trim()
}

/**
 * One detail page.
 *
 * Every field is optional: the caller keeps the previous value when a parse
 * comes back empty, so a single layout experiment by the site cannot wipe a
 * book's history.
 */
export function parseNovelPage(html) {
	const title = /<h1 class="title">\s*<span class="text">([^<\r\n]+)/.exec(html)
	const cover = findCover(html)
	const author = /<div class="author-name">\s*<span>([^<]*)<\/span>/.exec(html)
	const category = /<span class="text">类型：([^<\r\n]+)<\/span>/.exec(html)
	const words = /<span class="text">字数：([\d,]+)字\[([^\]]*)\]/.exec(html)
	const clicks = /<span class="text">人气：([^<\r\n]+)<\/span>/.exec(html)
	const updated = /<span class="text">更新：([0-9/: ]+?)\s*<\/span>/.exec(html)
	const collect = /收藏\s*([\d,.]+[万亿]?)\s*<\/a>/.exec(html)
	const likes = /赞\s*([\d,.]+[万亿]?)\s*<\/a>/.exec(html)
	const ticketRank = /本月排名：(\d+)名/.exec(html)
	const intro = /<p class="introduce">([\s\S]*?)<\/p>/.exec(html)

	return {
		title: title === null ? '' : stripTags(title[1]),
		cover,
		author: author === null ? '' : stripTags(author[1]),
		category: category === null ? '' : stripTags(category[1]),
		words: words === null ? null : parseCount(words[1]),
		status: words === null ? '' : stripTags(words[2]),
		clicks: clicks === null ? null : parseCount(clicks[1]),
		updatedAt: updated === null ? '' : updated[1].trim(),
		collect: collect === null ? null : parseCount(collect[1]),
		likes: likes === null ? null : parseCount(likes[1]),
		ticketRank: ticketRank === null ? null : Number(ticketRank[1]),
		intro: intro === null ? '' : stripTags(intro[1]).slice(0, 220)
	}
}

/**
 * The ticket endpoint answers with a bare integer ("3433").
 *
 * A logged-out visitor gets the current month's count for the book, which is
 * the same number the monthly-ticket ranking shows. Anything else — an error
 * page, a login wall — reads as null.
 */
export function parseTicketBody(text) {
	const match = /^\s*(\d{1,9})\s*$/.exec(String(text ?? ''))
	return match === null ? null : Number(match[1])
}

/** The URL a list page is fetched from. */
export function listUrl(days, page) {
	return `https://book.sfacg.com/List/?ud=${days}&PageIndex=${page}`
}

/** The URL a book's detail page is fetched from. */
export function novelUrl(id) {
	return `https://book.sfacg.com/Novel/${id}/`
}

/** The URL the monthly-ticket count is fetched from. */
export function ticketUrl(id) {
	return `https://book.sfacg.com/ajax/ashx/GetTicketNum.ashx?nid=${id}`
}
