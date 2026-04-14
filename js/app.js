/**
 * app.js — IGNITE Magic Spell Caster — Main application
 *
 * Orchestrates: tracker → spell matching → canvas rendering + particles + UI
 * Supports two tracker modes:
 *   'hand' — MediaPipe HandTracker (pinch to draw)
 *   'ir'   — IRTracker (hold still to toggle drawing)
 */

'use strict';

// ── Particle ──────────────────────────────────────────────────────────────────

class Particle {
    constructor(x, y, vx, vy, color, size) {
        this.x = x; this.y = y;
        this.vx = vx; this.vy = vy;
        this.color   = color;
        this.size    = size;
        this.life    = 1.0;
        this.decay   = 0.016 + Math.random() * 0.012;
        this.gravity = 0.055;
    }

    update() {
        this.x  += this.vx;
        this.y  += this.vy;
        this.vy += this.gravity;
        this.vx *= 0.97;
        this.life -= this.decay;
    }

    draw(ctx) {
        if (this.life <= 0) return;
        const a = Math.max(0, this.life);
        const r = this.size * Math.max(0.05, this.life);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle   = this.color;
        ctx.shadowBlur  = 14;
        ctx.shadowColor = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    isDead() { return this.life <= 0; }
}

// ── SpellApp ──────────────────────────────────────────────────────────────────

class SpellApp {
    constructor() {
        this.canvas = document.getElementById('overlay');
        this.ctx    = this.canvas.getContext('2d');
        this.video  = document.getElementById('webcam');

        this._syncCanvasSize();
        window.addEventListener('resize', () => this._syncCanvasSize());

        // Tracking state
        this.fingerPos   = null;
        this.currentPath = [];
        this.isDrawing   = false;
        this._wasDrawing = false;
        this._lastMeta   = null;   // most-recent tracker meta object

        // Animation state
        this.particles  = [];
        this.spellTimer = 0;

        // Tracker mode: 'hand' | 'ir'
        this.trackerMode = 'hand';
        this.tracker     = null;

        this._buildSpellBook();
        this._setupModeUI();
        this.trainingUI = new TrainingUI(this);   // must come after DOM is ready
        this._startTracker('hand');
        this._loop();
    }

    // ── Canvas sizing ─────────────────────────────────────────────────────────

    _syncCanvasSize() {
        const wrapper = document.getElementById('camera-wrapper');
        const rect    = wrapper.getBoundingClientRect();
        this.canvas.width  = rect.width  || 640;
        this.canvas.height = rect.height || 480;
    }

    // ── Mode toggle UI ────────────────────────────────────────────────────────

    _setupModeUI() {
        const btnHand = document.getElementById('btn-hand');
        const btnIR   = document.getElementById('btn-ir');
        const camSel  = document.getElementById('ir-camera-select');

        btnHand.addEventListener('click', () => {
            if (this.trackerMode === 'hand') return;
            btnHand.classList.add('active');
            btnIR.classList.remove('active');
            camSel.classList.add('hidden');
            camSel.value = '';
            this._startTracker('hand');
        });

        btnIR.addEventListener('click', async () => {
            if (this.trackerMode === 'ir') return;
            btnIR.classList.add('active');
            btnHand.classList.remove('active');

            // Stop the hand tracker immediately — don't wait for camera
            // enumeration with the old tracker still running.
            this.trackerMode = 'ir';
            if (this.tracker) {
                this.tracker.destroy();
                this.tracker = null;
            }
            this.fingerPos   = null;
            this.currentPath = [];
            this.isDrawing   = false;
            this._wasDrawing = false;
            this._lastMeta   = null;
            this.video.srcObject = null;
            this._setStatus('idle', '🪄', 'Select a camera to begin');

            // Now enumerate cameras and show the selector
            camSel.classList.remove('hidden');
            await this._populateCameraSelect(camSel);

            // Auto-start if there's exactly one camera
            if (camSel.options.length === 2) {
                camSel.selectedIndex = 1;
                this._startTracker('ir', camSel.value);
            }
        });

        // Start (or restart) IR tracker whenever a camera is picked
        camSel.addEventListener('change', () => {
            if (camSel.value === '') return;
            this._startTracker('ir', camSel.value);
        });
    }

