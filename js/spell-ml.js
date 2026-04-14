/**
 * spell-ml.js — 1D CNN spell classifier for IGNITE
 *
 * Pipeline
 * --------
 *   Training examples → arc-length resample (64 pts) → centroid-normalise
 *   → store in localStorage.
 *
 *   On fit():
 *     examples × 5 augmentation (noise + scale + translation jitter)
 *     → tf.Sequential 1D-CNN → trained weights saved to IndexedDB.
 *
 *   On classify():
 *     raw path → resample → normalise → model.predict() [synchronous]
 *     → softmax index → spell name + confidence.
 *
 * DTW utility
 * -----------
 *   dtwDistance(a, b)    — Sakoe-Chiba band DTW between two {x,y} sequences
 *   dtwSimilarity(a, b)  — normalised [0,1] similarity (resample + normalise first)
 *
 *   DTW replaces Fréchet distance as the sequence distance metric and is used
 *   during data augmentation to measure inter-example distances within a class.
 *
 * Dependencies (must load before this file):
 *   @tensorflow/tfjs   (global `tf`)
 *   frechet.js         (resampleCurve, normalizeCurve)
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const ML_DATA_KEY    = 'ignite_training_data';
const ML_META_KEY    = 'ignite_cnn_meta';
const ML_MODEL_KEY   = 'indexeddb://ignite-spell-cnn';
const ML_N           = 64;     // resampled path length fed to the CNN
const ML_MIN_CONF    = 0.60;   // minimum softmax confidence to accept a result
const ML_MIN_SAMPLES = 3;      // examples per class needed before training
const ML_MIN_CLASSES = 2;      // distinct classes needed before training
const ML_EPOCHS      = 100;
const ML_AUG         = 4;      // augmented copies per original example

// ═════════════════════════════════════════════════════════════════════════════
// DTW
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Dynamic Time Warping distance between two {x,y} point sequences.
 *
 * Uses a Sakoe-Chiba band to constrain warping (default: 20 % of sequence
 * length), which prevents degenerate alignments and keeps the O(N²) cost
 * practical for sequences of ~64 points.
 *
 * @param {Array<{x,y}>} a
 * @param {Array<{x,y}>} b
 * @param {number} [window]  Sakoe-Chiba half-band width in samples
 * @returns {number}  DTW cost (lower = more similar)
 */
function dtwDistance(a, b, window = Math.ceil(Math.max(a.length, b.length) * 0.20)) {
    const n = a.length;
    const m = b.length;

    // Full cost matrix — Float32 for memory efficiency
    const cost = Array.from({ length: n }, () => new Float32Array(m).fill(Infinity));

    const d = (p, q) => {
        const dx = p.x - q.x, dy = p.y - q.y;
        return Math.sqrt(dx * dx + dy * dy);
    };

    cost[0][0] = d(a[0], b[0]);

    for (let j = 1; j < Math.min(window + 1, m); j++) {
        cost[0][j] = cost[0][j - 1] + d(a[0], b[j]);
    }
    for (let i = 1; i < Math.min(window + 1, n); i++) {
        cost[i][0] = cost[i - 1][0] + d(a[i], b[0]);
    }

    for (let i = 1; i < n; i++) {
        const jLo = Math.max(1, i - window);
        const jHi = Math.min(m - 1, i + window);
        for (let j = jLo; j <= jHi; j++) {
            const up   = cost[i - 1][j];
            const left = cost[i][j - 1];
            const diag = cost[i - 1][j - 1];
            cost[i][j] = d(a[i], b[j]) + Math.min(up, left, diag);
        }
    }

    return cost[n - 1][m - 1];
}

/**
 * Normalised DTW similarity in [0, 1] between two raw {x,y} paths.
 * Both paths are arc-length resampled and centroid-normalised before
 * comparison so the score is invariant to drawing speed, position, and scale.
 *
 * @param {Array<{x,y}>} pathA
 * @param {Array<{x,y}>} pathB
 * @returns {number}  1 = identical shape, 0 = completely different
 */
function dtwSimilarity(pathA, pathB) {
    const a    = normalizeCurve(resampleCurve(pathA, ML_N));
    const b    = normalizeCurve(resampleCurve(pathB, ML_N));
    const dist = dtwDistance(a, b);
    // Exponential decay calibrated for normalised coords (range ≈ [−1, 1])
    return Math.exp(-dist / 4.0);
}

