#!/usr/bin/env node
/**
 * Takes the README's screenshots of the demo run (scripts/demo.mjs), live:
 *
 * - docs/screenshot.png: the full page, dark;
 * - docs/embed.png: the page in an iframe in a chat message, light, on a
 *   client's page of another origin.
 *
 *   node scripts/screenshot.mjs
 *
 * Needs Playwright with Chromium (`npm install --no-save playwright`, then
 * `npx playwright install chromium`), which the site itself doesn't depend on.
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

/** @type {typeof import('playwright')} */
let playwright;
try {
	playwright = await import('playwright');
} catch {
	try {
		// A global install, found through NODE_PATH, which only require() reads.
		playwright = createRequire(import.meta.url)('playwright');
	} catch {
		console.error('This needs Playwright: npm install --no-save playwright && npx playwright install chromium');
		process.exit(1);
	}
}

/**
 * A client's page, on another origin: one chat message with the terminal
 * embedded, sized by the frame's height messages.
 * @param {string} frame the iframe's src
 */
function chatPage(frame) {
	return `<!doctype html><meta charset="utf-8"><title>Chat</title>
<style>
	body { margin: 0; padding: 24px; background: #f8f6f3; color: #1c1f33; font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
	.message { display: flex; gap: 12px; width: 720px; padding: 12px 16px; }
	.avatar { flex: none; width: 36px; height: 36px; border-radius: 50%; background: #a83c14; color: #fff; display: grid; place-items: center; font-weight: 600; }
	.body { flex: 1; min-width: 0; }
	.name { font-weight: 600; } .time { color: #5b5d6c; font-size: 12px; margin-left: 6px; }
	.text { margin: 2px 0 8px; }
	iframe { display: block; width: 100%; height: 120px; border: 1px solid #dfdad2; border-radius: 10px; overflow: hidden; }
</style>
<div class="message">
	<div class="avatar">A</div>
	<div class="body">
		<div><span class="name">Ada</span><span class="time">10:42</span></div>
		<p class="text">Cutting the release, follow along:</p>
		<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" title="make release" src="${frame}"></iframe>
	</div>
</div>
<script>
	addEventListener('message', (event) => {
		const frame = document.querySelector('iframe');
		if (event.source === frame.contentWindow && event.data?.type === 'apron-terminal:height') frame.style.height = event.data.height + 2 + 'px';
	});
</script>`;
}

// The dev server's port when it's free, so the page says where it streams from as `npm run dev` would.
const site = await serve({ port: 8789, demo: true }).catch(() => serve({ port: 0, demo: true }));
// The client, on another origin than the page it embeds.
const client = createServer((request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	response.end(chatPage(decodeURIComponent(new URL(request.url ?? '/', 'http://x').searchParams.get('frame') ?? '')));
});
await new Promise((resolve) => client.listen(0, '127.0.0.1', () => resolve(undefined)));
const clientAddress = client.address();
const clientUrl = `http://127.0.0.1:${typeof clientAddress === 'object' && clientAddress ? clientAddress.port : 0}`;

const browser = await playwright.chromium.launch();
try {
	mkdirSync(docs, { recursive: true });
	// The stream stays open once written, so the page shows it Live.
	const stream = encodeURIComponent(`${site.url}/demo?hold`);
	const done = (/** @type {import('playwright').Page | import('playwright').FrameLocator} */ scope) => scope.locator('.xterm-rows').filter({ hasText: 'ready in' }).waitFor({ timeout: 30_000 });

	const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'reduce' });
	await page.goto(`${site.url}/#stream=${stream}&title=make%20release`);
	await done(page);
	await page.waitForTimeout(300);
	// Down to the screen's foot, and a margin like the one above it.
	const screen = await page.locator('.screen').boundingBox();
	const height = Math.ceil((screen?.y ?? 0) + (screen?.height ?? 820) + 24);
	await page.screenshot({ path: join(docs, 'screenshot.png'), clip: { x: 0, y: 0, width: 1180, height: Math.min(820, height) } });
	await page.close();

	const chat = await browser.newPage({ viewport: { width: 768, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
	const frame = `${site.url}/#stream=${stream}&title=make%20release&embed=1&theme=light`;
	await chat.goto(`${clientUrl}/?frame=${encodeURIComponent(frame)}`);
	await done(chat.frameLocator('iframe'));
	await chat.waitForTimeout(500);
	await chat.locator('.message').screenshot({ path: join(docs, 'embed.png') });
	console.log(`Wrote ${join(docs, 'screenshot.png')} and ${join(docs, 'embed.png')}`);
} finally {
	await browser.close();
	site.close();
	client.close();
}
