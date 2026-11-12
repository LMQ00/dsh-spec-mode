/**
 * Turns the generated SVG into a PNG with whatever rasterizer the machine has.
 *
 * The diagram must be a picture a person can open anywhere — a file manager, a
 * chat window, a word processor — so the product is a PNG, not SVG source. The
 * SVG is still drawn first because it is the layout this plugin knows how to
 * produce; rasterizing it is the last step.
 *
 * No dependency is installed. The plugin looks for a renderer that is already on
 * the machine and uses the first one it finds, in this order:
 *
 *   1. `rsvg-convert`  — librsvg, present on most Linux desktops and installable by brew
 *   2. a Chromium-family browser in headless mode — Chrome, Chromium or Edge,
 *      at the usual per-OS install locations
 *   3. `inkscape` — also common on Linux and macOS
 *
 * When none of them exists the caller keeps the SVG instead: the harness
 * document preview renders `image/svg+xml` natively, so the reader still sees a
 * picture, and the tool result says which format was written.
 *
 * @module dsh-spec-mode/rasterize
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long one rasterizer may take before the next candidate is tried. */
const TIMEOUT_MS = 20_000;

/**
 * Browser executables, by the name they answer to on PATH and by absolute
 * install path on macOS and Windows. Paths are probed with `existsSync`, so a
 * missing entry costs one syscall.
 */
const BROWSERS = [
	'google-chrome',
	'google-chrome-stable',
	'chromium',
	'chromium-browser',
	'microsoft-edge',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * The pixel size an SVG document declares.
 * @param {string} svg - the SVG source.
 * @returns {{ width: number, height: number } | undefined} the declared size.
 */
export function svgSize(svg) {
	const width = /<svg[^>]*\swidth="(\d+)"/.exec(svg);
	const height = /<svg[^>]*\sheight="(\d+)"/.exec(svg);
	if (width === null || height === null) return undefined;
	return { width: Number(width[1]), height: Number(height[1]) };
}

/**
 * Whether one candidate executable can be run.
 * @param {string} candidate - a PATH name or an absolute path.
 * @returns {boolean} true when the plugin is willing to try it.
 */
function usable(candidate) {
	return candidate.includes('/') || candidate.includes('\\') ? existsSync(candidate) : true;
}

/**
 * Run one rasterizer, resolving only when the PNG exists.
 * @param {string} command - executable name or path.
 * @param {string[]} args - its arguments.
 * @returns {Promise<void>} resolves on success, rejects otherwise.
 */
async function attempt(command, args) {
	await run(command, args, { timeout: TIMEOUT_MS, windowsHide: true });
}

/**
 * Rasterize one SVG file to PNG, trying each available renderer in turn.
 *
 * @param {string} svgPath - the SVG written to disk.
 * @param {string} pngPath - where the PNG must end up.
 * @param {{ width: number, height: number }} size - the document size in pixels.
 * @returns {Promise<string | undefined>} the renderer that worked, or undefined when none did.
 */
export async function rasterize(svgPath, pngPath, size) {
	const width = String(Math.round(size.width));
	const height = String(Math.round(size.height));

	const attempts = [];

	if (usable('rsvg-convert')) {
		attempts.push(['rsvg-convert', ['-w', width, '-h', height, '-o', pngPath, svgPath]]);
	}

	for (const browser of BROWSERS) {
		if (!usable(browser)) continue;
		// A device scale factor of 2 keeps the text crisp on a retina display; the
		// window is the document size, so the output is exactly twice as large.
		attempts.push([
			browser,
			[
				'--headless',
				'--disable-gpu',
				'--no-sandbox',
				'--hide-scrollbars',
				'--default-background-color=ffffffff',
				'--force-device-scale-factor=2',
				`--window-size=${width},${height}`,
				`--screenshot=${pngPath}`,
				`file://${svgPath}`,
			],
		]);
	}

	if (usable('inkscape')) {
		attempts.push(['inkscape', ['--export-type=png', `--export-filename=${pngPath}`, '-w', width, '-h', height, svgPath]]);
	}

	for (const [command, args] of attempts) {
		try {
			await attempt(command, args);
			if (existsSync(pngPath)) return command;
		} catch {
			// A renderer that is present but fails (a sandbox policy, a missing
			// library) is no better than one that is absent; the next one may work.
		}
	}
	return undefined;
}
