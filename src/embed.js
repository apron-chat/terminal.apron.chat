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
	/** @type {number | undefined} */
	let frame;
	// Measured in the next frame, after the screen has hidden the rows not written (src/screen.js), so the parent
	// isn't first told the height of all 40.
	const schedule = () => {
		frame ??= requestAnimationFrame(() => {
			frame = undefined;
			const height = Math.ceil(element.getBoundingClientRect().height);
			if (height === last) return;
			last = height;
			post({ type: HEIGHT, height });
		});
	};
	const observer = new ResizeObserver(schedule);
	observer.observe(element);
	return () => {
		observer.disconnect();
		if (frame !== undefined) cancelAnimationFrame(frame);
	};
}

/**
 * Tells `changed` when `element` goes out of sight and comes back: false once
 * it has been out of sight for `outMs` (its tab hidden, or, in a frame, the
 * frame scrolled out of the chat's view), true as soon as it is back. Until
 * the function returned is called.
 * @param {Element} element
 * @param {(inSight: boolean) => void} changed
 * @param {number} outMs
 */
export function watchSight(element, changed, outMs) {
	let inView = true;
	let visible = document.visibilityState !== 'hidden';
	/** What `changed` was last told. */
	let told = true;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	const update = () => {
		clearTimeout(timer);
		if (inView && visible) {
			if (!told) changed((told = true));
		} else if (told) {
			timer = setTimeout(() => changed((told = false)), outMs);
		}
	};
	// The viewport of the top-level page, from inside a frame too: a frame in a chat scrolled out of view isn't in sight.
	const observer = typeof IntersectionObserver === 'function'
		? new IntersectionObserver((entries) => {
			inView = entries.some((entry) => entry.isIntersecting);
			update();
		})
		: undefined;
	observer?.observe(element);
	const onVisibility = () => {
		visible = document.visibilityState !== 'hidden';
		update();
	};
	document.addEventListener('visibilitychange', onVisibility);
	return () => {
		clearTimeout(timer);
		observer?.disconnect();
		document.removeEventListener('visibilitychange', onVisibility);
	};
}
