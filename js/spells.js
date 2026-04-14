/**
 * spells.js — Simplified spell recognition (Lumos, Nox, Revelio only)
 *
 * Fast feature-based recognition for three simple spells.
 * No tie-breaking needed — rules are mutually exclusive.
 */

'use strict';

// ── Feature extractor (simplified) ────────────────────────────────────────────

function extractPathFeatures(path) {
  if (!path || path.length < 5) return null;

  var n = path.length, i;
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (i = 0; i < n; i++) {
    var p = path[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }

  var width = maxX - minX, height = maxY - minY;
  if (width < 15 && height < 15) return null;

  var aspectRatio = height > 1 ? width / height : 999;

  // Downsample for corner/reversal detection
  var ds = Math.max(1, Math.floor(n / 40));
  var samp = [];
  for (i = 0; i < n; i += ds) samp.push(path[i]);
  var sn = samp.length;

  // Count corners (sharp direction changes)
  var cornerCount = 0;
  var CORNER_RAD = 0.7; // ~40 degrees

  for (var j = 1; j < sn - 1; j++) {
    var v1x = samp[j].x - samp[j-1].x, v1y = samp[j].y - samp[j-1].y;
    var v2x = samp[j+1].x - samp[j].x, v2y = samp[j+1].y - samp[j].y;
    var m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    if (m1 > 0 && m2 > 0) {
      var ang = Math.acos(Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / (m1*m2))));
      if (ang > CORNER_RAD) cornerCount++;
    }
  }

  // Count Y-direction reversals (with minimum movement threshold)
  var yReversals = 0;
  var prevDy = 0;
  var minMove = height * 0.08; // must move at least 8% of height

  for (var r = 1; r < sn; r++) {
    var rdy = samp[r].y - samp[r-1].y;
    if (Math.abs(rdy) > minMove) {
      var rdir = rdy > 0 ? 1 : -1;
      if (prevDy !== 0 && rdir !== prevDy) yReversals++;
      prevDy = rdir;
    }
  }

  // Find apex (highest point = lowest Y in canvas coords)
  var apexIdx = 0;
  for (var m = 1; m < n; m++) {
    if (path[m].y < path[apexIdx].y) apexIdx = m;
  }
  var apexRelPos   = apexIdx / (n - 1);
  var hasTopApex   = apexRelPos > 0.15 && apexRelPos < 0.85;

  // Find valley (lowest point = highest Y in canvas coords)
  var valleyIdx = 0;
  for (var v = 1; v < n; v++) {
    if (path[v].y > path[valleyIdx].y) valleyIdx = v;
  }
  var valleyRelPos    = valleyIdx / (n - 1);
  var hasBottomValley = valleyRelPos > 0.15 && valleyRelPos < 0.85;

  // Direction measured from start → apex and apex → end.
  // Using the actual apex/valley index is far more robust than a temporal
  // midpoint split: it is unaffected by uneven drawing speed.
  var startToApexDY   = (path[apexIdx].y   - path[0].y)       / height;  // <0 for ^
  var apexToEndDY     = (path[n-1].y        - path[apexIdx].y) / height;  // >0 for ^
  var startToValleyDY = (path[valleyIdx].y  - path[0].y)       / height;  // >0 for v
  var valleyToEndDY   = (path[n-1].y        - path[valleyIdx].y) / height; // <0 for v

  // R-shape detection features
  var leftPts = path.filter(function(pt) { return pt.x < minX + width * 0.45; });
  var upperPts = path.filter(function(pt) { return pt.y < minY + height * 0.55; });
  var lateRightPts = path.filter(function(pt, idx) { 
    return idx > n * 0.45 && pt.x > minX + width * 0.45; 
  });
  
  var hasVerticalStem = aspectRatio < 1.0 && leftPts.length > n * 0.25;
  var hasUpperBulge = upperPts.length > n * 0.25 && cornerCount >= 2;
  var hasDiagonalLeg = lateRightPts.length > n * 0.10;

  return {
    width: width,
    height: height,
    aspectRatio: aspectRatio,
    cornerCount: cornerCount,
    yReversals: yReversals,
    hasTopApex: hasTopApex,
    hasBottomValley: hasBottomValley,
    startToApexDY: startToApexDY,
    apexToEndDY: apexToEndDY,
    startToValleyDY: startToValleyDY,
    valleyToEndDY: valleyToEndDY,
    hasVerticalStem: hasVerticalStem,
    hasUpperBulge: hasUpperBulge,
    hasDiagonalLeg: hasDiagonalLeg,
  };
}

