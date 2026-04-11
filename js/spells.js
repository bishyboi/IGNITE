/**
 * spells.js — Spell template definitions and matching
 *
 * Each entry in SPELLS has:
 *   name        — display name
 *   emoji       — big icon shown on success
 *   color       — hex colour for glow / particles
 *   description — flavour text shown on success
 *   shape       — short hint shown in the spell book
 *   template    — normalised Array<{x,y}> curve
 *   threshold   — minimum curveSimilarity().score to count as a match
 *   effect      — key for the particle emitter in app.js
 */

'use strict';

// ── Template generators ───────────────────────────────────────────────────────

function _circle(n = 64) {
    return Array.from({ length: n }, (_, i) => {
        const a = (i / n) * 2 * Math.PI;
        return { x: Math.cos(a), y: Math.sin(a) };
    });
}

// Zigzag with `peaks` full peaks (W shape when peaks=3)
function _zigzag(peaks = 3) {
    const pts = [];
    const segs = peaks * 2;
    for (let i = 0; i <= segs; i++) {
        pts.push({
            x: (i / segs) * 2 - 1,
            y: (i % 2 === 0) ? 1 : -1,
        });
    }
    return pts;
}

// 5-pointed star (outer + inner radius alternating)
function _star(n = 5, innerR = 0.38) {
    const pts = [];
    for (let i = 0; i <= n * 2; i++) {
        const a = (i * Math.PI / n) - Math.PI / 2;
        const r = (i % 2 === 0) ? 1 : innerR;
        pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pts;
}

// Outward Archimedean spiral
function _spiral(turns = 1.75, n = 80) {
    return Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        const a = t * turns * 2 * Math.PI;
        return { x: t * Math.cos(a), y: t * Math.sin(a) };
    });
}

// Lemniscate-of-Bernoulli style figure-8
function _figure8(n = 64) {
    return Array.from({ length: n }, (_, i) => {
        const t = (i / n) * 2 * Math.PI;
        return { x: Math.sin(t), y: Math.sin(2 * t) * 0.5 };
    });
}

// ── Spell catalogue ───────────────────────────────────────────────────────────

// Thresholds are minimum curveSimilarity().score values.
// With affine-invariant matching, score ≥ 0.40 = good match, ≥ 0.35 = acceptable.
const SPELLS = [
    {
        name:        'Circle of Protection',
        emoji:       '🛡️',
        color:       '#00ccff',
        description: 'A magical shield rises around you!',
        shape:       'Draw a full circle',
        template:    _circle(64),
        threshold:   0.42,
        effect:      'shield',
    },
    {
        name:        'Thunder Strike',
        emoji:       '⚡',
        color:       '#ffee00',
        description: 'Lightning crackles across the sky!',
        shape:       'Draw a zigzag / W',
        template:    _zigzag(3),
        threshold:   0.38,
        effect:      'lightning',
    },
    {
        name:        'Star Power',
        emoji:       '⭐',
        color:       '#ffaa00',
        description: 'Stars rain down from the heavens!',
        shape:       'Draw a 5-pointed star',
        template:    _star(5),
        threshold:   0.35,
        effect:      'star',
    },
    {
        name:        'Vortex Spiral',
        emoji:       '🌀',
        color:       '#aa44ff',
        description: 'A swirling vortex tears open!',
        shape:       'Draw an outward spiral',
        template:    _spiral(1.75, 80),
        threshold:   0.38,
        effect:      'spiral',
    },
    {
        name:        'Infinity Loop',
        emoji:       '🔁',
        color:       '#44ff88',
        description: 'Endless magic flows through you!',
        shape:       'Draw a figure-8 (∞)',
        template:    _figure8(64),
        threshold:   0.38,
        effect:      'infinity',
    },
];

// ── Spell matching ────────────────────────────────────────────────────────────

/**
 * Find the best-matching spell for a drawn path.
 * Returns the winning spell object (augmented with .score / .frechet / .rms)
 * or null if nothing clears its threshold.
 *
 * @param {Array<{x,y}>} drawnPath
 * @returns {object|null}
 */
function matchSpell(drawnPath) {
    if (!drawnPath || drawnPath.length < 10) return null;

    let best      = null;
    let bestScore = 0;

    for (const spell of SPELLS) {
        const { score, frechet, rms } = curveSimilarity(drawnPath, spell.template);
        if (score > bestScore && score >= spell.threshold) {
            bestScore = score;
            best = { ...spell, score, frechet, rms };
        }
    }

    return best;
}

// ── Mini SVG helper for the spell book ───────────────────────────────────────

/**
 * Convert a template curve to an SVG <polyline> points string
 * that fits inside a viewBox of "-1.1 -1.1 2.2 2.2".
 *
 * @param {Array<{x,y}>} template
 * @returns {string}
 */
function templateToSVGPoints(template) {
    return template
        .map(p => `${(p.x * 0.9).toFixed(2)},${(p.y * 0.9).toFixed(2)}`)
        .join(' ');
}
