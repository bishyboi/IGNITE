/**
 * spells.js — Spell definitions + fast feature-based recognition
 *
 * Primary  : extractPathFeatures() + classifySpell() — O(n), no matrix math.
 * Tie-break: curveSimilarity() from frechet.js on ≤2 ambiguous candidates only.
 *
 * euclideanDist is defined in frechet.js (loaded first). Not redefined here.
 */

'use strict';

// Protego circle template — only spell that uses affine tie-breaking
function _circle(n) {
    n = n || 64;
    return Array.from({ length: n }, function(_, i) {
        var a = (i / n) * 2 * Math.PI;
        return { x: Math.cos(a), y: Math.sin(a) };
    });
}

// ── Feature extractor ─────────────────────────────────────────────────────────

function extractPathFeatures(path) {
    if (!path || path.length < 5) return null;

    var n = path.length, i;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var totalLen = 0;

    for (i = 0; i < n; i++) {
        var p = path[i];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (i > 0) totalLen += euclideanDist(path[i - 1], p);
    }

    var width = maxX - minX, height = maxY - minY;
    if (width < 20 && height < 20) return null;

    var aspectRatio = height > 1 ? width / height : 999;
    var startToEnd  = euclideanDist(path[0], path[n - 1]);
    var isClosed    = startToEnd < Math.min(width, height) * 0.35;

    // Corners + Y-reversals on ~30-pt downsample (avoids EMA over-counting)
    var ds = Math.max(1, Math.floor(n / 30));
    var samp = [];
    for (i = 0; i < n; i += ds) samp.push(path[i]);
    var sn = samp.length, cornerCount = 0, yReversals = 0, prevDy = 0;
    var CORNER_RAD = 0.7; // ~40°

    for (var j = 1; j < sn - 1; j++) {
        var v1x = samp[j].x - samp[j-1].x, v1y = samp[j].y - samp[j-1].y;
        var v2x = samp[j+1].x - samp[j].x, v2y = samp[j+1].y - samp[j].y;
        var m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
        if (m1 > 0 && m2 > 0) {
            var ang = Math.acos(Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / (m1*m2))));
            if (ang > CORNER_RAD) cornerCount++;
        }
    }
    for (var r = 1; r < sn; r++) {
        var rdy = samp[r].y - samp[r-1].y;
        if (Math.abs(rdy) > 1) {
            var rdir = rdy > 0 ? 1 : -1;
            if (prevDy !== 0 && rdir !== prevDy) yReversals++;
            prevDy = rdir;
        }
    }

    // Apex (min Y = top of screen) and valley (max Y = bottom)
    var apexIdx = 0, valleyIdx = 0;
    for (var m = 1; m < n; m++) {
        if (path[m].y < path[apexIdx].y)   apexIdx   = m;
        if (path[m].y > path[valleyIdx].y) valleyIdx = m;
    }
    var hasTopApex      = apexIdx   > n * 0.15 && apexIdx   < n * 0.85;
    var hasBottomValley = valleyIdx > n * 0.15 && valleyIdx < n * 0.85;

    // Y direction in first vs second half
    var mid = Math.floor(n / 2);
    var firstHalfDY  = path[mid].y - path[0].y;
    var secondHalfDY = path[n - 1].y - path[mid].y;

    // R sub-features
    var leftPts      = path.filter(function(pt)      { return pt.x < minX + width * 0.45; });
    var upperPts     = path.filter(function(pt)      { return pt.y < minY + height * 0.55; });
    var lateRightPts = path.filter(function(pt, idx) { return idx > n*0.45 && pt.x > minX + width*0.45; });
    var hasVerticalStem = aspectRatio < 0.9 && leftPts.length  > n * 0.3;
    var hasUpperBulge   = upperPts.length > n * 0.3 && cornerCount >= 2;
    var hasDiagonalLeg  = lateRightPts.length > n * 0.12;

    return {
        width: width, height: height, aspectRatio: aspectRatio,
        isClosed: isClosed, cornerCount: cornerCount, yReversals: yReversals,
        hasTopApex: hasTopApex, hasBottomValley: hasBottomValley,
        firstHalfDY: firstHalfDY, secondHalfDY: secondHalfDY,
        totalLen: totalLen, startToEnd: startToEnd,
        hasVerticalStem: hasVerticalStem, hasUpperBulge: hasUpperBulge, hasDiagonalLeg: hasDiagonalLeg,
    };
}

// ── Rule classifier ───────────────────────────────────────────────────────────

