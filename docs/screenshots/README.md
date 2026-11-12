# Screenshots

These images are captured automatically from the fictional demo library — no personal media or paths.

```bash
npm run demo:media          # once: generate demo/media (needs FFmpeg)
npm run demo:screenshots    # writes the PNGs in this folder
```

`demo/capture.js` starts the isolated demo server, seeds accounts and watch history, then drives a headless
Edge/Chrome (set `BROWSER=/path/to/browser` to choose) at 1280 × 800 (×1.5) for desktop and 390 × 844 (×2) for mobile.

| File | Shows |
|---|---|
| `library.png` | Home: continue-watching hero, shelf |
| `collection.png` | A course with expanded module sections |
| `player.png` | Player resumed mid-film with English subtitles and the playlist |
| `subtitles.png` | The subtitle panel open |
| `light.png` | Movies collection in light mode |
| `accounts.png` | Account manager (admin view) |
| `login.png` | Sign-in page |
| `mobile.png`, `mobile-player.png` | Phone layout |
| `banner.svg` | Hand-made README banner (not captured) |
