# AstroShed PixInsight Scripts

## Dust Lane Enhancer

Deepens dust lanes and dark filaments. It finds them by their **shape** (long, dark ridges), not by their brightness, and darkens only where it found one. Flat sky, stars and anything brighter than its surroundings are left alone.

- Works on the active image; the result opens as a **new image**, and the original is not changed.
- A built-in preview, with zoom and pan. From 60% zoom the preview shows full resolution, exactly what Run will produce there.
- Use it on a **stretched** image, preferably a **starless** one: bright stars can leave a faint ring-shaped response.

### Settings

| Setting | What it does |
|---|---|
| Smallest structure (px) | The narrowest lane to look for, in pixels of the full-size image. |
| Largest structure (px) | The widest lane to look for. Also sets how wide an area each pixel is compared with. |
| Sensitivity | How faint a lane may be and still be found. Higher reaches fainter structure but picks up more noise. |
| Enhance amount | How much the lanes found are deepened. 0 changes nothing. |
| Show detection map | Shows what was found (white = a lane) instead of the result. |

### Installing

**From PixInsight's update system**

1. In PixInsight choose *Resources > Updates > Manage Repositories*.
2. Press *Add* and enter:
   `https://raw.githubusercontent.com/Astro5hed/AstroShed-PixInsight-Scripts/main/repository/`
3. Choose *Resources > Updates > Check for Updates*, install, and restart PixInsight when asked.
4. The script is under *Script > Utilities > DustLaneEnhancer*.

**By hand**

1. Download `DustLaneEnhancer.js` from this page.
2. In PixInsight choose *Script > Execute Script File* and pick it. To have it in the Script menu, use *Script > Feature Scripts*, add the folder you saved it in, and press *Done*.

### Versions

- **1.2.2** - first public version.

### How it works

A Frangi "vesselness" measure (Frangi et al., 1998) is taken at four sizes between Smallest and Largest structure on a reduced working copy of the luminance. Each size is weighted by its size squared, so wide shallow lanes are not lost, and the threshold is set from the image's own noise floor, so bright stars do not drown faint lanes. The result is then `image + amount * map * min(image - blurred image, 0)`, so a lane gets darker and nothing is ever made brighter.

From the Dust Lane Enhancer tool by AstroShed (astroshed.co.uk).
