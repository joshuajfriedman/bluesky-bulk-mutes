import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import { Agent } from '@atproto/api'
import { TID } from '@atproto/common-web'

// ---- Configuration -------------------------------------------------------
// SITE and SCOPE must match public/client-metadata.json exactly.
const SITE = 'https://mutes.joshuajfriedman.com'
const SCOPE =
  'atproto rpc:app.bsky.actor.getPreferences?aud=* rpc:app.bsky.actor.putPreferences?aud=*'
const HANDLE_RESOLVER = 'https://bsky.social'
const MAX_TERMS = 500 // sanity cap per batch
const PREF_TYPE = 'app.bsky.actor.defs#mutedWordsPref'
const DURATIONS = { never: 0, '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }

// ---- DOM -----------------------------------------------------------------
const $ = (id) => document.getElementById(id)
const el = {
  signedOut: $('signed-out'),
  signedIn: $('signed-in'),
  signInForm: $('sign-in-form'),
  handle: $('handle'),
  signInBtn: $('sign-in'),
  signInError: $('sign-in-error'),
  who: $('who'),
  signOut: $('sign-out'),
  terms: $('terms'),
  count: $('count'),
  preview: $('preview'),
  newList: $('new-list'),
  newHead: $('new-head'),
  dupeWrap: $('dupe-wrap'),
  dupeList: $('dupe-list'),
  dupeHead: $('dupe-head'),
  submit: $('submit'),
  status: $('status'),
  loading: $('loading'),
}

let client = null
let session = null
let agent = null
let activeKeys = new Set() // lowercased values of currently active muted words

// ---- Helpers -------------------------------------------------------------
// Mirrors the SDK's sanitizeMutedWordValue, applied globally.
function sanitize(value) {
  return value
    .trim()
    .replace(/^#(?!\ufe0f)/, '')
    .replace(/[\r\n\u00AD\u2060\u200D\u200C\u200B]+/g, '')
    .trim()
}
const key = (v) => v.toLowerCase()
const isExpired = (item, now) => item.expiresAt && Date.parse(item.expiresAt) <= now

function parse(text) {
  const mode = document.querySelector('input[name="split"]:checked').value
  const parts = text.split(mode === 'lines' ? /\r?\n/ : /[\r\n,]+/)
  const seen = new Set()
  const out = []
  for (const p of parts) {
    const v = sanitize(p)
    if (!v || seen.has(key(v))) continue
    seen.add(key(v))
    out.push(v)
  }
  return out
}

function options() {
  const targets =
    document.querySelector('input[name="targets"]:checked').value === 'tags'
      ? ['tag']
      : ['content', 'tag']
  const actorTarget = document.querySelector('input[name="actor"]:checked').value
  const ms = DURATIONS[$('duration').value]
  const expiresAt = ms ? new Date(Date.now() + ms).toISOString() : undefined
  return { targets, actorTarget, expiresAt }
}

function setStatus(msg, kind = '') {
  el.status.textContent = msg
  el.status.dataset.kind = kind
}

function chips(list, words) {
  list.replaceChildren(
    ...words.map((w) => {
      const li = document.createElement('li')
      li.textContent = w
      return li
    }),
  )
}

// ---- Preview -------------------------------------------------------------
function currentSplit() {
  const all = parse(el.terms.value)
  const fresh = all.filter((w) => !activeKeys.has(key(w)))
  const dupes = all.filter((w) => activeKeys.has(key(w)))
  return { all, fresh, dupes }
}

function renderPreview() {
  const { fresh, dupes } = currentSplit()
  const over = fresh.length > MAX_TERMS
  el.preview.hidden = fresh.length + dupes.length === 0
  el.newHead.textContent =
    fresh.length === 1 ? '1 new word' : `${fresh.length} new words`
  chips(el.newList, fresh)
  el.dupeWrap.hidden = dupes.length === 0
  el.dupeHead.textContent =
    dupes.length === 1
      ? '1 already muted, will be skipped'
      : `${dupes.length} already muted, will be skipped`
  chips(el.dupeList, dupes)
  el.submit.disabled = fresh.length === 0 || over
  el.submit.textContent =
    fresh.length === 0
      ? 'Mute words'
      : fresh.length === 1
        ? 'Mute 1 word'
        : `Mute ${fresh.length} words`
  if (over) setStatus(`That's ${fresh.length} new words. The limit is ${MAX_TERMS} per batch; split the list and run it in parts.`, 'error')
  else if (el.status.dataset.kind === 'error') setStatus('')
}

async function loadExisting() {
  const prefs = await agent.getPreferences()
  const now = Date.now()
  activeKeys = new Set(
    (prefs.moderationPrefs.mutedWords || [])
      .filter((w) => !isExpired(w, now))
      .map((w) => key(w.value)),
  )
  el.count.textContent =
    activeKeys.size === 1
      ? 'You have 1 muted word.'
      : `You have ${activeKeys.size} muted words.`
}

// ---- Write: one read-modify-write for the whole batch --------------------
async function muteAll() {
  const { fresh } = currentSplit()
  if (!fresh.length) return
  const { targets, actorTarget, expiresAt } = options()
  let added = 0
  el.submit.disabled = true
  setStatus('Saving…', 'busy')
  try {
    // updatePreferences holds a lock, fetches current prefs, and writes the
    // full array back, so every other preference is preserved.
    await agent.updatePreferences((prefs) => {
      const existing = prefs.findLast((p) => p.$type === PREF_TYPE)
      const now = Date.now()
      const items = (existing?.items || []).map((i) =>
        i.id ? i : { ...i, id: TID.nextStr() },
      )
      const active = new Set(items.filter((i) => !isExpired(i, now)).map((i) => key(i.value)))
      const toAdd = fresh.filter((w) => !active.has(key(w)))
      if (!toAdd.length) return false
      const addKeys = new Set(toAdd.map(key))
      // Drop expired entries for words being re-muted, so they don't linger.
      const kept = items.filter((i) => !(isExpired(i, now) && addKeys.has(key(i.value))))
      added = toAdd.length
      const newItems = toAdd.map((value) => ({
        id: TID.nextStr(),
        value,
        targets,
        actorTarget,
        ...(expiresAt ? { expiresAt } : {}),
      }))
      return prefs
        .filter((p) => p.$type !== PREF_TYPE)
        .concat({ $type: PREF_TYPE, items: [...kept, ...newItems] })
    })
    await loadExisting()
    el.terms.value = ''
    renderPreview()
    setStatus(
      added === 0
        ? 'Nothing to add. Those words were already muted.'
        : added === 1
          ? 'Muted 1 word.'
          : `Muted ${added} words.`,
      'ok',
    )
  } catch (err) {
    console.error(err)
    setStatus(`Couldn't save: ${err.message || err}. Your existing settings weren't changed. Try again.`, 'error')
    renderPreview()
  }
}

// ---- Auth ----------------------------------------------------------------
const onSessionDeleted = () => showSignedOut('Your session ended. Sign in again.')

async function makeClient() {
  const local = ['127.0.0.1', '[::1]'].includes(location.hostname)
  if (local) {
    // Loopback client for testing on your machine; no metadata file needed.
    const redirect = `${location.origin}/`
    // load() turns a loopback client_id string into the metadata object itself.
    return BrowserOAuthClient.load({
      handleResolver: HANDLE_RESOLVER,
      onSessionDeleted,
      clientId: `http://localhost?redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(SCOPE)}`,
    })
  }
  return BrowserOAuthClient.load({
    clientId: `${SITE}/client-metadata.json`,
    handleResolver: HANDLE_RESOLVER,
    onSessionDeleted,
  })
}

async function showSignedIn(s, handleHint) {
  session = s
  agent = new Agent(session)
  const stored = localStorage.getItem(`handle:${s.did}`)
  const handle = handleHint || stored || s.did
  try {
    if (handleHint) localStorage.setItem(`handle:${s.did}`, handleHint)
  } catch {}
  el.who.textContent = handle.startsWith('did:') ? handle : `@${handle}`
  el.signedOut.hidden = true
  el.signedIn.hidden = false
  el.count.textContent = 'Loading your muted words…'
  try {
    await loadExisting()
  } catch (err) {
    console.error(err)
    el.count.textContent = `Couldn't load your muted words: ${err.message || err}`
  }
  renderPreview()
}

function showSignedOut(msg = '') {
  session = agent = null
  el.signedIn.hidden = true
  el.signedOut.hidden = false
  el.signInError.textContent = msg
  el.signInBtn.disabled = false
}

async function main() {
  if (location.hostname === 'localhost') {
    // Loopback OAuth requires 127.0.0.1, not "localhost".
    location.replace(location.href.replace('//localhost', '//127.0.0.1'))
    return
  }
  try {
    client = await makeClient()
  } catch (err) {
    console.error(err)
    el.loading.hidden = true
    showSignedOut(`This page couldn't start sign-in: ${err.message || err}`)
    el.signInBtn.disabled = true
    return
  }
  try {
    const result = await client.init()
    el.loading.hidden = true
    if (result) await showSignedIn(result.session, result.state || null)
    else showSignedOut()
  } catch (err) {
    console.error(err)
    el.loading.hidden = true
    showSignedOut(`Sign-in didn't complete: ${err.message || err}`)
  }
}

el.signInForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const handle = el.handle.value.trim().replace(/^@/, '')
  if (!handle) return
  el.signInBtn.disabled = true
  el.signInError.textContent = ''
  try {
    await client.signInRedirect(handle, { state: handle, scope: SCOPE })
  } catch (err) {
    console.error(err)
    el.signInBtn.disabled = false
    el.signInError.textContent = `Couldn't start sign-in for "${handle}": ${err.message || err}. Check the handle and try again.`
  }
})

el.signOut.addEventListener('click', async () => {
  try {
    await session?.signOut()
  } catch (err) {
    console.error(err)
  }
  showSignedOut()
})

el.terms.addEventListener('input', renderPreview)
document.querySelectorAll('input[name="split"]').forEach((r) => r.addEventListener('change', renderPreview))
el.submit.addEventListener('click', muteAll)

main()
