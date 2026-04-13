/**
 * training-ui.js — Training Studio UI for IGNITE
 *
 * Responsibilities
 * ----------------
 *   • "🎓 Train" button in the mode-bar toggles Training Mode
 *   • Training Mode swaps the spellbook sidebar for the Training Studio panel
 *   • While Training Mode is active, every completed stroke shows a label
 *     dialog instead of attempting a spell cast
 *   • The Training Studio panel shows:
 *       - Recognizer toggle: Rule-based vs ML (kNN)
 *       - Per-spell example counts with individual delete buttons
 *       - Export / Import / Clear All data controls
 *   • A small inline toast confirms saves/errors
 *
 * Dependencies (must be loaded first):
 *   frechet.js  (resampleCurve, curveSimilarity)
 *   spell-ml.js (spellML singleton)
 *   spells.js   (SPELLS array)
 */

'use strict';

class TrainingUI {
    /**
     * @param {SpellApp} app  — the main application instance
     */
    constructor(app) {
        this.app          = app;
        this.trainingMode = false;
        this.recognizer   = 'rules';   // 'rules' | 'ml'
        this._pendingPath = null;

        this._buildPanel();
        this._bindControls();
        this._bindTrainButton();
        this.refresh();
    }

    // ── Training mode toggle ──────────────────────────────────────────────────

    setTrainingMode(on) {
        this.trainingMode = on;
        document.getElementById('btn-train')
            .classList.toggle('active', on);
        document.getElementById('spellbook')
            .classList.toggle('hidden', on);
        document.getElementById('training-panel')
            .classList.toggle('hidden', !on);
    }

    // ── Called by app when a drawn path should be labelled ───────────────────

    offerLabel(path) {
        this._pendingPath = path;
        this._showLabelDialog(path);
    }

    // ── Panel HTML ────────────────────────────────────────────────────────────

    _buildPanel() {
        const panel = document.createElement('div');
        panel.id        = 'training-panel';
        panel.className = 'hidden';
        panel.innerHTML = `
            <h2 class="training-title">🎓 Training Studio</h2>
            <p class="training-subtitle">Teach IGNITE new spells</p>

            <!-- Recognizer toggle -->
            <div class="training-section">
                <div class="training-row">
                    <span class="training-label">Recognizer</span>
                    <div class="tog-group" id="recognizer-toggle">
                        <button class="tog-btn active" data-val="rules">Rules</button>
                        <button class="tog-btn"        data-val="ml">ML kNN</button>
                    </div>
                </div>
                <p class="rec-hint" id="rec-hint">Built-in rule-based matching</p>
            </div>

            <!-- Example stats -->
            <div class="training-section">
                <div class="training-row">
                    <span class="training-label">Training Examples</span>
                    <span class="count-badge" id="total-count">0</span>
                </div>
                <div id="spell-stats"></div>
            </div>

            <!-- Actions -->
            <div class="training-actions">
                <button class="act-btn" id="btn-export"    title="Save training data to JSON file">📤 Export</button>
                <button class="act-btn" id="btn-import"    title="Load training data from JSON file">📥 Import</button>
                <button class="act-btn danger" id="btn-clear-all" title="Delete all training examples">🗑 Clear</button>
            </div>

            <input type="file" id="import-file" accept=".json" class="hidden">
        `;
        document.getElementById('app').appendChild(panel);
    }

    // ── Event wiring ──────────────────────────────────────────────────────────

    _bindTrainButton() {
        document.getElementById('btn-train')
            .addEventListener('click', () => this.setTrainingMode(!this.trainingMode));
    }

