// App icon for the web app / iOS "Add to Home Screen" PWA.
//
// iOS uses the `apple-touch-icon` link to render the home-screen tile. Without
// it, iOS auto-generates an ugly screenshot/letter tile (the old black "C").
// The icon is a 180x180 PNG (an upward green trend arrow on a dark navy tile)
// generated once and embedded as base64 so it ships with the bundle and needs
// no static-asset hosting. Served at /apple-touch-icon.png by the icon route.
//
// The base64 below is split across lines and concatenated at build time — keep
// it intact; a truncated literal yields a corrupt PNG that iOS renders black.
//
// NOTE: iOS caches home-screen icons. To pick up a new icon, remove the
// shortcut and re-add it via Share -> Add to Home Screen.

const APP_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAEgUlEQVR42u3dTWoUQRiA4ZxDUARBUCRCghIQA4ZAQERwFRA3' +
  'brLJRoRsXATXHsADeIAcwAPkAB7As/jBQJRxetLVXf1T1Q+8y2iczDPd/XWqy50793alje34EQgOwSE4BIfgEByCQ3AIDsEh' +
  'wSE4BIfgEByCQ3AIDsEhOCQ4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4BAcGqann9+9+vnp9e+vgxbfIr4RHMV0' +
  '9/H+CCzWiMQ3haOARpZx4wOOAs4m48tYlfH8Akc9h43sBw84BmkqGavggAMOpxU4XJDC4eABh6a4CQaH2+dwOOTAoSFORnCQ' +
  'AQcZcJCR8boVDjLgIAMOMuBQLxktvx6OJcqIPwUHGY2Lh+Ego3FZORxkND5wAAcZjY+iwEFG40NKcJDR+PgaHGQ0PtgIBxn7' +
  'fR56gGOJMuAgYxcOMrpsoAAHGXCQkb7pChxkwEFG+kZNcBTZs28fRtjC61Z/Nm+ZXY/en4yzudutz+/b9mle3X9+cPLry2jb' +
  '/m05eNgwbnYdXp2PuSFk08WNrSZn197l6SRbhf77/L5NaufYg6OXE24iO3Rw9Dq8H19f1CoDjl69+HHW/rARx5jiXiAcHXty' +
  '9maSXYXhqGp2jQNMoS8Tjsx3GtYKQ8VdasAx0m3yh2+Pyn2lcKQVb3Z7GcGo6BcLR9rs2v5SI++dbDjqmV3DUFy0wrGUkrYz' +
  'j0G3gpcMR/7b5OXOrnAMu8Tr+Pqi3NkVjmFn1xJvk9eG4/9fWA/0eU1a4rV3eVrTp2KnxNP/xoN8HM+zXwYm3SY/vDqv7JBZ' +
  'GI74HG9/t4JIfM34S7zqmF0LxtH+3B9vav/71klLvDKKhCN5Xkhap3lDpPOnOWl2Lf02ecE44n1KWtu91sH3j6lEql/iVQmO' +
  'XP/NYpwj2r+F1S/xKh5HvJfxoc+4I3gcftoQWcISr7JxNM2r/ds+8S5kiVfBOG6dV7MQ2ThfLGSJV6k4Uh9H7tPaxLucJV7l' +
  '4eg2r2YhEmeTRS3xKgxHz3k1y+XqcpZ4lYSj87wa72hcOuQdahZ4m3ymOPrMq3E6uLkkjDdsnFNSHUu8CsDRZ17deNaP64ZB' +
  'iVQ/u84FR+d5dXUq2f43t7/5nTT9Vj+7zgJH53k1jjQtb1fH8T8vkYpvk88FR595Na5Okj678cV7l6dZhqDKlnjNEUefebXz' +
  'bzFWRHreCFnm4tmdIubV/of0GGe6jUWLml0nwJFrXs2yJjT1pFblEq+54Mg+r2Z5GLolkYXcJp8Gx3DzapZ/2/ZxpuIlXtPj' +
  'GGFe7V/TxEvGUDjGnFez/GtH2NMTjsnmVRWAY9p5VTPFMZ95VfPC0eH/oTEuLgVHNxkjzKuaGEe364wx51VNhqPDYWP8eVXT' +
  '4DCvwpEBh3nVacW8CkfKBal51ShrXoWj9U0w8yocf88vfrcJh+AQHBIcgkNwCA7BITgEh+AQHIJDgkNwCA7BITgEh+AQHIJD' +
  'cEhwCA7BITgEh+AQHIJDcAgOweGnIDgEh+AQHIJDcAgOwaG6+wPAouiASqrphAAAAABJRU5ErkJggg==';

/** Raw PNG bytes, ready to send as the body of an image/png response. */
export const APP_ICON_PNG_BUFFER = Buffer.from(APP_ICON_PNG_BASE64, 'base64');

// Bump this when the icon bytes change. iOS caches the apple-touch-icon hard
// (an earlier deploy served a corrupt PNG with `immutable`, which iOS pinned
// for days). The version query forces iOS/Safari to fetch a fresh URL instead
// of serving the stale cached copy.
export const ICON_VERSION = 'v=2';

/** `<head>` tags that point browsers + iOS at the app icon. Inject into every page head. */
export const ICON_HEAD_TAGS =
  `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?${ICON_VERSION}">` +
  `<link rel="apple-touch-icon-precomposed" sizes="180x180" href="/apple-touch-icon.png?${ICON_VERSION}">` +
  `<link rel="icon" type="image/png" sizes="180x180" href="/apple-touch-icon.png?${ICON_VERSION}">` +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">';
