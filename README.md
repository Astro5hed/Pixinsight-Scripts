# PixInsight Scripts

## Dust Lane Enhancer
Before & After Images:
<img width="1679" height="947" alt="image" src="https://github.com/user-attachments/assets/2d7d7704-5a7d-457c-b6a9-676002d8b520" />
<img width="1679" height="947" alt="image" src="https://github.com/user-attachments/assets/2afa5719-bc98-46a0-93d1-dbe54a9049c0" />
<img width="1000" height="761" alt="DustLaneEnhancer" src="https://github.com/user-attachments/assets/558e6af1-3157-4354-a762-7ac534b04d69" />


Deepens dust lanes and dark filaments. It finds them by their **shape** (long, dark ridges), not by their brightness, and darkens only where it found one. Flat sky, stars and anything brighter than its surroundings are left alone.

- Works on the active image. With **Create a new image** ticked (the default) the result opens as a new image and the original is not changed; unticked, **Apply** changes the image itself, and PixInsight's Undo takes it back.
- A built-in preview, with zoom and pan. From 60% zoom the preview shows full resolution, exactly what Apply will produce there.
- Use it on a **stretched** image, preferably a **starless** one: bright stars can leave a faint ring-shaped response.

### Settings

| Setting | What it does |
|---|---|
| Smallest structure (px) | The narrowest lane to look for, in pixels of the full-size image. |
| Largest structure (px) | The widest lane to look for. Also sets how wide an area each pixel is compared with. |
| Sensitivity | How faint a lane may be and still be found. Higher reaches fainter structure but picks up more noise. |
| Enhance amount | How much the lanes found are deepened. 0 changes nothing. |
| Show detection map | Shows what was found (white = a lane) instead of the result. The map always opens as a new image. |
| Create a new image | Ticked: the result opens as a new image. Unticked: Apply changes the active image itself (Undo takes it back). |

### Installing

**From PixInsight's update system**

1. In PixInsight choose *Resources > Updates > Manage Repositories*.
2. Press *Add* and enter:
   `https://raw.githubusercontent.com/Astro5hed/Pixinsight-Scripts/main/repository/`
3. Choose *Resources > Updates > Check for Updates*, install, and restart PixInsight when asked.
4. The script is under *Script > AstroShed > Dust Lane Enhancer*.

**By hand**

1. Download `DustLaneEnhancer.js` from this page.
2. In PixInsight choose *Script > Execute Script File* and pick it. To have it in the Script menu, use *Script > Feature Scripts*, add the folder you saved it in, and press *Done*.

### Versions

- **1.3.0** - new window layout: large title, Create a new image option, and a big Apply button (was Run).
- **1.2.9** - shows its author and website (Stewart Oliver, AstroShed).
- **1.2.8** - fixed Run stopping with "read-only image" when making the result.
- **1.2.7** - its own AstroShed folder in the Script menu, and its icon now shows.
- **1.2.4 - 1.2.6** - icon work.
- **1.2.4** - added its own icon.
- **1.2.3** - removed a harmless warning shown in the console when the script starts.
- **1.2.2** - first public version.

### How it works

A Frangi "vesselness" measure (Frangi et al., 1998) is taken at four sizes between Smallest and Largest structure on a reduced working copy of the luminance. Each size is weighted by its size squared, so wide shallow lanes are not lost, and the threshold is set from the image's own noise floor, so bright stars do not drown faint lanes. The result is then `image + amount * map * min(image - blurred image, 0)`, so a lane gets darker and nothing is ever made brighter.

From the Dust Lane Enhancer tool in PhotonWorks by AstroShed (astroshed.co.uk).
