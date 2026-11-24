/* AA Smart — photo scoring, best-N selection and face-aware cropping for the Watermark tab.
 *
 * Runs entirely in the browser. Face detection, 68-point landmarks and expressions come from
 * face-api (vladmandic build, MIT) with models served from ./models; composition for photos
 * without faces comes from smartcrop.js (MIT). Nothing is uploaded anywhere.
 *
 *   AASmart.analyze(file)            -> info (cached per File object)
 *   AASmart.rank(infos)              -> infos get .score (0..100) and .why[]
 *   AASmart.pickBest(infos, n)       -> indices of the best n, skipping near-duplicates
 *   AASmart.cropBox(info, tw, th)    -> {x, y, w, h} in original pixels, or null
 */
(function () {
    const MODEL_URL = 'models';
    const A = 640;                 // analysis size (long side)
    let loading = null, ready = false, failed = false;

    function loadScript(src) {
        return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    }
    async function ensure() {
        if (ready) return true; if (failed) return false;
        if (!loading) loading = (async () => {
            try {
                if (!window.faceapi) await loadScript('vendor-face-api.js');
                if (!window.SmartCrop && !window.smartcrop) { try { await loadScript('smartcrop.js'); } catch (e) {} }
                const tf = faceapi.tf;
                try { await tf.setBackend('webgl'); } catch (e) { await tf.setBackend('cpu'); }
                await tf.ready();
                await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
                await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
                await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
                ready = true;
            } catch (e) { console.warn('AASmart: face models unavailable', e); failed = true; }
        })();
        await loading; return ready;
    }

    // ---------- pixel metrics ----------
    function grayOf(ctx, w, h) {
        const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        return { g, d };
    }
    function lapVar(g, w, h, x0 = 0, y0 = 0, x1 = w, y1 = h) {
        x0 = Math.max(1, Math.floor(x0)); y0 = Math.max(1, Math.floor(y0)); x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
        let s = 0, s2 = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = y * w + x, v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
            s += v; s2 += v * v; n++;
        }
        if (!n) return 0; const m = s / n; return s2 / n - m * m;
    }
    function toneStats(g, d) {
        let s = 0, s2 = 0, hi = 0, lo = 0, n = g.length, rg = 0, rg2 = 0, yb = 0, yb2 = 0;
        for (let j = 0, i = 0; j < n; j++, i += 4) {
            const v = g[j]; s += v; s2 += v * v; if (v > 250) hi++; if (v < 6) lo++;
            const a = d[i] - d[i + 1], b = 0.5 * (d[i] + d[i + 1]) - d[i + 2]; rg += a; rg2 += a * a; yb += b; yb2 += b * b;
        }
        const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m));
        const srg = Math.sqrt(Math.max(0, rg2 / n - (rg / n) ** 2)), syb = Math.sqrt(Math.max(0, yb2 / n - (yb / n) ** 2));
        const colorful = Math.sqrt(srg * srg + syb * syb) + 0.3 * Math.sqrt((rg / n) ** 2 + (yb / n) ** 2);
        return { mean: m / 255, sd: sd / 255, hi: hi / n, lo: lo / n, colorful };
    }
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    function eyeAR(pts) { return (dist(pts[1], pts[5]) + dist(pts[2], pts[4])) / (2 * dist(pts[0], pts[3]) || 1); }

    const cache = new WeakMap();
    async function bitmapOf(file) {
        try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { return await createImageBitmap(file); }
    }

    // rot: 0 upright, 1 = image turned clockwise, -1 = counter-clockwise; results mapped back to the upright frame
    async function detectFaces(c, g, cw, ch, rot) {
        let src = c, RW = cw, RH = ch;
        if (rot) {
            src = document.createElement('canvas'); src.width = ch; src.height = cw; RW = ch; RH = cw;
            const x = src.getContext('2d');
            if (rot > 0) { x.translate(ch, 0); x.rotate(Math.PI / 2); } else { x.translate(0, cw); x.rotate(-Math.PI / 2); }
            x.drawImage(c, 0, 0);
        }
        const back = (u, v) => rot === 0 ? { x: u, y: v } : rot > 0 ? { x: v, y: ch - u } : { x: cw - v, y: u };
        const det = await faceapi.detectAllFaces(src, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.45, maxResults: 12 })).withFaceLandmarks().withFaceExpressions();
        const out = [];
        for (const r of det) {
            const b = r.detection.box, pts = r.landmarks.positions;
            if (b.width < 14) continue;
            const le = eyeAR(pts.slice(36, 42)), re = eyeAR(pts.slice(42, 48));
            const mouth = dist(pts[62], pts[66]) / (b.height || 1);
            const ex = r.expressions || {};
            const p1 = back(b.x, b.y), p2 = back(b.x + b.width, b.y + b.height);
            const x0 = Math.min(p1.x, p2.x), y0 = Math.min(p1.y, p2.y), x1 = Math.max(p1.x, p2.x), y1 = Math.max(p1.y, p2.y);
            const eL = back(pts[37].x, pts[37].y), eR = back(pts[44].x, pts[44].y), iL = back(pts[39].x, pts[39].y), iR = back(pts[42].x, pts[42].y);
            out.push({
                x: x0 / cw, y: y0 / ch, w: (x1 - x0) / cw, h: (y1 - y0) / ch, conf: r.detection.score, rot,
                eyes: (le + re) / 2, mouth, happy: ex.happy || 0, neutral: ex.neutral || 0,
                sharp: lapVar(g, cw, ch, x0, y0, x1, y1),
                eyeY: ((eL.y + eR.y) / 2) / ch, cx: ((iL.x + iR.x) / 2) / cw
            });
        }
        return out;
    }

    async function analyze(file) {
        if (cache.has(file)) return cache.get(file);
        const p = (async () => {
            const info = { w: 0, h: 0, faces: [], ok: false };
            let bmp; try { bmp = await bitmapOf(file); } catch (e) { return info; }
            info.w = bmp.width; info.h = bmp.height;
            const k = A / Math.max(bmp.width, bmp.height), cw = Math.max(1, Math.round(bmp.width * k)), ch = Math.max(1, Math.round(bmp.height * k));
            const c = document.createElement('canvas'); c.width = cw; c.height = ch;
            const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, cw, ch); bmp.close && bmp.close();
            const { g, d } = grayOf(ctx, cw, ch);
            info.sharp = lapVar(g, cw, ch);
            Object.assign(info, toneStats(g, d));
            info.canvas = c;   // kept small (640px) for smartcrop
            if (await ensure()) {
                try {
                    // upright first; if no face is found, try the frame turned 90° both ways (people lying, leaning, upside-down riders)
                    let faces = await detectFaces(c, g, cw, ch, 0);
                    if (!faces.length) {
                        const a = await detectFaces(c, g, cw, ch, 1), b = await detectFaces(c, g, cw, ch, -1);
                        const best = (L) => L.reduce((m, f) => Math.max(m, f.conf), 0);
                        faces = (best(a) >= best(b) ? a : b).filter(f => f.conf >= 0.6);
                    }
                    faces.sort((a, b) => b.w * b.h - a.w * a.h);
                    info.faces = faces;
                } catch (e) { console.warn('AASmart: detection failed', e); }
            }
            info.ok = true; return info;
        })();
        cache.set(file, p); return p;
    }

    // ---------- scoring ----------
    const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
    function faceQuality(f) {
        const size = clamp(Math.sqrt(f.w * f.h) / 0.32);                     // a face ~1/10 of the frame scores full
        const eyes = f.eyes >= 0.21 ? 1 : f.eyes >= 0.17 ? 0.65 : f.eyes >= 0.13 ? 0.3 : 0.1;
        const talking = f.mouth > 0.085 && f.happy < 0.5;                     // caught mid-word
        const mouth = talking ? clamp(1 - (f.mouth - 0.085) * 6, 0.45, 1) : 1;
        const expr = 0.7 + 0.3 * clamp(f.happy + f.neutral);
        const edge = (f.x < 0.01 || f.y < 0.01 || f.x + f.w > 0.99 || f.y + f.h > 0.99) ? 0.6 : 1;   // face cut by the frame
        return { q: size * eyes * mouth * expr * edge, eyes, talking, edge: edge < 1 };
    }
    function rank(infos, target) {
        const ok = infos.filter(i => i && i.ok);
        const lv = v => Math.log(1 + Math.max(0, v));
        const sh = ok.map(i => lv(i.faces[0] ? Math.max(i.faces[0].sharp, i.sharp * 0.8) : i.sharp));
        const lo = Math.min(...sh), hi = Math.max(...sh);
        ok.forEach((i, k) => {
            const why = [];
            const sharpN = hi > lo ? (sh[k] - lo) / (hi - lo) : 0.7;
            const absSharp = clamp((sh[k] - 3.5) / 4);                          // absolute floor: very soft images lose even in a soft batch
            const sharp = 0.6 * sharpN + 0.4 * absSharp;
            const expo = clamp(1 - Math.abs(i.mean - 0.48) * 1.6 - (i.hi + i.lo) * 3);
            const contrast = clamp(i.sd / 0.22);
            const color = clamp(i.colorful / 60);
            let face = 0.55, fq = null;
            if (i.faces.length) { fq = faceQuality(i.faces[0]); face = 0.25 + 0.75 * fq.q; }
            let res = 1;
            if (target) { const need = Math.max(target.w, target.h); const have = Math.max(i.w, i.h); res = clamp(have / need, 0.4, 1); }
            const s = 100 * (0.30 * sharp + 0.14 * expo + 0.10 * contrast + 0.06 * color + 0.30 * face + 0.10 * res);
            i.score = Math.round(s);
            if (sharp > 0.75) why.push('sharp'); else if (sharp < 0.35) why.push('soft');
            if (expo < 0.5) why.push(i.mean < 0.48 ? 'dark' : 'bright');
            if (fq) { if (fq.eyes < 0.6) why.push('eyes'); if (fq.talking) why.push('mouth'); if (fq.edge) why.push('cut'); if (fq.q > 0.7) why.push('face'); }
            if (res < 0.95) why.push('lowres');
            i.why = why;
        });
        return infos;
    }
    // greedy best-first, skipping near-duplicates (dHash hamming <= dupT) of anything already picked
    function pickBest(infos, n, hashes, hamming, dupT = 10) {
        const order = infos.map((i, k) => k).filter(k => infos[k] && infos[k].ok).sort((a, b) => infos[b].score - infos[a].score);
        const pick = [], skipped = [];
        for (const k of order) {
            if (pick.length >= n) break;
            const dup = hashes && pick.some(p => hashes[p] && hashes[k] && hamming(hashes[p], hashes[k]) <= dupT);
            if (dup) skipped.push(k); else pick.push(k);
        }
        for (const k of skipped) { if (pick.length >= n) break; pick.push(k); }   // not enough distinct shots: fall back to the best duplicates
        return pick;
    }

    // ---------- cropping ----------
    async function cropBox(info, tw, th) {
        if (!info || !info.ok || !info.w) return null;
        const W = info.w, H = info.h, r = tw / th;
        let cw, ch;
        if (W / H > r) { ch = H; cw = H * r; } else { cw = W; ch = W / r; }
        if (Math.abs(cw - W) < 2 && Math.abs(ch - H) < 2) return { x: 0, y: 0, w: W, h: H };
        let cx, eyeY = null, top = null;
        const faces = info.faces || [];
        if (faces.length) {
            const big = faces[0], A0 = big.w * big.h;
            const main = faces.filter(f => f.w * f.h >= A0 * 0.3 && f.conf > 0.5);
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity;
            for (const f of main) { x0 = Math.min(x0, (f.x - 0.35 * f.w) * W); x1 = Math.max(x1, (f.x + 1.35 * f.w) * W); y0 = Math.min(y0, (f.y - 0.45 * f.h) * H); }
            if (x1 - x0 > cw) { x0 = (big.x - 0.35 * big.w) * W; x1 = (big.x + 1.35 * big.w) * W; }   // group too wide: frame the main face
            cx = (x0 + x1) / 2; eyeY = big.eyeY * H; top = y0;
            // looking room: shift slightly toward the side the face is turned to (eye-centre vs box-centre)
            const turn = (big.cx - (big.x + big.w / 2)) / big.w; cx += clamp(turn, -0.25, 0.25) * big.w * W * 1.2;
        } else {
            const sc = window.smartcrop || window.SmartCrop;
            if (sc && info.canvas) {
                const k = info.canvas.width / W, key = r.toFixed(3);
                info._sc = info._sc || {};
                if (!(key in info._sc)) {
                    try { const out = await sc.crop(info.canvas, { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)), minScale: 1 }); info._sc[key] = out && out.topCrop; }
                    catch (e) { info._sc[key] = null; }
                }
                const tc = info._sc[key];
                // no face to anchor on: saliency alone can wander (a hand, a bright light), so meet the centre half-way
                if (tc) { const sx = clamp(tc.x / k, 0, W - cw), sy = clamp(tc.y / k, 0, H - ch);
                          return { x: (sx + (W - cw) / 2) / 2, y: (sy + (H - ch) / 2) / 2, w: cw, h: ch }; }
            }
            return null;   // caller falls back to centre crop
        }
        let x = clamp(cx - cw / 2, 0, W - cw), y;
        if (ch < H - 1) {
            y = eyeY - (r < 0.7 ? 0.40 : 0.36) * ch;                            // eye line near the upper third (a bit lower for 9:16)
            if (top !== null && top < y) y = Math.max(top, eyeY - 0.5 * ch);    // never slice the top of the head if it fits
            y = clamp(y, 0, H - ch);
        } else y = 0;
        return { x, y, w: cw, h: ch };
    }

    window.AASmart = { ensure, analyze, rank, pickBest, cropBox, get ready() { return ready; }, get failed() { return failed; } };
})();
