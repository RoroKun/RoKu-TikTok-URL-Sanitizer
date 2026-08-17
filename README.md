# RoKu's TikTok URL Sanitizer — Netlify build

A static frontend +a Netlify serverless function that expands short links
(`vm.tiktok.com`, `vt.tiktok.com`, `tiktok.com/t/...`) and strips
tracking parameters, returning the canonical `@user/video/<id>` URL.

Nothing is downloaded, logged, or stored. Short links are expanded by
reading HTTP redirect headers only — the linked video content is never
fetched.

```

## Project layout

```
tiktok-sanitizer-netlify/

├── netlify.toml               # publish dir + function dir + /api/clean redirect

├── package.json

├── public/index.html          # frontend (same UI as the Flask version)

├── netlify/functions/clean.js # serverless function (port of sanitizer.py)

└── test_clean.js              # local test suite, no CLI required
```

## Known limitations (same as the Flask version)

- Does not download videos, bypass age gates/region blocks, or proxy
  TikTok content — it only rewrites the URL.
- If TikTok adds a new short-link domain or new post-type path shapes
  (beyond `/video/` and `/photo/`), update `SHORT_LINK_HOSTS` and the
  path patterns in `netlify/functions/clean.js`.
