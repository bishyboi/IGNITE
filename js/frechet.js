/**
 * frechet.js — Curve comparison metrics
 * Ported from BALDI/samples/frechet_preprocessing.py
 *
 * Key improvement over a plain normalise-then-compare approach:
 *
 *   affineAlignCurves(A, B) finds the least-squares affine transform that maps
 *   A → B (mirrors the np.linalg.lstsq affine fit in frechet_preprocessing.py).
 *   curveSimilarity() aligns the drawn curve onto each candidate template shift,
 *   then measures the residual Fréchet/RMS.  Because any rotation, uniform scale,
 *   non-uniform scale, shear, or translation is absorbed by the affine transform,
 *   only the *shape* of the curves affects the residual score.
 *
 * Pipeline:
 *   drawn  ──► arc-length resample ──┐
 *                                    ├─► affineAlign(drawn → shifted tpl) ──► frechetDistance
 *   template ─► arc-length resample ─┘        (best over 24 circular shifts × 2 directions)
 */

'use strict';

// ── Euclidean distance ────────────────────────────────────────────────────────

function euclideanDist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// ── Discrete Fréchet distance — direct port of frechet_preprocessing.py ──────

/**
 * Discrete Fréchet distance between curves A and B.
 * Iterative DP — identical logic to the Python implementation.
 *
 * @param {Array<{x,y}>} A
 * @param {Array<{x,y}>} B
 * @returns {number}
 */
function frechetDistance(A, B) {
    const N = A.length, M = B.length;
    if (N === 0 || M === 0) return Infinity;

    const ca = Array.from({ length: N }, () => new Float64Array(M));

    for (let i = 0; i < N; i++) {
        for (let j = 0; j < M; j++) {
            const dist = euclideanDist(A[i], B[j]);

            if (i === 0 && j === 0) {
                ca[i][j] = dist;
            } else if (i === 0) {
                ca[i][j] = Math.max(ca[i][j - 1], dist);
            } else if (j === 0) {
                ca[i][j] = Math.max(ca[i - 1][j], dist);
            } else {
                ca[i][j] = Math.max(
                    Math.min(ca[i - 1][j], ca[i - 1][j - 1], ca[i][j - 1]),
                    dist
                );
            }
        }
    }

    return ca[N - 1][M - 1];
}

// ── Arc-length resampling ─────────────────────────────────────────────────────

/**
 * Resample a curve to nPoints evenly spaced by arc length.
 * Works for any 2-D shape; used to establish point correspondence
 * before affine alignment.
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
        const t = segLen < 1e-9 ? 0 : (target - arcLen[lo]) / segLen;
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
 * This gives both curves a comparable initial scale before affine alignment.
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

// ── 3×3 linear solver (Gauss–Jordan with partial pivoting) ───────────────────

/**
 * Solve the 3×3 linear system  A · x = b.
 * Returns the solution vector [x0, x1, x2] or null if A is singular.
 *
 * @param {number[][]} A  3×3 matrix (will not be mutated)
 * @param {number[]}   b  length-3 RHS vector
 * @returns {number[]|null}
 */
function _solve3x3(A, b) {
    // Build augmented matrix [A | b]
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < 3; col++) {
        // Partial pivot
        let maxRow = col;
        for (let row = col + 1; row < 3; row++) {
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        }
        [M[col], M[maxRow]] = [M[maxRow], M[col]];

        const pivot = M[col][col];
        if (Math.abs(pivot) < 1e-12) return null;   // degenerate

        // Normalise pivot row
        for (let j = col; j <= 3; j++) M[col][j] /= pivot;

        // Eliminate column from all other rows (full Gauss–Jordan → RREF)
        for (let row = 0; row < 3; row++) {
            if (row === col) continue;
            const f = M[row][col];
            for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j];
        }
    }

    return M.map(row => row[3]);
}

// ── Affine alignment (mirrors lstsq in frechet_preprocessing.py) ─────────────

/**
 * Find the least-squares affine transform T that maps curve A onto curve B,
 * then return the transformed version of A.
 *
 * This is the JS equivalent of the Python:
 *   A_aug = np.hstack([A, np.ones((n,1))])
 *   M, _, _, _ = np.linalg.lstsq(A_aug, B, rcond=None)
 *   transformed = A_aug @ M
 *
 * The 6-DOF affine transform absorbs any rotation, uniform/non-uniform scale,
 * shear, and translation — so the residual Fréchet distance after alignment
 * reflects purely the topological/structural difference between the two curves.
 *
 * Point correspondence is established by arc-length resampling both curves to
 * the same number of points before calling this function.
 *
 * @param {Array<{x,y}>} A   source curve (the drawn path, already resampled)
 * @param {Array<{x,y}>} B   target curve (the template shift, already resampled)
 * @returns {Array<{x,y}>|null}  transformed A in B's coordinate frame, or null if degenerate
 */
