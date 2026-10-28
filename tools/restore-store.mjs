/**
 * Put the previous export back where the scanner expects its store.
 *
 * The public repo does not commit the working store (`.data/`): the four data
 * files under `docs/data/` already *are* the store, minus the scan log. This
 * copies them back and rebuilds `scans.json` from `status.json`, so the hourly
 * run continues from the last state instead of starting over.
 *
 * Usage: node tools/restore-store.mjs [--data docs/data] [--store .data]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`)
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const dataDir = path.resolve(flag('data', path.join(root, 'docs', 'data')))
const storeDir = path.resolve(flag('store', path.join(root, '.data')))

fs.mkdirSync(storeDir, { recursive: true })

let restored = 0
for (const name of ['books', 'latest', 'hourly', 'daily']) {
	const source = path.join(dataDir, `${name}.json`)
	if (!fs.existsSync(source)) continue
	fs.copyFileSync(source, path.join(storeDir, `${name}.json`))
	restored += 1
}

// `status.json` lists scans newest-first; the store keeps them oldest-last.
const statusFile = path.join(dataDir, 'status.json')
if (fs.existsSync(statusFile)) {
	try {
		const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
		const scans = Array.isArray(status.scans) ? status.scans.slice().reverse() : []
		fs.writeFileSync(path.join(storeDir, 'scans.json'), JSON.stringify({ v: scans }), 'utf8')
	} catch {
		/* a broken status file must not stop the scan */
	}
}

console.log(`恢复 ${restored} 个数据文件到 ${storeDir}`)
if (restored === 0) console.log('这是第一次运行，没有历史可恢复。')
