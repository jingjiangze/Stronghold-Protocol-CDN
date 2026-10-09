# assets-raw — the Stronghold Protocol asset tree, committed so git-mount CDNs can serve it

This branch carries nothing but game art. It is intentionally a **snapshot, not a history**: the
tree is replaced wholesale whenever upstream publishes a new release, and the old blobs are dropped
rather than accumulated. See "Why wholesale replacement" below.

Paths match the upstream deployment tree exactly (`assets/**`, `fonts/**`), which is the same layout
the R2 origin serves. That means any file here can be fetched from this branch at the identical path.

| | |
|---|---|
| Files | see `assets.summary.json` |
| Origin of truth | `https://weishucdn.jiangjiangze.icu/cdn/v1/index.json` (`{ path: { size, sha256 } }`) |
| Verified | every file matched on size **and** sha256 before each commit |

## Byte fidelity is the contract

The art here is PNG / MP3 / skel — already-compressed binary that git cannot meaningfully delta.
`.gitattributes` therefore declares every path `-text -diff -merge binary`. Line-ending conversion
would corrupt these bytes silently: the file would still open in many viewers, but its sha256 would
no longer match the one published in `index.json`, and a downstream integrity check would fail for
no visible reason.

## Reading a file through a git-mount CDN

All of these serve committed files over https with `Access-Control-Allow-Origin: *` and HTTP Range,
which is what lets a browser use them for WebGL textures (`crossOrigin='anonymous'`) and audio
seeking. Verified 2026-10-09.

```
https://cdn.jsdelivr.net/gh/jingjiangze/Stronghold-Protocol-CDN@assets-raw/assets/char/avatar/char_1016_agoat2.png
https://ghfast.top/https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-CDN/assets-raw/assets/char/avatar/char_1016_agoat2.png
https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-CDN/assets-raw/assets/char/avatar/char_1016_agoat2.png
https://raw.githubusercontent.com/jingjiangze/Stronghold-Protocol-CDN/assets-raw/assets/char/avatar/char_1016_agoat2.png
```

`@assets-raw` pins the ref, which keeps these URLs stable even though the branch is rewritten.

## Why wholesale replacement instead of appending

At ~618 MiB per version and effectively no delta compression on binary art, keeping every version's
history would reach several GiB within a year and collide with repository size limits. Replacing the
tree keeps the branch at roughly one tree's worth of bytes forever.

The trade-off is deliberate and honest: **this branch has no usable history.** Do not rely on it for
provenance or rollback — for that use the `cdn/v1/index-*.json` snapshots on the R2 origin, which are
frozen per content token and retain their own history.

## Serving note

Do not point a JavaScript runtime at a raw githubusercontent host for art used in a `<img
crossOrigin>` or WebGL texture without checking `Access-Control-Allow-Origin` yourself — jsDelivr
and both gh mirrors were measured to send `*`, but that is a property of the CDN, not of this repo,
and it can change.
