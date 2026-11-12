/**
 * The chart collection over HTTP, for the conversation view.
 *
 * The view needs four things the Host owns: which charts exist, one chart's model
 * plus the SVG drawn from it, and the ability to save, create and delete. All of
 * them run through the same validators a landing uses — the view never decides
 * whether a chart is acceptable, it only shows what the Host says.
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
 * `/spec/flows/<verb>`.
 *
 * @module dsh-spec-mode/flows-api
 */

import {
	drawableChart,
	ensureFlowsDir,
	parentsOf,
	readChartBrief,
	readCollection,
	removeChartFiles,
	revisionOf,
	validateChart,
	validateCollection,
	writeChartBrief,
	writeChartModel,
} from './flows.js';
import { renderFlowSvg } from './flow-svg.js';

/** The route prefix this module owns. */
export const FLOWS_ROUTE = '/spec/flows';

/** How much of a request body one call accepts, so a huge paste is refused early. */
const BODY_LIMIT = 4 * 1024 * 1024;

/** The two steps a newly created chart starts with. */
const SEED_NODES = [{ id: 'n1', label: '第一步' }, { id: 'n2', label: '第二步' }];
const SEED_EDGES = [{ from: 'n1', to: 'n2' }];

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
 * Register the collection routes.
 *
 * @param {object} ctx - the plugin context, already carrying `webServer` and `connection`.
 * @param {{
 *   specDirOf: (session: object) => string,
 *   redraw: (specDir: string, models: Map<string, object>, id: string) => Promise<{ path: string }>,
 * }} deps - what the routes need from the plugin.
 * @returns {() => void} the disposer.
 */
