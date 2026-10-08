// ============================================================================
// Dust Lane Enhancer  -  version 1.2.9
// Copyright (c) 2026 Stewart Oliver, AstroShed. astroshed.co.uk
//
// Deepens dust lanes and dark filaments. It finds them by SHAPE (long, dark
// ridges) and not by brightness, then darkens only where it found one.
// Flat sky and anything brighter than its surroundings are left alone.
//
// The method is the Dust Lane Enhancer tool of PhotonWorks (AstroShed), with
// the same controls and the same arithmetic:
//
//   1. Luminance is reduced to a small working copy (at most 1600 px wide).
//   2. A Frangi "vesselness" measure (Frangi et al. 1998) is taken at four
//      sizes between Smallest and Largest Structure. It is high on dark
//      ridges and low on blobs (stars) and flat sky. Two changes from the
//      textbook version make it suit astro images: each size is weighted by
//      its size squared, so wide shallow lanes are not lost, and the
//      threshold is set from the image's own noise floor, so bright stars
//      do not drown the faint lanes.
//   3. result = image + Amount * map * min(image - blurred image, 0)
//      so a lane (darker than its surroundings) gets darker and nothing is
//      ever made brighter.
//
// Use it on a STRETCHED image, and preferably a STARLESS one: bright stars
// can leave a faint ring-shaped response of their own.
//
// The image you run it on is not changed. The result opens as a new image.
// Preview shows the effect before you run it: wheel to zoom, drag to move.
// The whole image is shown from a reduced copy; zoom in and the part you are
// looking at is worked out from the full-size image: full resolution, with
// nothing added - exactly what Run gives there.
// ============================================================================

#feature-id    DustLaneEnhancer : AstroShed > Dust Lane Enhancer
#feature-icon  @script_icons_dir/DustLaneEnhancer.svg
#feature-info  Deepens dust lanes and dark filaments, found by their shape \
               rather than their brightness. Works on the active image and \
               writes the result to a new image. \
               Copyright &copy; 2026 Stewart Oliver, AstroShed. astroshed.co.uk

#include <pjsr/Sizer.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/SampleType.jsh>

#define DLE_TITLE    "Dust Lane Enhancer"
#define DLE_VERSION  "1.2.9"
#define DLE_KEY      "DustLaneEnhancer/"

// ============================================================================
// ENGINE-BEGIN  (plain arithmetic on arrays: nothing below, down to
// ENGINE-END, uses the host application)
// ============================================================================

var DLE_DET_MAX = 1600;      // widest working copy for the detection, in pixels
var DLE_WORK_SIGMA = 4.0;    // the largest structure is brought down to about this size

// Rounds to the nearest whole number, halves to the even one.
function dleRound(v) {
   var f = Math.floor(v);
   var d = v - f;
   if (d > 0.5) return f + 1;
   if (d < 0.5) return f;
   return (f % 2 === 0) ? f : f + 1;
}

// index -1 -> 0, -2 -> 1 ... (the edge pixel is repeated)
function dleReflect(i, n) {
   if (n === 1) return 0;
   while (i < 0 || i >= n) {
      if (i < 0) i = -i - 1;
      else i = 2 * n - 1 - i;
   }
   return i;
}

// index -1 -> 1, -2 -> 2 ... (the edge pixel is not repeated)
function dleReflect101(i, n) {
   if (n === 1) return 0;
   while (i < 0 || i >= n) {
      if (i < 0) i = -i;
      else i = 2 * n - 2 - i;
   }
   return i;
}

// A Gaussian (order 0) or its first derivative (order 1), sampled at
// -radius .. +radius. k[radius + t] is the value at offset t.
function dleGaussKernel(sigma, order, radius) {
   var n = 2 * radius + 1;
   var k = new Float64Array(n);
   var sum = 0;
   var t;
   for (t = -radius; t <= radius; ++t) {
      k[radius + t] = Math.exp(-0.5 / (sigma * sigma) * t * t);
      sum += k[radius + t];
   }
   for (t = 0; t < n; ++t) k[t] /= sum;
   if (order === 1)
      for (t = -radius; t <= radius; ++t) k[radius + t] *= -t / (sigma * sigma);
   return k;
}

// One pass along x or along y: out(p) = sum over d of wgt[radius + d] * src(p + d).
// reflect is dleReflect or dleReflect101.
function dlePass(src, w, h, wgt, radius, alongX, reflect) {
   var out = new Float32Array(w * h);
   var n = alongX ? w : h;
   var lines = alongX ? h : w;
   var step = alongX ? 1 : w;
   var taps = 2 * radius + 1;
   var pad = new Float64Array(n + 2 * radius);
   var idx = new Int32Array(n + 2 * radius);
   var i, j, l, base, acc;
   for (i = 0; i < n + 2 * radius; ++i) idx[i] = reflect(i - radius, n);
   for (l = 0; l < lines; ++l) {
      base = alongX ? l * w : l;
      for (i = 0; i < n + 2 * radius; ++i) pad[i] = src[base + idx[i] * step];
      for (i = 0; i < n; ++i) {
         acc = 0;
         for (j = 0; j < taps; ++j) acc += wgt[j] * pad[i + j];
         out[base + i * step] = acc;
      }
   }
   return out;
}

// Gaussian smoothing or first derivative along each axis (orderY down the
// rows, orderX across), edges mirrored with the edge pixel repeated.
function dleGaussDeriv(img, w, h, sigma, orderY, orderX, truncate) {
   var radius = Math.floor(truncate * sigma + 0.5);
   // beyond 12 sigma a Gaussian is below 1e-31 of its peak: not worth the time
   var cap = Math.ceil(12 * sigma) + 1;
   if (radius > cap) radius = cap;
   var kx = dleGaussKernel(sigma, orderX, radius);
   var ky = dleGaussKernel(sigma, orderY, radius);
   var n = 2 * radius + 1;
   var wx = new Float64Array(n), wy = new Float64Array(n);
   // a true convolution: the weight for offset d is the kernel at -d
   for (var d = -radius; d <= radius; ++d) {
      wx[radius + d] = kx[radius - d];
      wy[radius + d] = ky[radius - d];
   }
   var tmp = dlePass(img, w, h, wx, radius, true, dleReflect);
   return dlePass(tmp, w, h, wy, radius, false, dleReflect);
}

// Gaussian blur, edges mirrored without repeating the edge pixel.
// How far a Gaussian blur of this sigma reaches to either side, in pixels.
function dleBlurRadius(sigma) {
   var ksize = dleRound(sigma * 8 + 1);
   if (ksize % 2 === 0) ksize += 1;
   return (ksize - 1) / 2;
}

function dleGaussianBlur(img, w, h, sigma) {
   var radius = dleBlurRadius(sigma);
   var ksize = 2 * radius + 1;
   var k = new Float64Array(ksize);
   var sum = 0, i;
   for (i = 0; i < ksize; ++i) {
      k[i] = Math.exp(-((i - radius) * (i - radius)) / (2 * sigma * sigma));
      sum += k[i];
   }
   for (i = 0; i < ksize; ++i) k[i] /= sum;
   var tmp = dlePass(img, w, h, k, radius, true, dleReflect101);
   return dlePass(tmp, w, h, k, radius, false, dleReflect101);
}

