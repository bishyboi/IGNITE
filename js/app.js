/**
 * app.js — IGNITE Magic Spell Caster — Main application
 *
 * Orchestrates: HandTracker → spell matching → canvas rendering + particles + UI
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

        // Animation state
        this.particles  = [];
        this.spellTimer = 0;   // frames remaining to show result overlay

        this._buildSpellBook();

        this.tracker = new HandTracker(
            this.video,
            this.canvas,
            (pos, path, drawing, meta) => this._onTrack(pos, path, drawing, meta)
        );

        this._loop();
    }

    // ── Canvas sizing ─────────────────────────────────────────────────────────

    _syncCanvasSize() {
        const wrapper = document.getElementById('camera-wrapper');
        const rect    = wrapper.getBoundingClientRect();
        this.canvas.width  = rect.width  || 640;
        this.canvas.height = rect.height || 480;
    }

    // ── Tracking callback ─────────────────────────────────────────────────────

    _onTrack(pos, path, drawing, meta) {
        this.fingerPos   = pos;
        this.currentPath = path;
        this._wasDrawing = this.isDrawing;
        this.isDrawing   = drawing;

        // Status bar
        if (!pos) {
            this._setStatus('idle', '✋', 'Show your hand to begin');
        } else if (drawing) {
            this._setStatus('drawing', '✏️', 'Drawing… pinch again to cast!');
        } else {
            this._setStatus('ready', '🤌', 'Pinch to start drawing');
        }

        // Drawing just ended — evaluate the spell
        if (this._wasDrawing && !drawing && path.length > 15) {
            this._castSpell([...path]);
        }
    }

    // ── Spell evaluation ──────────────────────────────────────────────────────

    _castSpell(path) {
        const match = matchSpell(path);

        if (match) {
            this.spellTimer = 210;   // ~3.5 s at 60 fps

            this._highlightCard(match.name);
            this._emitParticles(match);

            document.getElementById('result-emoji').textContent = match.emoji;
            document.getElementById('result-name').textContent  = match.name;
            document.getElementById('result-name').style.color  = match.color;
            document.getElementById('result-desc').textContent  = match.description;
            document.getElementById('result-score').textContent =
                `Fréchet ${match.frechet.toFixed(3)}  ·  RMS ${match.rms.toFixed(3)}  ·  score ${(match.score * 100).toFixed(1)}%`;

            document.getElementById('spell-result').classList.remove('hidden');
            document.getElementById('spell-fail').classList.add('hidden');
        } else {
            this.spellTimer = 100;
            document.getElementById('spell-result').classList.add('hidden');
            document.getElementById('spell-fail').classList.remove('hidden');
        }
    }

    // ── Particle emitters ─────────────────────────────────────────────────────

    _emitParticles(spell) {
        const cx = this.canvas.width  / 2;
        const cy = this.canvas.height / 2;
        const N  = 90;

        switch (spell.effect) {

            case 'shield':
                // Even ring burst
                for (let i = 0; i < N; i++) {
                    const a  = (i / N) * Math.PI * 2;
                    const sp = 3 + Math.random() * 3.5;
                    this.particles.push(new Particle(
                        cx, cy,
                        Math.cos(a) * sp, Math.sin(a) * sp,
                        spell.color, 4 + Math.random() * 3
                    ));
                }
                break;

            case 'lightning':
                // Chaotic upward sparks
                for (let i = 0; i < N; i++) {
                    const a  = Math.random() * Math.PI * 2;
                    const sp = 4 + Math.random() * 9;
                    this.particles.push(new Particle(
                        cx + (Math.random() - 0.5) * 220,
                        cy + (Math.random() - 0.5) * 120,
                        Math.cos(a) * sp,
                        Math.sin(a) * sp - 2.5,
                        spell.color, 3 + Math.random() * 4
                    ));
                }
                break;

            case 'star':
                // Star-ray burst, alternating yellow/orange
                for (let i = 0; i < N; i++) {
                    const a  = (i / N) * Math.PI * 2;
                    const sp = 2.5 + Math.random() * 7;
                    this.particles.push(new Particle(
                        cx, cy,
                        Math.cos(a) * sp, Math.sin(a) * sp,
                        i % 3 === 0 ? '#fff8aa' : spell.color,
                        2.5 + Math.random() * 5
                    ));
                }
                break;

            case 'spiral':
                // Particles launched tangentially along a spiral
                for (let i = 0; i < N; i++) {
                    const t  = i / N;
                    const a  = t * 4 * Math.PI;
                    const r  = 15 + t * 90;
                    const sp = 2.5 + Math.random() * 4;
                    this.particles.push(new Particle(
                        cx + Math.cos(a) * r * 0.35,
                        cy + Math.sin(a) * r * 0.35,
                        Math.cos(a + Math.PI / 2) * sp,
                        Math.sin(a + Math.PI / 2) * sp,
                        spell.color, 3 + Math.random() * 4
                    ));
                }
                break;

            case 'infinity':
                // Particles seeded along a figure-8
                for (let i = 0; i < N; i++) {
                    const t  = (i / N) * Math.PI * 2;
                    const sx = Math.sin(t)       * 85;
                    const sy = Math.sin(2 * t)   * 42;
                    const a  = Math.random() * Math.PI * 2;
                    const sp = 1.5 + Math.random() * 3.5;
                    this.particles.push(new Particle(
                        cx + sx, cy + sy,
                        Math.cos(a) * sp, Math.sin(a) * sp,
                        spell.color, 3 + Math.random() * 3
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

        // Finger dot
        if (this.fingerPos) {
            this._drawFinger(this.fingerPos, this.isDrawing);
        }

        // Particles
        this.particles = this.particles.filter(p => !p.isDead());
        for (const p of this.particles) { p.update(); p.draw(ctx); }

        // Overlay timer countdown
        if (this.spellTimer > 0) {
            this.spellTimer--;
            if (this.spellTimer === 0) {
                document.getElementById('spell-result').classList.add('hidden');
                document.getElementById('spell-fail').classList.add('hidden');
            }
        }
    }

    // ── Drawing helpers ───────────────────────────────────────────────────────

    _drawPath(path, alpha) {
        const ctx   = this.ctx;
        const color = this.isDrawing ? '#ff44ff' : '#44aaff';

        // Wide glow halo
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

        // Crisp core line
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

            const pts = templateToSVGPoints(spell.template);
            card.innerHTML = `
                <div class="spell-preview">
                    <svg viewBox="-1.1 -1.1 2.2 2.2" xmlns="http://www.w3.org/2000/svg">
                        <polyline points="${pts}"
                            fill="none" stroke="${spell.color}"
                            stroke-width="0.14" stroke-linecap="round"
                            stroke-linejoin="round" opacity="0.9"/>
                    </svg>
                </div>
                <div class="spell-card-info">
                    <div class="spell-card-name">${spell.emoji} ${spell.name}</div>
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