    async _populateCameraSelect(select) {
        try {
            const devices = await listVideoDevices();
            // Keep the placeholder option, rebuild the rest
            select.options.length = 1;
            devices.forEach((d, i) => {
                const opt   = document.createElement('option');
                opt.value   = d.deviceId;
                opt.text    = d.label || `Camera ${i + 1}`;
                select.appendChild(opt);
            });
            // Auto-select second camera (index 1) if available — common IR setup
            if (devices.length > 1) select.selectedIndex = 2;
        } catch (err) {
            console.warn('[SpellApp] Could not enumerate cameras:', err);
        }
    }

    // ── Tracker lifecycle ─────────────────────────────────────────────────────

    _startTracker(mode, deviceId = null) {
        // Set mode first — any stale callbacks from the old tracker that slip
        // through before the _destroyed guard fires will still read the correct
        // trackerMode and show the right status message.
        this.trackerMode = mode;

        // Tear down previous tracker
        if (this.tracker) {
            this.tracker.destroy();
            this.tracker = null;
        }

        // Reset drawing state
        this.fingerPos   = null;
        this.currentPath = [];
        this.isDrawing   = false;
        this._wasDrawing = false;
        this._lastMeta   = null;

        // Both modes use the same CSS mirror (scaleX(-1)); IRTracker flips its
        // detected x-coordinates to match so the overlay stays in sync.
        document.getElementById('webcam').classList.remove('no-mirror');

        // Update spellbook hint
        document.querySelector('.spellbook-hint').textContent =
            mode === 'hand'
                ? 'Pinch thumb + index to draw'
                : 'Hold wand still 1 s to toggle draw';

        const callback = (pos, path, drawing, meta) =>
            this._onTrack(pos, path, drawing, meta);

        if (mode === 'hand') {
            this.tracker = new HandTracker(this.video, this.canvas, callback);
            this._setStatus('idle', '✋', 'Show your hand to begin');
        } else {
            this.tracker = new IRTracker(
                this.video, this.canvas, callback,
                deviceId ? { deviceId } : {}
            );
            this._setStatus('idle', '🪄', 'Point the wand at the camera');
        }
    }

    // ── Tracking callback ─────────────────────────────────────────────────────

    _onTrack(pos, path, drawing, meta) {
        this.fingerPos   = pos;
        this.currentPath = path;
        this._wasDrawing = this.isDrawing;
        this.isDrawing   = drawing;
        this._lastMeta   = meta;

        // Status bar
        if (this.trackerMode === 'hand') {
            if (!pos) {
                this._setStatus('idle', '✋', 'Show your hand to begin');
            } else if (drawing) {
                this._setStatus('drawing', '✏️', 'Drawing… pinch again to cast!');
            } else {
                this._setStatus('ready', '🤌', 'Pinch to start drawing');
            }
        } else {
            if (!pos) {
                this._setStatus('idle', '🪄', 'Point the wand at the camera');
            } else if (drawing) {
                this._setStatus('drawing', '✏️', 'Drawing… hold still to cast!');
            } else {
                const pct = meta?.stillProgress > 0
                    ? ` (${Math.round(meta.stillProgress * 100)}%)`
                    : '';
                this._setStatus('ready', '🪄', `Hold still to start drawing${pct}`);
            }
        }

        // Drawing just ended — evaluate or label the spell
        // In Training Mode accept shorter paths (min 5 pts) so partial shapes can be saved
        const minPathLen = this.trainingUI?.trainingMode ? 5 : 15;
        if (this._wasDrawing && !drawing && path.length > minPathLen) {
            this._castSpell([...path]);
        }
    }

