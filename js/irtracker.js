/**
 * irtracker.js — IR Wand tracker for IGNITE
 *
 * JavaScript port of BALDI/src/tracking/ir_tracker.py
 *
 * Pipeline per frame (runs on an offscreen <canvas>):
 *   1. Grayscale conversion
 *   2. EMA background subtraction — slow IR sources absorbed; moving
 *      reflector tip stands out in the difference image
 *   3. Fixed threshold on the difference image
 *   4. Proximity-gated blob detection (centroid of bright pixels)
 *   5. EMA smoothing of the accepted center
 *   6. Still-based drawing toggle — hold still ≥ 1 s → toggle draw mode
 *
 * Public API matches HandTracker exactly:
 *   onUpdate(fingerPos, path, isDrawing, meta) — called every frame
 *   pauseTracking() / resumeTracking()
 *   getPath() / clearPath()
 *   destroy()
 *
 * meta for IRTracker: { radius, stillProgress }  or  null when nothing detected
 *   radius        — estimated IR blob radius in pixels
 *   stillProgress — 0–1, how close the wand is to triggering a mode toggle
 *
 * NOTE: Browser exposure control is not supported on Windows USB cameras.
 * Set exposure externally before opening the browser:
 *   python -c "import cv2; cap = cv2.VideoCapture(1, cv2.CAP_DSHOW); \
 *     cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25); \
 *     cap.set(cv2.CAP_PROP_EXPOSURE, -10); \
 *     input('Press Enter to release...')"
 */

'use strict';

// ── Constants (matching ir_tracker.py) ───────────────────────────────────────

const IR_BG_ALPHA        = 0.99;  // background EMA weight — higher = slower adaptation
const IR_THRESH_OFFSET   = 40;    // include pixels within this many levels of diff-max
const IR_THRESH_FLOOR    = 8;     // minimum diff max to trigger any detection
const IR_MIN_RADIUS      = 2;     // px — reject single-pixel noise
const IR_MAX_RADIUS      = 80;    // px — reject huge false positives
const IR_MIN_AREA        = 5;     // px² — small reflector tip ~8 px²
const IR_MAX_JUMP        = 200;   // px — proximity gate radius
const IR_STILL_THRESHOLD = 10;    // px — movement below this = "still"
const IR_STILL_TIME      = 1.0;   // seconds — hold still to toggle drawing
const IR_SMOOTH_ALPHA    = 0.3;   // EMA blend — higher = more responsive
const IR_SMOOTH_DEADZONE = 3;     // px — sub-pixel jitter suppression
const IR_LOST_FRAMES     = 8;     // consecutive missed frames before tracking drops

// ── IRTracker ─────────────────────────────────────────────────────────────────

class IRTracker {
    /**
     * @param {HTMLVideoElement}  video    — <video> element (display + capture)
     * @param {HTMLCanvasElement} canvas   — overlay canvas (read for size only)
     * @param {Function}         onUpdate — (fingerPos, path, isDrawing, meta) => void
     * @param {object}           [options]
     * @param {string}           [options.deviceId] — specific camera deviceId
     */
    constructor(video, canvas, onUpdate, options = {}) {
        this.video    = video;
        this.canvas   = canvas;
        this.onUpdate = onUpdate;
        this.deviceId = options.deviceId ?? null;

        // Background model (Float32Array, allocated lazily on first frame)
        this._bgModel = null;

        // Tracking state
        this.smoothedPoint  = null;
        this.drawing        = false;
        this.currentPath    = [];
        this._paused        = false;
        this._lostFrames    = 0;

        // Still-detection state
        this._prevPoint      = null;
        this._stillStartTime = null;

        // Offscreen canvas for pixel processing
        this._proc    = document.createElement('canvas');
        this._procCtx = this._proc.getContext('2d', { willReadFrequently: true });

        this._rafId  = null;
        this._stream = null;

        this._initCamera();
    }

    // ── Camera setup ──────────────────────────────────────────────────────────

    async _initCamera() {
        try {
            const constraints = {
                video: {
                    width:     { ideal: 640 },
                    height:    { ideal: 480 },
                    frameRate: { ideal: 30  },
                    ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
                },
                audio: false,
            };

            this._stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this._stream;

            await new Promise(resolve =>
                this.video.addEventListener('loadedmetadata', resolve, { once: true })
            );
            await this.video.play();
            this._loop();
        } catch (err) {
            console.error('[IRTracker] Camera init failed:', err);
            this.onUpdate(null, [], false, null);
        }
    }

    // ── Frame loop ────────────────────────────────────────────────────────────

    _loop() {
        this._rafId = requestAnimationFrame(() => this._loop());
        if (this.video.readyState < 2) return;
        this._processFrame();
    }