// The weights that shrink one axis from n to m pixels by averaging the
// AREA each new pixel covers. Returns {start, count, weight} per new pixel.
function dleAreaTable(n, m) {
   var scale = n / m;
   var tab = [];
   for (var d = 0; d < m; ++d) {
      var f1 = d * scale, f2 = f1 + scale;
      var cell = Math.min(scale, n - f1);
      var s1 = Math.ceil(f1), s2 = Math.floor(f2);
      if (s2 > n - 1) s2 = n - 1;
      if (s1 > s2) s1 = s2;
      var idx = [], wt = [];
      if (s1 - f1 > 1e-3) { idx.push(s1 - 1); wt.push((s1 - f1) / cell); }
      for (var s = s1; s < s2; ++s) { idx.push(s); wt.push(1.0 / cell); }
      if (f2 - s2 > 1e-3) { idx.push(s2); wt.push(Math.min(Math.min(f2 - s2, 1.0), cell) / cell); }
      tab.push({ idx: idx, wt: wt });
   }
   return tab;
}

// Shrinks an image by area averaging (never used to enlarge).
function dleResizeArea(src, w, h, dw, dh) {
   if (dw === w && dh === h) return new Float32Array(src);
   var tx = dleAreaTable(w, dw), ty = dleAreaTable(h, dh);
   var tmp = new Float32Array(dw * h);
   var x, y, k, acc, e, row;
   for (y = 0; y < h; ++y) {
      row = y * w;
      for (x = 0; x < dw; ++x) {
         e = tx[x];
         acc = 0;
         for (k = 0; k < e.idx.length; ++k) acc += e.wt[k] * src[row + e.idx[k]];
         tmp[y * dw + x] = acc;
      }
   }
   var out = new Float32Array(dw * dh);
   for (y = 0; y < dh; ++y) {
      e = ty[y];
      for (x = 0; x < dw; ++x) {
         acc = 0;
         for (k = 0; k < e.idx.length; ++k) acc += e.wt[k] * tmp[e.idx[k] * dw + x];
         out[y * dw + x] = acc;
      }
   }
   return out;
}

// For enlarging one axis from n to m pixels by straight-line interpolation:
// new pixel d lies between old pixels i0[d] and i1[d], a fraction fr[d] along.
function dleLinearTable(n, m) {
   var scale = n / m;
   var i0 = new Int32Array(m), i1 = new Int32Array(m), fr = new Float64Array(m);
   for (var d = 0; d < m; ++d) {
      var f = (d + 0.5) * scale - 0.5;
      var s = Math.floor(f);
      f -= s;
      if (s < 0) { s = 0; f = 0; }
      if (s >= n - 1) { s = n - 1; f = 0; }
      i0[d] = s;
      i1[d] = Math.min(s + 1, n - 1);
      fr[d] = f;
   }
   return { i0: i0, i1: i1, fr: fr };
}

// The value in the middle of a list (the mean of the middle two for an even
// count). Rearranges the array it is given.
function dleMedian(a) {
   var n = a.length;
   if (n === 0) return 0;
   function select(k) {
      var lo = 0, hi = n - 1;
      while (lo < hi) {
         var pivot = a[(lo + hi) >> 1];
         var i = lo, j = hi;
         while (i <= j) {
            while (a[i] < pivot) ++i;
            while (a[j] > pivot) --j;
            if (i <= j) {
               var t = a[i]; a[i] = a[j]; a[j] = t;
               ++i; --j;
            }
         }
         if (k <= j) hi = j;
         else if (k >= i) lo = i;
         else break;
      }
      return a[k];
   }
   var mid = n >> 1;
   var upper = select(mid);
   if (n % 2 === 1) return upper;
   var lower = a[0];
   for (var i = 1; i < mid; ++i) if (a[i] > lower) lower = a[i];
   return (lower + upper) / 2;
}

// The Frangi vesselness of DARK ridges, the largest response over the
// given sizes. Returns a map in [0,1] the size of the image.
function dleVesselness(img, w, h, sigmas, beta, sensitivity, progress) {
   var n = w * h;
   var best = new Float32Array(n);
   var s = new Float32Array(n), rb = new Float32Array(n);
   var sorted = new Float32Array(n);
   var i;
   for (var si = 0; si < sigmas.length; ++si) {
      var sigma = sigmas[si];
      if (progress) progress("size " + (si + 1) + " of " + sigmas.length);
      var ss = sigma / Math.sqrt(2);
      var truncate = (ss > 1) ? 8 : 100;
      // the second derivatives, as two first-derivative passes at sigma / sqrt(2)
      var gy = dleGaussDeriv(img, w, h, ss, 1, 0, truncate);
      var gx = dleGaussDeriv(img, w, h, ss, 0, 1, truncate);
      var norm = sigma * sigma;                    // weight each size by its size squared
      var Hyy = dleGaussDeriv(gy, w, h, ss, 1, 0, truncate);
      var Hyx = dleGaussDeriv(gy, w, h, ss, 0, 1, truncate);
      gy = null;
      var Hxx = dleGaussDeriv(gx, w, h, ss, 0, 1, truncate);
      gx = null;
      for (i = 0; i < n; ++i) {
         var a = Hyy[i] * norm, b = Hyx[i] * norm, c = Hxx[i] * norm;
         var half = (a + c) / 2;
         var disc = Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
         var e1 = half + disc, e2 = half - disc;
         var l1, l2raw;
         if (Math.abs(e1) > Math.abs(e2)) { l1 = e2; l2raw = e1; }
         else { l1 = e1; l2raw = e2; }
         var l2 = (l2raw > 1e-10) ? l2raw : 1e-10; // a ridge of the wrong polarity scores nothing
         rb[i] = Math.abs(l1) / l2;
         s[i] = Math.sqrt(l1 * l1 + l2raw * l2raw);
      }
      Hyy = Hyx = Hxx = null;
      sorted.set(s);
      // most of any astro image is sky, so the middle value IS the noise floor
      var floor = dleMedian(sorted) + 1e-12;
      var gamma = floor * (20.0 / Math.max(sensitivity, 0.5));
      var twoB = 2 * beta * beta, twoG = 2 * gamma * gamma;
      for (i = 0; i < n; ++i) {
         var v = Math.exp(-(rb[i] * rb[i]) / twoB) * (1.0 - Math.exp(-(s[i] * s[i]) / twoG));
         if (v > best[i]) best[i] = v;
      }
   }
   return best;
}