    // ── Spell evaluation ──────────────────────────────────────────────────────

    _castSpell(path) {
        // ── Training Mode: intercept for labelling, not casting ──────────────
        if (this.trainingUI?.trainingMode) {
            this.tracker.pauseTracking();
            this.trainingUI.offerLabel(path);
            return;
        }

        // ── Recognizer selection ─────────────────────────────────────────────
        let match = null;

        if (this.trainingUI?.recognizer === 'cnn' && spellML.isReady) {
            // ML kNN path
            const result = spellML.classify(path);
            if (result) {
                const spell = SPELLS.find(s => s.name === result.spellName);
                if (spell) {
                    // Known spell — use its full metadata for animations
                    match = { ...spell, score: result.confidence };
                } else {
                    // Custom / user-defined spell — minimal display
                    match = {
                        name:        result.spellName,
                        emoji:       '✨',
                        color:       '#cc88ff',
                        description: `Confidence: ${Math.round(result.confidence * 100)}%`,
                        shape:       'custom',
                        effect:      'constellation',
                        score:       result.confidence,
                    };
                }
            }
        } else {
            // Rule-based path (default)
            match = matchSpell(path);
        }

        // ── Animate result ───────────────────────────────────────────────────
        this.tracker.pauseTracking();
        if (match) {
            this.spellTimer = 60;
            this._highlightCard(match.name);
            this._emitParticles(match);
            this._showToast(match);
        } else {
            this.spellTimer = 30;
            this._showFailToast();
        }
    }

    // ── Toast notification ────────────────────────────────────────────────────

    _showToast(match) {
        const toast  = document.getElementById('spell-toast');
        const nameEl = document.getElementById('toast-name');
        document.getElementById('toast-emoji').textContent = match.emoji;
        nameEl.textContent = match.name;
        nameEl.style.color = match.color;
        document.getElementById('toast-desc').textContent = match.description;
        toast.classList.remove('show', 'fail');
        void toast.offsetWidth;
        toast.classList.add('show');
    }

    _showFailToast() {
        const toast  = document.getElementById('spell-toast');
        const nameEl = document.getElementById('toast-name');
        document.getElementById('toast-emoji').textContent = '❓';
        nameEl.textContent = 'Unknown Spell';
        nameEl.style.color = '#ffaaaa';
        document.getElementById('toast-desc').textContent = 'Not recognised… try again!';
        toast.classList.remove('show');
        toast.classList.add('fail');
        void toast.offsetWidth;
        toast.classList.add('show');
    }

    _hideToast() {
        document.getElementById('spell-toast').classList.remove('show');
    }

    // ── Particle emitters ─────────────────────────────────────────────────────

