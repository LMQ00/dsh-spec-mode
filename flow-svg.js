/**
 * Draws one validated flow chart as a standalone SVG document.
 *
 * This is the intermediate the plugin rasterizes to `flow.png`; SVG is the
 * format the layout is computed in, not the product. When the machine has no
 * rasterizer the SVG is kept instead — the harness document preview renders
 * `image/svg+xml` directly, so the reader still opens a picture.
 *
 * Layout is the standard layered one: a node with no incoming forward edge sits in
 * the first row, every other node one row below its deepest predecessor. The
 * exception is the loop: a retry is a real cycle, and drawing it unrolled would
 * make the picture claim the procedure repeats once. Those edges are taken out of
 * the layering (`backEdgesOf`), so the body still stacks downward, and they are
 * then drawn as a route up the right-hand side of the diagram. Rows are filled in
 * the order the model submitted the nodes, so the picture matches the submission.
 *
 * Three things the plain layered drawing gets wrong, and this file corrects:
 *
 * - A loop edge points back at a row already drawn, so it cannot run down the
 *   middle with the other arrows; it goes out to a lane beside the diagram.
 * - An edge can skip rows, and the space it would run through is occupied by the
 *   boxes of the rows it skips. Such an edge is routed out to that same lane area,
 *   so a line never crosses a box.
 * - Several branches out of one box annotate the same gap between rows, and all
 *   of them start from one point, so a `when` note placed at the midpoint can
 *   land on a sibling's line. Notes follow their own line instead — see
 *   `placePills`.
 *
 * Runs that leave a row sideways are allocated per gap (`takeRun`) rather than
 * placed at a fixed offset, because a gap can carry a run out, a run back in, and
 * two long edges at once; 8px apart they stay readable, and `RUN_MAX` keeps the
 * last one inside the gap.
 *
 * The document is built by string concatenation: no dependency, no canvas, no
 * headless browser needed to produce it.
 *
 * @module dsh-spec-mode/flow-svg
 */

import { backEdgesOf } from './flow.js';

/** Font size of a node label, in pixels. */
const LABEL_FONT = 13;

/** Font size of the chart title, in pixels. */
const TITLE_FONT = 16;

/** Line height inside a node box. */
const LINE_HEIGHT = 18;

/** Inner padding of a node box, horizontally and vertically. */
const PAD_X = 14;
const PAD_Y = 11;

/** Widest a wrapped label line may run before the text wraps again. */
const LABEL_MAX_WIDTH = 250;

/**
 * How far past {@link LABEL_MAX_WIDTH} a line may run before it wraps. Character
 * widths here are estimated, not measured from the font, so a hard limit would
 * break lines that render fine — and an estimate that runs one character short
 * leaves an orphan on the next line, which reads worse than a slightly wider box.
 */
const LABEL_TOLERANCE = 1.06;

/** Smallest and largest node box width, so one short and one long label still read as one diagram. */
const BOX_MIN_WIDTH = 148;
const BOX_MAX_WIDTH = 300;

/** Gap between neighbouring boxes in one row, and between rows. */
const H_GAP = 34;
const V_GAP = 72;

/** Outer margin, and the band the title occupies above the diagram. */
const MARGIN = 28;
const TITLE_BAND = 42;

/** Font size of a `when` note on an edge, and how tall its pill is. */
const PILL_FONT = 11;
const PILL_HEIGHT = 18;

/**
 * Clear space kept between two `when` pills that share one gap between rows.
 */
const PILL_GAP = 6;

/**
 * How far below the gap's top edge a route runs when it leaves its row sideways,
 * and how far apart two such routes crossing the same gap are. The clamp keeps a
 * third run inside the gap rather than in the row below.
 */
const RUN_BASE = 42;
const RUN_STEP = 8;
const RUN_MAX = 62;

/**
 * Clear space added above the first row when a retry points back at it. Every
 * other retry comes in through the gap above its target row; the first row has
 * no such gap, and without this band the return run would be drawn across the
 * title.
 */
