/**
 * One scan at a time, across processes.
 *
 * The panel's scheduler and the command line can both be told to scan, and two
 * concurrent scans would double the load on the site *and* race on the JSON
 * snapshot files (one process would overwrite the other's books). A lock file in
 * the data directory makes the second caller wait instead.
 *
 * The lock is advisory and self-healing: a lock older than `staleMs`, or one
 * whose pid is gone, is taken over rather than blocking forever.
 */
import fs from 'node:fs'
import path from 'node:path'

const STALE_MS = 90 * 60 * 1000

/** True when a pid is still running (a foreign-user pid counts as running). */
function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false
	if (pid === process.pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error?.code === 'EPERM'
	}
}

/**
 * Try to take the scan lock.
 *
 * Returns `{ ok: true, release }`, or `{ ok: false, holder }` with the running
 * scan's pid and timestamp so the caller can say who is in the way.
 */
export function acquireLock(dir, { staleMs = STALE_MS } = {}) {
	const file = path.join(dir, 'scan.lock')
	fs.mkdirSync(dir, { recursive: true })
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = fs.openSync(file, 'wx')
			const payload = JSON.stringify({ pid: process.pid, at: Date.now() })
			fs.writeSync(handle, payload)
			fs.closeSync(handle)
			let released = false
			return {
				ok: true,
				file,
				release() {
					if (released) return
					released = true
					try {
						fs.rmSync(file, { force: true })
					} catch {
						/* the lock is advisory; a leftover file ages out */
					}
				}
			}
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error
			const holder = readLock(file)
			const expired = holder === null || Date.now() - holder.at > staleMs || !isAlive(holder.pid)
			if (!expired) return { ok: false, holder, file }
			// A dead or ancient lock: take it over.
			try {
				fs.rmSync(file, { force: true })
			} catch {
				/* somebody else removed it first */
			}
		}
	}
	return { ok: false, holder: readLock(file), file }
}

/** Read the lock file, or null when it is missing or unreadable. */
export function readLock(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (typeof parsed?.at !== 'number') return null
		return { pid: Number(parsed.pid) || 0, at: parsed.at }
	} catch {
		return null
	}
}
