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
 * then drawn as a route up the side of the diagram. Rows are filled in the order
 * the model submitted the nodes, so the picture matches the submission.
 *
 * Five things the plain layered drawing gets wrong, and this file corrects:
 *
 * - A loop edge points back at a row already drawn, so it cannot run down the
 *   middle with the other arrows; it goes out to a lane beside the diagram. It
 *   takes the side its target sits on, so a retry never crosses the picture.
 * - An edge can skip rows, and the space it would run through is occupied by the
 *   boxes of the rows it skips. Such an edge is routed out to that same lane area,
 *   so a line never crosses a box.
 * - Several branches out of one box annotate the same gap between rows, and all
 *   of them start from one point, so a `when` note placed at the midpoint can
 *   land on a sibling's line. Notes follow their own line instead — see
 *   `placePills`.
 * - A gap can carry more sideways runs than a fixed height would hold, which
 *   would stack two of them on one line and read as a single arrow. The gap is
 *   therefore measured from the number of runs it must carry (`gapHeight`).
 * - The canvas has to be sized from what was drawn rather than from the row
 *   stack: a retry out of the last row runs below it, and a note pushed sideways
 *   runs past the boxes. Both extend the picture instead of being clipped by it.
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

/** Font size and line height of the port lines a module box carries. */
const PORT_FONT = 11;
const PORT_LINE_HEIGHT = 15;

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

/** Gap between neighbouring boxes in one row, and the smallest gap between rows. */
const H_GAP = 34;
const V_GAP = 76;

/**
 * The widest a row of boxes may run before it wraps onto another row.
 *
 * Without this the picture grows sideways without limit: eight module boxes in
 * one layer are 1481px wide, so the reader has to drag the pane left and right to
 * see one diagram. Wrapping keeps every picture near the width of the pane it is
 * read in, at the cost of a layer occasionally taking two rows.
 */
export const WRAP_WIDTH = 860;

/**
 * Gap between two rows of the SAME layer. Smaller than {@link V_GAP}: a
 * continuation row is not the next step, and spacing it like one would make the
 * reader think the flow had advanced.
 */
const WRAP_GAP = 56;

/** Outer margin, and the band the title occupies above the diagram. */
const MARGIN = 28;
const TITLE_BAND = 42;

/** Space kept below the last row so the picture does not end on a box edge. */
const BOTTOM_SPACE = 40;

/** Font size of a `when` note on an edge, and how tall its pill is. */
const PILL_FONT = 11;
const PILL_HEIGHT = 18;

/** Clear space kept between two `when` pills that share one gap between rows. */
const PILL_GAP = 6;

/**
 * The top slice of a gap that belongs to the notes. Every sideways run of the
 * gap is drawn below it, so a note is never read across an arrow that is not its
 * own; the runs get the rest of the gap.
 */
const PILL_ZONE = 54;

/**
 * Where the first sideways run of a gap sits below its top edge, how far apart
 * two such runs are, and the clear space kept under the last one. A gap carrying
 * more runs than {@link V_GAP} holds grows to fit them instead of stacking the
 * extra runs on one line.
 */
const RUN_BASE = 60;
const RUN_STEP = 8;
const RUN_CLEAR = 16;

/**
 * Space above the first row when a retry points back at it, before the runs that
 * enter there are counted. Every other retry comes in through the gap above its
 * target row; the first row has no such gap, and without this band the return run
 * would be drawn across the title.
 */
const TOP_LOOP_NEAR = 16;
const TOP_LOOP_HEAD = 12;

/**
 * Where a retry leaves its box. A retry drawn from the box's centre would run
 * down the same column as the forward arrows and stop at the note of the edge
 * that goes straight on; leaving near the box's lower corner sends it out to its
 * lane without touching any other line.
 */
const LOOP_EXIT_INSET = 14;

/**
 * Where an edge that skips rows or returns runs: clear space beside the boxes,
 * and the distance between two such lanes. A vertical line drawn down the middle
 * of the picture would be covered by the boxes the later rows draw on top of it,
 * so every such edge gets its own channel beside the diagram instead.
 */
const LANE_GAP = 26;
const LANE_STEP = 18;

/** How far a lane is held off the boxes' row, and the clear space before the title. */
const LANE_PAD = 0;

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

/**
 * The height of the gap below one row: its minimum, or enough to stack every
 * sideways run it carries without putting two of them on one line.
 * @param {number} runs - how many runs cross the gap.
 * @returns {number} the gap height in pixels.
 */