// The four sizes to look at, in working-copy pixels: evenly spaced from
// smallest to largest, none below 0.6, no duplicates.
function dleSigmas(minScale, maxScale, factor) {
   var out = [];
   for (var i = 0; i < 4; ++i) {
      var v = (minScale + (maxScale - minScale) * i / 3) * factor;
      if (v < 0.6) v = 0.6;
      out.push(v);
   }
   out.sort(function (a, b) { return a - b; });
   var u = [out[0]];
   for (i = 1; i < out.length; ++i) if (out[i] !== u[u.length - 1]) u.push(out[i]);
   return u;
}

// The detection map from full-resolution luminance. Sizes are in
// full-resolution pixels. Returns {map, w, h}: a SMALL map, to be enlarged.
// keep (optional) is an object that holds the working copy between calls, so
// that changing a setting does not shrink the same image all over again.
function dleDetectionMap(lum, w, h, minScale, maxScale, sensitivity, progress, keep) {
   if (maxScale < minScale + 0.1) maxScale = minScale + 0.1;
   var factor = Math.min(DLE_DET_MAX / w, DLE_WORK_SIGMA / maxScale, 1.0);
   var dw = Math.max(32, dleRound(w * factor));
   var dh = Math.max(32, dleRound(h * factor));
   if (dw > w) dw = w;
   if (dh > h) dh = h;
   var det;
   if (keep && keep.lum === lum && keep.dw === dw && keep.dh === dh) {
      det = keep.det;
   } else {
      det = dleResizeArea(lum, w, h, dw, dh);
      if (keep) { keep.lum = lum; keep.dw = dw; keep.dh = dh; keep.det = det; }
   }
   var sigmas = dleSigmas(minScale, maxScale, dw / w);
   var V = dleVesselness(det, dw, dh, sigmas, 0.5, sensitivity, progress);
   V = dleGaussianBlur(V, dw, dh, 1.0);
   for (var i = 0; i < V.length; ++i) V[i] = (V[i] < 0) ? 0 : (V[i] > 1 ? 1 : V[i]);
   return { map: V, w: dw, h: dh };
}

// Enlarges a small map to w x h (straight-line interpolation).
function dleEnlarge(small, sw, sh, w, h) {
   var out = new Float32Array(w * h);
   var tx = dleLinearTable(sw, w), ty = dleLinearTable(sh, h);
   for (var y = 0; y < h; ++y) {
      var r0 = ty.i0[y] * sw, r1 = ty.i1[y] * sw, fy = ty.fr[y];
      var o = y * w;
      for (var x = 0; x < w; ++x) {
         var x0 = tx.i0[x], x1 = tx.i1[x], fx = tx.fr[x];
         var top = small[r0 + x0] + (small[r0 + x1] - small[r0 + x0]) * fx;
         var bot = small[r1 + x0] + (small[r1 + x1] - small[r1 + x0]) * fx;
         out[o + x] = top + (bot - top) * fy;
      }
   }
   return out;
}

// Deepens the lanes in ONE channel, in place.
//   chan   the channel's pixels, 0..1          V   the detection map, full size
//   scale  1 for the full image; for a reduced copy, its width / full width,
//          so the same settings mean the same thing on both
// Only ever darkens: where a pixel is brighter than its surroundings (a
// star, a bright knot) the change is exactly zero.
function dleEnhanceChannel(chan, w, h, V, maxScale, amount, scale) {
   if (!scale) scale = 1;
   var blurSigma = Math.max(1.5, maxScale * 1.5 * scale);
   var bg;
   if (blurSigma >= 6.0) {
      // a blur this wide holds nothing fine, so it is made at half size
      var bw = Math.max(1, Math.floor(w / 2)), bh = Math.max(1, Math.floor(h / 2));
      var small = dleResizeArea(chan, w, h, bw, bh);
      small = dleGaussianBlur(small, bw, bh, Math.max(0.6, blurSigma / 2.0));
      bg = dleEnlarge(small, bw, bh, w, h);
   } else {
      bg = dleGaussianBlur(chan, w, h, blurSigma);
   }
   for (var i = 0; i < chan.length; ++i) {
      var diff = chan[i] - bg[i];
      if (diff > 0) diff = 0;
      var v = chan[i] + amount * V[i] * diff;
      chan[i] = (v < 0) ? 0 : (v > 1 ? 1 : v);
   }
}

// The part of the result that does not depend on Amount, for one channel:
// map * min(channel - blurred channel, 0). The result is then simply
// channel + Amount * this, which is why the preview can follow the Amount
// slider at once. (dleEnhanceChannel does the same sum in one go.)
function dleDarkening(chan, w, h, V, maxScale, scale) {
   var zero = new Float32Array(chan);
   // with Amount 1 and no clipping: zero - chan is exactly the term wanted
   var blurSigma = Math.max(1.5, maxScale * 1.5 * (scale ? scale : 1));
   var bg;
   if (blurSigma >= 6.0) {
      var bw = Math.max(1, Math.floor(w / 2)), bh = Math.max(1, Math.floor(h / 2));
      var small = dleResizeArea(chan, w, h, bw, bh);
      small = dleGaussianBlur(small, bw, bh, Math.max(0.6, blurSigma / 2.0));
      bg = dleEnlarge(small, bw, bh, w, h);
   } else {
      bg = dleGaussianBlur(chan, w, h, blurSigma);
   }
   for (var i = 0; i < zero.length; ++i) {
      var diff = chan[i] - bg[i];
      zero[i] = (diff > 0) ? 0 : V[i] * diff;
   }
   return zero;
}

// ---- one AREA of the full-size image, for the zoomed-in preview -------------
// These give, for a rectangle x0,y0,rw,rh of the full image, exactly what the
// whole-image functions above give there, without doing the whole image.

function dleCrop(img, w, x0, y0, rw, rh) {
   var out = new Float32Array(rw * rh);
   for (var y = 0; y < rh; ++y) {
      var src = (y0 + y) * w + x0;
      for (var x = 0; x < rw; ++x) out[y * rw + x] = img[src + x];
   }
   return out;
}

// dleEnlarge, for one rectangle of the enlarged picture.
function dleEnlargeRegion(small, sw, sh, w, h, x0, y0, rw, rh) {
   var out = new Float32Array(rw * rh);
   var tx = dleLinearTable(sw, w), ty = dleLinearTable(sh, h);
   for (var y = 0; y < rh; ++y) {
      var Y = y0 + y;
      var r0 = ty.i0[Y] * sw, r1 = ty.i1[Y] * sw, fy = ty.fr[Y];
      for (var x = 0; x < rw; ++x) {
         var X = x0 + x;
         var a = tx.i0[X], b = tx.i1[X], fx = tx.fr[X];
         var top = small[r0 + a] + (small[r0 + b] - small[r0 + a]) * fx;
         var bot = small[r1 + a] + (small[r1 + b] - small[r1 + a]) * fx;
         out[y * rw + x] = top + (bot - top) * fy;
      }
   }
   return out;
}

