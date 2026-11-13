/**
 * The chart collection over HTTP, for the conversation view.
 *
 * The view needs four things the Host owns: which charts exist, one chart's
 * markdown plus the mermaid it draws, and the ability to save, create and delete.
 * All of them run through the same validators a landing uses — the view never
 * decides whether a chart is acceptable, it only shows what the Host says.
 *
 * Two rules make this safe enough to be a plain route rather than a service:
 *
 * - Every request is fenced by `connection.requestRejection`, the same check the
 *   shipped JSON routes use. A request the page did not make is refused before it
 *   reaches the filesystem.
 * - A save carries the revision the reader loaded. If the file changed in the
 *   meantime the write is refused with the current revision, so a stale editor
 *   cannot silently overwrite a landing or a model's edit.
 *
 * Routes live under one prefix so the whole surface is visible in one place:
 * `/spec/flows/<verb>`. The one exception is `mermaid.js`, the drawing library
 * the page loads as a script.
 *
 * @module dsh-spec-mode/flows-api
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
	drawableChart,
	kindOf,
	parentsOf,
	readCollection,
	removeChartFiles,
	validateChart,
	validateCollection,
	writeChart,
} from './flows.js';
import { drawMermaid } from './mermaid-graph.js';

/** The route prefix this module owns. */
export const FLOWS_ROUTE = '/spec/flows';

/** Where the page loads the drawing library from. */
export const MERMAID_ROUTE = `${FLOWS_ROUTE}/mermaid.js`;

/** How much of a request body one call accepts, so a huge paste is refused early. */
const BODY_LIMIT = 4 * 1024 * 1024;

/** Every verb this route answers. */
const KNOWN_VERBS = new Set(['list', 'chart', 'save', 'create', 'delete']);

/** The two steps a newly created chart starts with. */
const SEED_SOURCE = drawMermaid({
	direction: 'LR',
	nodes: [
		{ id: 'n1', label: '第一步' },
		{ id: 'n2', label: '第二步' },
	],
	edges: [{ from: 'n1', to: 'n2' }],
});

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {unknown} payload - the JSON body.
 */
function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	});
	res.end(body);
}

/**
 * Read a request body as text, refusing anything over the limit.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the body text.
 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new Error('请求太大');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * Where the drawing library sits on this machine.
 *
 * The plugin ships no copy of its own: mermaid is a browser library of several
 * megabytes, and every install already has one beside the plugins that draw
 * markdown. The first path that exists wins, so a project that keeps mermaid
 * somewhere unusual can name it once in `DSH_SPEC_MERMAID`.
 *
 * @returns {string | undefined} the absolute path, or `undefined` when absent.
 */
