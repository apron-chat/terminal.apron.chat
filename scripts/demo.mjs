/**
 * A pretend release run, as a program would write it to a terminal: colors
 * (16 and 24-bit), box drawing, progress bars redrawn with carriage
 * returns, and a table. `npm run dev` with DEMO=1 serves it as a stream, and
 * scripts/screenshot.mjs takes the README's screenshots of it.
 *
 * Every line fits in 80 columns.
 */

const ESC = '\x1b[';
const reset = `${ESC}0m`;
const bold = (/** @type {string} */ text) => `${ESC}1m${text}${reset}`;
const dim = (/** @type {string} */ text) => `${ESC}2m${text}${reset}`;
const color = (/** @type {number} */ code, /** @type {string} */ text) => `${ESC}${code}m${text}${reset}`;
const green = (/** @type {string} */ text) => color(32, text);
const yellow = (/** @type {string} */ text) => color(33, text);
const cyan = (/** @type {string} */ text) => color(36, text);
const magenta = (/** @type {string} */ text) => color(35, text);

/** Five rows of block letters. */
const LETTERS = {
	A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
	P: ['████ ', '█   █', '████ ', '█    ', '█    '],
	R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
	O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
	N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █']
};

/** Apron's accent (rust) to its denim, in 24-bit color. */
const FROM = [242, 138, 60];
const TO = [143, 176, 245];

/**
 * `word` in block letters, each column shaded along the gradient. The blocks
 * are background colors behind spaces, not █: a terminal draws runs of
 * background as one, where glyphs side by side can show seams.
 */
function banner(/** @type {string} */ word) {
	const rows = [0, 1, 2, 3, 4].map((row) => [...word].map((letter) => LETTERS[/** @type {keyof typeof LETTERS} */ (letter)][row]).join('  '));
	const width = rows[0].length;
	return rows.map((row) => `  ${[...row].map((cell, x) => {
		if (cell === ' ') return `${reset} `;
		const t = x / (width - 1);
		const [r, g, b] = FROM.map((from, i) => Math.round(from + (TO[i] - from) * t));
		return `${ESC}48;2;${r};${g};${b}m `;
	}).join('')}${reset}`);
}

/** A progress bar 24 cells wide, of heavy lines: one per row, where blocks on rows next to each other would merge. */
function bar(/** @type {number} */ fraction) {
	const filled = Math.round(fraction * 24);
	return `${green('━'.repeat(filled))}${dim('━'.repeat(24 - filled))}`;
}

const step = (/** @type {string} */ name) => `${cyan('▸')} ${bold(name.padEnd(8))}`;

/**
 * The run, as [pause before it in ms, text] pairs.
 * @returns {Generator<[number, string]>}
 */
export function* demo() {
	yield [0, `\r\n${banner('APRON').join('\r\n')}\r\n\r\n`];
	yield [200, `  ${dim('terminal.apron.chat · live output from any Apron chat')}\r\n\r\n`];
	yield [400, `${bold('$')} make release\r\n`];
	yield [300, `${step('lint')} ${green('✓')} no problems${' '.repeat(39)}${dim('0.8s')}\r\n`];
	yield [200, `${step('test')}\r\n`];
	const packages = [['pkg/protocol', 128], ['pkg/server', 96], ['pkg/live', 57]];
	for (const [name, tests] of packages) {
		for (let done = 0; done <= 12; done++) {
			const fraction = done / 12;
			const count = `${Math.round(fraction * Number(tests))}`.padStart(4);
			yield [done ? 35 : 120, `\r  ${String(name).padEnd(14)} ${bar(fraction)} ${`${Math.round(fraction * 100)}%`.padStart(4)}  ${count} passed`];
		}
		yield [0, '\r\n'];
	}
	yield [250, `${step('bench')}\r\n`];
	const rule = (/** @type {string} */ left, /** @type {string} */ mid, /** @type {string} */ right) => dim(`  ${left}${'─'.repeat(19)}${mid}${'─'.repeat(10)}${mid}${'─'.repeat(10)}${mid}${'─'.repeat(9)}${right}`);
	const row = (/** @type {string[]} */ cells) => `  ${dim('│')} ${cells[0].padEnd(17)} ${dim('│')} ${cells[1].padStart(8)} ${dim('│')} ${cells[2].padStart(8)} ${dim('│')} ${cells[3]} ${dim('│')}`;
	yield [100, `${rule('┌', '┬', '┐')}\r\n${row(['benchmark', 'before', 'after', ' delta '.padStart(7)])}\r\n${rule('├', '┼', '┤')}\r\n`];
	for (const [name, before, after, delta] of [['Append', '412 ns', '287 ns', -30.3], ['Replay', '1.94 ms', '1.23 ms', -36.6], ['Fanout', '88 µs', '91 µs', 3.4]]) {
		const shown = `${Number(delta) > 0 ? '+' : ''}${Number(delta).toFixed(1)}%`.padStart(7);
		yield [180, `${row([`Benchmark${name}`, String(before), String(after), Number(delta) < 0 ? green(shown) : yellow(shown)])}\r\n`];
	}
	yield [0, `${rule('└', '┴', '┘')}\r\n`];
	yield [250, `${step('build')}\r\n`];
	for (const [file, size] of [['apron-linux-amd64', '12.4 MB'], ['apron-darwin-arm64', '11.9 MB'], ['apron-windows-amd64.exe', '12.8 MB']]) {
		yield [160, `  ${magenta('dist/')}${file.padEnd(28)}${dim(size.padStart(9))}\r\n`];
	}
	yield [300, `\r\n${green('✓')} ${bold('release v10.2.0')} ready in ${bold('14.2s')}  ${dim('281 tests · 3 binaries')}\r\n`];
}

/** The whole run at once, as a finished embed's `output` holds it. */
export function demoOutput() {
	return [...demo()].map(([, text]) => text).join('');
}