    _bindControls() {
        // Recognizer toggle
        document.querySelectorAll('#recognizer-toggle .tog-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#recognizer-toggle .tog-btn')
                    .forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.recognizer = btn.dataset.val;
                this._updateRecHint();
            });
        });

        // Export
        document.getElementById('btn-export').addEventListener('click', () => {
            const json = spellML.exportJSON();
            const blob = new Blob([json], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = 'ignite-training-data.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        // Import
        document.getElementById('btn-import').addEventListener('click', () =>
            document.getElementById('import-file').click()
        );
        document.getElementById('import-file').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                if (spellML.importJSON(ev.target.result)) {
                    this.refresh();
                    this._toast('✅ Imported successfully');
                } else {
                    this._toast('❌ Import failed — invalid JSON', true);
                }
            };
            reader.readAsText(file);
            e.target.value = '';
        });

        // Clear all
        document.getElementById('btn-clear-all').addEventListener('click', () => {
            if (!confirm('Delete ALL training examples? This cannot be undone.')) return;
            spellML.clearAll();
            this.refresh();
        });
    }

    // ── Spell stats list ──────────────────────────────────────────────────────

    refresh() {
        const counts = spellML.getCounts();
        const total  = Object.values(counts).reduce((a, b) => a + b, 0);
        document.getElementById('total-count').textContent = total;

        const stats = document.getElementById('spell-stats');
        stats.innerHTML = '';

        const names = spellML.getSpellNames();

        if (names.length === 0) {
            stats.innerHTML = `
                <p class="no-data-hint">
                    No examples yet.<br>
                    Enable Training Mode and draw spells to begin.
                </p>`;
            this._updateRecHint();
            return;
        }

        for (const name of names) {
            const spell = SPELLS.find(s => s.name === name);
            const emoji = spell?.emoji ?? '✨';
            const color = spell?.color ?? '#aa88ff';
            const n     = counts[name];

            const row = document.createElement('div');
            row.className = 'stat-row';
            row.innerHTML = `
                <span class="stat-emoji">${emoji}</span>
                <span class="stat-name" style="color:${color}">${name}</span>
                <span class="stat-count">${n}</span>
                <button class="stat-del" title="Delete all ${name} examples">✕</button>
            `;
            row.querySelector('.stat-del').addEventListener('click', () => {
                if (!confirm(`Delete all ${n} example${n !== 1 ? 's' : ''} of "${name}"?`)) return;
                spellML.deleteBySpell(name);
                this.refresh();
            });
            stats.appendChild(row);
        }

        this._updateRecHint();
    }

    _updateRecHint() {
        const hint = document.getElementById('rec-hint');
        if (!hint) return;
        if (this.recognizer === 'ml') {
            const n = spellML.getAll().length;
            hint.textContent = n > 0
                ? `ML kNN · ${n} example${n !== 1 ? 's' : ''} loaded`
                : 'ML kNN · add examples first!';
        } else {
            hint.textContent = 'Built-in rule-based matching';
        }
    }

    // ── Label dialog ──────────────────────────────────────────────────────────

    _showLabelDialog(path) {
        document.getElementById('label-dialog')?.remove();

        // Known spell names: built-in first, then any custom ones already trained
        const knownNames = [
            ...SPELLS.map(s => s.name),
            ...spellML.getSpellNames().filter(n => !SPELLS.find(s => s.name === n)),
        ];

        const spellBtns = knownNames.map(n => {
            const sp = SPELLS.find(s => s.name === n);
            return `
                <button class="label-spell-btn" data-name="${n}"
                        style="--sc:${sp?.color ?? '#aa88ff'}">
                    ${sp?.emoji ?? '✨'} ${n}
                </button>`;
        }).join('');

        const dialog = document.createElement('div');
        dialog.id = 'label-dialog';
        dialog.innerHTML = `
            <div class="label-inner">
                <h3 class="label-title">✏️ Label this spell</h3>
                <div class="label-preview">${this._pathToSVG(path, 200, 140)}</div>
                <div class="label-spell-btns">${spellBtns}</div>
                <hr class="label-divider">
                <div class="label-custom-row">
                    <input id="custom-name" type="text"
                           placeholder="Custom spell name…"
                           maxlength="32" autocomplete="off">
                    <button id="btn-save-custom">Save</button>
                </div>
                <button id="btn-discard" class="label-discard">Discard</button>
            </div>
        `;
        document.getElementById('camera-area').appendChild(dialog);

        // Known spell buttons
        dialog.querySelectorAll('.label-spell-btn').forEach(btn =>
            btn.addEventListener('click', () => this._saveLabel(btn.dataset.name))
        );

        // Custom name
        const customInput = document.getElementById('custom-name');
        document.getElementById('btn-save-custom').addEventListener('click', () => {
            const n = customInput.value.trim();
            if (n) this._saveLabel(n);
        });
        customInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const n = customInput.value.trim();
                if (n) this._saveLabel(n);
            }
        });

        // Discard
        document.getElementById('btn-discard').addEventListener('click', () => this._dismiss());

        // Auto-focus for keyboard entry
        setTimeout(() => customInput.focus(), 80);
    }

    _saveLabel(spellName) {
        if (!this._pendingPath) return;
        spellML.train(spellName, this._pendingPath);
        this._pendingPath = null;
        this._dismiss();
        this.refresh();
        this._toast(`✅ Saved "${spellName}"`);
    }

    _dismiss() {
        document.getElementById('label-dialog')?.remove();
        this._pendingPath = null;
        // Resume tracking so the user can draw again
        this.app.tracker?.resumeTracking();
    }

    // ── Path → inline SVG preview ─────────────────────────────────────────────

    _pathToSVG(path, w, h) {
        if (!path || path.length < 2) {
            return `<svg width="${w}" height="${h}">
                <rect width="${w}" height="${h}" rx="8" fill="rgba(8,0,26,0.85)"/>
                <text x="50%" y="52%" text-anchor="middle" fill="rgba(180,160,220,0.4)"
                      font-size="12" font-family="sans-serif">no path</text>
            </svg>`;
        }

        const pad = 16;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of path) {
            if (p.x < x0) x0 = p.x;  if (p.x > x1) x1 = p.x;
            if (p.y < y0) y0 = p.y;  if (p.y > y1) y1 = p.y;
        }
        const rx = x1 - x0 || 1;
        const ry = y1 - y0 || 1;
        const sc = Math.min((w - pad * 2) / rx, (h - pad * 2) / ry);
        const ox = pad + ((w - pad * 2) - rx * sc) / 2;
        const oy = pad + ((h - pad * 2) - ry * sc) / 2;

        const pts = path.map(p => ({
            x: ox + (p.x - x0) * sc,
            y: oy + (p.y - y0) * sc,
        }));
        const d  = 'M' + pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L');
        const sp = pts[0];
        const ep = pts[pts.length - 1];

        return `
            <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <filter id="svgGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="2.5" result="blur"/>
                        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                    </filter>
                </defs>
                <rect width="${w}" height="${h}" rx="8" fill="rgba(8,0,26,0.88)"/>
                <!-- glow layer -->
                <path d="${d}" stroke="rgba(200,120,255,0.35)" stroke-width="7"
                      stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                <!-- main line -->
                <path d="${d}" stroke="#cc88ff" stroke-width="2.2"
                      stroke-linecap="round" stroke-linejoin="round"
                      fill="none" filter="url(#svgGlow)"/>
                <!-- start / end markers -->
                <circle cx="${sp.x.toFixed(1)}" cy="${sp.y.toFixed(1)}" r="4.5" fill="#44ff88"
                        style="filter:drop-shadow(0 0 3px #44ff88)"/>
                <circle cx="${ep.x.toFixed(1)}" cy="${ep.y.toFixed(1)}" r="4.5" fill="#ff4488"
                        style="filter:drop-shadow(0 0 3px #ff4488)"/>
            </svg>`;
    }

    // ── Inline toast notification ─────────────────────────────────────────────

    _toast(msg, isError = false) {
        const el = document.createElement('div');
        el.className = 'training-toast' + (isError ? ' error' : '');
        el.textContent = msg;
        document.getElementById('camera-area').appendChild(el);
        setTimeout(() => el.remove(), 2200);
    }
}
