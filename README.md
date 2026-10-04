# Bulk mute words for Bluesky

A static page at https://mutes.joshuajfriedman.com that lets a Bluesky user sign in with OAuth, paste a list of words or phrases, and add them all to their muted words in a single preferences write.

## How it works

- Sign-in uses `@atproto/oauth-client-browser`. The user approves access on their own PDS; the page never handles passwords, and the session lives only in the user's browser.
- Requested scope: `atproto rpc:app.bsky.actor.getPreferences?aud=* rpc:app.bsky.actor.putPreferences?aud=*` (preferences only).
- Muting runs one `updatePreferences` call: fetch all preferences, append the new words to `mutedWordsPref`, write the full array back. Other preferences are untouched. Words already actively muted are skipped (case-insensitive); expired entries for re-muted words are replaced.
- Everything is bundled into `public/app.js`, so the page loads no third-party scripts.

## Files

- `src/main.js`: app logic
- `public/index.html`, `public/style.css`: page
- `public/app.js`: built bundle (regenerate with `npm run build`)
- `public/client-metadata.json`: OAuth client metadata; its `client_id` is this app's identity
- `public/_headers`: Cloudflare Pages headers (CSP, JSON content type)

If you change the domain or scope, update both `src/main.js` (`SITE`, `SCOPE`) and `public/client-metadata.json`, then rebuild.

## Deploy (Cloudflare Pages)

Connect the GitHub repo in Cloudflare Pages with build command `npm run build` and output directory `public`, then add `mutes.joshuajfriedman.com` as a custom domain.

## Local testing

`npm install && npm run dev`, then open http://127.0.0.1:8080. On 127.0.0.1 the app uses an atproto loopback client, so no metadata file is needed.