export function registerFlowRoutes(ctx, deps) {
	const fence = (req) => ctx.connection.requestRejection(req) === undefined;

	/**
	 * Resolve the session one request speaks for. The view always sends its own
	 * session id, so a route never has to guess which project is meant.
	 * @param {URL} url - the request URL.
	 * @returns {object | undefined} the session.
	 */
	function sessionOf(url) {
		const id = url.searchParams.get('session') ?? '';
		if (id === '') return undefined;
		try {
			// An agent only exists while its Session is running; a Session the reader
			// has merely opened is live in the store but has no agent. Asking the agent
			// registry alone therefore answered "找不到这个会话" for every finished
			// conversation, which is exactly when a reader goes back to fix a chart.
			const live = ctx.get('sessions')?.get(id) ?? ctx.get('agents')?.get(id)?.session;
			return live;
		} catch {
			return undefined;
		}
	}

	/**
	 * The whole collection, with each chart's parents, modules and brief.
	 * @param {object} session - the session.
	 * @returns {object} the payload.
	 */
	function listPayload(session) {
		const specDir = deps.specDirOf(session);
		const { charts, problems } = readCollection(specDir);
		const models = new Map([...charts].map(([id, chart]) => [id, chart.model]));
		return {
			ok: true,
			specDir,
			problems,
			charts: [...charts.values()].map((chart) => ({
				id: chart.model.id,
				kind: chart.model.kind,
				name: chart.model.name,
				scope: chart.model.scope,
				revision: chart.revision,
				parents: parentsOf(models, chart.model.id),
				modules: (chart.model.nodes ?? [])
					.filter((node) => typeof node?.module === 'string' && node.module !== '')
					.map((node) => node.module),
				brief: readChartBrief(specDir, chart.model.id),
			})),
		};
	}

	/**
	 * The collection as models, for validating one chart against its siblings.
	 * @param {string} specDir - the absolute `.spec` directory.
	 * @returns {{ charts: Map<string, object>, models: Map<string, object> }} both views.
	 */
	function readBoth(specDir) {
		const { charts } = readCollection(specDir);
		return { charts, models: new Map([...charts].map(([id, chart]) => [id, chart.model])) };
	}

	const handler = async (req, res) => {
		if (!fence(req)) {
			json(res, 403, { ok: false, code: 'forbidden', message: 'forbidden' });
			return;
		}
		const url = new URL(req.url ?? '/', 'http://localhost');
		const verb = url.pathname.slice(FLOWS_ROUTE.length).replace(/^\//, '');
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
				const { charts, models } = readBoth(specDir);
				const read = charts.get(id);
				if (read === undefined) {
					json(res, 404, { ok: false, code: 'no-chart', message: `图集里没有「${id}」` });
					return;
				}
				// The picture is always drawn from the current model, so an editor that
				// has not saved yet still sees what its model would look like.
				json(res, 200, {
					ok: true,
					chart: read.model,
					revision: read.revision,
					brief: readChartBrief(specDir, id),
					svg: renderFlowSvg(drawableChart(read.model, models), `${read.model.name}：功能流程`, { interactive: true }),
				});
				return;
			}

			if (verb === 'preview' && req.method === 'POST') {
				// A preview is drawn from the model the editor holds, which may be
				// transiently invalid — a box added before its arrow, an edge added
				// before its condition. It is not validated, and it is never written:
				// the picture simply follows the editor, so dragging a box shows the
				// result before anything is committed.
				const payload = JSON.parse(await readBody(req));
				const session = sessionOf(url);
				if (session === undefined) {
					json(res, 404, { ok: false, code: 'no-session', message: '找不到这个会话' });
					return;
				}
				const specDir = deps.specDirOf(session);
				const { models } = readBoth(specDir);
				const candidate = payload?.chart;
				if (candidate === null || typeof candidate !== 'object' || !Array.isArray(candidate.nodes)) {
					json(res, 422, { ok: false, code: 'invalid', errors: ['chart 需要一个 nodes 数组'] });
					return;
				}
				const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
				const name = typeof candidate.name === 'string' && candidate.name.trim() !== '' ? candidate.name.trim() : '（未命名）';
				models.set(id, { ...candidate, name });
				try {
					const svg = renderFlowSvg(drawableChart({ ...candidate, name }, models), `${name}：功能流程`, { interactive: true });
					json(res, 200, { ok: true, svg });
				} catch (error) {
					json(res, 422, { ok: false, code: 'unrenderable', message: String(error?.message ?? error) });
				}
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
				const { charts, models } = readBoth(specDir);
				const candidate = payload?.chart;
				const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
				const outcome = validateChart(candidate, { knownModules: new Set([...models.keys(), id]) });
				if (!outcome.ok) {
					json(res, 422, { ok: false, code: 'invalid', errors: outcome.errors });
					return;
				}
				const current = charts.get(outcome.model.id);
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
				models.set(outcome.model.id, outcome.model);
				const collection = validateCollection(models);
				if (collection.errors.length > 0) {
					json(res, 422, { ok: false, code: 'invalid', errors: collection.errors });
					return;
				}
				ensureFlowsDir(specDir);
				writeChartModel(specDir, outcome.model);
				const brief = typeof payload?.brief === 'string' ? payload.brief : undefined;
				if (brief !== undefined) writeChartBrief(specDir, outcome.model.id, brief);
				const picture = await deps.redraw(specDir, models, outcome.model.id);
				json(res, 200, {
					ok: true,
					id: outcome.model.id,
					revision: revisionOf(outcome.model),
					picture: picture.path,
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
				const { models } = readBoth(specDir);
				const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
				const model = {
					id,
					kind: payload?.kind === 'overview' ? 'overview' : 'module',
					name: typeof payload?.name === 'string' ? payload.name.trim() : '',
					scope: typeof payload?.scope === 'string' ? payload.scope.trim() : '',
					// A new chart starts as two steps with one arrow: an empty graph would
					// fail the two-node rule and read as a broken chart rather than a blank
					// one the author is about to fill in.
					nodes: SEED_NODES.map((node) => ({ ...node })),
					edges: SEED_EDGES.map((edge) => ({ ...edge })),
				};
				if (models.has(id)) {
					json(res, 409, { ok: false, code: 'exists', message: `图集里已经有「${id}」` });
					return;
				}
				const known = new Set([...models.keys(), id]);
				const outcome = validateChart(model, { knownModules: known });
				if (!outcome.ok) {
					json(res, 422, { ok: false, code: 'invalid', errors: outcome.errors });
					return;
				}
				models.set(outcome.model.id, outcome.model);
				const collection = validateCollection(models);
				if (collection.errors.length > 0) {
					json(res, 422, { ok: false, code: 'invalid', errors: collection.errors });
					return;
				}
				ensureFlowsDir(specDir);
				writeChartModel(specDir, outcome.model);
				await deps.redraw(specDir, models, outcome.model.id);
				json(res, 200, { ok: true, id: outcome.model.id, revision: revisionOf(outcome.model) });
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
				const { models } = readBoth(specDir);
				const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
				if (!models.has(id)) {
					json(res, 404, { ok: false, code: 'no-chart', message: `图集里没有「${id}」` });
					return;
				}
				// Deleting a chart is a collection-level change: the parents that point
				// at it and the single-overview rule both have to survive it.
				const collection = validateCollection(models, { removed: [id] });
				if (collection.errors.length > 0) {
					json(res, 422, { ok: false, code: 'invalid', errors: collection.errors });
					return;
				}
				removeChartFiles(specDir, id);
				json(res, 200, { ok: true, removed: id });
				return;
			}

			json(res, 404, { ok: false, code: 'no-route', message: `没有这个接口：${verb || '/'}` });
		} catch (error) {
			json(res, 500, { ok: false, code: 'failed', message: String(error?.message ?? error) });
		}
	};

	ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: FLOWS_ROUTE, handler }), 'spec-mode: chart collection routes');
}
