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
        this.spellTimer = 0;   // frames remaining to show toast

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
        this.tracker.pauseTracking();

        if (match) {
            this.spellTimer = 210;   // ~3.5 s at 60 fps
            this._highlightCard(match.name);
            this._emitParticles(match);
            this._showToast(match);
        } else {
            this.spellTimer = 100;
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
        void toast.offsetWidth;   // force reflow to restart transition
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
                        i % 2 === 0 ? '#ffffff' : spell.color, 3 + Math.random() * 4
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
                        i % 2 === 0 ? '#4444aa' : spell.color, 3 + Math.random() * 4
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
                        i % 3 === 0 ? '#ffffff' : spell.color, 2 + Math.random() * 4
                    ));
                }
                break;

            case 'levitate':
                for (let i = 0; i < N; i++) {
                    this.particles.push(new Particle(
                        cx + (Math.random() - 0.5) * this.canvas.width * 0.8,
                        cy + (Math.random() - 0.5) * 60,
                        (Math.random() - 0.5) * 1.5, -(1.5 + Math.random() * 3),
                        i % 2 === 0 ? '#ffffff' : spell.color, 2 + Math.random() * 3
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
                        spell.color, 4 + Math.random() * 3
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
                        i % 3 === 0 ? '#ffee44' : spell.color, 3 + Math.random() * 5
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
                        i % 3 === 0 ? '#ffffff' : spell.color, 2 + Math.random() * 4
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

        // Subtle finger trail particles while drawing
        if (this.isDrawing && this.fingerPos && !this.spellTimer) {
            if (Math.random() < 0.65) {
                const p = new Particle(
                    this.fingerPos.x + (Math.random() - 0.5) * 6,
                    this.fingerPos.y + (Math.random() - 0.5) * 6,
                    (Math.random() - 0.5) * 1.5,
                    -0.6 - Math.random() * 1.0,
                    Math.random() < 0.5 ? '#ff44ff' : '#cc88ff',
                    1 + Math.random() * 1.5
                );
                p.decay   = 0.055 + Math.random() * 0.03;
                p.gravity = 0.015;
                this.particles.push(p);
            }
        }

        // Particles
        this.particles = this.particles.filter(p => !p.isDead());
        for (const p of this.particles) { p.update(); p.draw(ctx); }

        // Toast timer countdown — hide and resume tracking when done
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