function affineAlignCurves(A, B) {
    const n = A.length;
    if (n < 3) return null;

    // Build normal equations:  (Aᵀ A) M = Aᵀ B
    // where each row of A is [x, y, 1]  (augmented with homogeneous coord)
    // and M is 3×2 (solved column-by-column).
    const AtA  = [[0,0,0],[0,0,0],[0,0,0]];
    const AtBx = [0, 0, 0];
    const AtBy = [0, 0, 0];

    for (let i = 0; i < n; i++) {
        const ax = A[i].x, ay = A[i].y;
        const bx = B[i].x, by = B[i].y;
        const row = [ax, ay, 1.0];

        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) AtA[r][c] += row[r] * row[c];
            AtBx[r] += row[r] * bx;
            AtBy[r] += row[r] * by;
        }
    }

    const Mx = _solve3x3(AtA, AtBx);
    const My = _solve3x3(AtA, AtBy);
    if (!Mx || !My) return null;

    // Apply:  [x', y'] = [Mx[0]·x + Mx[1]·y + Mx[2],  My[0]·x + My[1]·y + My[2]]
    return A.map(p => ({
        x: Mx[0] * p.x + Mx[1] * p.y + Mx[2],
        y: My[0] * p.x + My[1] * p.y + My[2],
    }));
}

// ── RMS helper ────────────────────────────────────────────────────────────────

function _rmsDirect(r1, r2) {
    let sumSq = 0;
    const n = Math.min(r1.length, r2.length);
    for (let i = 0; i < n; i++) {
        const d = euclideanDist(r1[i], r2[i]);
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / n);
}

/**
 * RMS distance between two curves — kept as a public utility.
 * Normalises and arc-length resamples before comparison.
 *
 * @param {Array<{x,y}>} curve1
 * @param {Array<{x,y}>} curve2
 * @param {number} nPoints
 * @returns {number}
 */
function rmsBetweenCurves(curve1, curve2, nPoints = 64) {
    const r1 = resampleCurve(normalizeCurve(curve1), nPoints);
    const r2 = resampleCurve(normalizeCurve(curve2), nPoints);
    return _rmsDirect(r1, r2);
}

// ── Main similarity entry point ───────────────────────────────────────────────

/**
 * Compare a drawn curve against a template using affine-invariant matching.
 *
 * For each of 24 circular shifts of the template (to handle any starting point)
 * and both drawing directions (forward / reversed):
 *   1. Arc-length resample both to nPoints — establishes point correspondence.
 *   2. Affinely align the drawn curve onto the shifted template via least-squares
 *      (absorbs rotation, scale, skew, translation — mirrors frechet_preprocessing.py).
 *   3. Measure Fréchet distance between aligned drawn and template.
 *      This residual reflects only the structural/topological difference.
 *
 * The best (lowest residual) over all shifts and directions is converted to a
 * [0, 1] score.
 *
 * @param {Array<{x,y}>} drawn
 * @param {Array<{x,y}>} template
 * @param {number} nPoints   Resampling resolution
 * @returns {{ frechet: number, rms: number, score: number }}
 */
function curveSimilarity(drawn, template, nPoints = 64) {
    if (drawn.length < 5) return { frechet: Infinity, rms: Infinity, score: 0 };

    // Resample both (no pre-normalization needed — affine handles scale/translation)
    const rDrawn    = resampleCurve(drawn,    nPoints);
    const rTpl      = resampleCurve(template, nPoints);
    const rDrawnRev = [...rDrawn].reverse();

    let bestFrechet = Infinity;
    let bestRms     = Infinity;

    // 24 circular shifts to cover all possible start positions
    const step = Math.max(1, Math.floor(nPoints / 24));

    for (let shift = 0; shift < nPoints; shift += step) {
        const shifted = [
            ...rTpl.slice(shift),
            ...rTpl.slice(0, shift),
        ];

        for (const candidate of [rDrawn, rDrawnRev]) {
            const aligned = affineAlignCurves(candidate, shifted);
            if (!aligned) continue;

            const f = frechetDistance(aligned, shifted);
            const r = _rmsDirect(aligned, shifted);

            if (f < bestFrechet) bestFrechet = f;
            if (r < bestRms)     bestRms     = r;
        }
    }

    const score = _toScore(bestFrechet, bestRms);
    return { frechet: bestFrechet, rms: bestRms, score };
}

/**
 * Convert residual Fréchet + RMS distances to a [0, 1] similarity score.
 *
 * After affineAlignCurves() the aligned curve is in the template's coordinate
 * frame (values roughly in [−1, 1]).  Scale factors are chosen for that range:
 *
 *   frechet  0.05 → score ≈ 0.78  (very good)
 *   frechet  0.10 → score ≈ 0.61  (good)
 *   frechet  0.20 → score ≈ 0.37  (borderline)
 *   frechet  0.35 → score ≈ 0.17  (poor — wrong shape)
 */
function _toScore(frechet, rms) {
    const fs = Math.exp(-frechet / 0.20);
    const rs = Math.exp(-rms     / 0.18);
    return fs * 0.6 + rs * 0.4;
}
