/**
 * spell-ml.js — kNN spell classifier for IGNITE
 *
 * Uses curveSimilarity() from frechet.js as the distance metric.
 * Each training sample is stored as a 64-point arc-length resampled path so
 * comparisons stay fast regardless of how many points the user drew.
 *
 * Persistence: localStorage key  'ignite_training_data'
 *
 * Public API
 * ----------
 *   spellML.train(spellName, rawPath)   → id string
 *   spellML.classify(rawPath)           → { spellName, confidence } | null
 *   spellML.getAll()                    → sample[]
 *   spellML.getSpellNames()             → string[]
 *   spellML.getCounts()                 → { [name]: number }
 *   spellML.deleteById(id)
 *   spellML.deleteBySpell(name)
 *   spellML.clearAll()
 *   spellML.hasEnoughData(minPerSpell)  → bool
 *   spellML.exportJSON()                → string
 *   spellML.importJSON(str)             → bool
 */

'use strict';

const ML_STORAGE_KEY = 'ignite_training_data';
const ML_RESAMPLE_N  = 64;    // stored path resolution (points)
const ML_MIN_CONF    = 0.38;  // minimum top-1 similarity to accept a result
const ML_K           = 5;     // k nearest neighbours to vote over

// ── SpellML ───────────────────────────────────────────────────────────────────

class SpellML {
    constructor() {
        this._db = [];
        this._load();
    }

    // ── Training ──────────────────────────────────────────────────────────────

    /**
     * Add one labelled training example.
     * The raw path is resampled to ML_RESAMPLE_N points for compact storage.
     * @param {string}            spellName
     * @param {Array<{x,y}>}      rawPath
     * @returns {string}  sample id
     */
    train(spellName, rawPath) {
        const stored = resampleCurve(rawPath, ML_RESAMPLE_N);
        const sample = {
            id:        this._uid(),
            spellName: spellName.trim(),
            path:      stored,
            ts:        Date.now(),
        };
        this._db.push(sample);
        this._save();
        return sample.id;
    }

    // ── Classification ────────────────────────────────────────────────────────

    /**
     * Classify a drawn path using weighted kNN over curveSimilarity scores.
     * Returns null if confidence is below ML_MIN_CONF or database is empty.
     *
     * @param {Array<{x,y}>} rawPath
     * @param {number}       [k=ML_K]
     * @returns {{ spellName: string, confidence: number } | null}
     */
    classify(rawPath, k = ML_K) {
        if (this._db.length === 0) return null;

        // Score every stored example against the query
        const scored = this._db.map(s => ({
            spellName: s.spellName,
            score:     curveSimilarity(rawPath, s.path, ML_RESAMPLE_N).score,
        }));

        scored.sort((a, b) => b.score - a.score);

        const neighbours = scored.slice(0, Math.min(k, scored.length));

        // Weighted vote — weight = similarity score
        const tally = {};
        for (const n of neighbours) {
            tally[n.spellName] = (tally[n.spellName] ?? 0) + n.score;
        }

        const winner     = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
        const confidence = neighbours[0].score;   // top-1 score as confidence proxy

        if (confidence < ML_MIN_CONF) return null;
        return { spellName: winner[0], confidence };
    }

    // ── Data management ───────────────────────────────────────────────────────

    getAll()        { return [...this._db]; }
    getSpellNames() { return [...new Set(this._db.map(s => s.spellName))].sort(); }

    /** Returns { [spellName]: count } */
    getCounts() {
        const c = {};
        for (const s of this._db) c[s.spellName] = (c[s.spellName] ?? 0) + 1;
        return c;
    }

    deleteById(id) {
        this._db = this._db.filter(s => s.id !== id);
        this._save();
    }

    deleteBySpell(name) {
        this._db = this._db.filter(s => s.spellName !== name);
        this._save();
    }

    clearAll() {
        this._db = [];
        this._save();
    }

    /**
     * True when there is at least one spell with >= minPerSpell examples.
     * Used to decide whether ML classification is viable.
     */
    hasEnoughData(minPerSpell = 1) {
        if (this._db.length === 0) return false;
        return Object.values(this.getCounts()).some(c => c >= minPerSpell);
    }

    // ── Import / Export ───────────────────────────────────────────────────────

    exportJSON() { return JSON.stringify(this._db, null, 2); }

    importJSON(str) {
        try {
            const parsed = JSON.parse(str);
            if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
            this._db = parsed;
            this._save();
            return true;
        } catch (e) {
            console.error('[SpellML] Import failed:', e);
            return false;
        }
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _save() {
        try {
            localStorage.setItem(ML_STORAGE_KEY, JSON.stringify(this._db));
        } catch (e) {
            console.warn('[SpellML] localStorage write failed:', e);
        }
    }

    _load() {
        try {
            const raw = localStorage.getItem(ML_STORAGE_KEY);
            this._db  = raw ? JSON.parse(raw) : [];
        } catch {
            this._db = [];
        }
    }

    _uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const spellML = new SpellML();