// ═════════════════════════════════════════════════════════════════════════════
// SpellCNN
// ═════════════════════════════════════════════════════════════════════════════

class SpellCNN {
    constructor() {
        this._db          = [];    // { id, spellName, path:[{x,y}×64], ts }
        this._model       = null;  // tf.LayersModel
        this._labelMap    = {};    // spellName → int index
        this._labelMapInv = {};    // int index → spellName

        /** True once a trained model is loaded and ready for inference. */
        this.isReady   = false;

        /** True while fit() is running. */
        this.isFitting = false;

        this._loadData();

        // Async — sets isReady when a previously saved model is found
        this._loadModel().then(() => {
            document.dispatchEvent(new CustomEvent('spellcnn-ready'));
        });
    }

    // ── Add a labelled example ────────────────────────────────────────────────

    /**
     * Store one labelled training path.
     * The raw path is resampled + normalised immediately for compact storage.
     * Marks the model as needing retraining.
     *
     * @param {string}         spellName
     * @param {Array<{x,y}>}   rawPath
     * @returns {string}  sample id
     */
    train(spellName, rawPath) {
        const path   = normalizeCurve(resampleCurve(rawPath, ML_N));
        const sample = { id: this._uid(), spellName: spellName.trim(), path, ts: Date.now() };
        this._db.push(sample);
        this._saveData();
        this.isReady = false;
        return sample.id;
    }

    // ── Train the CNN ─────────────────────────────────────────────────────────

    /**
     * Build and fit the 1D CNN on all stored examples.
     *
     * Requires at least ML_MIN_CLASSES spells each with ML_MIN_SAMPLES examples.
     * Training data is augmented ML_AUG× before fitting.
     * Weights are saved to IndexedDB on completion.
     *
     * @param {Function} [onEpoch]  (epoch, totalEpochs, logs) called each epoch
     * @param {Function} [onDone]   () called on successful completion
     * @returns {Promise<void>}
     */
    async fit(onEpoch, onDone) {
        if (this.isFitting) return;

        // Validate data requirements
        const classes = this.getSpellNames();
        const counts  = this.getCounts();
        const valid   = classes.filter(c => counts[c] >= ML_MIN_SAMPLES);

        if (valid.length < ML_MIN_CLASSES) {
            throw new Error(
                `Need at least ${ML_MIN_CLASSES} spells with ` +
                `${ML_MIN_SAMPLES}+ examples each. ` +
                `Have: ${valid.map(c => `${c} (${counts[c]})`).join(', ') || 'none'}`
            );
        }

        this.isFitting = true;
        this.isReady   = false;

        // Restrict to classes with sufficient data; sort for stable label order
        const eligible = this._db.filter(d => valid.includes(d.spellName));

        valid.sort();
        this._labelMap    = Object.fromEntries(valid.map((c, i) => [c, i]));
        this._labelMapInv = Object.fromEntries(valid.map((c, i) => [i, c]));

        // Augment training set
        const augmented = this._augment(eligible);

        // Build tensors
        const xData = augmented.map(d => d.path.map(p => [p.x, p.y])); // [N, 64, 2]
        const yData = augmented.map(d => this._labelMap[d.spellName]);  // [N]

        const xs = tf.tensor3d(xData);                                  // [N, 64, 2]
        const ys = tf.oneHot(tf.tensor1d(yData, 'int32'), valid.length); // [N, C]

        // Dispose previous model before rebuilding
        this._model?.dispose();
        this._model = this._buildModel(valid.length);

        const valSplit = augmented.length >= 24 ? 0.15 : 0;

        await this._model.fit(xs, ys, {
            epochs:          ML_EPOCHS,
            batchSize:       Math.max(4, Math.min(16, Math.floor(augmented.length / 4))),
            shuffle:         true,
            validationSplit: valSplit,
            callbacks: {
                onEpochEnd: (epoch, logs) => onEpoch?.(epoch, ML_EPOCHS, logs),
            },
        });

        xs.dispose();
        ys.dispose();

        this.isReady   = true;
        this.isFitting = false;

        await this._saveModel();
        this._saveMeta();

        onDone?.();
    }