export function mermaidAssetPath() {
	const named = process.env.DSH_SPEC_MERMAID;
	if (typeof named === 'string' && named !== '' && existsSync(named)) return named;
	const relative = join('node_modules', 'mermaid', 'dist', 'mermaid.min.js');
	const parents = [];
	// The plugin's own directory, then every directory above it: a package manager
	// that hoists dependencies lands on one of these.
	let at = dirname(new URL(import.meta.url).pathname);
	while (at !== '/' && parents.length < 8) {
		parents.push(at);
		at = dirname(at);
	}
	parents.push(homedir());
	const candidates = parents.map((base) => join(base, relative));
	// Every profile keeps its own node_modules; the library is installed once per
	// profile, and the plugin runs under whichever profile loaded it.
	try {
		const profiles = join(homedir(), '.dsh', 'profiles');
		for (const name of readdirSync(profiles)) candidates.push(join(profiles, name, relative));
	} catch {
		// No profiles directory: the other candidates still apply.
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	try {
		return createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
	} catch {
		return undefined;
	}
}

/**
 * Register the collection routes.
 *
 * @param {object} ctx - the plugin context, already carrying `webServer` and `connection`.
 * @param {{ specDirOf: (session: object) => string }} deps - what the routes need from the plugin.
 * @returns {() => void} the disposer.
 */
export function registerFlowRoutes(ctx, deps) {
	const fence = (req) => ctx.connection.requestRejection(req) === undefined;

	/** The drawing library, read once and kept for the life of the process. */
	let mermaidCache;

	/**
	 * Resolve the session one request speaks for. The view always sends its own
	 * session id, so a route never has to guess which project is meant.
	 * @param {URL} url - the request URL.
	 * @returns {object | undefined} the session.
	 */
	function sessionOf(url) {
		const raw = url.searchParams.get('session') ?? '';
		if (raw === '') return undefined;
		// The view slot hands the page a session id; whether that carries the
		// `session-` prefix depends on where the conversation came from, so both
		// spellings are tried before saying the session is gone.
		const candidates = raw.startsWith('session-') ? [raw, raw.slice('session-'.length)] : [raw, `session-${raw}`];
		for (const id of candidates) {
			if (id === '') continue;
			try {
				// An agent only exists while its Session is running; a Session the reader
				// has merely opened is live in the store but has no agent. Asking the agent
				// registry alone therefore answered "找不到这个会话" for every finished
				// conversation, which is exactly when a reader goes back to fix a chart.
				const found = ctx.get('sessions')?.get(id) ?? ctx.get('agents')?.get(id)?.session;
				if (found !== undefined) return found;
			} catch {
				// A store that throws answers the same as one that missed.
			}
		}
		return undefined;
	}

	/**
	 * The collection as entries, for validating one chart against its siblings.
	 * @param {string} specDir - the absolute `.spec` directory.
	 * @returns {Map<string, object>} id → entry.
	 */
	function entriesOf(specDir) {
		return readCollection(specDir).charts;
	}

	/**
	 * The whole collection, with each chart's parents and module targets.
	 * @param {object} session - the session.
	 * @returns {object} the payload.
	 */
	function listPayload(session) {
		const specDir = deps.specDirOf(session);
		const { charts, problems } = readCollection(specDir);
		return {
			ok: true,
			specDir,
			problems,
			charts: [...charts.values()].map((entry) => ({
				id: entry.chart.id,
				kind: kindOf(entry.chart.id),
				name: entry.chart.name,
				scope: entry.chart.scope,
				revision: entry.revision,
				parents: parentsOf(charts, entry.chart.id),
				modules: (entry.graph.nodes ?? [])
					.filter((node) => typeof node?.module === 'string' && node.module !== '')
					.map((node) => node.module),
				brief: entry.chart.brief,
			})),
		};
	}

	const handler = async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const verb = url.pathname.slice(FLOWS_ROUTE.length).replace(/^\//, '');

		if (verb === 'mermaid.js') {
			// The drawing library is the same file for every reader and carries no
			// project data, so it is served without the request fence and cached.
			const path = mermaidAssetPath();
			if (path === undefined) {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('没有找到 mermaid。装一个，或用 DSH_SPEC_MERMAID 指定 mermaid.min.js 的路径。');
				return;
			}
			// The same 3.4 MB for every page load: read it once per process and keep
			// the header that says how long the browser may too. A path that is a
			// directory or an unreadable file answers like a missing one instead of
			// throwing out of the request handler.
			try {
				mermaidCache ??= readFileSync(path);
			} catch {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('没有找到 mermaid。装一个，或用 DSH_SPEC_MERMAID 指定 mermaid.min.js 的路径。');
				return;
			}
			const body = mermaidCache;
			res.writeHead(200, {
				'content-type': 'application/javascript; charset=utf-8',
				'content-length': body.length,
				'cache-control': 'public, max-age=86400',
			});
			res.end(body);
			return;
		}

		if (!fence(req)) {
			json(res, 403, { ok: false, code: 'forbidden', message: 'forbidden' });
			return;
		}

		try {
			if (verb === 'list' && req.method === 'GET') {
				const session = sessionOf(url);
				if (session === undefined) {
					json(res, 404, { ok: false, code: 'no-session', message: '找不到这个会话' });
					return;
				}
				json(res, 200, listPayload(session));
				return;
			}

			if (verb === 'chart' && req.method === 'GET') {
				const session = sessionOf(url);
				const id = url.searchParams.get('id') ?? '';
				if (session === undefined) {
					json(res, 404, { ok: false, code: 'no-session', message: '找不到这个会话' });
					return;
				}
				const specDir = deps.specDirOf(session);
				const charts = entriesOf(specDir);
				const entry = charts.get(id);
				if (entry === undefined) {
					json(res, 404, { ok: false, code: 'no-chart', message: `图集里没有「${id}」` });
					return;
				}
				json(res, 200, {
					ok: true,
					chart: { id: entry.chart.id, name: entry.chart.name, scope: entry.chart.scope, brief: entry.chart.brief },
					source: entry.chart.source,
					// The view draws this string; module boxes already carry the name of
					// the chart each one points at.
					drawn: drawableChart(entry, charts),
					revision: entry.revision,
				});
				return;
			}

			if (verb === 'save' && req.method === 'POST') {
				const payload = JSON.parse(await readBody(req));
				const session = sessionOf(url);
				if (session === undefined) {
					json(res, 404, { ok: false, code: 'no-session', message: '找不到这个会话' });
					return;
				}
				const specDir = deps.specDirOf(session);
				const charts = entriesOf(specDir);
				const candidate = payload?.chart;
				const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
				const outcome = validateChart(candidate, { knownModules: new Set([...charts.keys(), id]) });
				if (!outcome.ok) {
					json(res, 422, { ok: false, code: 'invalid', errors: outcome.errors });
					return;
				}
				const current = charts.get(outcome.chart.id);
				const expected = typeof payload?.revision === 'string' ? payload.revision : '';
				if (current !== undefined && expected !== current.revision) {
					json(res, 409, {
						ok: false,
						code: 'conflict',
						message: '盘上的图已经变了，先重新载入再改',
						revision: current.revision,
					});
					return;
				}
				charts.set(outcome.chart.id, { chart: outcome.chart, graph: outcome.graph, revision: '' });
				const collection = validateCollection(charts);
				if (collection.errors.length > 0) {
					json(res, 422, { ok: false, code: 'invalid', errors: collection.errors });
					return;
				}
				const written = writeChart(specDir, outcome.chart);
				json(res, 200, {
					ok: true,
					id: outcome.chart.id,
					revision: written.revision,
					path: written.path,
					warnings: collection.warnings,
				});
				return;
			}

			if (verb === 'create' && req.method === 'POST') {
				const payload = JSON.parse(await readBody(req));
				const session = sessionOf(url);
				if (session === undefined) {
					json(res, 404, { ok: false, code: 'no-session', message: '找不到这个会话' });
					return;
				}
				const specDir = deps.specDirOf(session);
				const charts = entriesOf(specDir);
				const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
				if (charts.has(id)) {
					json(res, 409, { ok: false, code: 'exists', message: `图集里已经有「${id}」` });
					return;
				}
				const chart = {
					id,
					name: typeof payload?.name === 'string' ? payload.name.trim() : '',
					scope: typeof payload?.scope === 'string' ? payload.scope.trim() : '',
					source: SEED_SOURCE,
					brief: '',
				};
				const outcome = validateChart(chart, { knownModules: new Set([...charts.keys(), id]) });
				if (!outcome.ok) {
					json(res, 422, { ok: false, code: 'invalid', errors: outcome.errors });
					return;
				}
				charts.set(outcome.chart.id, { chart: outcome.chart, graph: outcome.graph, revision: '' });
				const collection = validateCollection(charts);
				if (collection.errors.length > 0) {
					json(res, 422, { ok: false, code: 'invalid', errors: collection.errors });
					return;
				}
				const written = writeChart(specDir, outcome.chart);
				json(res, 200, { ok: true, id: outcome.chart.id, revision: written.revision });
				return;
			}

			if (verb === 'delete' && req.method === 'POST') {
				const payload = JSON.parse(await readBody(req));
				const session = sessionOf(url);
				if (session === undefined) {
					json(res, 404, { ok: false, code: 'no-session', message: '找不到这个会话' });
					return;
				}
				const specDir = deps.specDirOf(session);
				const charts = entriesOf(specDir);
				const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
				if (!charts.has(id)) {
					json(res, 404, { ok: false, code: 'no-chart', message: `图集里没有「${id}」` });
					return;
				}
				// Deleting a chart is a collection-level change: the parents that point
				// at it and the overview rule both have to survive it.
				const collection = validateCollection(charts, { removed: [id] });
				if (collection.errors.length > 0) {
					json(res, 422, { ok: false, code: 'invalid', errors: collection.errors });
					return;
				}
				removeChartFiles(specDir, id);
				json(res, 200, { ok: true, removed: id });
				return;
			}

				// A verb this route knows, called the wrong way round: the caller is
				// holding the wrong method, not the wrong address.
			if (KNOWN_VERBS.has(verb)) {
				json(res, 405, { ok: false, code: 'no-method', message: `${verb} 不接受 ${req.method}` });
				return;
			}
			json(res, 404, { ok: false, code: 'no-route', message: `没有这个接口：${verb || '/'}` });
		} catch (error) {
			// The two failures a caller can cause are named: a body that is not JSON is
			// their mistake, and a body over the limit is not a server fault either.
			if (error?.message === '请求太大') {
				json(res, 413, { ok: false, code: 'too-large', message: `请求超过 ${BODY_LIMIT} 字节` });
				return;
			}
			if (error instanceof SyntaxError) {
				json(res, 400, { ok: false, code: 'bad-json', message: `请求体不是 JSON：${error.message}` });
				return;
			}
			json(res, 500, { ok: false, code: 'failed', message: String(error?.message ?? error) });
		}
	};

	ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: FLOWS_ROUTE, handler }), 'spec-mode: chart collection routes');
}
