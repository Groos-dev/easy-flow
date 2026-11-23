# Antigravity pet sources and previews

Original Google Antigravity artwork, resized static images, and a custom four-state
pet animation study. These files were moved into the easy-flow `main` checkout
at the user's request.

## Preview

Open `antigravity-pet-animations.html` for the standalone animated preview.
Open `antigravity-preview.html` for the standalone static asset preview.
Both files include their images, styles, and scripts; no server or dependencies
are needed for opening them in a normal browser.

The four custom animation states are `idle`, `thinking`, `working`, and `complete`.
The preview supports manual switching, a full workflow demo, pause, replay, speed,
size, backgrounds, and an optional face overlay.

## Files

- `antigravity-pet-assets/`: original official PNG/SVG files, normalized transparent PNGs, and provenance.
- `antigravity-pet-animations/`: reusable CSS/JS component, logo, preview, manifest, and usage instructions.
- `antigravity-pet-animations.html`: portable animated preview.
- `antigravity-preview.html`: portable static preview.
- `*.jpg`: browser verification screenshots.
- `*.zip`: portable asset and component packages.
- `tools/`: Python 3 build scripts; paths are resolved relative to this directory.
- `transfer-manifest.json`: SHA-256 inventory from the relocation.

## Rebuild

From the repository root, with Python 3 available:

```sh
python3 .pet-src/antigravity/tools/build_preview.py
python3 .pet-src/antigravity/tools/package_pet_animations.py
```

## Integration status

The preview is not yet connected to the production `Pet` renderer or live agent
events. It is source material for the Antigravity integration requirement
`req-ae642c2f64`. The animation component is HTML/CSS/JS, not an animated WebP.

Official artwork: https://antigravity.google/press
The original logo artwork is unchanged. Faces, props, and animations are custom
derivatives; this is not an official Google pet.