function classifySpell(f) {
    if (!f) return null;
    var hits = [];

    if (f.isClosed && Math.abs(f.aspectRatio - 1) < 0.5 && f.cornerCount < 4)
        hits.push({ name: 'Protego', confidence: 0.85 });

    if (!f.isClosed && f.aspectRatio < 0.55 && f.cornerCount <= 1 && f.yReversals <= 1)
        hits.push({ name: 'Alohomora', confidence: 0.82 });

    if (!f.isClosed && f.aspectRatio > 1.9 && f.cornerCount <= 1 && f.yReversals <= 1)
        hits.push({ name: 'Wingardium Leviosa', confidence: 0.82 });

    if (!f.isClosed && f.hasTopApex && f.firstHalfDY < -10 && f.secondHalfDY > 10 &&
        f.yReversals <= 2 && f.cornerCount <= 3)
        hits.push({ name: 'Lumos', confidence: 0.78 });

    if (!f.isClosed && f.hasBottomValley && f.firstHalfDY > 10 && f.secondHalfDY < -10 &&
        f.yReversals <= 2 && f.cornerCount <= 3)
        hits.push({ name: 'Nox', confidence: 0.78 });

    if (!f.isClosed && f.yReversals >= 3 && f.cornerCount >= 3)
        hits.push({ name: 'Incendio', confidence: 0.74 });

    if (!f.isClosed && f.hasVerticalStem && f.hasUpperBulge && f.hasDiagonalLeg && f.cornerCount >= 3)
        hits.push({ name: 'Revelio', confidence: 0.68 });

    if (hits.length === 0) return null;
    hits.sort(function(a, b) { return b.confidence - a.confidence; });
    return hits;
}

// ── Spell catalogue ───────────────────────────────────────────────────────────

var SPELLS = [
    { name: 'Lumos',               emoji: '💡', color: '#ffee88', description: 'Your wand lights up the darkness!',      shape: 'Draw  ^',    threshold: 0.70, effect: 'lumos',         template: null        },
    { name: 'Nox',                 emoji: '🌑', color: '#8888cc', description: 'The light fades into shadow...',         shape: 'Draw  v',    threshold: 0.70, effect: 'nox',           template: null        },
    { name: 'Alohomora',           emoji: '🔓', color: '#44aaff', description: 'The lock clicks open!',                  shape: 'Draw  |',    threshold: 0.74, effect: 'unlock',        template: null        },
    { name: 'Wingardium Leviosa',  emoji: '🪶', color: '#ffaaff', description: 'Objects float gracefully upward!',       shape: 'Draw  \u2014', threshold: 0.74, effect: 'levitate',   template: null        },
    { name: 'Protego',             emoji: '🛡️', color: '#00ccff', description: 'A magical shield surrounds you!',        shape: 'Draw  O',    threshold: 0.78, effect: 'shield',        template: _circle(64) },
    { name: 'Incendio',            emoji: '🔥', color: '#ff6600', description: 'Flames burst forth from your wand!',     shape: 'Draw  ~~~', threshold: 0.66, effect: 'fire',           template: null        },
    { name: 'Revelio',             emoji: '✨', color: '#ffffaa', description: 'Hidden constellations are revealed!',    shape: 'Draw  R',    threshold: 0.60, effect: 'constellation', template: null        },
];

// ── matchSpell ────────────────────────────────────────────────────────────────

function matchSpell(drawnPath) {
    if (!drawnPath || drawnPath.length < 10) return null;

    var features   = extractPathFeatures(drawnPath);
    var candidates = classifySpell(features);
    if (!candidates) return null;

    var top = candidates[0];
    var isAmbiguous = candidates.length > 1 && (top.confidence - candidates[1].confidence) < 0.12;

    function findSpell(name) {
        for (var k = 0; k < SPELLS.length; k++) if (SPELLS[k].name === name) return SPELLS[k];
        return null;
    }

    if (!isAmbiguous) {
        var spell = findSpell(top.name);
        if (!spell || top.confidence < spell.threshold) return null;
        return Object.assign({}, spell, { score: top.confidence, frechet: null, rms: null });
    }

    // Tie-break with affine curveSimilarity() — only candidates that have a template
    var topTwo = candidates.slice(0, 2)
        .map(function(c) { return findSpell(c.name); })
        .filter(function(s) { return s && s.template; });

    if (topTwo.length === 0) {
        var fb = findSpell(top.name);
        if (!fb || top.confidence < fb.threshold) return null;
        return Object.assign({}, fb, { score: top.confidence, frechet: null, rms: null });
    }

    var best = null, bestScore = 0;
    for (var i = 0; i < topTwo.length; i++) {
        var s = topTwo[i];
        var res = curveSimilarity(drawnPath, s.template);
        if (res.score > bestScore && res.score >= s.threshold) {
            bestScore = res.score;
            best = Object.assign({}, s, { score: res.score, frechet: res.frechet, rms: res.rms });
        }
    }
    return best;
}