const TOP_LOOP_BAND = 34;

/**
 * Where a retry leaves its box. A retry drawn from the box's centre would run
 * down the same column as the forward arrows and stop at the note of the edge
 * that goes straight on; leaving near the box's lower right corner sends it out
 * to its lane without touching any other line.
 */
const LOOP_EXIT_INSET = 12;

/**
 * Where an edge that skips rows runs: clear space right of the boxes, and the
 * distance between two such lanes. A vertical line drawn down the middle of the
 * picture would be covered by the boxes the later rows draw on top of it, so
 * every long edge gets its own channel beside the diagram instead.
 */
const LANE_GAP = 24;
const LANE_STEP = 20;

/* Explicit colours: this file is rendered as an image, not inside a themed page. */
const COLOR_BG = '#ffffff';
const COLOR_BOX = '#f5f8fc';
const COLOR_BOX_BORDER = '#c6d2e1';
const COLOR_TEXT = '#1f2933';
const COLOR_MUTED = '#5c6b7a';
const COLOR_EDGE = '#7b8794';

/** Estimated width of one character at a given size: full-width characters take one em, others a bit over half. */
function charWidth(codePoint) {
	// CJK, kana, full-width forms and emoji render about twice as wide as Latin.
	const wide =
		(codePoint >= 0x1100 && codePoint <= 0x115f)
		|| (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
		|| (codePoint >= 0xac00 && codePoint <= 0xd7a3)
		|| (codePoint >= 0xf900 && codePoint <= 0xfaff)
		|| (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
		|| (codePoint >= 0xff00 && codePoint <= 0xff60)
		|| (codePoint >= 0xffe0 && codePoint <= 0xffe6)
		|| codePoint >= 0x1f300;
	return wide ? 1 : 0.55;
}

/**
 * Estimated pixel width of one run of text.
 * @param {string} text - the text to measure.
 * @param {number} font - the font size in pixels.
 * @returns {number} the width in pixels.
 */
function measure(text, font) {
	let units = 0;
	for (const char of text) units += charWidth(char.codePointAt(0));
	return units * font;
}

/**
 * Wrap one label into the lines a node box shows.
 *
 * A Latin word is never split — breaking `schema` into `sc` + `hema` reads as a
 * typo. Chinese has no spaces to break on, so a run of wide characters breaks
 * per character instead. The rule is therefore: break at a space after a Latin
 * word, and anywhere inside a run of wide characters.
 *
 * A space is only used when it leaves the line reasonably full. `用户输入
 * /spec，模式打开…` is one space near the start of a long line; honouring it
 * would put the whole sentence on a single second line and leave the first one
 * nearly empty.
 *
 * @param {string} label - the node label.
 * @returns {string[]} one or more lines.
 */
export function wrapLabel(label) {
	const text = label.trim();
	if (text === '') return [''];

	const lines = [];
	let current = '';
	let width = 0;
	let lastBreak = -1; // index in `current` just past the last space

	const flush = (keepFrom) => {
		lines.push(current.slice(0, keepFrom).trimEnd());
		current = current.slice(keepFrom).trimStart();
		width = measure(current, LABEL_FONT);
		lastBreak = -1;
	};

	for (const char of text) {
		const w = charWidth(char.codePointAt(0)) * LABEL_FONT;
		if (width + w > LABEL_MAX_WIDTH * LABEL_TOLERANCE && current !== '') {
			// Only fall back to a space that filled most of the line; below that the
			// character boundary is the better break.
			const usesSpace = lastBreak > 0 && measure(current.slice(0, lastBreak), LABEL_FONT) >= LABEL_MAX_WIDTH * 0.62;
			flush(usesSpace ? lastBreak : current.length);
		}
		current += char;
		width += w;
		if (char === ' ') lastBreak = current.length;
	}
	if (current !== '') lines.push(current.trimEnd());

	// Pull a lone trailing character back up beside its word: `…工作树变只` + `读`
	// is worse than letting the first line run one character wider.
	if (lines.length > 1 && lines[lines.length - 1].length === 1 && lines[lines.length - 2].length > 1) {
		const previous = lines[lines.length - 2];
		lines[lines.length - 2] = previous.slice(0, -1).trimEnd();
		lines[lines.length - 1] = previous.slice(-1) + lines[lines.length - 1];
	}
	return lines.length === 0 ? [''] : lines;
}

/**
 * The layer of every node: 0 for a source, otherwise one past its deepest
 * predecessor. Computed with a memoised walk, which terminates because the graph
 * was already proven acyclic.
 * @param {{ nodes: object[], edges: object[] }} flow - the validated flow.
 * @returns {Map<string, number>} node id → layer index.
 */
export function layersOf(flow) {
	const back = backEdgesOf(flow);
	const parents = new Map(flow.nodes.map((node) => [node.id, []]));
	for (const edge of flow.edges) {
		// A loop edge points at a row already decided below; letting it choose the
		// row would ask for "one past a node that is one past me".
		if (back.has(`${edge.from}->${edge.to}`)) continue;
		parents.get(edge.to).push(edge.from);
	}
	const layers = new Map();
	const visit = (id) => {
		if (layers.has(id)) return layers.get(id);
		// Seed with 0 so a cycle would terminate here rather than recurse forever;
		// validateFlow rejects a cycle long before this renderer is reached.
		layers.set(id, 0);
		let layer = 0;
		for (const parent of parents.get(id)) layer = Math.max(layer, visit(parent) + 1);
		layers.set(id, layer);
		return layer;
	};
	for (const node of flow.nodes) visit(node.id);
	return layers;
}


/** Escape the five characters that would break an XML text node or attribute. */
function escapeXml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Sample a polyline densely enough to test a note box against it.
 * @param {[number, number][]} points - the polyline's vertices.
 * @returns {[number, number][]} points every couple of pixels along it.
 */
function segmentSamples(points) {
	const samples = [];
	for (let index = 1; index < points.length; index += 1) {
		const [ax, ay] = points[index - 1];
		const [bx, by] = points[index];
		const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
		for (let step = 1; step <= steps; step += 1) {
			samples.push([ax + ((bx - ax) * step) / steps, ay + ((by - ay) * step) / steps]);
		}
	}
	return samples;
}

/**
 * Sample a cubic Bézier the same way.
 * @param {[number, number]} start - the start point.
 * @param {[number, number]} control1 - the first control point.
 * @param {[number, number]} control2 - the second control point.
 * @param {[number, number]} end - the end point.
 * @returns {[number, number][]} points along the curve.
 */
function curveSamples(start, control1, control2, end) {
	const samples = [];
	for (let step = 1; step <= 48; step += 1) {
		const t = step / 48;
		const m = 1 - t;
		samples.push([
			m ** 3 * start[0] + 3 * m * m * t * control1[0] + 3 * m * t * t * control2[0] + t ** 3 * end[0],
			m ** 3 * start[1] + 3 * m * m * t * control1[1] + 3 * m * t * t * control2[1] + t ** 3 * end[1],
		]);
	}
	return samples;
}

/**
 * Whether a note box at one point would touch any line but its own, or any note
 * already placed.
 * @param {{ w: number }} pill - the note being placed.
 * @param {[number, number]} point - its centre.
 * @param {[number, number][][]} foreign - the other routes' samples.
 * @param {{ cx: number, cy: number, w: number }[]} placed - notes already placed.
 * @returns {boolean} true when the spot is free.
 */
function pillFits(pill, point, foreign, placed) {
	const left = point[0] - pill.w / 2 - 4;
	const right = point[0] + pill.w / 2 + 4;
	const top = point[1] - PILL_HEIGHT / 2 - 3;
	const bottom = point[1] + PILL_HEIGHT / 2 + 3;
	for (const samples of foreign) {
		for (const [x, y] of samples) {
			if (x > left && x < right && y > top && y < bottom) return false;
		}
	}
	for (const other of placed) {
		const apart = Math.min(right, other.cx + other.w / 2 + PILL_GAP) > Math.max(left, other.cx - other.w / 2 - PILL_GAP)
			&& Math.min(bottom, other.cy + PILL_HEIGHT / 2 + PILL_GAP) > Math.max(top, other.cy - PILL_HEIGHT / 2 - PILL_GAP);
		if (apart) return false;
	}
	return true;
}

/**
 * Place the `when` notes on the lines they belong to.
 *
 * A note is the only thing in the picture that says which way a branch goes, so
 * it has to sit on its own edge and clear of every other edge. Both pull against
 * each other in a gap that holds several branches: near the box they leave, all
 * of those edges are on the same pixel, so a note there covers its siblings.
 * Each note is therefore placed along its own line, starting from the point
 * closest to the target box — where the branches have separated — and sliding
 * back toward the source until the box fits.
 *
 * A box with more branches than the gap can annotate leaves one note without a
 * free spot on its line. That note falls back to one of the gap's two rows and
 * is pushed past the note already there, which keeps the picture honest: a note
 * beside its arrow still names the condition.
 *
 * @param {{ text: string, w: number, band: number, route: object, cx: number, cy: number }[]} pills - the notes, mutated in place.
 * @param {number[]} rowTops - top edge of each row.
 * @param {number[]} rowBottoms - bottom edge of each row.
 */
function placePills(pills, rowTops, rowBottoms) {
	const placed = [];
	for (const pill of pills) {
		const gapTop = rowBottoms[pill.band] ?? rowTops[pill.band] + V_GAP;
		const gapBottom = rowTops[pill.band + 1] ?? gapTop + V_GAP;
		const top = gapTop + PILL_HEIGHT / 2 + 3;
		const bottom = gapBottom - PILL_HEIGHT / 2 - 3;
		const own = pill.route.samples;
		const foreign = pills.filter((other) => other.route !== pill.route).map((other) => other.route.samples);

		// The point closest to the target row is where the branches have spread
		// furthest apart, so it is tried first.
		const candidates = own.filter((point) => point[1] >= top && point[1] <= bottom).sort((a, b) => b[1] - a[1]);
		let spot = candidates.find((point) => pillFits(pill, point, foreign, placed));
		if (spot === undefined) {
			spot = fallbackSpot(pill, top, bottom, placed);
		}
		pill.cx = spot[0];
		pill.cy = spot[1];
		placed.push(pill);
	}
}

/**
 * The nearest free spot in the gap's two rows when the note's own line has none.
 *
 * Rows are the only heights whose lines have separated, so the note keeps one of
 * them and slides sideways past whatever is already there. The row requiring the
 * smaller slide wins, and the upper row wins a tie.
 *
 * @param {{ w: number }} pill - the note being placed.
 * @param {number} top - the highest note centre the gap allows.
 * @param {number} bottom - the lowest note centre the gap allows.
 * @param {{ cx: number, cy: number, w: number }[]} placed - notes already placed.
 * @returns {[number, number]} the centre to use.
 */
function fallbackSpot(pill, top, bottom, placed) {
	const rows = top + 3 <= bottom - 3 ? [top, bottom] : [(top + bottom) / 2];
	let best;
	for (const row of rows) {
		const beside = placed.filter((other) => Math.abs(other.cy - row) < PILL_HEIGHT);
		const wanted = pill.route.samples.reduce(
			(right, point) => (Math.abs(point[1] - row) < Math.abs(right[1] - row) ? point : right),
			pill.route.samples[0] ?? [pill.route.x1, row],
		)[0];
		const free = beside.reduce((right, other) => Math.max(right, other.cx + other.w / 2 + PILL_GAP + pill.w / 2), wanted);
		const slide = Math.abs(free - wanted);
		if (best === undefined || slide < best.slide) best = { spot: [free, row], slide };
	}
	return best.spot;
}

/**
 * Render one validated flow chart as a standalone SVG document.
 * @param {{ nodes: object[], edges: object[] }} flow - the validated flow.
 * @param {string} title - the chart title, drawn above the graph.
 * @returns {string} the complete SVG source.
 */
export function renderFlowSvg(flow, title = '功能流程') {
	const layers = layersOf(flow);

	// One row per layer, in declaration order, so the picture follows the order
	// the author wrote the nodes in rather than an internal sort.
	const rows = [];
	for (const node of flow.nodes) {
		const layer = layers.get(node.id);
		if (rows[layer] === undefined) rows[layer] = [];
		rows[layer].push(node);
	}

	const boxes = new Map();
	for (const node of flow.nodes) {
		const lines = wrapLabel(node.label);
		const widest = Math.max(...lines.map((line) => measure(line, LABEL_FONT)));
		const width = Math.min(BOX_MAX_WIDTH, Math.max(BOX_MIN_WIDTH, widest + PAD_X * 2));
		const height = lines.length * LINE_HEIGHT + PAD_Y * 2;
		boxes.set(node.id, { lines, width, height });
	}

	// Vertical extent of each row depends on its tallest box, so a row of long
	// labels pushes the next row down rather than overlapping it.
	//
	// A retry onto the first row has no gap above it to come in through, so the
	// whole diagram starts one band lower and that band belongs to the retry.
	const topLoop = backEdgesOf(flow);
	const entersTopRow = flow.edges.some((edge) => topLoop.has(`${edge.from}->${edge.to}`) && layers.get(edge.to) === 0);
	const rowTops = [];
	const rowBottoms = [];
	let y = MARGIN + TITLE_BAND + (entersTopRow ? TOP_LOOP_BAND : 0);
	let contentWidth = 0;
	for (const row of rows) {
		const tallest = Math.max(...row.map((node) => boxes.get(node.id).height));
		const rowWidth = row.reduce((sum, node) => sum + boxes.get(node.id).width, 0) + H_GAP * (row.length - 1);
		contentWidth = Math.max(contentWidth, rowWidth);
		rowTops.push(y);
		rowBottoms.push(y + tallest);
		y += tallest + V_GAP;
	}

	const width = Math.max(contentWidth + MARGIN * 2, measure(title, TITLE_FONT) + MARGIN * 2, 320);
	const height = y - V_GAP + MARGIN;

	const centres = new Map();
	rows.forEach((row, layer) => {
		const rowWidth = row.reduce((sum, node) => sum + boxes.get(node.id).width, 0) + H_GAP * (row.length - 1);
		let x = (width - rowWidth) / 2;
		for (const node of row) {
			const box = boxes.get(node.id);
			centres.set(node.id, { x: x + box.width / 2, top: rowTops[layer], width: box.width, height: box.height, layer });
			x += box.width + H_GAP;
		}
	});

	// Routes are resolved before the canvas is fixed: a lane, a run's height and a
	// note's place all move the picture's width.
	const backEdges = backEdgesOf(flow);
	const routes = [];
	const pills = [];
	for (const edge of flow.edges) {
		const from = centres.get(edge.from);
		const to = centres.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const isLoop = backEdges.has(`${edge.from}->${edge.to}`);
		const span = isLoop ? -1 : to.layer - from.layer;
		const route = {
			x1: from.x,
			y1: from.top + from.height,
			x2: to.x,
			y2: to.top,
			span,
			isLoop,
			fromLayer: from.layer,
			toLayer: to.layer,
			x1Right: from.x + from.width / 2,
			y1Mid: from.top + from.height / 2,
			x2Right: to.x + to.width / 2,
			y2Mid: to.top + to.height / 2,
			pill: undefined,
			samples: [],
		};
		routes.push(route);
		if (edge.when !== undefined && edge.when !== '') {
			route.pill = {
				text: edge.when,
				w: measure(edge.when, PILL_FONT) + 12,
				cx: 0,
				cy: 0,
				band: from.layer,
				route,
				placed: false,
			};
			pills.push(route.pill);
		}
	}

	// A route that leaves its row has to run sideways through a gap between rows,
	// and that gap is already occupied by the notes of the edges that branch just
	// above it. Runs are therefore allocated per gap: each one takes its own
	// height below the gap's top edge, two in one gap are 8px apart, and a note
	// is placed clear of them by `placePills`.
	//
	// A hop that skips rows also cannot run down the column its two ends share:
	// every row in between draws a box on top of that column. It leaves its own
	// box, runs along the gap below it to a lane beside the diagram, goes down that
	// lane, and comes back in above the target row — so it never crosses a box.
	//
	// Both ends of such a route run sideways through a gap and both need a slot, so
	// one counter serves both passes: two runs in the same gap must not land on the
	// same line.
	const runsInGap = new Map();
	const takeRun = (gap) => {
		const index = runsInGap.get(gap) ?? 0;
		runsInGap.set(gap, index + 1);
		const top = rowBottoms[gap] ?? rowTops[gap] + V_GAP;
		return top + Math.min(RUN_BASE + RUN_STEP * index, RUN_MAX);
	};

	/**
	 * The height at which a route enters its target row. Normally that is the gap
	 * above the row; a retry that points at the first row has no such gap, so it
	 * comes in over the row's top edge instead, in the band reserved for it. Two
	 * such retries get two heights, or their return runs would be drawn on top of
	 * each other and read as one arrow.
	 */
	let topRuns = 0;
	const takeEntry = (toLayer) => {
		if (toLayer > 0) return takeRun(toLayer - 1);
		topRuns += 1;
		return rowTops[0] - TOP_LOOP_BAND / 2 - RUN_STEP * (topRuns - 1);
	};

	let laneCount = 0;
	const laneRight = (width + contentWidth) / 2;
	for (const route of routes) {
		if (route.span <= 1 && !route.isLoop) continue;
		route.lane = laneRight + LANE_GAP + LANE_STEP * laneCount;
		laneCount += 1;
	}
	for (const route of routes) {
		if (route.span <= 1 && !route.isLoop) continue;
		route.out = takeRun(route.fromLayer);
		if (route.span > 1 || route.isLoop) route.back = takeEntry(route.toLayer);
	}

	const paths = [];
	for (const route of routes) {
		const { x1, y1, x2, y2, span } = route;
		const mid = (y1 + y2) / 2;
		if (route.isLoop) {
			// A retry leaves its own box, crosses the gap below it under the notes,
			// runs right into a lane beside the diagram, climbs the lane, comes back in
			// through the gap above the target row, and only then turns into the
			// target's side. Entering from the side keeps the arrow tip out of the
			// column the downward arrows use.
			route.outX = route.x1Right - LOOP_EXIT_INSET;
			route.d =
				`M ${route.outX} ${y1} L ${route.outX} ${route.out} L ${route.lane} ${route.out} `
				+ `L ${route.lane} ${route.back} L ${route.x2Right + 6} ${route.back} `
				+ `L ${route.x2Right + 6} ${route.y2Mid} L ${route.x2Right + 3} ${route.y2Mid}`;
			route.samples = segmentSamples([
				[route.outX, y1], [route.outX, route.out], [route.lane, route.out],
				[route.lane, route.back], [route.x2Right + 6, route.back],
				[route.x2Right + 6, route.y2Mid], [route.x2Right + 3, route.y2Mid],
			]);
		} else if (span <= 1) {
			// Adjacent rows: a straight line when the boxes line up, a smooth
			// curve when they do not.
			if (Math.abs(x1 - x2) < 0.5) {
				route.d = `M ${x1} ${y1} L ${x2} ${y2}`;
				route.samples = segmentSamples([[x1, y1], [x2, y2]]);
			} else {
				route.d = `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
				route.samples = curveSamples([x1, y1], [x1, mid], [x2, mid], [x2, y2]);
			}
		} else {
			route.d = `M ${x1} ${y1} L ${x1} ${route.out} L ${route.lane} ${route.out} L ${route.lane} ${route.back} L ${x2} ${route.back} L ${x2} ${y2}`;
			route.samples = segmentSamples([
				[x1, y1], [x1, route.out], [route.lane, route.out],
				[route.lane, route.back], [x2, route.back], [x2, y2],
			]);
		}
		paths.push(route.d);
	}

	placePills(pills, rowTops, rowBottoms);

	// A pill pushed right can leave the canvas; widening keeps every condition
	// inside the picture instead of cropping it.
	let pictureWidth = width;
	for (const pill of pills) {
		const left = pill.cx - pill.w / 2;
		if (left < MARGIN) pill.cx += MARGIN - left;
		pictureWidth = Math.max(pictureWidth, pill.cx + pill.w / 2 + MARGIN);
	}
	if (laneCount > 0) {
		pictureWidth = Math.max(pictureWidth, laneRight + LANE_GAP + LANE_STEP * (laneCount - 1) + MARGIN);
	}

	const parts = [];
	const svgWidth = Math.ceil(pictureWidth);
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${Math.ceil(height)}" `
			+ `viewBox="0 0 ${svgWidth} ${Math.ceil(height)}" role="img" aria-label="${escapeXml(title)}">`,
		'<defs>',
		`<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
			+ `<path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_EDGE}"/></marker>`,
		'</defs>',
		`<rect x="0" y="0" width="${svgWidth}" height="${Math.ceil(height)}" fill="${COLOR_BG}"/>`,
		`<text x="${MARGIN}" y="${MARGIN + 18}" font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" `
			+ `font-size="${TITLE_FONT}" font-weight="600" fill="${COLOR_TEXT}">${escapeXml(title)}</text>`,
	);

	// Edges first, so a box always covers the line that would run into it.
	for (const path of paths) {
		parts.push(`<path d="${path}" fill="none" stroke="${COLOR_EDGE}" stroke-width="1.4" marker-end="url(#arrow)"/>`);
	}
	for (const pill of pills) {
		parts.push(
			`<rect x="${(pill.cx - pill.w / 2).toFixed(1)}" y="${(pill.cy - PILL_HEIGHT / 2).toFixed(1)}" `
				+ `width="${pill.w.toFixed(1)}" height="${PILL_HEIGHT}" rx="4" fill="${COLOR_BG}" `
				+ `stroke="${COLOR_BOX_BORDER}" stroke-width="0.8"/>`,
			`<text x="${pill.cx.toFixed(1)}" y="${(pill.cy + 4).toFixed(1)}" text-anchor="middle" `
				+ `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" `
				+ `font-size="${PILL_FONT}" fill="${COLOR_MUTED}">${escapeXml(pill.text)}</text>`,
		);
	}

	for (const node of flow.nodes) {
		const box = boxes.get(node.id);
		const centre = centres.get(node.id);
		const left = centre.x - box.width / 2;
		parts.push(
			`<rect x="${left.toFixed(1)}" y="${centre.top}" width="${box.width.toFixed(1)}" height="${box.height}" rx="9" `
				+ `fill="${COLOR_BOX}" stroke="${COLOR_BOX_BORDER}" stroke-width="1.1"/>`,
		);
		box.lines.forEach((line, index) => {
			const baseline = centre.top + PAD_Y + LINE_HEIGHT * index + LABEL_FONT - 1;
			parts.push(
				`<text x="${centre.x.toFixed(1)}" y="${baseline.toFixed(1)}" text-anchor="middle" `
					+ `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" `
					+ `font-size="${LABEL_FONT}" fill="${COLOR_TEXT}">${escapeXml(line)}</text>`,
			);
		});
	}

	parts.push('</svg>');
	return `${parts.join('\n')}\n`;
}
