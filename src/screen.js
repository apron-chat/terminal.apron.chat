// @ts-check
/**
 * The terminal screen, as apron-web draws a terminal embed
 * (src/lib/ui/terminal-screen.ts): xterm.js, 80 columns by 40 rows
 * (PROTOCOL.md §4.8.6). It only reads: no input, and nothing a program prints
 * acts outside it. It never sends xterm's replies anywhere, ignores title
 * changes, the bell and the clipboard (OSC 52), and opens no links (OSC 8).
 * The font is scaled so the 80 columns fit the space it has (`TerminalFit`).
 * Rows below the last one written are hidden, unless a program is using the
 * alternate screen.
 *
 * Two fits, as in apron-web: the full page is its full-screen viewer
 * (`VIEWER_FIT`, with `SCROLLBACK` lines to scroll back through); a frame in
 * a chat message is its screen in a message (`INLINE_FIT`, no scrollback: a
 * wheel or swipe over it scrolls the page around it).
 *
 * This module doesn't load xterm.js: the page passes its `Terminal` in, so
 * the functions here run in tests without a browser.
 */

/** @typedef {import('@xterm/xterm').Terminal} Terminal */
/** @typedef {typeof import('@xterm/xterm').Terminal} TerminalClass */
/** @typedef {import('@xterm/xterm').ITheme} ITheme */
/** @typedef {import('@xterm/xterm').IBuffer} IBuffer */
/** @typedef {import('@xterm/xterm').ITerminalOptions & import('@xterm/xterm').ITerminalInitOnlyOptions} TerminalOptions */

export const TERMINAL_COLS = 80;
export const TERMINAL_ROWS = 40;

/**
 * A screen's size: a terminal embed's is 80 by 40 (§4.8.6); a recording
 * opened from asciinema has its own (src/formats.js).
 * @typedef {{ cols: number, rows: number }} TerminalSize
 */

/** A terminal embed's size. */
export const EMBED_SIZE = /** @type {TerminalSize} */ ({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS });

/**
 * How a screen's font fits its space: between `min` and `max`, its 80
 * columns in the width, and with `rows` its 40 rows in the height too, down
 * to that size (a shorter space keeps it and scrolls).
 * @typedef {{ min: number, max: number, rows?: number }} TerminalFit
 */

/** In a message: the columns in the width, small as that is on a phone (the page never scrolls sideways). */
export const INLINE_FIT = /** @type {TerminalFit} */ ({ min: 4, max: 13 });
/** Full page: 80 by 40, as large as fits, but never too small to read; a narrower space scrolls sideways. */
export const VIEWER_FIT = /** @type {TerminalFit} */ ({ min: 9, max: 24, rows: 13 });

/** The lines that scroll off the top the full page keeps, to scroll back through: some 5 MB of xterm's buffer at most. */
export const SCROLLBACK = 5000;

/**
 * How much of a finished output the page shows, in UTF-16 code units: about
 * 256 KiB, more than servers keep of a terminal's output (64 KiB on
 * apron-server-go), as apron-web's `TERMINAL_FEED_KEEP`.
 */
export const OUTPUT_KEEP = 256 * 1024;

/**
 * The last `limit` code units of `text`, cut as the server cuts a terminal's
 * output (`keep_last`, §4.8.6): from its first control character (below
 * U+0020), or, with none, from its first whole character.
 * @param {string} text
 * @param {number} limit
 */
