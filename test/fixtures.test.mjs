// Replays shazow/apron's terminal fixtures (protocol/tests/fixtures/terminal.json,
// from the `protocol` submodule) through a headless xterm made as the page's
// screen is (src/screen.js), and checks the screen each one expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import { behaviorOptions, swallowOutsideControls, TERMINAL_ROWS } from '../src/screen.js';

const { Terminal } = headless;
const FIXTURES = new URL('../protocol/tests/fixtures/terminal.json', import.meta.url);

/**
 * @typedef {{ row: number, col: number, char: string, fg?: number | string, bg?: number | string,
 *   bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean, inverse?: boolean, strikethrough?: boolean }} Cell
 * @typedef {{ name: string, level: string, description: string, output: string, expected: { screen: string[], cells?: Cell[] } }} Case
 */

if (!existsSync(FIXTURES)) {
	throw new Error('The terminal fixtures come from the protocol submodule: run `git submodule update --init`.');
}
/** @type {{ kind: string, cases: Case[] }} */
const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));

/** How each case is written: all at once, and a character at a time, as a live stream may split it anywhere. */
const WRITES = {
	'in one write': (/** @type {string} */ output) => [output],
	'a character at a time': (/** @type {string} */ output) => [...output]
};

/**
 * A fresh terminal with `chunks` written to it, and the titles it was told to set.
 * @param {string[]} chunks
 */
async function render(chunks) {
	const terminal = new Terminal({ ...behaviorOptions(), allowProposedApi: true });
	swallowOutsideControls(terminal);
	/** @type {string[]} */
	const titles = [];
	terminal.onTitleChange((title) => titles.push(title));
	for (const chunk of chunks) await new Promise((resolve) => terminal.write(chunk, () => resolve(undefined)));
	return { terminal, titles };
}

/**
 * The screen's rows from the top, down to the last with text, without trailing spaces.
 * @param {InstanceType<typeof Terminal>} terminal
 */
function screen(terminal) {
	const buffer = terminal.buffer.active;
	const rows = [];
	// Compared in NFC, as the fixtures say: xterm keeps a combining mark as it arrived.
	for (let y = 0; y < TERMINAL_ROWS; y++) rows.push((buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').normalize('NFC'));
	while (rows.length && !rows[rows.length - 1]) rows.pop();
	return rows;
}

/**
 * A cell as the fixtures write it: its character, and the attributes that are set.
 * @param {InstanceType<typeof Terminal>} terminal
 * @param {number} row
 * @param {number} col
 */
function cell(terminal, row, col) {
	const buffer = terminal.buffer.active;
	const found = buffer.getLine(buffer.baseY + row)?.getCell(col);
	assert.ok(found, `no cell at ${row},${col}`);
	const color = (/** @type {boolean} */ palette, /** @type {boolean} */ rgb, /** @type {number} */ value) =>
		palette ? value : rgb ? `#${value.toString(16).padStart(6, '0')}` : undefined;
	/** @type {Omit<Cell, 'row' | 'col'>} */
	const out = { char: found.getChars().normalize('NFC') };
	const fg = color(found.isFgPalette(), found.isFgRGB(), found.getFgColor());
	const bg = color(found.isBgPalette(), found.isBgRGB(), found.getBgColor());
	if (fg !== undefined) out.fg = fg;
	if (bg !== undefined) out.bg = bg;
	if (found.isBold()) out.bold = true;
	if (found.isDim()) out.dim = true;
	if (found.isItalic()) out.italic = true;
	if (found.isUnderline()) out.underline = true;
	if (found.isInverse()) out.inverse = true;
	if (found.isStrikethrough()) out.strikethrough = true;
	return out;
}

test('the fixtures are terminal cases', () => {
	assert.equal(fixtures.kind, 'terminal');
	assert.ok(fixtures.cases.length > 0);
});

for (const fixture of fixtures.cases) {
	for (const [how, split] of Object.entries(WRITES)) {
		test(`${fixture.level} ${fixture.name}, ${how}`, async () => {
			const { terminal, titles } = await render(split(fixture.output));
			assert.deepEqual(screen(terminal), fixture.expected.screen, fixture.description);
			for (const { row, col, ...expected } of fixture.expected.cells ?? []) {
				assert.deepEqual(cell(terminal, row, col), expected, `cell ${row},${col}: ${fixture.description}`);
			}
			// Nothing a program prints acts outside the screen.
			assert.deepEqual(titles, []);
			terminal.dispose();
		});
	}
}
