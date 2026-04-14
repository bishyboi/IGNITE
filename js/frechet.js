/**
 * frechet.js — Curve utilities
 *
 * Only the pieces that other modules depend on are kept here:
 *   euclideanDist   — used by handtracking.js
 *   resampleCurve   — used by spell-ml.js
 *   normalizeCurve  — used by spell-ml.js
 *
 * Fréchet distance, affine alignment, and curveSimilarity have been removed;
 * Dynamic Time Warping (DTW) in spell-ml.js replaces them as the sequence
 * distance metric.
 */

'use strict';

// ── Euclidean distance ────────────────────────────────────────────────────────

function euclideanDist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// ── Arc-length resampling ─────────────────────────────────────────────────────

/**
 * Resample a curve to nPoints evenly spaced by arc length.
 * Normalises point density so that fast/slow strokes produce the same shape.
 *
 * @param {Array<{x,y}>} curve
 * @param {number} nPoints
 * @returns {Array<{x,y}>}
 */
function resampleCurve(curve, nPoints = 64) {
    if (curve.length === 0) return Array.from({ length: nPoints }, () => ({ x: 0, y: 0 }));
    if (curve.length === 1) return Array.from({ length: nPoints }, () => ({ ...curve[0] }));

    const arcLen = [0];
    for (let i = 1; i < curve.length; i++) {
        arcLen.push(arcLen[i - 1] + euclideanDist(curve[i - 1], curve[i]));
    }
    const totalLen = arcLen[arcLen.length - 1];
    if (totalLen < 1e-9) return Array.from({ length: nPoints }, () => ({ ...curve[0] }));

    const result = [];
    for (let k = 0; k < nPoints; k++) {
        const target = (k / (nPoints - 1)) * totalLen;

        let lo = 0, hi = arcLen.length - 2;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arcLen[mid + 1] < target) lo = mid + 1;
            else hi = mid;
        }

        const segLen = arcLen[lo + 1] - arcLen[lo];
        const t  = segLen < 1e-9 ? 0 : (target - arcLen[lo]) / segLen;
        const p0 = curve[lo];
        const p1 = curve[Math.min(lo + 1, curve.length - 1)];
        result.push({
            x: p0.x + t * (p1.x - p0.x),
            y: p0.y + t * (p1.y - p0.y),
        });
    }
    return result;
}

// ── Curve normalization ───────────────────────────────────────────────────────

/**
 * Translate centroid to origin; scale so the largest absolute coordinate is 1.
 *
 * @param {Array<{x,y}>} curve
 * @returns {Array<{x,y}>}
 */
function normalizeCurve(curve) {
    if (curve.length === 0) return [];

    let cx = 0, cy = 0;
    for (const p of curve) { cx += p.x; cy += p.y; }
    cx /= curve.length;
    cy /= curve.length;

    const translated = curve.map(p => ({ x: p.x - cx, y: p.y - cy }));

    let maxVal = 0;
    for (const p of translated) maxVal = Math.max(maxVal, Math.abs(p.x), Math.abs(p.y));
    if (maxVal < 1e-9) return translated;

    return translated.map(p => ({ x: p.x / maxVal, y: p.y / maxVal }));
}