// The blurred surroundings (what each pixel is compared with) for one
// rectangle of a full-size channel. The blur needs the pixels around the
// rectangle too, so a margin as wide as the blur reaches is worked on and
// then thrown away.
function dleRegionBackground(chan, w, h, x0, y0, rw, rh, maxScale) {
   var blurSigma = Math.max(1.5, maxScale * 1.5);
   var out = new Float32Array(rw * rh);
   var x, y, radius, cx0, cy0, cx1, cy1, cw, ch, crop;
   if (blurSigma < 6.0) {
      radius = dleBlurRadius(blurSigma);
      cx0 = Math.max(0, x0 - radius); cy0 = Math.max(0, y0 - radius);
      cx1 = Math.min(w - 1, x0 + rw - 1 + radius); cy1 = Math.min(h - 1, y0 + rh - 1 + radius);
      cw = cx1 - cx0 + 1; ch = cy1 - cy0 + 1;
      crop = dleGaussianBlur(dleCrop(chan, w, cx0, cy0, cw, ch), cw, ch, blurSigma);
      for (y = 0; y < rh; ++y)
         for (x = 0; x < rw; ++x)
            out[y * rw + x] = crop[(y0 + y - cy0) * cw + (x0 + x - cx0)];
      return out;
   }
   // the half-size route, as dleEnhanceChannel takes
   var bw = Math.max(1, Math.floor(w / 2)), bh = Math.max(1, Math.floor(h / 2));
   var lx = dleLinearTable(bw, w), ly = dleLinearTable(bh, h);
   var sigma = Math.max(0.6, blurSigma / 2.0);
   radius = dleBlurRadius(sigma);
   // the half-size pixels the rectangle is enlarged from, plus the blur's reach
   cx0 = Math.max(0, lx.i0[x0] - radius); cy0 = Math.max(0, ly.i0[y0] - radius);
   cx1 = Math.min(bw - 1, lx.i1[x0 + rw - 1] + radius); cy1 = Math.min(bh - 1, ly.i1[y0 + rh - 1] + radius);
   cw = cx1 - cx0 + 1; ch = cy1 - cy0 + 1;
   var tx = dleAreaTable(w, bw), ty = dleAreaTable(h, bh);
   crop = new Float32Array(cw * ch);
   var row = new Float64Array(cw);
   var k, e, acc, j, ey;
   for (y = 0; y < ch; ++y) {
      ey = ty[cy0 + y];
      for (x = 0; x < cw; ++x) row[x] = 0;
      for (j = 0; j < ey.idx.length; ++j) {
         var base = ey.idx[j] * w, wy = ey.wt[j];
         for (x = 0; x < cw; ++x) {
            e = tx[cx0 + x];
            acc = 0;
            for (k = 0; k < e.idx.length; ++k) acc += e.wt[k] * chan[base + e.idx[k]];
            row[x] += wy * acc;
         }
      }
      for (x = 0; x < cw; ++x) crop[y * cw + x] = row[x];
   }
   crop = dleGaussianBlur(crop, cw, ch, sigma);
   for (y = 0; y < rh; ++y) {
      var Y = y0 + y;
      var r0 = (ly.i0[Y] - cy0) * cw, r1 = (ly.i1[Y] - cy0) * cw, fy = ly.fr[Y];
      for (x = 0; x < rw; ++x) {
         var X = x0 + x;
         var a = lx.i0[X] - cx0, b = lx.i1[X] - cx0, fx = lx.fr[X];
         var top = crop[r0 + a] + (crop[r0 + b] - crop[r0 + a]) * fx;
         var bot = crop[r1 + a] + (crop[r1 + b] - crop[r1 + a]) * fx;
         out[y * rw + x] = top + (bot - top) * fy;
      }
   }
   return out;
}

// dleDarkening, for one rectangle of a full-size channel. Vr is the
// detection map for the same rectangle (dleEnlargeRegion).
function dleRegionDark(chan, w, h, Vr, x0, y0, rw, rh, maxScale) {
   var bg = dleRegionBackground(chan, w, h, x0, y0, rw, rh, maxScale);
   for (var y = 0; y < rh; ++y) {
      var src = (y0 + y) * w + x0;
      for (var x = 0; x < rw; ++x) {
         var i = y * rw + x;
         var diff = chan[src + x] - bg[i];
         bg[i] = (diff > 0) ? 0 : Vr[i] * diff;
      }
   }
   return bg;
}

// ============================================================================
// ENGINE-END
// ============================================================================

// The settings, remembered between runs.
function DLEParameters() {
   this.minScale = 3.0;
   this.maxScale = 20.0;
   this.sensitivity = 3.0;
   this.amount = 1.5;
   this.showMap = false;

   this.reset = function () {
      this.minScale = 3.0;
      this.maxScale = 20.0;
      this.sensitivity = 3.0;
      this.amount = 1.5;
      this.showMap = false;
   };

   this.load = function () {
      try {
         var v;
         v = Settings.read(DLE_KEY + "minScale", DataType_Double);
         if (Settings.lastReadOK) this.minScale = v;
         v = Settings.read(DLE_KEY + "maxScale", DataType_Double);
         if (Settings.lastReadOK) this.maxScale = v;
         v = Settings.read(DLE_KEY + "sensitivity", DataType_Double);
         if (Settings.lastReadOK) this.sensitivity = v;
         v = Settings.read(DLE_KEY + "amount", DataType_Double);
         if (Settings.lastReadOK) this.amount = v;
         v = Settings.read(DLE_KEY + "showMap", DataType_Boolean);
         if (Settings.lastReadOK) this.showMap = v;
      } catch (e) {
         // no saved settings yet: the defaults stand
      }
   };

   this.save = function () {
      try {
         Settings.write(DLE_KEY + "minScale", DataType_Double, this.minScale);
         Settings.write(DLE_KEY + "maxScale", DataType_Double, this.maxScale);
         Settings.write(DLE_KEY + "sensitivity", DataType_Double, this.sensitivity);
         Settings.write(DLE_KEY + "amount", DataType_Double, this.amount);
         Settings.write(DLE_KEY + "showMap", DataType_Boolean, this.showMap);
      } catch (e) {
         // not being able to remember the settings must not stop the run
      }
   };
}

// One channel of an image as a Float32Array, row by row.
function dleReadChannel(image, c) {
   var w = image.width, h = image.height;
   var buf = new Float32Array(w * h);
   try {
      image.getSamples(buf, new Rect(0, 0, w, h), c);
   } catch (e) {
      // the slow, certain way
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x)
            buf[y * w + x] = image.sample(x, y, c);
   }
   return buf;
}

function dleWriteChannel(image, buf, c) {
   var w = image.width, h = image.height;
   try {
      image.setSamples(buf, new Rect(0, 0, w, h), c);
   } catch (e) {
      for (var y = 0; y < h; ++y)
         for (var x = 0; x < w; ++x)
            image.setSample(buf[y * w + x], x, y, c);
   }
}