    _emitParticles(spell) {
        const cx = this.canvas.width  / 2;
        const cy = this.canvas.height / 2;
        const N  = 90;

        switch (spell.effect) {

            case 'lumos':
                for (let i = 0; i < N; i++) {
                    const a  = (i / N) * Math.PI * 2;
                    const sp = 2 + Math.random() * 6;
                    this.particles.push(new Particle(
                        cx, cy,
                        Math.cos(a) * sp, Math.sin(a) * sp - 1,
                        i % 2 === 0 ? '#ffffff' : spell.color, 6 + Math.random() * 8
                    ));
                }
                break;

            case 'nox':
                for (let i = 0; i < N; i++) {
                    const a  = (i / N) * Math.PI * 2;
                    const r  = 80 + Math.random() * 120;
                    const sp = 2 + Math.random() * 3;
                    this.particles.push(new Particle(
                        cx + Math.cos(a) * r, cy + Math.sin(a) * r,
                        -Math.cos(a) * sp, -Math.sin(a) * sp,
                        i % 2 === 0 ? '#4444aa' : spell.color, 6 + Math.random() * 8
                    ));
                }
                break;

            case 'unlock':
                for (let i = 0; i < N; i++) {
                    const a  = (i / N) * Math.PI * 2;
                    const sp = 3 + Math.random() * 7;
                    this.particles.push(new Particle(
                        cx, cy,
                        Math.cos(a) * sp, Math.sin(a) * sp - 1.5,
                        i % 3 === 0 ? '#ffffff' : spell.color, 5 + Math.random() * 8
                    ));
                }
                break;

            case 'levitate':
                for (let i = 0; i < N; i++) {
                    this.particles.push(new Particle(
                        cx + (Math.random() - 0.5) * this.canvas.width * 0.8,
                        cy + (Math.random() - 0.5) * 60,
                        (Math.random() - 0.5) * 1.5, -(1.5 + Math.random() * 3),
                        i % 2 === 0 ? '#ffffff' : spell.color, 5 + Math.random() * 7
                    ));
                }
                break;

            case 'shield':
                for (let i = 0; i < N; i++) {
                    const a  = (i / N) * Math.PI * 2;
                    const sp = 3 + Math.random() * 3.5;
                    this.particles.push(new Particle(
                        cx, cy,
                        Math.cos(a) * sp, Math.sin(a) * sp,
                        spell.color, 7 + Math.random() * 6
                    ));
                }
                break;

            case 'fire':
                for (let i = 0; i < N; i++) {
                    const ox = (Math.random() - 0.5) * this.canvas.width * 0.6;
                    const sp = 2 + Math.random() * 5;
                    this.particles.push(new Particle(
                        cx + ox, this.canvas.height * 0.8,
                        (Math.random() - 0.5) * 3, -(sp),
                        i % 3 === 0 ? '#ffee44' : spell.color, 6 + Math.random() * 8
                    ));
                }
                break;

            case 'constellation':
                for (let i = 0; i < N; i++) {
                    const sx = Math.random() * this.canvas.width;
                    const sy = Math.random() * this.canvas.height * 0.7;
                    this.particles.push(new Particle(
                        sx, sy,
                        (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4,
                        i % 3 === 0 ? '#ffffff' : spell.color, 5 + Math.random() * 8
                    ));
                }
                break;
        }
    }

    // ── Render loop ───────────────────────────────────────────────────────────

    _loop() {
        requestAnimationFrame(() => this._loop());
        this._render();
    }

    _render() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Drawn path
        if (this.currentPath.length > 1) {
            this._drawPath(this.currentPath, this.isDrawing ? 1.0 : 0.45);
        }

        // Cursor / wand indicator
        if (this.fingerPos) {
            if (this.trackerMode === 'ir') {
                this._drawWand(this.fingerPos, this.isDrawing, this._lastMeta);
            } else {
                this._drawFinger(this.fingerPos, this.isDrawing);
            }
        }

        // Trail particles while drawing
        if (this.isDrawing && this.fingerPos && !this.spellTimer) {
            if (Math.random() < 0.65) {
                const p = new Particle(
                    this.fingerPos.x + (Math.random() - 0.5) * 6,
                    this.fingerPos.y + (Math.random() - 0.5) * 6,
                    (Math.random() - 0.5) * 1.5,
                    -0.6 - Math.random() * 1.0,
                    Math.random() < 0.5 ? '#ff44ff' : '#cc88ff',
                    4 + Math.random() * 4
                );
                p.decay   = 0.055 + Math.random() * 0.03;
                p.gravity = 0.015;
                this.particles.push(p);
            }
        }

        // Particles
        this.particles = this.particles.filter(p => !p.isDead());
        for (const p of this.particles) { p.update(); p.draw(ctx); }

        // Toast timer countdown
        if (this.spellTimer > 0) {
            this.spellTimer--;
            if (this.spellTimer === 0) {
                this._hideToast();
                this.tracker.resumeTracking();
            }
        }
    }

    // ── Drawing helpers ───────────────────────────────────────────────────────