export function keepLast(text, limit) {
	if (text.length <= limit) return text;
	const tail = text.slice(-limit);
	for (let i = 0; i < tail.length; i++) if (tail.charCodeAt(i) < 0x20) return tail.slice(i);
	const first = tail.charCodeAt(0);
	return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/**
 * The options that decide what the screen holds, as opposed to how it looks:
 * the size, line feeds, and the lines it keeps above the screen. The tests
 * replay shazow/apron's terminal fixtures through a headless xterm made with
 * these (test/fixtures.test.mjs).
 * @param {number} [scrollback]
 * @param {TerminalSize} [size]
 */
export function behaviorOptions(scrollback = 0, { cols, rows } = EMBED_SIZE) {
	return {
		cols,
		rows,
		// A line feed also returns to the first column (§4.8.6): output piped without a pseudo-terminal ends lines with
		// a bare line feed, which a terminal's driver would turn into CR LF.
		convertEol: true,
		scrollback,
		// No window manipulation or reports (the default, stated).
		windowOptions: {}
	};
}

/**
 * Swallows the control functions that would act outside the screen (§4.8.6):
 * window titles (OSC 0, 1, 2) and the clipboard (OSC 52). They are parsed and
 * dropped, never shown or performed.
 * @param {Pick<Terminal, 'parser'>} terminal
 */
export function swallowOutsideControls(terminal) {
	for (const osc of [0, 1, 2, 52]) terminal.parser.registerOscHandler(osc, () => true);
}

/**
 * The options its xterm is made with; `scrollback`, the lines it keeps above the screen.
 * @param {ITheme} theme
 * @param {string} fontFamily
 * @param {number} fontSize
 * @param {number} [scrollback]
 * @param {TerminalSize} [size]
 * @returns {TerminalOptions}
 */
export function terminalOptions(theme, fontFamily, fontSize, scrollback = 0, size = EMBED_SIZE) {
	return {
		...behaviorOptions(scrollback, size),
		// Read-only: nothing typed reaches it, and no cursor of its own blinks.
		disableStdin: true,
		cursorBlink: false,
		cursorStyle: 'block',
		cursorInactiveStyle: 'none',
		// OSC 8 links are shown, never opened.
		linkHandler: { activate: () => {}, allowNonHttpProtocols: false },
		fontFamily,
		fontSize,
		lineHeight: 1,
		theme
	};
}

/**
 * The theme from the design tokens of the page around `element`, so the
 * terminal follows light and dark.
 * @param {Element} element
 * @returns {ITheme}
 */
export function terminalTheme(element) {
	const style = getComputedStyle(element);
	const token = (/** @type {string} */ name, /** @type {string} */ fallback) => style.getPropertyValue(name).trim() || fallback;
	const ink = token('--ink', '#ece9e4');
	const muted = token('--ink-muted', '#a8a6b2');
	const red = token('--danger', '#ff6f86');
	const green = token('--ok', '#62c287');
	const yellow = token('--warn', '#d6b24c');
	const blue = token('--denim', '#8fb0f5');
	const magenta = token('--term-magenta', '#d99be8');
	const cyan = token('--term-cyan', '#6cc9d1');
	return {
		background: token('--bg-rail', '#0b0b12'),
		foreground: ink,
		// A program's cursor is where it would write next: nothing to show a reader.
		cursor: 'rgba(0, 0, 0, 0)',
		cursorAccent: 'rgba(0, 0, 0, 0)',
		selectionBackground: token('--denim-soft', '#1e2b48'),
		selectionForeground: ink,
		black: token('--line-strong', '#6d6d80'),
		red, green, yellow, blue, magenta, cyan,
		white: ink,
		brightBlack: muted,
		brightRed: red, brightGreen: green, brightYellow: yellow, brightBlue: blue, brightMagenta: magenta, brightCyan: cyan,
		brightWhite: ink
	};
}

/**
 * The size that fits the columns in `width` pixels (and, for a fit with
 * `rows`, the rows in `height`, down to that size), in quarter pixels,
 * between the fit's smallest and largest. `ratio` is the face's advance and
 * `line` its row height, per pixel of size.
 * @param {number} width
 * @param {number} ratio
 * @param {TerminalFit} [fit]
 * @param {number} [height]
 * @param {number} [line]
 * @param {TerminalSize} [terminal] the screen's columns and rows, 80 by 40 unless said
 */
export function terminalFontSize(width, ratio, fit = INLINE_FIT, height = Infinity, line = 1.2, { cols, rows } = EMBED_SIZE) {
	let size = width / (cols * ratio);
	if (fit.rows !== undefined) size = Math.min(size, Math.max(fit.rows, height / (rows * line)));
	return Math.max(fit.min, Math.min(fit.max, Math.floor(size * 4) / 4));
}

/**
 * The rows to show: all of them on the alternate screen or once lines have
 * scrolled off, else down to the last one written, at least one.
 * @param {IBuffer} buffer
 * @param {number} [rows] the screen's rows, 40 unless said
 */
export function shownRows(buffer, rows = TERMINAL_ROWS) {
	if (buffer.type === 'alternate' || buffer.baseY > 0) return rows;
	for (let y = rows - 1; y > 0; y--) {
		const line = buffer.getLine(y);
		if (!line) continue;
		if (line.translateToString(true).trim()) return y + 1;
		// A row of colored blanks, such as a bar, is written too.
		for (let x = 0; x < line.length; x++) if (!line.getCell(x)?.isBgDefault()) return y + 1;
	}
	return 1;
}

/** Full reset (RIS): the initial state of a terminal. */
const RESET = '\u001bc';

/** Pointer gestures that scroll: without scrollback, the page's, never the terminal's, which has nothing to scroll. */
const SCROLLS = /** @type {const} */ (['wheel', 'touchstart', 'touchmove']);

/** The keys that scroll, in lines (a page is the rows in view less one; ±Infinity, all the way). */
/** @type {Record<string, number | 'page'>} */
const SCROLL_KEYS = { ArrowUp: -1, ArrowDown: 1, PageUp: 'page', PageDown: 'page', Home: -Infinity, End: Infinity };

/** A face's advance width and line height per pixel of size, measured on the page. */
function faceRatios(/** @type {HTMLElement} */ host, /** @type {string} */ fontFamily) {
	const probe = document.createElement('span');
	probe.textContent = 'W'.repeat(40);
	probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${fontFamily};font-size:100px;line-height:normal`;
	host.append(probe);
	const { width, height } = probe.getBoundingClientRect();
	probe.remove();
	return { advance: width > 0 ? width / 40 / 100 : 0.6, line: height > 0 ? height / 100 : 1.2 };
}

/**
 * How a `TerminalScreen` is made.
 * @typedef {object} TerminalScreenOptions
 * @property {HTMLElement} [space] the box whose content area is the space to fit; the host unless said
 * @property {TerminalFit} [fit] how its font fits; INLINE_FIT unless said
 * @property {number} [scrollback] the lines it keeps that scroll off the top, 0 unless said. With some, a wheel, a
 *   vertical swipe or a key (on `keys`) over the space scrolls through them and the screen as one (`scrollBy`).
 * @property {HTMLElement | Document} [keys] where its scrolling keys are read, with scrollback
 * @property {TerminalSize} [size] its columns and rows, 80 by 40 unless said
 */

export class TerminalScreen {
	/** @type {HTMLElement} */ #host;
	/** @type {HTMLElement} */ #space;
	/** @type {HTMLElement | Document | undefined} */ #keys;
	/** @type {TerminalFit} */ #fitting;
	/** @type {TerminalSize} */ #size;
	/** @type {number} */ #scrollback;
	/** @type {Terminal} */ #terminal;
	/** @type {number | undefined} */ #frame;
	/** @type {ResizeObserver | undefined} */ #observer;
	/** @type {() => void} */ #unwatchTheme;
	#ratio = 0.6;
	#line = 1.2;
	/** A scroll too small to move a line yet, in pixels, kept until the next in the same direction. */
	#owed = 0;
	/** @type {number | undefined} Where a one-finger swipe last was. */
	#touchY;
	/** With scrollback, whether the space is scrolled to the screen's foot, where the newest line is: it stays there. */
	#atFoot = true;
	#disposed = false;
	#keep = (/** @type {Event} */ event) => event.stopPropagation();

	/**
	 * Mounts a terminal in `host`, a box the page sizes, fitted to `options.space`.
	 * @param {TerminalClass} Terminal
	 * @param {HTMLElement} host
	 * @param {TerminalScreenOptions} [options]
	 */
	constructor(Terminal, host, { space = host, fit = INLINE_FIT, scrollback = 0, keys, size = EMBED_SIZE } = {}) {
		this.#host = host;
		this.#size = size;
		this.#space = space;
		this.#fitting = fit;
		this.#scrollback = scrollback;
		this.#keys = keys;
		const fontFamily = getComputedStyle(host).getPropertyValue('--font-mono').trim() || 'monospace';
		({ advance: this.#ratio, line: this.#line } = faceRatios(host, fontFamily));
		const room = this.#room();
		const terminal = new Terminal(terminalOptions(terminalTheme(host), fontFamily, terminalFontSize(room.width, this.#ratio, fit, room.height, this.#line, size), scrollback, size));
		swallowOutsideControls(terminal);
		// No key is xterm's once a click has focused it: the arrows and Page Up reach the page, and copying is the browser's.
		terminal.attachCustomKeyEventHandler(() => false);
		const screen = document.createElement('div');
		host.append(screen);
		terminal.open(screen);
		// Not a stop on the way through the page: nothing can be typed into it.
		if (terminal.textarea) {
			terminal.textarea.tabIndex = -1;
			terminal.textarea.setAttribute('aria-hidden', 'true');
		}
		terminal.onWriteParsed(() => this.#schedule());
		terminal.buffer.onBufferChange(() => this.#schedule());
		this.#terminal = terminal;

		if (scrollback > 0) {
			// One scroll for the lines kept and the space (`scrollBy`), read before xterm's own. Sideways is the space's.
			space.addEventListener('wheel', this.#wheel, { capture: true, passive: false });
			space.addEventListener('touchstart', this.#touchstart, { capture: true, passive: true });
			space.addEventListener('touchmove', this.#touchmove, { capture: true, passive: true });
			space.addEventListener('scroll', this.#scrolled, { passive: true });
			space.style.touchAction = 'pan-x pinch-zoom';
			keys?.addEventListener('keydown', /** @type {EventListener} */ (this.#keydown));
		} else for (const type of SCROLLS) host.addEventListener(type, this.#keep, { capture: true, passive: true });
		if (typeof ResizeObserver === 'function') {
			this.#observer = new ResizeObserver(() => this.#fit());
			this.#observer.observe(space);
		}
		this.#unwatchTheme = watchTheme(() => {
			terminal.options.theme = terminalTheme(host);
		});
		this.#fit();
	}

	/** A fresh terminal: the initial state, default colors and attributes, nothing on screen or kept above it. */
	reset() {
		if (this.#disposed) return;
		// RIS (ESC c), in the same queue as the writes before and after it: xterm parses what it is given later.
		this.#terminal.write(RESET);
		this.#atFoot = true;
	}

	/**
	 * Writes output as it arrives: decoded text.
	 * @param {string} text
	 */
	write(text) {
		if (!this.#disposed && text) this.#terminal.write(text);
	}

	/**
	 * Shows `output` from a fresh terminal, such as a finished embed's.
	 * @param {string} output
	 */
	show(output) {
		this.reset();
		this.write(output);
	}

	/** The text on the screen and the lines kept above it, as plain text, for Copy. */
	text() {
		const buffer = this.#terminal.buffer.active;
		const lines = [];
		for (let y = 0; y < buffer.length; y++) {
			const line = buffer.getLine(y);
			if (!line) continue;
			const text = line.translateToString(true);
			if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		while (lines.length && !lines[lines.length - 1]) lines.pop();
		return lines.join('\n');
	}

	/**
	 * Scrolls by `pixels` (down if positive) through all there is to see as
	 * one: the lines kept above the screen, then the screen, which its space
	 * scrolls where the 40 rows are taller than it. Back, the space stays at
	 * the screen's foot until there are no more lines above; forward, it
	 * reaches the foot first. Lines move whole, a part of one owed to the next
	 * scroll the same way.
	 * @param {number} pixels
	 */
	scrollBy(pixels) {
		const terminal = this.#terminal;
		const row = this.#rowHeight();
		if (this.#disposed || !row || !pixels) return;
		if (Math.sign(pixels) !== Math.sign(this.#owed)) this.#owed = 0;
		this.#owed += pixels;
		const space = this.#space;
		const { viewportY, baseY } = terminal.buffer.active;
		if (this.#owed < 0) {
			const lines = Math.min(viewportY, Math.floor(-this.#owed / row));
			if (lines) terminal.scrollLines(-lines);
			this.#owed += lines * row;
			if (lines < viewportY) return;
			space.scrollTop = Math.max(0, space.scrollTop + this.#owed);
		} else {
			const room = Math.max(0, space.scrollHeight - space.clientHeight - space.scrollTop);
			const stage = Math.min(room, this.#owed);
			if (stage > 0) space.scrollTop += stage;
			this.#owed -= stage;
			const below = baseY - viewportY;
			const lines = Math.min(below, Math.floor(this.#owed / row));
			if (lines) terminal.scrollLines(lines);
			this.#owed -= lines * row;
			if (lines < below) return;
		}
		this.#owed = 0;
	}

	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		const space = this.#space;
		for (const type of SCROLLS) this.#host.removeEventListener(type, this.#keep, { capture: true });
		space.removeEventListener('wheel', this.#wheel, { capture: true });
		space.removeEventListener('touchstart', this.#touchstart, { capture: true });
		space.removeEventListener('touchmove', this.#touchmove, { capture: true });
		space.removeEventListener('scroll', this.#scrolled);
		if (this.#scrollback > 0) space.style.touchAction = '';
		this.#keys?.removeEventListener('keydown', /** @type {EventListener} */ (this.#keydown));
		this.#observer?.disconnect();
		this.#unwatchTheme();
		if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
		this.#terminal.dispose();
	}

	/** The space to fit: the content area of the space box. */
	#room() {
		const space = this.#space;
		const style = getComputedStyle(space);
		const padding = (/** @type {string} */ a, /** @type {string} */ b) => (parseFloat(style.getPropertyValue(a)) || 0) + (parseFloat(style.getPropertyValue(b)) || 0);
		return {
			width: Math.max(0, space.clientWidth - padding('padding-left', 'padding-right')),
			height: Math.max(0, space.clientHeight - padding('padding-top', 'padding-bottom'))
		};
	}

	/** The font that fits the space (`TerminalFit`); checked against what xterm drew, as faces round. */
	#fit() {
		if (this.#disposed) return;
		const terminal = this.#terminal;
		const fit = this.#fitting;
		const { width, height } = this.#room();
		if (!width) return;
		let size = terminalFontSize(width, this.#ratio, fit, height, this.#line, this.#size);
		if (terminal.options.fontSize !== size) terminal.options.fontSize = size;
		const drawn = this.#screenElement()?.getBoundingClientRect();
		if (drawn) {
			let fits = size;
			if (drawn.width > width) fits = size * (width / drawn.width);
			if (fit.rows !== undefined && height && drawn.height > height) fits = Math.min(fits, Math.max(fit.rows, size * (height / drawn.height)));
			fits = Math.max(fit.min, Math.floor(fits * 4) / 4);
			if (fits < size) terminal.options.fontSize = size = fits;
		}
		this.#host.dataset.fontSize = String(terminal.options.fontSize);
		this.#schedule();
	}

	#screenElement() {
		return this.#host.querySelector('.xterm-screen');
	}

	/** The shown rows, at most once a frame, after the output and the layout it changed. */
	#schedule() {
		if (this.#frame !== undefined || this.#disposed) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = undefined;
			const screen = this.#screenElement();
			if (this.#disposed || !screen) return;
			const rows = shownRows(this.#terminal.buffer.active, this.#size.rows);
			const rowHeight = screen.getBoundingClientRect().height / this.#size.rows;
			this.#host.style.height = `${Math.ceil(rows * rowHeight)}px`;
			this.#host.dataset.rows = String(rows);
			// With scrollback, a space at the screen's foot (the newest line) stays there as the screen grows.
			if (this.#scrollback > 0 && this.#atFoot) this.#space.scrollTop = this.#space.scrollHeight;
		});
	}

	#scrolled = () => {
		const space = this.#space;
		this.#atFoot = space.scrollTop >= space.scrollHeight - space.clientHeight - 1;
	};

	/** The height of a row as drawn; 0 before it is. */
	#rowHeight() {
		return (this.#screenElement()?.getBoundingClientRect().height ?? 0) / this.#size.rows;
	}

	/** A wheel up and down scrolls it (`scrollBy`), and never xterm; sideways, or a pinch (with Ctrl), is the browser's. */
	#wheel = (/** @type {WheelEvent} */ event) => {
		event.stopPropagation();
		if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
		event.preventDefault();
		const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.#rowHeight() : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.#space.clientHeight : 1;
		this.scrollBy(event.deltaY * unit);
	};

	/** A one-finger swipe up and down scrolls it (`scrollBy`): the space leaves vertical panning to it (`touch-action`). */
	#touchstart = (/** @type {TouchEvent} */ event) => {
		this.#touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined;
		this.#owed = 0;
	};

	#touchmove = (/** @type {TouchEvent} */ event) => {
		if (this.#touchY === undefined || event.touches.length !== 1) return;
		const y = event.touches[0].clientY;
		this.scrollBy(this.#touchY - y);
		this.#touchY = y;
	};

	/** ↑ and ↓ a line, Page Up and Page Down the rows in view less one, Home and End all the way; with no Ctrl, Alt or Meta. */
	#keydown = (/** @type {KeyboardEvent} */ event) => {
		const step = SCROLL_KEYS[event.key];
		if (step === undefined || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
		// Keys typed into a field, such as the address box, are the field's.
		const target = /** @type {HTMLElement | null} */ (event.target);
		if (target?.closest?.('input, textarea, select, button')) return;
		const row = this.#rowHeight();
		if (!row) return;
		event.preventDefault();
		if (step === -Infinity || step === Infinity) {
			if (step < 0) this.#terminal.scrollToTop();
			else this.#terminal.scrollToBottom();
			this.#space.scrollTop = step < 0 ? 0 : this.#space.scrollHeight;
			this.#owed = 0;
			return;
		}
		const page = Math.max(1, Math.min(this.#size.rows, Math.floor(this.#space.clientHeight / row)) - 1);
		const lines = step === 'page' ? page * (event.key === 'PageUp' ? -1 : 1) : step;
		this.#owed = 0;
		this.scrollBy(lines * row);
	};
}

/**
 * Calls `changed` when the theme changes: the page's `data-theme`, or the system's light or dark.
 * @param {() => void} changed
 */
function watchTheme(changed) {
	const observer = new MutationObserver(changed);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : undefined;
	query?.addEventListener('change', changed);
	return () => {
		observer.disconnect();
		query?.removeEventListener('change', changed);
	};
}