function gapHeight(runs, base = V_GAP) {
	if (runs <= 0) return base;
	return Math.max(base, RUN_BASE + RUN_STEP * (runs - 1) + RUN_CLEAR);
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
 * Sample a cubic Bézier densely enough for the same test. The step count follows
 * the control polygon's length: a wide chart draws curves several hundred pixels
 * long, and a fixed step count would leave gaps larger than a note box between
 * two samples, so an overlap in the middle of a long leg would go unseen.
 * @param {[number, number]} start - the start point.
 * @param {[number, number]} control1 - the first control point.
 * @param {[number, number]} control2 - the second control point.
 * @param {[number, number]} end - the end point.
 * @returns {[number, number][]} points along the curve.
 */
function curveSamples(start, control1, control2, end) {
	// The control polygon is an upper bound on the arc length, so this never
	// under-samples a curve that swings out sideways.
	const bound = Math.hypot(control1[0] - start[0], control1[1] - start[1])
		+ Math.hypot(control2[0] - control1[0], control2[1] - control1[1])
		+ Math.hypot(end[0] - control2[0], end[1] - control2[1]);
	const steps = Math.max(24, Math.ceil(bound / 2));
	const samples = [];
	for (let step = 1; step <= steps; step += 1) {
		const t = step / steps;
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
 * @param {[number, number][][]} foreign - every other route's samples.
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
 * The nearest free spot in the gap's note rows when the note's own line has none.
 *
 * The rows are the only heights whose lines have separated, so the note keeps one
 * of them and slides sideways past whatever is already there. The row requiring
 * the smaller slide wins, and the upper row wins a tie.
 *
 * @param {{ w: number, route: object }} pill - the note being placed.
 * @param {{ top: number, bottom: number }} band - the gap's note rows, as centres.
 * @param {{ cx: number, cy: number, w: number }[]} placed - notes already placed.
 * @returns {[number, number]} the centre to try first.
 */
function fallbackSpot(pill, band, placed) {
	const rows = band.top + PILL_HEIGHT + PILL_GAP <= band.bottom ? [band.top, band.bottom] : [(band.top + band.bottom) / 2];
	const anchor = pill.route.samples[0] ?? [pill.route.x1, band.top];
	let best;
	for (const row of rows) {
		const beside = placed.filter((other) => Math.abs(other.cy - row) < PILL_HEIGHT + PILL_GAP);
		const wanted = pill.route.samples.reduce((right, point) => (Math.abs(point[1] - row) < Math.abs(right[1] - row) ? point : right), anchor)[0];
		const free = beside.reduce((right, other) => Math.max(right, other.cx + other.w / 2 + PILL_GAP + pill.w / 2), wanted);
		const slide = Math.abs(free - wanted);
		if (best === undefined || slide < best.slide) best = { spot: [free, row], slide };
	}
	return best.spot;
}

/**
 * Slide one note to the right until it touches neither a foreign line nor another
 * note. A note on its own line has a free spot in theory but not always in
 * practice — a box with more branches than its gap can annotate leaves the last
 * note with nothing — so this is the one move that always terminates and never
 * leaves the note on top of an arrow that is not its own.
 * @param {{ w: number }} pill - the note being placed.
 * @param {[number, number]} start - where it would naturally go.
 * @param {[number, number][][]} foreign - every other route's samples.
 * @param {{ cx: number, cy: number, w: number }[]} placed - notes already placed.
 * @returns {[number, number]} the first free centre at or right of `start`.
 */
function slideUntilFree(pill, start, foreign, placed) {
	const step = 6;
	const limit = 600;
	for (let offset = 0; offset <= limit; offset += step) {
		const point = [start[0] + offset, start[1]];
		if (pillFits(pill, point, foreign, placed)) return point;
	}
	return [start[0] + limit, start[1]];
}

/**
 * Place the `when` notes on the lines they belong to.
 *
 * A note is the only thing in the picture that says which way a branch goes, so
 * it has to sit on its own edge and clear of every other edge — including the
 * edges that carry no note, which a note on a sibling's line would cover just as
 * badly. Both pull against each other in a gap that holds several branches: near
 * the box they leave, all of those edges are on the same pixel. Each note is
 * therefore placed along its own line, starting from the point closest to the
 * target box — where the branches have separated — and sliding back toward the
 * source until the box fits.
 *
 * @param {{ text: string, w: number, band: number, route: object, cx: number, cy: number }[]} pills - the notes, mutated in place.
 * @param {{ top: number, bottom: number }[]} bands - each gap's note rows, as centres.
 * @param {object[]} routes - every route, for the lines a note must keep clear of.
 */
function placePills(pills, bands, routes) {
	const placed = [];
	for (const pill of pills) {
		const band = bands[pill.band] ?? { top: pill.route.y1 + V_GAP / 2, bottom: pill.route.y1 + V_GAP / 2 };
		const own = pill.route.samples;
		const foreign = routes.filter((route) => route !== pill.route).map((route) => route.samples);

		// The point closest to the target row is where the branches have spread
		// furthest apart, so it is tried first.
		const candidates = own
			.filter((point) => point[1] >= band.top && point[1] <= band.bottom)
			.sort((a, b) => b[1] - a[1]);
		let spot = candidates.find((point) => pillFits(pill, point, foreign, placed));
		if (spot === undefined) {
			// No point of its own line is clear, so the note takes one of the gap's
			// note rows and slides past the notes already there.
			spot = slideUntilFree(pill, fallbackSpot(pill, band, placed), foreign, placed);
		}
		pill.cx = spot[0];
		pill.cy = spot[1];
		placed.push(pill);
	}
}

/**
 * Break one layer's boxes into rows that fit the wrap width.
 *
 * A layer is one step of the flow, but its boxes are laid out side by side, and
 * eight of them are 1481px wide — wider than the pane the picture is read in. A
 * layer therefore wraps onto continuation rows, packed in declaration order, and
 * every continuation row is separated by a smaller gap than a real row so the
 * reader does not mistake it for the next step.
 *
 * THE ROW IS BALANCED, not filled greedily. A greedy pack of nine boxes at a
 * 860px limit is 4 + 4 + 1: a lone box on the third row, with the whole width
 * of the picture hanging off to its left. The count of rows is therefore decided
 * first (as few as the width allows, then as many as make the longest row even),
 * and the boxes are spread over exactly that many rows.
 *
 * @param {object[]} nodes - the boxes of one layer, in declaration order.
 * @param {Map<string, object>} boxes - id → measured box.
 * @param {number} limit - the widest a row may run.
 * @returns {object[][]} the rows this layer occupies.
 */
function wrapLayer(nodes, boxes, limit) {
	const widthOf = (row) => row.reduce((sum, node) => sum + boxes.get(node.id).width, 0) + H_GAP * Math.max(0, row.length - 1);

	/** Pack greedily into `count` rows, then widen the result to the average. */
	const packInto = (count) => {
		const rows = [];
		let current = [];
		let currentWidth = 0;
		// How many boxes each row should hold so the layers come out even. The
		// remainder goes to the earlier rows, which keeps the first row the full
		// one — that is the row whose arrows leave the step above.
		const target = Math.ceil(nodes.length / count);
		for (const node of nodes) {
			const boxWidth = boxes.get(node.id).width;
			const next = current.length === 0 ? boxWidth : currentWidth + H_GAP + boxWidth;
			const full = current.length > 0 && (next > limit || current.length >= target);
			if (full) {
				rows.push(current);
				current = [node];
				currentWidth = boxWidth;
				continue;
			}
			current.push(node);
			currentWidth = next;
		}
		if (current.length > 0) rows.push(current);
		return rows;
	};

	// The fewest rows that fit the limit decide the count; the split among those is
	// the one whose widest row is narrowest. Both halves matter: fewer rows is
	// shorter to read, and an even split is what keeps a layer from ending in a row
	// with one box on it and the rest of the picture empty beside it.
	let fewest = null;
	for (let candidate = 1; candidate <= nodes.length; candidate += 1) {
		const rows = packInto(candidate);
		if (rows.every((row) => widthOf(row) <= limit)) {
			fewest = rows.length;
			break;
		}
		fewest = rows.length;
	}
	let best = packInto(fewest);
	let bestWidest = Math.max(...best.map(widthOf));
	for (let candidate = 1; candidate <= nodes.length; candidate += 1) {
		const rows = packInto(candidate);
		if (rows.length !== fewest) continue;
		const widest = Math.max(...rows.map(widthOf));
		if (widest < bestWidest - 1) {
			best = rows;
			bestWidest = widest;
		}
	}
	return best;
}

/**
 * Render one validated flow chart as a standalone SVG document.
 *
 * @param {{ nodes: object[], edges: object[] }} flow - the validated flow.
 * @param {string} title - the chart title, drawn above the graph.
 * @param {{ interactive?: boolean }} [options] - `interactive` adds the drag handle
 *   the view connects arrows with. It is off by default: the picture the plugin
 *   writes to disk is a product, and a handle drawn on it would be chrome on a
 *   diagram.
 * @returns {string} the complete SVG source.
 */
export function renderFlowSvg(flow, title = '功能流程', options = {}) {
	const interactive = options.interactive === true;
	const layers = layersOf(flow);
	const backEdges = backEdgesOf(flow);

	const boxes = new Map();
	for (const node of flow.nodes) {
		const lines = wrapLabel(typeof node.label === 'string' ? node.label : '');
		// A module node stands for a whole sub-chart, so its box also carries the
		// ports its parent feeds in and takes out: the box is the one place the
		// reader sees what crosses that boundary without opening the sub-chart.
		const ports = Array.isArray(node.ports) ? node.ports.filter((port) => typeof port === 'string' && port.trim() !== '') : [];
		const widest = Math.max(
			...lines.map((line) => measure(line, LABEL_FONT)),
			...ports.map((port) => measure(port, PORT_FONT)),
			BOX_MIN_WIDTH - PAD_X * 2,
		);
		const width = Math.min(BOX_MAX_WIDTH, Math.max(BOX_MIN_WIDTH, widest + PAD_X * 2));
		const height = lines.length * LINE_HEIGHT + ports.length * PORT_LINE_HEIGHT + PAD_Y * 2;
		boxes.set(node.id, { lines, ports, width, height, isModule: node.isModule === true || ports.length > 0 });
	}

	// Layers in declaration order, then each layer wrapped into the rows it needs.
	// A visual row is the unit the rest of the file lays out, so the wrapping is
	// decided here, once, before anything is positioned.
	const layerNodes = [];
	for (const node of flow.nodes) {
		const layer = layers.get(node.id);
		if (layerNodes[layer] === undefined) layerNodes[layer] = [];
		layerNodes[layer].push(node);
	}
	/** Every visual row: `{ layer, index, nodes }`, top to bottom. */
	const visualRows = [];
	/** node id → the visual row it sits in. */
	const rowOfNode = new Map();
	/** layer → its first and last visual row index. */
	const layerRows = new Map();
	for (let layer = 0; layer < layerNodes.length; layer += 1) {
		const nodes = layerNodes[layer];
		if (nodes === undefined) continue;
		const wrapped = wrapLayer(nodes, boxes, WRAP_WIDTH);
		const first = visualRows.length;
		wrapped.forEach((row, index) => {
			visualRows.push({ layer, index, nodes: row });
			for (const node of row) rowOfNode.set(node.id, visualRows.length - 1);
		});
		layerRows.set(layer, { first, last: visualRows.length - 1 });
	}
	const rowHeight = visualRows.map((row) => Math.max(...row.nodes.map((node) => boxes.get(node.id).height)));

	// Every edge that has to leave its row sideways: a retry onto an earlier step,
	// or a forward edge that skips at least one step. Both need a channel beside
	// the boxes; a plain next-step arrow does not.
	//
	// The test is on LAYERS, not visual rows: a wrapped continuation is still the
	// same step, and an arrow from it to the next step is a normal downward arrow.
	const laned = [];
	const laneOf = new Map();
	for (const edge of flow.edges) {
		const from = layers.get(edge.from);
		const to = layers.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const isLoop = backEdges.has(`${edge.from}->${edge.to}`);
		const fromRow = rowOfNode.get(edge.from);
		const toRow = rowOfNode.get(edge.to);
		if (fromRow === undefined || toRow === undefined) continue;
		// The span that matters is over VISUAL rows, not layers: a wrapped layer
		// occupies several rows, so an arrow from the step above into its second row
		// would otherwise be drawn straight through the boxes of the first.
		if (!isLoop && toRow - fromRow <= 1) continue;
		const entry = { edge, isLoop, from, to, fromRow, toRow };
		laned.push(entry);
		laneOf.set(edge, entry);
	}

	// A retry goes round the side nearest its two ends, so the run it draws outside
	// the boxes is the short one: sending it to the far side would cross the whole
	// picture twice for no gain. A forward long edge always uses the right, which
	// keeps the "downward" reading direction on the left intact.
	const columnOf = new Map();
	for (const row of visualRows) for (const node of row.nodes) columnOf.set(node.id, { index: row.nodes.indexOf(node), total: row.nodes.length });
	for (const entry of laned) {
		if (!entry.isLoop) {
			entry.side = 'right';
			continue;
		}
		const seat = columnOf.get(entry.edge.from);
		const mid = seat === undefined ? 0.5 : (seat.index + 0.5) / seat.total;
		const target = columnOf.get(entry.edge.to);
		const targetMid = target === undefined ? 0.5 : (target.index + 0.5) / target.total;
		entry.side = (mid + targetMid) / 2 < 0.5 ? 'left' : 'right';
	}

	// How many sideways runs cross each gap. Counted before the rows are placed,
	// because the answer is what the gap's height has to hold: two runs on one
	// line read as a single arrow. A gap is identified by the visual row above it.
	const runsInGap = new Map();
	const bump = (gap) => runsInGap.set(gap, (runsInGap.get(gap) ?? 0) + 1);
	for (const entry of laned) {
		entry.outGap = entry.fromRow;
		entry.backGap = entry.toRow > 0 ? entry.toRow - 1 : -1;
		bump(entry.outGap);
		if (entry.backGap >= 0) bump(entry.backGap);
	}
	const topEntries = laned.filter((entry) => entry.backGap === -1).length;
	const topBand = topEntries === 0 ? 0 : TOP_LOOP_NEAR + RUN_STEP * (topEntries - 1) + TOP_LOOP_HEAD;

	// Half the width of each visual row. Rows are centred on one column, so a row's
	// extent is what a vertical passing beside it has to clear.
	const rowHalf = visualRows.map((row) => (row.nodes.reduce((sum, node) => sum + boxes.get(node.id).width, 0) + H_GAP * (row.nodes.length - 1)) / 2);
	const halfWidth = Math.max(...rowHalf, 0);

	/**
	 * One lane per row a route returns to: every route pointing back at the same
	 * row shares its vertical, so three retries onto one step read as one bus
	 * instead of three parallel detours. A lane is only as far out as the widest
	 * row it has to pass: a retry into the middle of a tall picture hugs the boxes
	 * instead of being pushed to the margin the whole diagram needs.
	 * @param {object[]} list - the routes on one side.
	 * @returns {object[]} the lanes, innermost first.
	 */
	function lanesFor(list) {
		const groups = new Map();
		for (const entry of list) {
			const key = `${entry.toRow}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(entry);
		}
		const lanes = [];
		for (const [key, entries] of groups) {
			// The lane has to clear every row the vertical passes, and the vertical
			// runs between the two ends of each route — which for a forward long edge
			// is a downward span, not an upward one.
			let highest = 0;
			let lowest = 0;
			for (const entry of entries) {
				highest = Math.max(highest, entry.fromRow, entry.toRow);
				lowest = lowest === 0 ? Math.min(entry.fromRow, entry.toRow) : Math.min(lowest, entry.fromRow, entry.toRow);
			}
			let half = 0;
			for (let row = lowest; row <= highest; row += 1) half = Math.max(half, rowHalf[row] ?? 0);
			lanes.push({ key, entries, to: Math.min(...entries.map((entry) => entry.toRow)), from: highest, half, span: highest - lowest });
		}
		// A lane whose vertical covers a shorter stretch sits inside one that covers
		// a longer stretch: nesting them this way means no two verticals swap order
		// and no horizontal has to cut through one.
		lanes.sort((a, b) => (a.span - b.span) || (a.to - b.to));
		return lanes;
	}

	const leftLanes = lanesFor(laned.filter((entry) => entry.side === 'left'));
	const rightLanes = lanesFor(laned.filter((entry) => entry.side === 'right'));

	// Lane positions are worked out in a frame whose origin is the column the rows
	// are centred on; the drawing offset is added once the canvas is known.
	let minX = -halfWidth;
	let maxX = halfWidth;
	leftLanes.forEach((lane, index) => {
		lane.offset = -lane.half - LANE_GAP - LANE_STEP * index;
		minX = Math.min(minX, lane.offset);
	});
	rightLanes.forEach((lane, index) => {
		lane.offset = lane.half + LANE_GAP + LANE_STEP * index;
		maxX = Math.max(maxX, lane.offset);
	});

	// The picture is as wide as what it has to hold: the rows, the lanes beside
	// them, and the title, whichever is widest.
	let width = maxX - minX + MARGIN * 2;
	const titleWidth = measure(title, TITLE_FONT) + MARGIN * 2;
	if (titleWidth > width) {
		const extra = (titleWidth - width) / 2;
		minX -= extra;
		maxX += extra;
		width = titleWidth;
	}
	const columnX = MARGIN - minX;

	// Vertical placement. A continuation row of the same layer is closer to its
	// sibling than to the next step: the reader has to see that those boxes are one
	// step, not two.
	const rowTops = [];
	const rowBottoms = [];
	let y = MARGIN + TITLE_BAND + topBand;
	for (let index = 0; index < visualRows.length; index += 1) {
		const row = visualRows[index];
		rowTops[index] = y;
		rowBottoms[index] = y + rowHeight[index];
		const gapRuns = runsInGap.get(index) ?? 0;
		// The gap depends on the row BELOW it: when that row continues this layer,
		// the two are one step and sit close together; otherwise the next row starts
		// a new step and takes the full gap.
		const continues = (visualRows[index + 1]?.index ?? -1) > 0;
		y += rowHeight[index] + gapHeight(gapRuns, continues ? WRAP_GAP : V_GAP);
	}

	// Rows are centred on the column, so a lane never touches a box.
	const centres = new Map();
	visualRows.forEach((row, index) => {
		const rowWidth = row.nodes.reduce((sum, node) => sum + boxes.get(node.id).width, 0) + H_GAP * (row.nodes.length - 1);
		let x = columnX - rowWidth / 2;
		for (const node of row.nodes) {
			const box = boxes.get(node.id);
			centres.set(node.id, { x: x + box.width / 2, top: rowTops[index], width: box.width, height: box.height, row: index });
			x += box.width + H_GAP;
		}
	});

	// Routes are resolved before the canvas is fixed: a lane, a run's height and a
	// note's place all move the picture's width.
	const routes = [];
	const pills = [];
	for (const edge of flow.edges) {
		const from = centres.get(edge.from);
		const to = centres.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const lane = laneOf.get(edge);
		const isLoop = lane?.isLoop === true;
		const span = isLoop ? -1 : to.row - from.row;
		const route = {
			edge,
			x1: from.x,
			y1: from.top + from.height,
			x2: to.x,
			y2: to.top,
			span,
			isLoop,
			fromRow: from.row,
			toRow: to.row,
			x1Right: from.x + from.width / 2,
			x1Left: from.x - from.width / 2,
			x2Right: to.x + to.width / 2,
			x2Left: to.x - to.width / 2,
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
				band: from.row,
				route,
			};
			pills.push(route.pill);
		}
	}

	// A route that leaves its row has to run sideways through a gap between rows,
	// and that gap is already occupied by the notes of the edges that branch just
	// above it. Runs are therefore allocated per gap: each one takes its own
	// height below the gap's top edge, and the gap was sized for that count.
	//
	// A hop that skips rows also cannot run down the column its two ends share:
	// every row in between draws a box on top of that column. It leaves its own
	// box, runs along the gap below it to a lane beside the diagram, goes down that
	// lane, and comes back in above the target row — so it never crosses a box.
	//
	// Both ends of such a route run sideways through a gap and both need a slot, so
	// one counter serves both passes: two runs in the same gap must not land on the
	// same line.
	const runsUsed = new Map();
	const takeRun = (gap) => {
		const index = runsUsed.get(gap) ?? 0;
		runsUsed.set(gap, index + 1);
		const top = rowBottoms[gap] ?? rowTops[gap] + V_GAP;
		return top + RUN_BASE + RUN_STEP * index;
	};
	let topUsed = 0;
	const takeTopEntry = () => {
		const offset = TOP_LOOP_NEAR + RUN_STEP * topUsed;
		topUsed += 1;
		return rowTops[0] - offset;
	};

	// Lanes are placed from the column outwards; the drawing offset turns their
	// frame into canvas coordinates. Routes sharing a lane share the vertical.
	const laneOfEntry = new Map();
	for (const lane of [...leftLanes, ...rightLanes]) {
		for (const entry of lane.entries) laneOfEntry.set(entry, lane);
	}
	const laneX = (lane) => columnX + lane.offset;
	// Outs are taken in lane order so the innermost run also takes the upper
	// slot; doing it in edge order would let a wide route claim the narrow one's
	// height.
	//
	// Routes that leave the SAME row and come back at the SAME row share one
	// sideways run. Nine siblings fanning out of one box would otherwise draw nine
	// parallel horizontals through the gap, which reads as a hatch rather than as
	// a fan; sharing the run turns them into one line that splits downstream.
	const runsShared = new Map();
	const runFor = (gap, key) => {
		const bucket = `${gap}:${key}`;
		if (!runsShared.has(bucket)) runsShared.set(bucket, takeRun(gap));
		return runsShared.get(bucket);
	};
	const byLane = [...leftLanes, ...rightLanes].sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
	for (const lane of byLane) {
		// Keyed by the row the routes LEAVE, not the row they arrive at. A box that
		// fans out to two wrapped rows leaves once; keying by target drew one busbar
		// per destination, stacked in the same gap, which is the hatch this rule is
		// meant to remove. Where they split is on the way back in, and that is keyed
		// by the row they arrive at.
		for (const entry of lane.entries) entry.out = runFor(entry.outGap, `o${entry.fromRow}`);
	}
	for (const lane of byLane) {
		for (const entry of lane.entries) {
			entry.back = entry.backGap === -1 ? takeTopEntry() : runFor(entry.backGap, `b${entry.toRow}`);
		}
	}

	const paths = [];
	for (const route of routes) {
		const { x1, y1, x2, y2, span } = route;
		const entry = laneOf.get(route.edge);
		const lane = entry === undefined ? undefined : laneOfEntry.get(entry);
		if (route.isLoop && entry !== undefined && lane !== undefined) {
			// A retry leaves its own box, crosses the gap below it under the notes,
			// runs out to a lane beside the diagram, climbs the lane, comes back in
			// through the gap above the target row, and only then turns into the
			// target's side. Entering from the side keeps the arrow tip out of the
			// column the downward arrows use.
			const onLeft = entry.side === 'left';
			const exitX = onLeft ? route.x1Left + LOOP_EXIT_INSET : route.x1Right - LOOP_EXIT_INSET;
			const enterX = onLeft ? route.x2Left - 7 : route.x2Right + 7;
			const tipX = onLeft ? route.x2Left - 4 : route.x2Right + 4;
			route.d =
				`M ${exitX} ${y1} L ${exitX} ${entry.out} L ${laneX(lane)} ${entry.out} `
				+ `L ${laneX(lane)} ${entry.back} L ${enterX} ${entry.back} `
				+ `L ${enterX} ${route.y2Mid} L ${tipX} ${route.y2Mid}`;
			route.samples = segmentSamples([
				[exitX, y1], [exitX, entry.out], [laneX(lane), entry.out],
				[laneX(lane), entry.back], [enterX, entry.back],
				[enterX, route.y2Mid], [tipX, route.y2Mid],
			]);
		} else if (span > 1 && entry !== undefined && lane !== undefined) {
			route.d = `M ${x1} ${y1} L ${x1} ${entry.out} L ${laneX(lane)} ${entry.out} L ${laneX(lane)} ${entry.back} L ${x2} ${entry.back} L ${x2} ${y2}`;
			route.samples = segmentSamples([
				[x1, y1], [x1, entry.out], [laneX(lane), entry.out],
				[laneX(lane), entry.back], [x2, entry.back], [x2, y2],
			]);
		} else {
			// A plain downward arrow: straight when the boxes line up, a smooth
			// curve when they do not. The curve stays inside the gap between the two
			// rows, so it never runs through a box.
			const mid = (y1 + y2) / 2;
			if (Math.abs(x1 - x2) < 0.5) {
				route.d = `M ${x1} ${y1} L ${x2} ${y2}`;
				route.samples = segmentSamples([[x1, y1], [x2, y2]]);
			} else {
				route.d = `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
				route.samples = curveSamples([x1, y1], [x1, mid], [x2, mid], [x2, y2]);
			}
		}
		paths.push(route.d);
	}

	// The note rows of each gap: the top slice, above every run, so a label is
	// never read across an arrow that is not its own.
	const bands = rowBottoms.map((bottom) => ({
		top: bottom + PILL_HEIGHT / 2 + 5,
		bottom: bottom + PILL_ZONE - PILL_HEIGHT / 2 - 3,
	}));
	placePills(pills, bands, routes);

	// The canvas is grown to what was drawn, never the other way round: a note
	// pushed sideways sits past the boxes and a retry out of the last row runs
	// below it, so both extend the picture instead of being cut off by it.
	let pictureWidth = width;
	let pictureHeight = MARGIN;
	for (const bottom of rowBottoms) if (bottom !== undefined) pictureHeight = Math.max(pictureHeight, bottom + BOTTOM_SPACE);
	for (const route of routes) {
		for (const [x, pointY] of route.samples) {
			pictureWidth = Math.max(pictureWidth, x + MARGIN);
			pictureHeight = Math.max(pictureHeight, pointY + MARGIN);
		}
	}
	for (const pill of pills) {
		const left = pill.cx - pill.w / 2;
		if (left < MARGIN) pill.cx = MARGIN + pill.w / 2;
		pictureWidth = Math.max(pictureWidth, pill.cx + pill.w / 2 + MARGIN);
		pictureHeight = Math.max(pictureHeight, pill.cy + PILL_HEIGHT / 2 + MARGIN);
	}

	const parts = [];
	const svgWidth = Math.ceil(pictureWidth);
	const svgHeight = Math.ceil(pictureHeight);
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" `
			+ `viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="${escapeXml(title)}">`,
		'<defs>',
		`<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
			+ `<path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR_EDGE}"/></marker>`,
		'</defs>',
		`<rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="${COLOR_BG}"/>`,
		`<text x="${MARGIN}" y="${MARGIN + 18}" font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" `
			+ `font-size="${TITLE_FONT}" font-weight="600" fill="${COLOR_TEXT}">${escapeXml(title)}</text>`,
	);

	// Edges first, so a box always covers the line that would run into it. Every
	// edge and every box carries the id it stands for: the view uses them to turn
	// a click on the picture into a selection in the editor.
	routes.forEach((route, index) => {
		const edge = route.edge;
		parts.push(
			`<path d="${paths[index]}" fill="none" stroke="${COLOR_EDGE}" stroke-width="1.4" marker-end="url(#arrow)" `
				+ `data-edge="${edge.from}-&gt;${edge.to}" data-from="${escapeXml(edge.from)}" data-to="${escapeXml(edge.to)}"/>`,
		);
	});
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
		if (centre === undefined) continue;
		const left = centre.x - box.width / 2;
		parts.push(
		// The anchors are emitted as data, not recomputed in the view: the view must
		// not re-derive geometry the renderer already decided, or the two drift the
		// first time the layout changes. `data-in` is the top-centre point an arrow
		// arrives at, `data-out` the bottom-centre one it leaves from.
			`<g data-node="${escapeXml(node.id)}" data-layer="${layers.get(node.id) ?? 0}" data-row="${centre.row}" `
				+ `data-x="${centre.x.toFixed(1)}" data-y="${centre.top.toFixed(1)}" `
				+ `data-w="${centre.width.toFixed(1)}" data-h="${centre.height.toFixed(1)}" `
				+ `data-in="${centre.x.toFixed(1)},${centre.top.toFixed(1)}" `
				+ `data-out="${centre.x.toFixed(1)},${(centre.top + centre.height).toFixed(1)}">`,
			`<rect x="${left.toFixed(1)}" y="${centre.top}" width="${box.width.toFixed(1)}" height="${box.height}" rx="9" `
				+ `fill="${COLOR_BOX}" stroke="${COLOR_BOX_BORDER}" stroke-width="1.1"/>`,
		);
		// A module box is a container, not a step: the second outline says so
		// before the reader parses the ports.
		if (box.isModule) {
			parts.push(
				`<rect x="${(left + 3).toFixed(1)}" y="${(centre.top + 3).toFixed(1)}" `
					+ `width="${(box.width - 6).toFixed(1)}" height="${(box.height - 6).toFixed(1)}" rx="7" `
					+ `fill="none" stroke="${COLOR_BOX_BORDER}" stroke-width="0.7"/>`,
			);
		}
		box.lines.forEach((line, index) => {
			const baseline = centre.top + PAD_Y + LINE_HEIGHT * index + LABEL_FONT - 1;
			parts.push(
				`<text x="${centre.x.toFixed(1)}" y="${baseline.toFixed(1)}" text-anchor="middle" `
					+ `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" `
					+ `font-size="${LABEL_FONT}" fill="${COLOR_TEXT}">${escapeXml(line)}</text>`,
			);
		});
		box.ports.forEach((port, index) => {
			const baseline = centre.top + PAD_Y + LINE_HEIGHT * box.lines.length + PORT_LINE_HEIGHT * index + PORT_FONT;
			parts.push(
				`<text x="${centre.x.toFixed(1)}" y="${baseline.toFixed(1)}" text-anchor="middle" `
					+ `font-family="-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" `
					+ `font-size="${PORT_FONT}" fill="${COLOR_MUTED}">${escapeXml(port)}</text>`,
			);
		});
		// The connect handle sits on the box's right edge. It is drawn only for the
		// view, and only as a drag affordance: the same gesture is available from
		// the editor form, which is what a keyboard or a screen reader uses.
		if (interactive) {
			parts.push(
				`<circle data-handle="${escapeXml(node.id)}" cx="${(left + box.width + 9).toFixed(1)}" `
					+ `cy="${(centre.top + box.height / 2).toFixed(1)}" r="6" `
					+ `fill="${COLOR_BG}" stroke="${COLOR_BOX_BORDER}" stroke-width="1.2" style="cursor:crosshair"/>`,
			);
		}
		parts.push('</g>');
	}

	parts.push('</svg>');
	return `${parts.join('\n')}\n`;
}
