// @ts-check
/**
 * The page in an iframe, such as in a chat message of a client that doesn't
 * draw terminals itself: what it tells the page around it, and what it
 * takes from it, with `postMessage`. README.md (Embedding) documents it for
 * clients.
 *
 * To the parent:
 * - `{ type: 'apron-terminal:ready' }` once it listens, so a finished
 *   `output` sent before it loaded isn't lost: send it (again) on this.
 * - `{ type: 'apron-terminal:height', height }` whenever the height its
 *   content needs, in CSS pixels, changes: the iframe's height, to fit it.
 *
 * From the parent:
 * - `{ type: 'apron-terminal:output', output }`: the embed's `output`, once a
 *   snapshot carries it (§4.8.6). It stops reading the stream and shows this
 *   from a fresh terminal, as the client's own screen would.
 *
 * Only the frame's parent is heard, from any origin: that is whoever chose
 * to show it. Nothing it sends is secret: no address, no output.
 */
import { keepLast, OUTPUT_KEEP } from './screen.js';

export const READY = 'apron-terminal:ready';
export const HEIGHT = 'apron-terminal:height';
export const OUTPUT = 'apron-terminal:output';

/**
 * Whether the page is in a frame.
 * @param {Window} win
 */
export function isFramed(win) {
	try {
		return win.self !== win.top;
	} catch {
		// A browser that won't even compare them is a frame's.
		return true;
	}
}

/**
 * The finished output a message from the parent carries, cut to what the
 * page shows (`OUTPUT_KEEP`), or undefined for any other message.
 * @param {unknown} data
 * @returns {string | undefined}
 */
export function outputOf(data) {
	if (typeof data !== 'object' || data === null) return undefined;
	const message = /** @type {{ type?: unknown, output?: unknown }} */ (data);
	if (message.type !== OUTPUT || typeof message.output !== 'string') return undefined;
	return keepLast(message.output, OUTPUT_KEEP);
}

/**
 * Tells the parent the height `element` needs whenever it changes, until the
 * function returned is called.
 * @param {HTMLElement} element
 * @param {(message: { type: string, height: number }) => void} post
 */
export function reportHeight(element, post) {
	let last = -1;
	const report = () => {
		const height = Math.ceil(element.getBoundingClientRect().height);
		if (height === last) return;
		last = height;
		post({ type: HEIGHT, height });
	};
	const observer = new ResizeObserver(report);
	observer.observe(element);
	report();
	return () => observer.disconnect();
}