    _drawPath(path, alpha) {
        const ctx   = this.ctx;
        const color = this.isDrawing ? '#ff44ff' : '#44aaff';

        ctx.save();
        ctx.globalAlpha = alpha * 0.35;
        ctx.strokeStyle = color;
        ctx.lineWidth   = 18;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.shadowBlur  = 35;
        ctx.shadowColor = color;
        this._strokePath(path, ctx);
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth   = 3.5;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.shadowBlur  = 10;
        ctx.shadowColor = color;
        this._strokePath(path, ctx);
        ctx.restore();
    }

    _strokePath(path, ctx) {
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
        ctx.stroke();
    }

    /** Hand mode: simple glowing dot */
    _drawFinger(pos, drawing) {
        const ctx   = this.ctx;
        const color = drawing ? '#ff44ff' : '#ffffff';
        const r     = drawing ? 11 : 7;

        ctx.save();
        ctx.fillStyle   = color;
        ctx.shadowBlur  = 26;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    /**
     * IR mode: ring + crosshairs (mirrors ir_tracker.py _draw_overlay).
     * Green = idle/ready  |  Red = drawing active
     * Also draws a still-progress arc when the user is holding still.
     */
    _drawWand(pos, drawing, meta) {
        const ctx    = this.ctx;
        const { x, y } = pos;
        const color  = drawing ? '#ff4444' : '#44ff44';
        const ringR  = Math.max(meta?.radius ?? 8, 8);
        const arm    = ringR + 10;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle   = color;
        ctx.shadowBlur  = 18;
        ctx.shadowColor = color;
        ctx.lineWidth   = 2;

        // Outer ring
        ctx.beginPath();
        ctx.arc(x, y, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Center dot
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();

        // Crosshairs
        ctx.beginPath();
        ctx.moveTo(x - arm, y); ctx.lineTo(x + arm, y);
        ctx.moveTo(x, y - arm); ctx.lineTo(x, y + arm);
        ctx.stroke();

        ctx.restore();

        // Still-progress arc (sweeps from top, clockwise)
        const progress = meta?.stillProgress ?? 0;
        if (progress > 0) {
            const arcR  = ringR + 6;
            const start = -Math.PI / 2;
            const end   = start + progress * Math.PI * 2;

            ctx.save();
            ctx.strokeStyle = drawing ? '#ff8888' : '#88ff88';
            ctx.lineWidth   = 3;
            ctx.shadowBlur  = 12;
            ctx.shadowColor = drawing ? '#ff4444' : '#44ff44';
            ctx.lineCap     = 'round';
            ctx.beginPath();
            ctx.arc(x, y, arcR, start, end);
            ctx.stroke();
            ctx.restore();
        }
    }

    // ── Status bar ────────────────────────────────────────────────────────────

    _setStatus(state, icon, text) {
        document.getElementById('draw-status').className = state;
        document.getElementById('status-icon').textContent = icon;
        document.getElementById('status-text').textContent = text;
    }

    // ── Spell book ────────────────────────────────────────────────────────────

    _buildSpellBook() {
        const container = document.getElementById('spell-cards');
        container.innerHTML = '';

        for (const spell of SPELLS) {
            const card = document.createElement('div');
            card.className = 'spell-card';
            card.id = `card-${spell.name.replace(/\s+/g, '-')}`;
            card.style.setProperty('--spell-color', spell.color);

            card.innerHTML = `
                <div class="spell-emoji">${spell.emoji}</div>
                <div class="spell-card-info">
                    <div class="spell-card-name">${spell.name}</div>
                    <div class="spell-card-shape">${spell.shape}</div>
                </div>`;

            container.appendChild(card);
        }
    }

    _highlightCard(spellName) {
        document.querySelectorAll('.spell-card').forEach(c => c.classList.remove('matched'));
        const id = `card-${spellName.replace(/\s+/g, '-')}`;
        document.getElementById(id)?.classList.add('matched');
    }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    window._app = new SpellApp();
});