    // ── Synchronous inference ─────────────────────────────────────────────────

    /**
     * Classify a drawn path.  Returns null if the model is not ready or if
     * confidence is below ML_MIN_CONF.
     *
     * @param {Array<{x,y}>} rawPath
     * @returns {{ spellName: string, confidence: number, probs: number[] } | null}
     */
    classify(rawPath) {
        if (!this._model || !this.isReady) return null;

        const path   = normalizeCurve(resampleCurve(rawPath, ML_N));
        const input  = tf.tensor3d([path.map(p => [p.x, p.y])]);  // [1, 64, 2]
        const output = this._model.predict(input);                  // [1, C]
        const probs  = Array.from(output.dataSync());
        input.dispose();
        output.dispose();

        let maxIdx = 0;
        for (let i = 1; i < probs.length; i++) {
            if (probs[i] > probs[maxIdx]) maxIdx = i;
        }

        const confidence = probs[maxIdx];
        if (confidence < ML_MIN_CONF) return null;

        return { spellName: this._labelMapInv[maxIdx], confidence, probs };
    }

    // ── Data helpers ──────────────────────────────────────────────────────────

    getAll()        { return [...this._db]; }
    getSpellNames() { return [...new Set(this._db.map(s => s.spellName))].sort(); }

    getCounts() {
        const c = {};
        for (const s of this._db) c[s.spellName] = (c[s.spellName] ?? 0) + 1;
        return c;
    }

    deleteById(id) {
        this._db     = this._db.filter(s => s.id !== id);
        this.isReady = false;
        this._saveData();
    }

    deleteBySpell(name) {
        this._db     = this._db.filter(s => s.spellName !== name);
        this.isReady = false;
        this._saveData();
    }

    clearAll() {
        this._db     = [];
        this.isReady = false;
        this._model?.dispose();
        this._model = null;
        this._saveData();
        localStorage.removeItem(ML_META_KEY);
        tf.io.removeModel(ML_MODEL_KEY).catch(() => {});
    }

    /**
     * Returns true when there are enough classes + examples to call fit().
     * @param {number} [minPerSpell=ML_MIN_SAMPLES]
     */
    hasEnoughData(minPerSpell = ML_MIN_SAMPLES) {
        const counts  = this.getCounts();
        const passing = Object.values(counts).filter(c => c >= minPerSpell).length;
        return passing >= ML_MIN_CLASSES;
    }

    exportJSON()  { return JSON.stringify(this._db, null, 2); }

    importJSON(str) {
        try {
            const parsed = JSON.parse(str);
            if (!Array.isArray(parsed)) throw new Error('Expected array');
            this._db     = parsed;
            this.isReady = false;
            this._saveData();
            return true;
        } catch (e) {
            console.error('[SpellCNN] Import failed:', e);
            return false;
        }
    }

    // ── CNN architecture ──────────────────────────────────────────────────────

    /**
     * Small 1D CNN designed for limited training data (tens of examples per
     * class).  Three conv blocks with batch-norm + pooling extract local
     * temporal features; global average pooling collapses the sequence
     * dimension; a dropout head prevents overfitting.
     *
     * Input shape : [batch, ML_N, 2]   (64 × (x, y))
     * Output shape: [batch, numClasses] (softmax)
     */
    _buildModel(numClasses) {
        const m = tf.sequential({ name: 'spell-cnn' });

        // Block 1 — wide kernel to catch coarse stroke direction
        m.add(tf.layers.conv1d({
            filters: 32, kernelSize: 7, activation: 'relu',
            padding: 'same', inputShape: [ML_N, 2],
        }));
        m.add(tf.layers.batchNormalization());
        m.add(tf.layers.maxPooling1d({ poolSize: 2 }));   // → [32, 32]

        // Block 2 — medium kernel for shape segments
        m.add(tf.layers.conv1d({
            filters: 64, kernelSize: 5, activation: 'relu', padding: 'same',
        }));
        m.add(tf.layers.batchNormalization());
        m.add(tf.layers.maxPooling1d({ poolSize: 2 }));   // → [16, 64]

        // Block 3 — fine detail
        m.add(tf.layers.conv1d({
            filters: 128, kernelSize: 3, activation: 'relu', padding: 'same',
        }));
        m.add(tf.layers.globalAveragePooling1d());         // → [128]

        // Classification head
        m.add(tf.layers.dense({ units: 64, activation: 'relu' }));
        m.add(tf.layers.dropout({ rate: 0.4 }));
        m.add(tf.layers.dense({ units: numClasses, activation: 'softmax' }));

        m.compile({
            optimizer: tf.train.adam(0.001),
            loss:      'categoricalCrossentropy',
            metrics:   ['accuracy'],
        });

        return m;
    }

