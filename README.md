# RoKu's URL Sanitizer — Netlify build

A static frontend + a Netlify serverless function that turns TikTok and
YouTube share links into plain, tracker-free links.

- **TikTok:** expands short links (`vm.tiktok.com`, `vt.tiktok.com`,
  `tiktok.com/t/...`) and strips tracking parameters, returning the
  canonical `@user/video/<id>` URL.
- **YouTube:** rebuilds each link from only what it needs (the video,
  playlist or channel, plus a start time if one was chosen) and drops
  everything else, including the `si`/`is` share IDs that tell YouTube
  who shared the link, `pp`, `feature`, `ab_channel` and playlist info on
  video links. Because it keeps a short list of allowed parts instead of
  blocking known trackers, tracking parameters YouTube adds later are
  removed too.

Nothing is downloaded, logged, or stored. TikTok short links are expanded
by reading HTTP redirect headers only — the linked video content is never
fetched. YouTube links are cleaned without any network requests.

## How YouTube links are cleaned

| You paste | You get |
| --- | --- |
| `youtu.be/ID?si=...&t=42` | `www.youtube.com/watch?v=ID&t=42` |
| `youtube.com/watch?v=ID&list=...&pp=...&si=...` | `www.youtube.com/watch?v=ID` |
| `youtube.com/shorts/ID?si=...` | `www.youtube.com/shorts/ID` |
| `youtube.com/live/ID?si=...&feature=share` | `www.youtube.com/watch?v=ID` |
| `youtube.com/embed/ID?start=30` | `www.youtube.com/watch?v=ID&t=30` |
| `youtube.com/playlist?list=PL...&si=...` | `www.youtube.com/playlist?list=PL...` |
| `youtube.com/@channel?si=...` | `www.youtube.com/@channel` |
| `music.youtube.com/watch?v=ID&si=...` | `music.youtube.com/watch?v=ID` |
| `youtube.com/redirect?q=https://example.com/...&redir_token=...` | `https://example.com/...` |

Start times are normalised to seconds (`t=1m30s` becomes `t=90`).
`time_continue` is dropped: YouTube adds it automatically when someone
leaves an embedded player, so it records how far they watched rather than
a start time anyone chose.

## Project layout

```
RoKu-TikTok-URL-Sanitizer/
├── netlify.toml               # publish dir + function dir + /api/clean redirect
├── package.json
├── public/index.html          # frontend
├── netlify/functions/clean.js # serverless function behind /api/clean
├── lib/
│   ├── sanitize.js            # finds the link in pasted text, picks the cleaner
│   ├── tiktok.js              # TikTok cleaner (short-link expansion)
│   ├── youtube.js             # YouTube cleaner
│   ├── query.js               # query-string helpers
│   └── errors.js              # error types the API maps to status codes
└── test_clean.js              # test suite: npm test (no network needed)
```

## Running the tests

```
npm test
```

## Known limitations

- Does not download videos, bypass age gates/region blocks, or proxy
  TikTok or YouTube content — it only rewrites the URL.
- If TikTok adds a new short-link domain or new post-type path shapes
  (beyond `/video/` and `/photo/`), update `SHORT_LINK_HOSTS` and the
  path patterns in `lib/tiktok.js`.
- If YouTube adds a new kind of page, `lib/youtube.js` keeps the page
  path and drops every parameter. That's always tracker-free, but check
  the result still opens the right thing.