    _processFrame() {
        const W = this.video.videoWidth  || 640;
        const H = this.video.videoHeight || 480;

        if (this._proc.width !== W || this._proc.height !== H) {
            this._proc.width  = W;
            this._proc.height = H;
            this._bgModel = null;
        }

        this._procCtx.drawImage(this.video, 0, 0, W, H);
        const imgData = this._procCtx.getImageData(0, 0, W, H);
        const pixels  = imgData.data;
        const N = W * H;

        // ── 1. Grayscale ──────────────────────────────────────────────────────
        const gray = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const p = i << 2;
            gray[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
        }

        // ── 2. Background EMA ─────────────────────────────────────────────────
        if (!this._bgModel) {
            this._bgModel = gray.slice();
        } else {
            const alpha = 1.0 - IR_BG_ALPHA;
            for (let i = 0; i < N; i++) {
                this._bgModel[i] += alpha * (gray[i] - this._bgModel[i]);
            }
        }

        // ── 3. Difference + threshold ─────────────────────────────────────────
        const diff = new Float32Array(N);
        let maxDiff = 0;
        for (let i = 0; i < N; i++) {
            const d = gray[i] - this._bgModel[i];
            if (d > 0) {
                diff[i] = d;
                if (d > maxDiff) maxDiff = d;
            }
        }

        if (maxDiff < IR_THRESH_FLOOR) {
            this._handleNoDetection();
            return;
        }

        const thresh = Math.max(maxDiff - IR_THRESH_OFFSET, 1);
        const binary = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
            if (diff[i] >= thresh) binary[i] = 1;
        }

        // ── 4. Blob detection ─────────────────────────────────────────────────
        const raw = this._findBestBlob(binary, W, H);

        if (!raw) {
            this._handleNoDetection();
            return;
        }

        // ── 5. EMA smoothing ──────────────────────────────────────────────────
        this._lostFrames = 0;

        if (!this.smoothedPoint) {
            this.smoothedPoint = { x: raw.x, y: raw.y };
        } else {
            const dx = raw.x - this.smoothedPoint.x;
            const dy = raw.y - this.smoothedPoint.y;
            if (Math.hypot(dx, dy) >= IR_SMOOTH_DEADZONE) {
                this.smoothedPoint = {
                    x: this.smoothedPoint.x + IR_SMOOTH_ALPHA * dx,
                    y: this.smoothedPoint.y + IR_SMOOTH_ALPHA * dy,
                };
            }
        }

        const center = { x: this.smoothedPoint.x, y: this.smoothedPoint.y };
        const stillProgress = this._updatePath({ x: raw.x, y: raw.y }, center);
        const meta = { radius: raw.radius, stillProgress };

        if (this._paused) {
            this.onUpdate(null, [], false, null);
            return;
        }

        this.onUpdate({ ...center }, this.currentPath, this.drawing, meta);
    }

    _handleNoDetection() {
        this._lostFrames++;
        if (this._lostFrames >= IR_LOST_FRAMES) {
            this.smoothedPoint   = null;
            this._prevPoint      = null;
            this._stillStartTime = null;
            this._lostFrames     = 0;
            if (this.drawing) this.drawing = false;
        }
        this.onUpdate(this.smoothedPoint, this.currentPath, this.drawing, null);
    }

    // ── Blob detection ────────────────────────────────────────────────────────

    _findBestBlob(binary, W, H) {
        const last = this.smoothedPoint;
        let sumX = 0, sumY = 0, count = 0;

        for (let y = 0; y < H; y++) {
            const rowOff = y * W;
            for (let x = 0; x < W; x++) {
                if (!binary[rowOff + x]) continue;
                if (last && Math.hypot(x - last.x, y - last.y) > IR_MAX_JUMP) continue;
                sumX += x;
                sumY += y;
                count++;
            }
        }

        if (count < IR_MIN_AREA) return null;

        const cx     = sumX / count;
        const cy     = sumY / count;
        const radius = Math.sqrt(count / Math.PI);

        if (radius < IR_MIN_RADIUS || radius > IR_MAX_RADIUS) return null;

        // Mirror x to match CSS scaleX(-1) display
        return { x: Math.round(W - cx), y: Math.round(cy), radius: Math.round(radius) };
    }

    // ── Still-based drawing toggle ────────────────────────────────────────────

    _updatePath(rawPoint, smoothedPoint) {
        if (this._paused) return 0;

        const now = performance.now() / 1000;

        if (!this._prevPoint) {
            this._prevPoint = rawPoint;
            return 0;
        }

        const distance = Math.hypot(
            rawPoint.x - this._prevPoint.x,
            rawPoint.y - this._prevPoint.y,
        );

        let stillProgress = 0;

        if (distance < IR_STILL_THRESHOLD) {
            if (this._stillStartTime === null) {
                this._stillStartTime = now;
            } else {
                const elapsed = now - this._stillStartTime;
                stillProgress = Math.min(elapsed / IR_STILL_TIME, 1);

                if (elapsed >= IR_STILL_TIME) {
                    this.drawing         = !this.drawing;
                    this._stillStartTime = null;
                    stillProgress        = 0;
                    if (this.drawing) this.currentPath = [];
                }
            }
        } else {
            this._stillStartTime = null;
            if (this.drawing) {
                this.currentPath.push({ x: smoothedPoint.x, y: smoothedPoint.y });
            }
        }

        this._prevPoint = rawPoint;
        return stillProgress;
    }

    // ── Pause / resume ────────────────────────────────────────────────────────

    pauseTracking() {
        this._paused         = true;
        this.drawing         = false;
        this.currentPath     = [];
        this._stillStartTime = null;
    }

    resumeTracking() {
        this._paused       = false;
        this.smoothedPoint = null;
        this._prevPoint    = null;
    }

    // ── Public helpers ────────────────────────────────────────────────────────

    getPath()   { return [...this.currentPath]; }
    clearPath() { this.currentPath = []; }

    destroy() {
        if (this._rafId !== null) cancelAnimationFrame(this._rafId);
        this._stream?.getTracks().forEach(t => t.stop());
        this._rafId  = null;
        this._stream = null;
    }
}

// ── Device enumeration helper ─────────────────────────────────────────────────

async function listVideoDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
}
