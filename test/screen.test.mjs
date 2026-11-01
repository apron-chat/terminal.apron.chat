import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONT_MAX, FONT_MIN, FONT_ROWS_MIN, SCROLLBACK, shownRows, TERMINAL_COLS, TERMINAL_ROWS, terminalFontSize, terminalOptions } from '../src/screen.js';

test('the terminal is 80 by 40, read-only, and opens nothing', () => {
	const options = terminalOptions({}, 'monospace', 13);
	assert.equal(options.cols, TERMINAL_COLS);
	assert.equal(options.rows, TERMINAL_ROWS);
	assert.equal(TERMINAL_COLS, 80);
	assert.equal(TERMINAL_ROWS, 40);
	assert.equal(options.disableStdin, true);
	assert.equal(options.scrollback, SCROLLBACK);
	assert.equal(options.linkHandler?.allowNonHttpProtocols, false);
	assert.deepEqual(options.windowOptions, {});
});

test('the font fits 80 columns, and 40 rows down to a size, within bounds', () => {
	// Wide and tall: the columns decide, up to the largest.
	assert.equal(terminalFontSize(10_000, 0.6, 10_000), FONT_MAX);
	// 80 columns of 0.6 em in 960 px: 20 px.
	assert.equal(terminalFontSize(960, 0.6), 20);
	// Short: the rows decide, 40 rows of 1.2 em in 720 px, 15 px.
	assert.equal(terminalFontSize(960, 0.6, 720, 1.2), 15);
	// Shorter still: the rows stop at FONT_ROWS_MIN, and the stage scrolls.
	assert.equal(terminalFontSize(960, 0.6, 300, 1.2), FONT_ROWS_MIN);
	// A phone: never below the smallest; the stage scrolls sideways.
	assert.equal(terminalFontSize(320, 0.6, 600, 1.2), FONT_MIN);
	// Quarter pixels.
	assert.equal(terminalFontSize(700, 0.6) * 4 % 1, 0);
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
