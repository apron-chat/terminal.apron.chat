import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_FIT, keepLast, shownRows, TERMINAL_COLS, TERMINAL_ROWS, terminalFontSize, terminalOptions, VIEWER_FIT } from '../src/screen.js';

test('the terminal is 80 by 40, read-only, and opens nothing', () => {
	const options = terminalOptions({}, 'monospace', 13, 5000);
	assert.equal(options.cols, TERMINAL_COLS);
	assert.equal(options.rows, TERMINAL_ROWS);
	assert.equal(TERMINAL_COLS, 80);
	assert.equal(TERMINAL_ROWS, 40);
	assert.equal(options.disableStdin, true);
	assert.equal(options.scrollback, 5000);
	assert.equal(terminalOptions({}, 'monospace', 13).scrollback, 0);
	assert.equal(options.linkHandler?.allowNonHttpProtocols, false);
	assert.deepEqual(options.windowOptions, {});
});

test('full page: 80 columns, and 40 rows down to a size, within bounds', () => {
	// Wide and tall: the columns decide, up to the largest.
	assert.equal(terminalFontSize(10_000, 0.6, VIEWER_FIT, 10_000), VIEWER_FIT.max);
	// 80 columns of 0.6 em in 960 px: 20 px.
	assert.equal(terminalFontSize(960, 0.6, VIEWER_FIT), 20);
	// Short: the rows decide, 40 rows of 1.2 em in 720 px, 15 px.
	assert.equal(terminalFontSize(960, 0.6, VIEWER_FIT, 720, 1.2), 15);
	// Shorter still: the rows stop at the fit's `rows`, and the stage scrolls.
	assert.equal(terminalFontSize(960, 0.6, VIEWER_FIT, 300, 1.2), VIEWER_FIT.rows);
	// A phone: never below the smallest; the stage scrolls sideways.
	assert.equal(terminalFontSize(320, 0.6, VIEWER_FIT, 600, 1.2), VIEWER_FIT.min);
	// Quarter pixels.
	assert.equal(terminalFontSize(700, 0.6, VIEWER_FIT) * 4 % 1, 0);
});

test('in a message: the columns in the width, whatever the height, smaller on a phone', () => {
	assert.equal(terminalFontSize(10_000, 0.6, INLINE_FIT, 100), INLINE_FIT.max);
	// 80 columns of 0.6 em in 336 px: 7 px, below the full page's smallest.
	assert.equal(terminalFontSize(336, 0.6, INLINE_FIT, 100), 7);
	assert.equal(terminalFontSize(50, 0.6, INLINE_FIT), INLINE_FIT.min);
});

test('keepLast cuts as servers cut a terminal output', () => {
	assert.equal(keepLast('short', 10), 'short');
	assert.equal(keepLast('aaaa\r\nbbbb', 8), '\r\nbbbb');
	assert.equal(keepLast('abcdefgh', 4), 'efgh');
	// Not half of a surrogate pair.
	assert.equal(keepLast('a😀bc', 3), 'bc');
});

/** A buffer of `rows` lines of text, as xterm's `IBuffer` gives them. */
function buffer(/** @type {string[]} */ rows, { type = 'normal', baseY = 0, colored = -1 } = {}) {
	return /** @type {import('@xterm/xterm').IBuffer} */ (/** @type {unknown} */ ({
		type,
		baseY,
		getLine: (/** @type {number} */ y) => ({
			length: TERMINAL_COLS,
			translateToString: () => rows[y] ?? '',
			getCell: () => ({ isBgDefault: () => y !== colored })
		})
	}));
}

test('rows are shown down to the last one written', () => {
	assert.equal(shownRows(buffer([])), 1);
	assert.equal(shownRows(buffer(['a', '', 'b'])), 3);
	assert.equal(shownRows(buffer(['a', '', '', ''], { colored: 3 })), 4);
	assert.equal(shownRows(buffer(['a'], { type: 'alternate' })), TERMINAL_ROWS);
	assert.equal(shownRows(buffer(['a'], { baseY: 2 })), TERMINAL_ROWS);
});