// The detection for one image at one group of settings, kept so that a
// preview and the run that follows it do the slow part once.
//   cache = { id, w, h, key, det }   (det is the SMALL map, see dleDetectionMap)
function dleDetectionFor(cache, viewId, lum, w, h, p, progress) {
   var key = viewId + "|" + w + "x" + h + "|" + p.minScale + "|" + p.maxScale + "|" + p.sensitivity;
   if (cache.key !== key || !cache.det) {
      cache.det = dleDetectionMap(lum, w, h, p.minScale, p.maxScale, p.sensitivity, progress, cache.keep);
      cache.key = key;
   }
   return cache.det;
}

function dleLuminance(channels, n) {
   if (channels.length === 1) return channels[0];
   var lum = new Float32Array(n);
   var R = channels[0], G = channels[1], B = channels[2];
   for (var i = 0; i < n; ++i) lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
   return lum;
}

function dleClamp01(a) {
   for (var i = 0; i < a.length; ++i) a[i] = (a[i] < 0) ? 0 : (a[i] > 1 ? 1 : a[i]);
   return a;
}

// Runs the tool on a window's image and opens the result as a new image.
// held (optional): { channels, lum } already read from this image by the
// preview, so they are not read a second time.
function dleRun(sourceWindow, p, cache, held) {
   var view = sourceWindow.mainView;
   var image = view.image;
   var w = image.width, h = image.height;
   var nch = image.isColor ? 3 : 1;
   var started = new Date();

   console.show();
   console.writeln("<end><cbr><br><b>" + DLE_TITLE + " " + DLE_VERSION + "</b>");
   console.writeln("Copyright \u00A9 2026 Stewart Oliver, AstroShed. astroshed.co.uk");
   console.writeln("Image: " + view.id + "  (" + w + " x " + h + ", " + (nch === 3 ? "colour" : "mono") + ")");
   console.writeln(format("Smallest %.1f px, largest %.1f px, sensitivity %.1f, amount %.2f",
                          p.minScale, p.maxScale, p.sensitivity, p.amount));
   processEvents();

   // 1. luminance
   var channels = [];
   var c, lum;
   if (held) {
      channels = held.channels;
      lum = held.lum;
   } else {
      for (c = 0; c < nch; ++c) channels.push(dleReadChannel(image, c));
      lum = dleLuminance(channels, w * h);
   }

   // 2. the detection map
   console.writeln("Finding the lanes...");
   processEvents();
   var det = dleDetectionFor(cache, view.id, lum, w, h, p, function (what) {
      console.writeln("   " + what);
      processEvents();
   });
   lum = null;
   var V = dleClamp01(dleEnlarge(det.map, det.w, det.h, w, h));

   // 3. the result
   var result;
   if (p.showMap) {
      result = new ImageWindow(w, h, 1, 32, true, false, view.id + "_dust_map");
      result.mainView.beginProcess(UndoFlag_NoSwapFile);
      dleWriteChannel(result.mainView.image, V, 0);
      result.mainView.endProcess();
   } else {
      // deepen every channel first ...
      var done = [];
      for (c = 0; c < nch; ++c) {
         console.writeln("Deepening " + (nch === 3 ? ["red", "green", "blue"][c] : "the image") + "...");
         processEvents();
         // the preview's own copy must stay as it is, so work on a copy of it
         var chan = held ? new Float32Array(channels[c]) : channels[c];
         dleEnhanceChannel(chan, w, h, V, p.maxScale, p.amount, 1);
         done.push(chan);
         chan = null;
         if (!held) channels[c] = null;
      }
      // ... then write them all in one go, with nothing else in between
      result = new ImageWindow(w, h, nch, 32, true, nch === 3, view.id + "_dust");
      result.mainView.beginProcess(UndoFlag_NoSwapFile);
      for (c = 0; c < nch; ++c) dleWriteChannel(result.mainView.image, done[c], c);
      result.mainView.endProcess();
      done = null;
      try {
         result.keywords = sourceWindow.keywords;   // keep the image's header
      } catch (e) {
         // the header is a convenience; the result is still good without it
      }
   }
   result.show();
   console.writeln(format("Done in %.1f s. Result: ", (new Date().getTime() - started.getTime()) / 1000) + result.mainView.id);
   console.writeln("The original image was not changed.");
}

// ----------------------------------------------------------------------------
// The preview
// ----------------------------------------------------------------------------

var DLE_PREVIEW_MAX = 1600;   // the longest side of the reduced copy, in pixels
var DLE_SHARP_FROM = 0.6;     // real pixels are shown from this zoom (of full size) upwards

// The size of the preview pane, in screen pixels.
var DLE_PANE_W = 1104, DLE_PANE_H = 851;   // 15% up on 960 x 740

// A picture of 1 or 3 channels (0..1) for drawing on screen.
function dleBitmap(channels, w, h) {
   var c;
   try {
      var n = channels.length;
      var img = new Image(w, h, n, (n === 3) ? ColorSpace_RGB : ColorSpace_Gray, 32, SampleType_Real);
      for (c = 0; c < n; ++c) img.setSamples(channels[c], new Rect(0, 0, w, h), c);
      var bmp = img.render();
      if (bmp && bmp.width === w && bmp.height === h) return bmp;
   } catch (e) {
      // fall through to the slow, certain way
   }
   var b = new Bitmap(w, h);
   var R = channels[0], G = channels[channels.length === 3 ? 1 : 0], B = channels[channels.length === 3 ? 2 : 0];
   for (var y = 0; y < h; ++y)
      for (var x = 0; x < w; ++x) {
         var i = y * w + x;
         var r = Math.round(255 * Math.max(0, Math.min(1, R[i])));
         var g = Math.round(255 * Math.max(0, Math.min(1, G[i])));
         var bl = Math.round(255 * Math.max(0, Math.min(1, B[i])));
         b.setPixel(x, y, 0xff000000 | (r << 16) | (g << 8) | bl);
      }
   return b;
}

// Everything the preview holds about the image it was made from.
function DLEPreviewState() {
   this.viewId = "";
   this.w = 0; this.h = 0;          // the full image
   this.pw = 0; this.ph = 0;        // the reduced copy
   this.lum = null;                 // full-size luminance, for the detection
   this.full = null;                // the full-size channels, for the zoomed-in view and for Run
   this.sharp = null;               // the zoomed-in view: one rectangle in real pixels (see sharpen)
   this.small = null;               // the reduced copy's channels
   this.Vp = null; this.VpKey = ""; // the detection map at the reduced copy's size
   this.dark = null;                // per channel: the darkening for Amount 1 (see dleDarkening)
   this.bitmap = null;
   this.zoom = 0;                   // 0 = fit the pane
   this.cx = 0.5; this.cy = 0.5;    // the point of the picture at the pane's centre (0..1)
}

