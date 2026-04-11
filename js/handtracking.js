/**
 * handtracking.js — MediaPipe Hands wrapper
 *
 * Mirrors the logic in BALDI/src/gestures/gestures.py:
 *
 *   EMA smoothing   — same SMOOTHING_ALPHA / SMOOTHING_DEADZONE constants
 *   Pinch gesture   — thumb ↔ index-tip distance normalised by hand size
 *                     toggles drawing; PINCH_THRESHOLD / PINCH_RELEASE hysteresis
 *   Single path     — when a new drawing starts the old path is cleared
 *
 * onUpdate(fingerPos, path, isDrawing, meta) is called every frame.
 *   fingerPos — {x, y} smoothed index-tip in canvas pixels, or null if no hand
 *   path      — Array<{x,y}> current drawn path (shared reference, read-only)
 *   isDrawing — boolean
 *   meta      — { thumbTip, indexTip, normDist, pinchActive, landmarks } or null
 */

'use strict';

// ── Constants (matching gestures.py) ─────────────────────────────────────────

const SMOOTHING_ALPHA    = 0.35;   // EMA blend — lower → smoother
const SMOOTHING_DEADZONE = 4;      // px — suppress sub-pixel jitter
const PINCH_THRESHOLD    = 0.20;   // 20 % of hand length → pinch fires
const PINCH_RELEASE      = 0.50;   // 50 % of hand length → re-arm

// ── HandTracker ───────────────────────────────────────────────────────────────

class HandTracker {
    /**
     * @param {HTMLVideoElement}  video
     * @param {HTMLCanvasElement} canvas   Read for width / height only
     * @param {Function}         onUpdate  (fingerPos, path, isDrawing, meta) => void
     */
    constructor(video, canvas, onUpdate) {
        this.video    = video;
        this.canvas   = canvas;
        this.onUpdate = onUpdate;

        // Internal state — mirrors gestures.py instance variables
        this.smoothedPoint = null;
        this.drawing       = false;
        this._pinchActive  = false;
        this.currentPath   = [];      // single path; cleared on each new drawing

        this._hands  = null;
        this._camera = null;

        this._init();
    }

    // ── Setup ─────────────────────────────────────────────────────────────────

    _init() {
        this._hands = new Hands({
            locateFile: file =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });

        this._hands.setOptions({
            maxNumHands:            1,
            modelComplexity:        1,
            minDetectionConfidence: 0.70,
            minTrackingConfidence:  0.50,
        });

        this._hands.onResults(r => this._onResults(r));

        this._camera = new Camera(this.video, {
            onFrame: async () => {
                if (this._hands) await this._hands.send({ image: this.video });
            },
            width:  640,
            height: 480,
        });

        this._camera.start().catch(err =>
            console.error('[HandTracker] Camera start failed:', err)
        );
    }

    // ── MediaPipe callback ────────────────────────────────────────────────────

    _onResults(results) {
        const W = this.canvas.width  || 640;
        const H = this.canvas.height || 480;

        // ── No hand visible ──────────────────────────────────────────────────
        if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
            if (this.drawing) this.drawing = false;
            this.smoothedPoint = null;
            this._pinchActive  = false;
            this.onUpdate(null, this.currentPath, false, null);
            return;
        }

        const lm = results.multiHandLandmarks[0];

        // Convert a landmark index to mirrored canvas pixels.
        // Mirroring (1 - lm.x) makes the overlay match the CSS-mirrored <video>.
        const px = idx => ({
            x: (1 - lm[idx].x) * W,
            y:      lm[idx].y  * H,
        });

        const indexTip = px(8);   // index finger tip
        const thumbTip = px(4);   // thumb tip
        const wrist    = px(0);
        const midMCP   = px(9);   // middle finger MCP — hand-size reference

        // ── Pinch detection (mirrors gestures.py) ────────────────────────────
        const handSize  = euclideanDist(wrist, midMCP);
        const pinchDist = euclideanDist(thumbTip, indexTip);
        const normDist  = handSize > 0 ? pinchDist / handSize : 1;

        if (normDist < PINCH_THRESHOLD && !this._pinchActive) {
            // Fingers just came together — toggle drawing
            this._pinchActive = true;
            this.drawing      = !this.drawing;

            if (this.drawing) {
                // New stroke starts — clear old path (one path at a time)
                this.currentPath = [];
            }
        } else if (normDist > PINCH_RELEASE) {
            this._pinchActive = false;   // re-arm for next pinch
        }

        // ── EMA smoothing on index fingertip (mirrors gestures.py) ───────────
        if (!this.smoothedPoint) {
            this.smoothedPoint = { ...indexTip };
        } else {
            const dx = indexTip.x - this.smoothedPoint.x;
            const dy = indexTip.y - this.smoothedPoint.y;
            if (Math.hypot(dx, dy) >= SMOOTHING_DEADZONE) {
                this.smoothedPoint = {
                    x: this.smoothedPoint.x + SMOOTHING_ALPHA * dx,
                    y: this.smoothedPoint.y + SMOOTHING_ALPHA * dy,
                };
            }
        }

        // ── Append smoothed point to path while drawing ───────────────────────
        if (this.drawing) {
            this.currentPath.push({ ...this.smoothedPoint });
        }

        this.onUpdate(
            { ...this.smoothedPoint },
            this.currentPath,
            this.drawing,
            { thumbTip, indexTip, normDist, pinchActive: this._pinchActive, landmarks: lm }
        );
    }

    // ── Public helpers ────────────────────────────────────────────────────────

    getPath()   { return [...this.currentPath]; }
    clearPath() { this.currentPath = []; }

    destroy() {
        this._camera?.stop();
        this._hands?.close();
        this._camera = null;
        this._hands  = null;
    }
}
