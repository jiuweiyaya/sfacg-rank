/**
 * Where the plugin keeps its data and how it behaves by default.
 *
 * The data lives in the user's harness directory rather than in a Session
 * workspace: it is a growing time series that belongs to the machine, not to one
 * conversation, and it must survive switching projects. `DSH_SFACG_DIR`
 * overrides it (the tests use that to stay out of the real folder).
 */
import os from 'node:os'
import path from 'node:path'

/** The directory holding the snapshots, the book registry and the settings. */
export function dataDir() {
	const override = process.env.DSH_SFACG_DIR
	if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
	return path.join(os.homedir(), '.dsh', 'sfacg-rank')
}

/**
 * Defaults.
 *
 * `universeDays` has to be one of the site's own windows (7, 15 or 30 days);
 * seven days is the sweet spot: it is every book the site currently calls
 * "recently updated" (~1,900 books) and still finishes a scan in about six
 * minutes.
 */
export const DEFAULTS = {
	autoScan: true,
	intervalMinutes: 60,
	universeDays: 7,
	concurrency: 4,
	requestsPerSecond: 8,
	hourlyRetentionHours: 96,
	dailyRetentionDays: 400,
	scanLogLimit: 200
}

/** The windows the site offers for "recently updated". */
export const UNIVERSE_DAYS = [7, 15, 30]

/** Clamp one numeric setting into a range, falling back when it is not a number. */
function clampNumber(value, fallback, min, max) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, Math.round(number)))
}

/** Coerce whatever is on disk (or in a request) into a usable settings object. */
export function normalizeSettings(input) {
	const source = input && typeof input === 'object' ? input : {}
	const universeDays = UNIVERSE_DAYS.includes(Number(source.universeDays)) ? Number(source.universeDays) : DEFAULTS.universeDays
	return {
		autoScan: source.autoScan === undefined ? DEFAULTS.autoScan : source.autoScan === true,
		intervalMinutes: clampNumber(source.intervalMinutes, DEFAULTS.intervalMinutes, 10, 24 * 60),
		universeDays,
		concurrency: clampNumber(source.concurrency, DEFAULTS.concurrency, 1, 8),
		requestsPerSecond: clampNumber(source.requestsPerSecond, DEFAULTS.requestsPerSecond, 1, 20),
		hourlyRetentionHours: clampNumber(source.hourlyRetentionHours, DEFAULTS.hourlyRetentionHours, 24, 24 * 30),
		dailyRetentionDays: clampNumber(source.dailyRetentionDays, DEFAULTS.dailyRetentionDays, 30, 3650),
		scanLogLimit: clampNumber(source.scanLogLimit, DEFAULTS.scanLogLimit, 10, 5000)
	}
}