// ── Rule classifier (three spells only) ───────────────────────────────────────

function classifySpell(f) {
  if (!f) return null;
  var hits = [];

  // Lumos: ^ shape — stroke goes up to apex then back down.
  // Direction is measured start→apex and apex→end (not a temporal midpoint
  // split) so drawing speed variation cannot fool it.
  // yReversals allows 1–3 to tolerate normal hand tremor.
  if (f.hasTopApex &&
      f.startToApexDY  < -0.25 &&   // stroke rises to apex
      f.apexToEndDY    >  0.25 &&   // stroke falls from apex
      f.yReversals >= 1 && f.yReversals <= 3 &&
      f.cornerCount >= 1 && f.cornerCount <= 5 &&
      f.aspectRatio > 0.25 && f.aspectRatio < 4.0) {
    hits.push({ name: 'Lumos', confidence: 0.85 });
  }

  // Nox: v shape — stroke goes down to valley then back up.
  if (f.hasBottomValley &&
      f.startToValleyDY >  0.25 &&  // stroke descends to valley
      f.valleyToEndDY   < -0.25 &&  // stroke rises from valley
      f.yReversals >= 1 && f.yReversals <= 3 &&
      f.cornerCount >= 1 && f.cornerCount <= 5 &&
      f.aspectRatio > 0.25 && f.aspectRatio < 4.0) {
    hits.push({ name: 'Nox', confidence: 0.85 });
  }

  // Revelio: R shape — vertical stem + upper loop + diagonal kick.
  // Requires cornerCount >= 3 (the loop adds extra corners vs the 1 of ^ or v)
  // and yReversals >= 2 to distinguish the looping body from a simple arc.
  if (f.hasVerticalStem &&
      f.hasUpperBulge &&
      f.hasDiagonalLeg &&
      f.cornerCount >= 3 &&
      f.yReversals   >= 2 &&
      f.aspectRatio  <  1.3) {
    hits.push({ name: 'Revelio', confidence: 0.75 });
  }

  if (hits.length === 0) return null;
  hits.sort(function(a, b) { return b.confidence - a.confidence; });
  return hits;
}

// ── Spell catalogue (three spells) ────────────────────────────────────────────

var SPELLS = [
  {
    name: 'Lumos',
    emoji: '💡',
    color: '#ffee88',
    description: 'Your wand lights up the darkness!',
    shape: 'Draw ^',
    threshold: 0.70,
    effect: 'lumos',
    template: null
  },
  {
    name: 'Nox',
    emoji: '🌑',
    color: '#8888cc',
    description: 'The light fades into shadow...',
    shape: 'Draw v',
    threshold: 0.70,
    effect: 'nox',
    template: null
  },
  {
    name: 'Revelio',
    emoji: '✨',
    color: '#ffffaa',
    description: 'Hidden constellations are revealed!',
    shape: 'Draw R',
    threshold: 0.65,
    effect: 'constellation',
    template: null
  },
];

// ── matchSpell (simplified - no tie-breaking needed) ──────────────────────────

function matchSpell(drawnPath) {
  if (!drawnPath || drawnPath.length < 10) return null;

  var features = extractPathFeatures(drawnPath);
  var candidates = classifySpell(features);
  
  if (!candidates || candidates.length === 0) return null;

  var top = candidates[0];

  // Find the matching spell definition
  var spell = null;
  for (var k = 0; k < SPELLS.length; k++) {
    if (SPELLS[k].name === top.name) {
      spell = SPELLS[k];
      break;
    }
  }

  if (!spell || top.confidence < spell.threshold) return null;

  // Return winner immediately (no expensive tie-breaking)
  return {
    name: spell.name,
    emoji: spell.emoji,
    color: spell.color,
    description: spell.description,
    shape: spell.shape,
    effect: spell.effect,
    score: top.confidence,
    frechet: null,
    rms: null
  };
}

// ── SVG helper for spell book ─────────────────────────────────────────────────

function templateToSVGPoints(template) {
  // For spells without templates, return a simple placeholder
  if (!template) return '0,0 0.5,0.5 1,1';
  
  return template
    .map(function(p) { return (p.x * 0.9).toFixed(2) + ',' + (p.y * 0.9).toFixed(2); })
    .join(' ');
}