function DLEDialog(p, cache) {
   this.__base__ = Dialog;
   this.__base__();

   var dlg = this;
   var st = new DLEPreviewState();
   var busy = false;
   var paintFault = false;
   var labelWidth = this.font.width("Smallest structure (px):") + 8;

   this.help = new Label(this);
   this.help.wordWrapping = true;
   this.help.useRichText = true;
   this.help.text = "<b>" + DLE_TITLE + " " + DLE_VERSION + "</b><br>" +
      "Copyright &copy; 2026 Stewart Oliver, AstroShed. astroshed.co.uk<br>" +
      "Finds dust lanes and dark filaments by their shape and deepens them. " +
      "Use it on a stretched image, preferably starless. " +
      "It works on the image that is active when you press Run or Preview; " +
      "the result opens as a new image and the original is not changed.";
   this.help.minWidth = 506;

   this.status = new Label(this);
   this.status.text = "Ready.";

   function say(text) {
      dlg.status.text = text;
      processEvents();
   }

   function activeWindowOrNull() {
      var w = ImageWindow.activeWindow;
      if (w.isNull) {
         (new MessageBox("There is no image open.", DLE_TITLE, StdIcon_Error, StdButton_Ok)).execute();
         return null;
      }
      return w;
   }

   function sizesOk() {
      if (p.maxScale > p.minScale) return true;
      say("Largest structure must be bigger than Smallest structure.");
      return false;
   }

   // ---- the preview pane ---------------------------------------------------

   this.pane = new Control(this);
   this.pane.setFixedSize(DLE_PANE_W, DLE_PANE_H);
   this.pane.toolTip = "<p>Wheel: zoom. Drag: move. Fit: the whole picture.</p>" +
      "<p>From 60% zoom the view switches to full resolution a moment after you stop.</p>";

   // where the picture sits in the pane: {x0, y0, x1, y1} in pane pixels
   function pictureRect() {
      var cw = dlg.pane.width, ch = dlg.pane.height;
      var fit = Math.min(cw / st.pw, ch / st.ph);
      var z = (st.zoom > 0) ? st.zoom : fit;
      var dw = st.pw * z, dh = st.ph * z;
      var x0 = cw / 2 - st.cx * dw, y0 = ch / 2 - st.cy * dh;
      if (dw <= cw) x0 = (cw - dw) / 2;                 // smaller than the pane: centred
      else x0 = Math.min(0, Math.max(cw - dw, x0));     // larger: no empty margin
      if (dh <= ch) y0 = (ch - dh) / 2;
      else y0 = Math.min(0, Math.max(ch - dh, y0));
      return { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x0 + dw), y1: Math.round(y0 + dh), z: z, fit: fit };
   }

   this.pane.onPaint = function () {
      var g = new Graphics(this);
      try {
         g.fillRect(0, 0, this.width, this.height, new Brush(0xff181818));
         if (st.bitmap) {
            var r = pictureRect();
            g.drawScaledBitmap(r.x0, r.y0, r.x1, r.y1, st.bitmap);
            var sh = st.sharp;
            if (sh && sh.bitmap) {
               // the same place in the picture, in real pixels
               var px = (r.x1 - r.x0) / st.w, py = (r.y1 - r.y0) / st.h;
               g.drawScaledBitmap(Math.round(r.x0 + sh.x0 * px), Math.round(r.y0 + sh.y0 * py),
                                  Math.round(r.x0 + (sh.x0 + sh.rw) * px), Math.round(r.y0 + (sh.y0 + sh.rh) * py), sh.bitmap);
            }
         }
      } catch (e) {
         if (!paintFault) {
            paintFault = true;
            console.criticalln("Dust Lane Enhancer: the preview could not be drawn: " + e);
         }
      }
      g.end();
   };

   this.pane.onMouseWheel = function (x, y, delta) {
      if (!st.bitmap) return;
      var r = pictureRect();
      var z = r.z * ((delta > 0) ? 1.25 : 0.8);
      if (z <= r.fit) { st.zoom = 0; st.cx = 0.5; st.cy = 0.5; }
      else {
         // keep the point under the pointer where it is
         var px = (x - r.x0) / (r.x1 - r.x0), py = (y - r.y0) / (r.y1 - r.y0);
         st.zoom = Math.min(z, Math.max(2, 2 * st.w / st.pw));   // up to twice real size
         var dw = st.pw * st.zoom, dh = st.ph * st.zoom;
         st.cx = px + (this.width / 2 - x) / dw;
         st.cy = py + (this.height / 2 - y) / dh;
      }
      this.update();
      sharpenSoon();
   };

   var drag = null;
   this.pane.onMousePress = function (x, y) {
      if (st.bitmap) {
         var r = pictureRect();
         // start from where the picture really is (it may have been held at an edge)
         st.cx = (this.width / 2 - r.x0) / (r.x1 - r.x0);
         st.cy = (this.height / 2 - r.y0) / (r.y1 - r.y0);
         drag = { x: x, y: y, cx: st.cx, cy: st.cy };
      }
   };
   this.pane.onMouseMove = function (x, y) {
      if (!drag || !st.bitmap) return;
      var r = pictureRect();
      st.cx = drag.cx - (x - drag.x) / (r.x1 - r.x0);
      st.cy = drag.cy - (y - drag.y) / (r.y1 - r.y0);
      this.update();
   };
   this.pane.onMouseRelease = function () {
      if (drag) { drag = null; sharpenSoon(); }
   };

   this.showOriginal = new CheckBox(this);
   this.showOriginal.text = "Show original";
   this.showOriginal.toolTip = "<p>Tick to see the image as it is, untick to see the result: flick between the two.</p>";
   this.showOriginal.onCheck = function () { redraw(); };

   this.fit_Button = new PushButton(this);
   this.fit_Button.text = "Fit";
   this.fit_Button.toolTip = "<p>Shows the whole picture.</p>";
   this.fit_Button.onClick = function () { st.zoom = 0; st.cx = 0.5; st.cy = 0.5; st.sharp = null; dlg.pane.update(); };

   this.update_Button = new PushButton(this);
   this.update_Button.text = "Update";
   this.update_Button.toolTip = "<p>Makes the preview again from the image that is active now.</p>";
   this.update_Button.onClick = function () { st.viewId = ""; refresh(); };

   this.paneBar = new HorizontalSizer;
   this.paneBar.spacing = 6;
   this.paneBar.add(this.showOriginal);
   this.paneBar.addStretch();
   this.paneBar.add(this.fit_Button);
   this.paneBar.add(this.update_Button);

   this.previewBox = new Control(this);
   this.previewBox.sizer = new VerticalSizer;
   this.previewBox.sizer.spacing = 4;
   this.previewBox.sizer.add(this.pane);
   this.previewBox.sizer.add(this.paneBar);
   this.previewBox.sizer.addStretch();
   this.previewBox.visible = true;          // open from the start

   // Builds the picture from what is already worked out. Cheap.
   function redraw() {
      if (!st.small || !st.Vp) return;
      var shown;
      if (p.showMap && !dlg.showOriginal.checked) {
         shown = [st.Vp];
      } else {
         shown = [];
         for (var c = 0; c < st.small.length; ++c) {
            if (dlg.showOriginal.checked || !st.dark) {
               shown.push(st.small[c]);
               continue;
            }
            // channel + Amount * darkening: one pass, so the slider is followed at once
            var src = st.small[c], dk = st.dark[c], amt = p.amount;
            var a = new Float32Array(src.length);
            for (var i = 0; i < a.length; ++i) {
               var v = src[i] + amt * dk[i];
               a[i] = (v < 0) ? 0 : (v > 1 ? 1 : v);
            }
            shown.push(a);
         }
      }
      st.bitmap = dleBitmap(shown, st.pw, st.ph);
      if (st.sharp && st.sharp.key === st.VpKey) sharpBitmap();
      else st.sharp = null;
      dlg.pane.update();
   }

   // ---- the zoomed-in view: real pixels for the part being looked at ---------

   // The picture of the sharp rectangle, for the settings as they are now. Cheap.
   function sharpBitmap() {
      var sh = st.sharp;
      if (!sh) return;
      var shown;
      if (dlg.showOriginal.checked) {
         shown = sh.crop;
      } else if (p.showMap) {
         shown = [sh.Vr];
      } else {
         shown = [];
         for (var c = 0; c < sh.crop.length; ++c) {
            var src = sh.crop[c], dk = sh.dark[c], amt = p.amount;
            var a = new Float32Array(src.length);
            for (var i = 0; i < a.length; ++i) {
               var v = src[i] + amt * dk[i];
               a[i] = (v < 0) ? 0 : (v > 1 ? 1 : v);
            }
            shown.push(a);
         }
      }
      sh.bitmap = dleBitmap(shown, sh.rw, sh.rh);
   }

   // Works out the part of the image now in view from the full-size image.
   // Only when zoomed in far enough for that to be a manageable area.
   function sharpen() {
      if (busy || !dlg.previewBox.visible || !st.bitmap || !st.full || !cache.det) return;
      var r = pictureRect();
      var W = r.x1 - r.x0, H = r.y1 - r.y0;
      var x0 = Math.max(0, Math.floor((0 - r.x0) / W * st.w));
      var y0 = Math.max(0, Math.floor((0 - r.y0) / H * st.h));
      var x1 = Math.min(st.w, Math.ceil((dlg.pane.width - r.x0) / W * st.w));
      var y1 = Math.min(st.h, Math.ceil((dlg.pane.height - r.y0) / H * st.h));
      var rw = x1 - x0, rh = y1 - y0;
      if (r.z <= 1.0 || rw < 1 || rh < 1 || W / st.w < DLE_SHARP_FROM - 1e-9) {
         // below 60% of full size the reduced copy is shown
         if (st.sharp) { st.sharp = null; dlg.pane.update(); }
         say(format("Shown at %.0f%%. Full resolution from %.0f%%.", 100 * W / st.w, 100 * DLE_SHARP_FROM));
         return;
      }
      var sh = st.sharp;
      if (sh && sh.key === st.VpKey && sh.x0 === x0 && sh.y0 === y0 && sh.rw === rw && sh.rh === rh) return;
      busy = true;
      try {
         say("Showing full resolution...");
         var det = cache.det;
         sh = { key: st.VpKey, x0: x0, y0: y0, rw: rw, rh: rh, crop: [], dark: [], bitmap: null };
         sh.Vr = dleClamp01(dleEnlargeRegion(det.map, det.w, det.h, st.w, st.h, x0, y0, rw, rh));
         for (var c = 0; c < st.full.length; ++c) {
            sh.crop.push(dleCrop(st.full[c], st.w, x0, y0, rw, rh));
            sh.dark.push(dleRegionDark(st.full[c], st.w, st.h, sh.Vr, x0, y0, rw, rh, p.maxScale));
         }
         st.sharp = sh;
         sharpBitmap();
         dlg.pane.update();
         say(format("Full resolution, shown at %.0f%%.", 100 * W / st.w));
      } catch (e) {
         st.sharp = null;
         console.criticalln("Dust Lane Enhancer: the zoomed-in view failed: " + e);
         say("The zoomed-in view failed - see the console.");
      }
      busy = false;
   }

   // Zooming and dragging call this many times; the work waits until they stop.
   var sharpTimer = null;
   try {
      sharpTimer = new Timer;
      sharpTimer.interval = 0.35;
      sharpTimer.periodic = false;
      sharpTimer.onTimeout = function () { sharpen(); };
   } catch (e) {
      sharpTimer = null;
   }
   function sharpenSoon() {
      if (sharpTimer !== null) {
         try { sharpTimer.stop(); sharpTimer.start(); return; } catch (e) { sharpTimer = null; }
      }
      sharpen();
   }

   // Makes the preview up to date with the settings. The detection (the slow
   // part) is only done again when the image or one of its three settings changed.
   function refresh() {
      if (busy || !dlg.previewBox.visible) return;
      if (!sizesOk()) return;
      busy = true;
      try {
         if (st.viewId === "") {
            var win = activeWindowOrNull();
            if (win === null) { busy = false; return; }
            var image = win.mainView.image;
            say("Reading " + win.mainView.id + "...");
            var nch = image.isColor ? 3 : 1;
            var full = [];
            for (var c = 0; c < nch; ++c) full.push(dleReadChannel(image, c));
            st.w = image.width; st.h = image.height;
            var f = Math.min(1, DLE_PREVIEW_MAX / Math.max(st.w, st.h));
            st.pw = Math.max(1, Math.round(st.w * f));
            st.ph = Math.max(1, Math.round(st.h * f));
            st.small = [];
            for (c = 0; c < nch; ++c) st.small.push(dleResizeArea(full[c], st.w, st.h, st.pw, st.ph));
            st.lum = (nch === 1) ? full[0] : dleLuminance(full, st.w * st.h);
            st.full = full;
            st.sharp = null;
            st.viewId = win.mainView.id;
            st.Vp = null; st.VpKey = ""; st.dark = null;
            st.zoom = 0; st.cx = 0.5; st.cy = 0.5;
         }
         var key = st.viewId + "|" + p.minScale + "|" + p.maxScale + "|" + p.sensitivity;
         if (st.VpKey !== key) {
            say("Finding the lanes in " + st.viewId + "...");
            var det = dleDetectionFor(cache, st.viewId, st.lum, st.w, st.h, p, null);
            st.Vp = dleClamp01(dleEnlarge(det.map, det.w, det.h, st.pw, st.ph));
            st.dark = [];
            for (var k = 0; k < st.small.length; ++k)
               st.dark.push(dleDarkening(st.small[k], st.pw, st.ph, st.Vp, p.maxScale, st.pw / st.w));
            st.VpKey = key;
         }
         redraw();
         say("Preview of " + st.viewId + ". Zoom to 60% or more for full resolution.");
         busy = false;
         sharpen();
      } catch (e) {
         console.criticalln("Dust Lane Enhancer: the preview failed: " + e);
         say("The preview failed - see the console.");
      }
      busy = false;
   }

   // A slider that is being dragged calls back many times a second. The
   // detection waits until it has been still for a moment.
   var timer = null;
   try {
      timer = new Timer;
      timer.interval = 0.4;
      timer.periodic = false;
      timer.onTimeout = function () { refresh(); };
   } catch (e) {
      timer = null;
   }
   function detectionChanged() {
      if (!dlg.previewBox.visible) return;
      if (timer !== null) {
         try { timer.stop(); timer.start(); return; } catch (e) { timer = null; }
      }
      say("Settings changed - press Update to see them.");
   }

   // ---- the settings ---------------------------------------------------------

   function numeric(text, lo, hi, precision, value, tip, setter) {
      var n = new NumericControl(dlg);
      n.label.text = text;
      n.label.minWidth = labelWidth;
      n.setRange(lo, hi);
      n.slider.setRange(0, 200);
      n.slider.minWidth = 220;
      n.setPrecision(precision);
      n.setValue(value);
      n.toolTip = tip;
      n.onValueUpdated = function (v) { setter(v); };
      return n;
   }

   this.minScale = numeric("Smallest structure (px):", 1.0, 15.0, 1, p.minScale,
      "<p>The narrowest lane to look for, in pixels of the full-size image. " +
      "Raise it to ignore fine detail and noise.</p>",
      function (v) { p.minScale = v; detectionChanged(); });

   this.maxScale = numeric("Largest structure (px):", 3.0, 60.0, 1, p.maxScale,
      "<p>The widest lane to look for, in pixels of the full-size image. " +
      "It also sets how wide an area each pixel is compared with.</p>",
      function (v) { p.maxScale = v; detectionChanged(); });

   this.sensitivity = numeric("Sensitivity:", 0.5, 10.0, 1, p.sensitivity,
      "<p>How faint a lane may be and still be found. Higher reaches fainter " +
      "structure, at the cost of picking up more noise.</p>",
      function (v) { p.sensitivity = v; detectionChanged(); });

   this.amount = numeric("Enhance amount:", 0.0, 3.0, 2, p.amount,
      "<p>How much the lanes that were found are deepened. 0 changes nothing.</p>",
      function (v) { p.amount = v; if (dlg.previewBox.visible && !busy) redraw(); });

   this.showMap = new CheckBox(this);
   this.showMap.text = "Show detection map";
   this.showMap.checked = p.showMap;
   this.showMap.toolTip = "<p>Shows what was FOUND (white = a lane) in place of the result, " +
      "in the preview and when you press Run. Use it to tune the three settings above.</p>";
   this.showMap.onCheck = function (checked) { p.showMap = checked; if (dlg.previewBox.visible && !busy) redraw(); };

   this.reset_Button = new PushButton(this);
   this.reset_Button.text = "Reset";
   this.reset_Button.toolTip = "<p>Puts every setting back to its default.</p>";
   this.reset_Button.onClick = function () {
      p.reset();
      dlg.minScale.setValue(p.minScale);
      dlg.maxScale.setValue(p.maxScale);
      dlg.sensitivity.setValue(p.sensitivity);
      dlg.amount.setValue(p.amount);
      dlg.showMap.checked = p.showMap;
      refresh();
   };

   this.preview_Button = new PushButton(this);
   this.preview_Button.text = "Preview";
   this.preview_Button.toolTip = "<p>Opens or closes the preview: the effect on a reduced copy " +
      "of the active image, before you run it on the whole image.</p>";
   // Fills the preview for the first time (called once the window is up).
   this.startPreview = function () { st.viewId = ""; refresh(); };

   this.preview_Button.onClick = function () {
      dlg.previewBox.visible = !dlg.previewBox.visible;
      fitWindow();
      if (dlg.previewBox.visible) { st.viewId = ""; refresh(); }
   };

   this.ok_Button = new PushButton(this);
   this.ok_Button.text = "Run";
   this.ok_Button.toolTip = "<p>Runs on the whole of the active image and opens the result as a new image.</p>";
   this.ok_Button.onClick = function () {
      if (busy || !sizesOk()) return;
      var win = activeWindowOrNull();
      if (win === null) return;
      busy = true;
      p.save();
      say("Running on " + win.mainView.id + "...");
      try {
         dleRun(win, p, cache, (st.full && st.viewId === win.mainView.id) ? { channels: st.full, lum: st.lum } : null);
         say("Done: " + win.mainView.id + (p.showMap ? "_dust_map" : "_dust") + " opened.");
      } catch (e) {
         console.criticalln("Dust Lane Enhancer stopped: " + e);
         say("Stopped with an error - see the console.");
      }
      busy = false;
   };

   this.cancel_Button = new PushButton(this);
   this.cancel_Button.text = "Close";
   this.cancel_Button.onClick = function () { p.save(); dlg.hide(); };

   this.buttons = new HorizontalSizer;
   this.buttons.spacing = 6;
   this.buttons.add(this.reset_Button);
   this.buttons.add(this.preview_Button);
   this.buttons.addStretch();
   this.buttons.add(this.ok_Button);
   this.buttons.add(this.cancel_Button);

   // The settings keep one width, so the window is no wider than it needs to be.
   this.leftBox = new Control(this);
   this.left = new VerticalSizer;
   this.left.spacing = 6;
   this.left.add(this.help);
   this.left.addSpacing(4);
   this.left.add(this.minScale);
   this.left.add(this.maxScale);
   this.left.add(this.sensitivity);
   this.left.add(this.amount);
   this.left.add(this.showMap);
   this.left.addSpacing(4);
   this.left.add(this.status);
   this.left.add(this.buttons);
   this.left.addStretch();
   this.leftBox.sizer = this.left;
   this.leftBox.setFixedWidth(540);

   this.sizer = new HorizontalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 8;
   this.sizer.add(this.leftBox);
   this.sizer.add(this.previewBox);

   // Makes the window exactly as big as what is showing in it.
   function fitWindow() {
      try { dlg.setVariableSize(); } catch (e) { /* older versions: it grows but may not shrink */ }
      dlg.adjustToContents();
      try { dlg.setFixedSize(); } catch (e) { /* not essential */ }
   }

   this.windowTitle = DLE_TITLE;
   fitWindow();
}

DLEDialog.prototype = new Dialog;

function main() {
   if (ImageWindow.activeWindow.isNull) {
      (new MessageBox("There is no image open. Open one and run the script again.",
                      DLE_TITLE, StdIcon_Error, StdButton_Ok)).execute();
      return;
   }
   var p = new DLEParameters();
   p.load();
   var cache = { key: "", det: null, keep: { lum: null, dw: 0, dh: 0, det: null } };
   var dialog = new DLEDialog(p, cache);
   // The script stays alive here until the window is closed. (While any script
   // runs, PixInsight keeps its own image windows still; the preview is where
   // the image is looked at.)
   dialog.show();
   processEvents();
   dialog.startPreview();
   while (dialog.visible) {
      processEvents();
      try { msleep(15); } catch (e) { /* no pause available: carry on */ }
   }
   p.save();
}

main();