    // ── Data augmentation ─────────────────────────────────────────────────────

    /**
     * Expand the training set ML_AUG× per original example using:
     *   • Gaussian coordinate noise  (σ = 0.04)
     *   • Random scale jitter        (±20 %)
     *   • Random translation jitter  (±15 %)
     *
     * DTW is used to verify that each augmented path remains closer to its
     * own class centroid than to any other class, discarding outliers that
     * augmentation has pushed into an ambiguous region.
     */
    _augment(examples) {
        const result = [...examples];

        // Build per-class centroid paths using DTW barycenter approximation
        // (simple mean of normalised paths — good enough for small N)
        const classCentroids = {};
        const byClass = {};
        for (const ex of examples) {
            (byClass[ex.spellName] ??= []).push(ex.path);
        }
        for (const [name, paths] of Object.entries(byClass)) {
            const n = paths[0].length;
            classCentroids[name] = Array.from({ length: n }, (_, i) => ({
                x: paths.reduce((s, p) => s + p[i].x, 0) / paths.length,
                y: paths.reduce((s, p) => s + p[i].y, 0) / paths.length,
            }));
        }
        const centroidEntries = Object.entries(classCentroids);

        for (const ex of examples) {
            for (let k = 0; k < ML_AUG; k++) {
                const scale = 0.80 + Math.random() * 0.40;   // 0.80 – 1.20
                const tx    = (Math.random() - 0.5) * 0.30;
                const ty    = (Math.random() - 0.5) * 0.30;

                const path = ex.path.map(p => ({
                    x: p.x * scale + tx + (Math.random() - 0.5) * 0.08,
                    y: p.y * scale + ty + (Math.random() - 0.5) * 0.08,
                }));

                // DTW guard: discard if closer to a different class centroid
                if (centroidEntries.length > 1) {
                    const ownDist  = dtwDistance(path, classCentroids[ex.spellName]);
                    const minOther = Math.min(
                        ...centroidEntries
                            .filter(([n]) => n !== ex.spellName)
                            .map(([, c]) => dtwDistance(path, c))
                    );
                    if (ownDist >= minOther) continue;  // ambiguous — skip
                }

                result.push({ ...ex, id: this._uid(), path });
            }
        }

        return result;
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _saveData() {
        try { localStorage.setItem(ML_DATA_KEY, JSON.stringify(this._db)); }
        catch (e) { console.warn('[SpellCNN] Data save failed:', e); }
    }

    _loadData() {
        try {
            const raw = localStorage.getItem(ML_DATA_KEY);
            this._db  = raw ? JSON.parse(raw) : [];
        } catch { this._db = []; }
    }

    _saveMeta() {
        localStorage.setItem(ML_META_KEY, JSON.stringify({
            labelMap:    this._labelMap,
            labelMapInv: this._labelMapInv,
        }));
    }

    async _saveModel() {
        try { await this._model.save(ML_MODEL_KEY); }
        catch (e) { console.warn('[SpellCNN] Model save failed:', e); }
    }

    async _loadModel() {
        try {
            const raw = localStorage.getItem(ML_META_KEY);
            if (!raw) return;
            const { labelMap, labelMapInv } = JSON.parse(raw);
            this._labelMap    = labelMap;
            this._labelMapInv = labelMapInv;
            this._model  = await tf.loadLayersModel(ML_MODEL_KEY);
            this.isReady = true;
            console.log('[SpellCNN] Restored model from IndexedDB');
        } catch {
            console.log('[SpellCNN] No saved model — fit() required');
        }
    }

    _uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const spellML = new SpellCNN();
