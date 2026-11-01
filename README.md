# terminal.apron.chat

A stand-alone viewer for the live output of Apron `terminal` embeds
([PROTOCOL.md §4.8.6](https://github.com/shazow/apron/blob/main/PROTOCOL.md#486-embedterminal)).
Open a terminal in any browser, including from chat apps that can't show
terminals themselves.

```text
https://terminal.apron.chat/#stream=https://chat.example/t/p3Wn9d…&title=make%20test
```

The page reads the stream and draws it the way web.apron.chat's terminal viewer
does: xterm.js at 80 columns by 40 rows, scaled to fit, with scrollback. It
follows the output live, reconnects when the connection drops, and keeps
showing what arrived once the output ends.

## Links

| key      |          | what |
|----------|----------|------|
| `stream` | required | the embed's `url`: the live text that the chat server serves |
| `title`  | optional | the embed's `title`, such as the command |

- Put the keys in the fragment, after `#`. The stream's address is all anyone
  needs to read it, and the fragment never reaches this site's host. A link
  with `stream` in the query is refused, since the address has already been
  sent.
- Percent-encode a value that contains `&`, `#`, `+` or `%`. `:` and `/` can
  stay as they are.
- If a key is repeated, the first value is used.
- `stream` must be `https:`. Plain `http:` is allowed only for `localhost`,
  names under it, and `127.0.0.1`, for local development. An address with a
  user name or password is refused.

`viewerUrl` in [`src/stream.js`](src/stream.js) builds a link. A server can
build the same thing in one line:

```js
`https://terminal.apron.chat/#stream=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ''}`
```

## What the page does with a stream

- It reads `GET <stream>` with `fetch`. It sends no cookies, no credentials and
  no referrer. Live text is served with `Access-Control-Allow-Origin: *`
  (§4.8.5), so it needs nothing else. The page decodes the bytes as UTF-8, as
  the server does for the output it keeps.
- It shows the stream as the protocol's clients do. Each response starts from
  a fresh terminal, a line feed also returns to the first column, and the page
  never performs a control function that acts outside the screen. Window
  titles (OSC 0–2) and clipboard writes (OSC 52) are ignored. OSC 8 links are
  shown but never opened.
- If a read fails or drops, it tries again after 1, 2, 4, 8, then every 15
  seconds, and the new response replaces what was shown. A 4xx other than 408
  or 429 stops it, because every try counts against the server's limits on
  readers.
- When the response ends, the output has ended. The page keeps what it showed.

Chat servers differ once the output has ended. apron-server-go keeps serving
the finished output at the same address. apron-server-cloudflare answers 404,
and the page then says the stream has ended and points to the chat message,
which shows the final output. Servers can also limit how many people read one
stream (apron-server-cloudflare allows 5 to 10). When they are full, the page
says so instead of retrying.

## Security

- The site is files only, with no server code. The page loads nothing from
  another origin, and builds all its markup with DOM calls.
- The Content-Security-Policy (in `_headers`, from
  [`scripts/build.mjs`](scripts/build.mjs)) allows only the page's own scripts.
  It forbids the DOM's HTML sinks (Trusted Types), and lets the page connect
  only to `https:` and to localhost over `http:`.
- Inline styles are allowed, because xterm.js sizes and colors its screen with
  `<style>` elements and `style` attributes. No markup can come from a stream:
  its text only ever reaches xterm's cells.
- The page shows which host it streams from, so that output can't pass itself
  off as coming from somewhere else. Titles are cleaned up before they are
  shown: they're kept on one line, controls that could reorder the text around
  them are removed, and they're cut to 120 characters.

## Development

You need Node 22 or later. The only dependency is xterm.js, pinned to the
version that apron-web uses.

```sh
npm ci
npm test               # link parsing, stream reading, screen sizing, and build checks
npm run dev            # build, then serve at http://localhost:8789 with production's headers
DEMO=1 npm run dev     # the same, with a demo stream at /demo and a link to view it
npm run build          # write the site to build/
```

| path | what |
|------|------|
| `src/stream.js` | reads and writes links: the stream's address and title, with their checks |
| `src/live.js` | follows a stream: reads, reconnects, decodes |
| `src/screen.js` | the terminal screen: xterm.js, fitted to the window, with scrollback |
| `src/app.js` | the page |
| `scripts/build.mjs` | builds `build/`: the page, `xterm.mjs` and `xterm.css` from `node_modules`, and `_headers` |

`src/live.js` and `src/screen.js` follow apron-web's
`src/lib/protocol/live-text.ts` and `src/lib/ui/terminal-screen.ts`. When you
change how terminals look or read in one place, change the other to match.

## Deploying

The site is a Cloudflare Worker with static assets only, like link.apron.chat.
`wrangler.toml` has no `main`, so no Worker code runs, and `npm test` fails if
one is added.

One-time setup:

1. In the Cloudflare dashboard, create a Worker from this repository with
   Workers Builds.
2. Set the build command to `npm ci && npm run build`, and the deploy command
   to `npx wrangler deploy`.
3. The custom domain `terminal.apron.chat` comes from `wrangler.toml`.
