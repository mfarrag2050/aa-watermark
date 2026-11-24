/* AA Smart — photo scoring, best-N selection and face-aware cropping for the Watermark tab.
 *
 * Runs entirely in the browser. Face detection, 68-point landmarks and expressions come from
 * face-api (vladmandic build, MIT) with models served from ./models; composition for photos
 * without faces comes from smartcrop.js (MIT). Nothing is uploaded anywhere.
 *
 *   AASmart.analyzeCheap(file)       -> pixel metrics only (fast; used to pre-filter)
 *   AASmart.analyze(file)            -> full info: faces; if none, people/animals + head point (cached, also in IndexedDB)
 *   AASmart.rank(infos)              -> infos get .score (0..100) and .why[]
 *   AASmart.pickBest(infos, n)       -> indices of the best n, skipping near-duplicates
 *   AASmart.cropBox(info, tw, th, o) -> {x, y, w, h} in original pixels, or null
 *        o.safeTop: share of the frame height kept clear of heads (story UI);  o.logo: {x0,y0,x1,y1} logo area in 0..1 of the frame
 *
 * The heavy part (face / people / pose models) runs in a Web Worker (aa-smart-worker.js, which loads this
 * same file) so the panel never freezes; if the browser can't run WebGL in a worker it falls back to the page.
 */
(function () {
    const G = typeof self !== 'undefined' ? self : window;
    const IN_WORKER = typeof document === 'undefined';
    function mkCanvas(w, h) { if (IN_WORKER) return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    const MODEL_URL = 'models';
    const A = 640;                 // analysis size (long side)
    let loading = null, ready = false, failed = false;

    let bodyLoading = null, bodyReady = false, OBJ = null, POSE = null;
    const LABELS = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"];
    const SUBJECT = new Set(['person', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'dog', 'cat', 'bird']);
    // people / animal detector (CenterNet, COCO) and single-person pose (MoveNet Lightning) — from Human (MIT); loaded only when a photo has no face
    async function ensureBody() {
        if (bodyReady) return true;
        if (!(await ensureLocal())) return false;
        if (!bodyLoading) bodyLoading = (async () => {
            try { const tf = G.faceapi.tf; OBJ = await tf.loadGraphModel(MODEL_URL + '/centernet.json'); POSE = await tf.loadGraphModel(MODEL_URL + '/movenet-lightning.json'); bodyReady = true; }
            catch (e) { console.warn('AASmart: body models unavailable', e); }
        })();
        await bodyLoading; return bodyReady;
    }

    function loadScript(src) {
        if (IN_WORKER) { importScripts(src); return Promise.resolve(); }
        return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    }
    // models in this thread (the worker, or the page when the worker is not available)
    let lLoading = null, lReady = false, lFailed = false;
    async function ensureLocal() {
        if (lReady) return true; if (lFailed) return false;
        if (!lLoading) lLoading = (async () => {
            try {
                if (!G.faceapi) await loadScript('vendor-face-api.js');
                const fa = G.faceapi, tf = fa.tf;
                if (IN_WORKER) {
                    const O = () => new OffscreenCanvas(1, 1);
                    fa.env.setEnv({ Canvas: OffscreenCanvas, CanvasRenderingContext2D: G.OffscreenCanvasRenderingContext2D, Image: OffscreenCanvas, ImageData, Video: OffscreenCanvas,
                        createCanvasElement: O, createImageElement: O, createVideoElement: O, fetch: (...a) => fetch(...a), readFile: () => { throw new Error('no file system'); } });
                }
                try { await tf.setBackend('webgl'); } catch (e) { await tf.setBackend('cpu'); }
                await tf.ready();
                await fa.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
                await fa.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
                await fa.nets.faceExpressionNet.loadFromUri(MODEL_URL);
                lReady = true;
            } catch (e) { console.warn('AASmart: face models unavailable', e); lFailed = true; }
        })();
        await lLoading; return lReady;
    }

    // face identity (128-number descriptor, face-api FaceRecognitionNet, MIT) — used to avoid the same person twice in an album
    let recLoading = null, recReady = false;
    async function ensureRec() {
        if (recReady) return true;
        if (!(await ensureLocal())) return false;
        if (!recLoading) recLoading = G.faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL).then(() => { recReady = true; }).catch(e => console.warn('AASmart: identity model unavailable', e));
        await recLoading; return recReady;
    }

    // ---------- worker client (page side) ----------
    let worker = null, wStart = null, wSeq = 0, mode = null;
    const wPend = new Map();
    function startWorker() {
        if (wStart) return wStart;
        wStart = new Promise(res => {
            try {
                worker = new Worker('aa-smart-worker.js');
                worker.onmessage = e => {
                    const m = e.data;
                    if (m.type === 'init') { res(!!m.ok && m.backend === 'webgl'); return; }
                    const p = wPend.get(m.id); if (!p) return; wPend.delete(m.id);
                    if (m.error) p.rej(new Error(m.error)); else p.res(m.res);
                };
                worker.onerror = e => { console.warn('AASmart: worker error', e.message || e); res(false); mode = 'local'; for (const p of wPend.values()) p.rej(new Error('worker')); wPend.clear(); };
                worker.postMessage({ type: 'init' });
                setTimeout(() => res(false), 90000);
            } catch (e) { res(false); }
        });
        return wStart;
    }
    const workerDetect = c => workerCall('detect', c);

    function workerCall(type, c, extra) {
        const im = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
        return new Promise((res, rej) => {
            const id = ++wSeq; wPend.set(id, { res, rej });
            worker.postMessage(Object.assign({ type, id, w: im.width, h: im.height, buf: im.data.buffer }, extra || {}), [im.data.buffer]);
        });
    }

    async function ensure() {
        if (ready) return true; if (failed) return false;
        if (!loading) loading = (async () => {
            if (!IN_WORKER && !G.SmartCrop && !G.smartcrop) { try { await loadScript('smartcrop.js'); } catch (e) {} }
            if (!IN_WORKER && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && await startWorker()) { mode = 'worker'; ready = true; return; }
            if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
            if (await ensureLocal()) { mode = 'local'; ready = true; } else failed = true;
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
    function meanBox(g, w, h, x0, y0, x1, y1) {
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
        let s = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += g[y * w + x]; n++; }
        return n ? s / n / 255 : 0.5;
    }
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    function eyeAR(pts) { return (dist(pts[1], pts[5]) + dist(pts[2], pts[4])) / (2 * dist(pts[0], pts[3]) || 1); }

    const cheapCache = new WeakMap(), fullCache = new WeakMap();
    const yieldUI = () => new Promise(r => setTimeout(r, 0));
    async function bitmapOf(file) {
        try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { return await createImageBitmap(file); }
    }

    // ---------- persistent cache (IndexedDB): re-adding the same photos is instant ----------
    const VER = 6;
    let dbp = null;
    function db() {
        if (!dbp) dbp = new Promise(res => {
            try { const r = indexedDB.open('aa-smart', 1); r.onupgradeneeded = () => r.result.createObjectStore('info'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }
            catch (e) { res(null); }
        });
        return dbp;
    }
    const idKey = f => [f.name, f.size, f.lastModified, VER].join('|');
    async function idbGet(k) { const d = await db(); if (!d) return null; return new Promise(res => { try { const q = d.transaction('info').objectStore('info').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } }); }
    async function idbPut(k, v) { const d = await db(); if (!d) return; try { d.transaction('info', 'readwrite').objectStore('info').put(v, k); } catch (e) {} }

    // ---------- stage 1: pixels only ----------
    async function analyzeCheap(file) {
        if (cheapCache.has(file)) return cheapCache.get(file);
        const p = (async () => {
            const info = { file, w: 0, h: 0, faces: [], subjects: [], ok: false, level: 'cheap' };
            let bmp; try { bmp = await bitmapOf(file); } catch (e) { return info; }
            info.w = bmp.width; info.h = bmp.height;
            const k = A / Math.max(bmp.width, bmp.height), cw = Math.max(1, Math.round(bmp.width * k)), ch = Math.max(1, Math.round(bmp.height * k));
            const c = mkCanvas(cw, ch);
            const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, cw, ch); bmp.close && bmp.close();
            const { g, d } = grayOf(ctx, cw, ch);
            info.sharp = lapVar(g, cw, ch);
            Object.assign(info, toneStats(g, d));
            info.canvas = c;   // small (640px) copy for detection and smartcrop
            info.ok = true; return info;
        })();
        cheapCache.set(file, p); return p;
    }

    // ---------- people and animals (only for photos without a face) ----------
    async function detectSubjects(c) {
        const tf = G.faceapi.tf, cw = c.width, ch = c.height;
        // pad to a square (grey) instead of stretching: the detector is far more confident on undistorted frames
        const S = Math.max(cw, ch), ox0 = (S - cw) / 2, oy0 = (S - ch) / 2;
        const sq0 = mkCanvas(S, S);
        const g0 = sq0.getContext('2d'); g0.fillStyle = '#808080'; g0.fillRect(0, 0, S, S); g0.drawImage(c, ox0, oy0);
        const inp = tf.tidy(() => tf.image.resizeBilinear(tf.cast(tf.browser.fromPixels(sq0), 'float32').expandDims(0), [512, 512]));
        const det = OBJ.execute(inp, ['tower_0/detections']); const arr = (await det.array())[0]; tf.dispose([inp, det]);
        const k512 = S / 512;
        let objs = [];
        for (const d of arr) {
            const [x1, y1, x2, y2, score, cls] = d; let label = LABELS[cls];
            if (!(score >= 0.25) || !SUBJECT.has(label)) continue;
            if (label !== 'person') label = 'animal:' + label;      // the exact species is unreliable on action shots
            const X1 = clamp((x1 * k512 - ox0) / cw), Y1 = clamp((y1 * k512 - oy0) / ch), X2 = clamp((x2 * k512 - ox0) / cw), Y2 = clamp((y2 * k512 - oy0) / ch);
            const b = { x: X1, y: Y1, w: X2 - X1, h: Y2 - Y1, score, label };
            if (b.w < 0.03 || b.h < 0.03) continue;
            objs.push(b);
        }
        objs.sort((a, b) => b.score - a.score);
        const iou = (a, b) => { const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); const I = ix * iy; return I / (a.w * a.h + b.w * b.h - I); };
        const kept = []; for (const o of objs) if (!kept.some(k => (k.label === 'person') === (o.label === 'person') && iou(k, o) > 0.45)) kept.push(o);
        // main subject: big, confident, people slightly preferred; a spectator at the edge does not beat the horse in the middle
        const wt = o => o.w * o.h * Math.sqrt(o.score) * (o.label === 'person' ? 1.4 : 1);
        kept.sort((a, b) => wt(b) - wt(a));
        const M = kept[0];
        const overl = (a, b) => { const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); return ix * iy > 0.25 * Math.min(a.w * a.h, b.w * b.h); };
        const group = M ? kept.filter(o => o === M || overl(M, o) && o.w * o.h > 0.08 * M.w * M.h || (o.label === M.label && o.w * o.h >= 0.35 * M.w * M.h && o.score >= 0.3)) : [];
        group.forEach(o => o.main = true);
        // head of the main person from the pose model (works with the face turned away)
        let head = null; const main = group.filter(o => o.label === 'person').sort((a, b) => b.w * b.h - a.w * a.h)[0];
        if (main && POSE) {
            const ex = 0.15, bx = clamp(main.x - main.w * ex) * cw, by = clamp(main.y - main.h * ex) * ch;
            const bw = Math.min(cw - bx, main.w * (1 + 2 * ex) * cw), bh = Math.min(ch - by, main.h * (1 + 2 * ex) * ch), side = Math.max(bw, bh);
            const sq = mkCanvas(192, 192);
            const sx = sq.getContext('2d'); sx.fillStyle = '#000'; sx.fillRect(0, 0, 192, 192);
            const k = 192 / side, ox = (side - bw) / 2 * k, oy = (side - bh) / 2 * k;
            sx.drawImage(c, bx, by, bw, bh, ox, oy, bw * k, bh * k);
            const t = tf.tidy(() => tf.cast(tf.browser.fromPixels(sq), 'int32').expandDims(0));
            const out = POSE.execute(t); const kp = (await out.array())[0][0]; tf.dispose([t, out]);
            const pts = kp.slice(0, 7).map(([y, x, sc]) => ({ x: (bx + (x * 192 - ox) / k) / cw, y: (by + (y * 192 - oy) / k) / ch, sc }));
            const hp = pts.slice(0, 5).filter(p => p.sc > 0.3);
            if (hp.length) head = { x: hp.reduce((a, p) => a + p.x, 0) / hp.length, y: hp.reduce((a, p) => a + p.y, 0) / hp.length };
            else { const sh = pts.slice(5, 7).filter(p => p.sc > 0.3); if (sh.length === 2) head = { x: (sh[0].x + sh[1].x) / 2, y: (sh[0].y + sh[1].y) / 2 - Math.abs(sh[0].x - sh[1].x) * 0.9 }; }
        }

        return { subjects: kept.slice(0, 8), head };
    }

    // rot: 0 upright, 1 = image turned clockwise, -1 = counter-clockwise; results mapped back to the upright frame
    async function detectFaces(c, g, cw, ch, rot) {
        let src = c;
        if (rot) {
            src = mkCanvas(ch, cw);
            const x = src.getContext('2d');
            if (rot > 0) { x.translate(ch, 0); x.rotate(Math.PI / 2); } else { x.translate(0, cw); x.rotate(-Math.PI / 2); }
            x.drawImage(c, 0, 0);
        }
        const back = (u, v) => rot === 0 ? { x: u, y: v } : rot > 0 ? { x: v, y: ch - u } : { x: cw - v, y: u };
        const fa = G.faceapi, px = fa.tf.browser.fromPixels(src);   // a tensor works the same in the page and in a worker
        let det; try { det = await fa.detectAllFaces(px, new fa.SsdMobilenetv1Options({ minConfidence: 0.45, maxResults: 12 })).withFaceLandmarks().withFaceExpressions(); }
        finally { px.dispose(); }
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
                sharp: lapVar(g, cw, ch, x0, y0, x1, y1), lum: meanBox(g, cw, ch, x0, y0, x1, y1),
                eyeY: ((eL.y + eR.y) / 2) / ch, cx: ((iL.x + iR.x) / 2) / cw
            });
        }
        return out;
    }

    // who is it: 128-number descriptors for the given faces (normalised boxes). Only asked for when "no repeated person" is on.
    async function describeFaces(c, boxesN) {
        if (!boxesN.length || !(await ensureRec())) return null;
        const fa = G.faceapi, cw = c.width, ch = c.height, px = fa.tf.browser.fromPixels(c);
        try {
            const tens = await fa.extractFaceTensors(px, boxesN.map(f => new fa.Rect(f.x * cw, f.y * ch, f.w * cw, f.h * ch)));
            const out = [];
            for (const t of tens) out.push(Array.from(await fa.computeFaceDescriptor(t), v => Math.round(v * 1000) / 1000));
            fa.tf.dispose(tens); return out;
        } finally { px.dispose(); }
    }

    // faces; people/animals when there is no clear face; rotated faces as a last resort
    async function detectAll(c) {
        const cw = c.width, ch = c.height, r = { faces: [], subjects: [], head: null };
        try {
            const { g } = grayOf(c.getContext('2d', { willReadFrequently: true }), cw, ch);
            // upright faces first
            r.faces = (await detectFaces(c, g, cw, ch, 0)).sort((a, b) => b.w * b.h - a.w * a.h);
        } catch (e) { console.warn('AASmart: face detection failed', e); }
        const maxFace = r.faces.reduce((m, f) => Math.max(m, f.w), 0);
        if (maxFace < 0.07 && await ensureBody()) {   // no face, or only small ones (crowd): look for the actual subject
            try { Object.assign(r, await detectSubjects(c)); } catch (e) { console.warn('AASmart: subject detection failed', e); }
        }
        // still no face: try the frame turned 90° both ways (people lying, leaning, upside-down riders),
        // unless the pose model already found the head of an upright main person — that saves two passes
        const mp = (r.subjects || []).find(o => o.main && o.label === 'person');
        if (!r.faces.length && !(mp && r.head && mp.h > mp.w * 1.1)) {
            try {
                const { g } = grayOf(c.getContext('2d', { willReadFrequently: true }), cw, ch);
                const A1 = await detectFaces(c, g, cw, ch, 1), B1 = await detectFaces(c, g, cw, ch, -1);
                const best = (L) => L.reduce((m, f) => Math.max(m, f.conf), 0);
                r.faces = (best(A1) >= best(B1) ? A1 : B1).filter(f => f.conf >= 0.6).sort((a, b) => b.w * b.h - a.w * a.h);
            } catch (e) { console.warn('AASmart: rotated face detection failed', e); }
        }
        return r;
    }

    // ---------- stage 2: full analysis ----------
    const KEEP = ['w', 'h', 'sharp', 'mean', 'sd', 'hi', 'lo', 'colorful', 'faces', 'subjects', 'head'];
    async function analyze(file) {
        if (fullCache.has(file)) return fullCache.get(file);
        const p = (async () => {
            const k = idKey(file), hit = await idbGet(k);
            if (hit) return Object.assign({ file, ok: true, level: 'full', cached: true }, hit);
            const base = await analyzeCheap(file);
            const info = Object.assign({}, base, { faces: [], subjects: [], head: null, level: 'full' });
            if (!base.ok) return info;
            const c = base.canvas, cw = c.width, ch = c.height;
            if (await ensure()) {
                let r = null;
                if (mode === 'worker') { try { r = await workerDetect(c); } catch (e) { console.warn('AASmart: worker detection failed, using the page', e); mode = 'local'; } }
                if (!r && await ensureLocal()) r = await detectAll(c);
                if (r) { Object.assign(info, r); const rec = {}; KEEP.forEach(key => rec[key] = info[key]); idbPut(k, rec); }
            }
            info.ok = true; await yieldUI(); return info;
        })();
        fullCache.set(file, p); return p;
    }
    // identity for the two biggest clear upright faces; done once per photo and kept with the analysis
    async function identify(info) {
        if (!info || !info.ok || info.idDone || !info.faces) return info;
        const faces = info.faces.filter(f => f.w >= 0.05 && f.conf >= 0.6 && !f.rot).slice(0, 2);
        if (!faces.length) { info.idDone = true; return info; }
        if (!(await ensure())) return info;
        const c = await canvasOf(info), boxes = faces.map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
        let d = null;
        if (mode === 'worker') { try { d = await workerCall('describe', c, { boxes }); } catch (e) { console.warn('AASmart: worker identity failed', e); } }
        if (!d) { try { d = await describeFaces(c, boxes); } catch (e) { console.warn('AASmart: identity failed', e); } }
        if (!d) return info;
        faces.forEach((f, k) => { if (d[k]) f.desc = d[k]; });
        info.idDone = true;
        const rec = {}; KEEP.forEach(key => rec[key] = info[key]); rec.idDone = true; idbPut(idKey(info.file), rec);
        return info;
    }
    async function canvasOf(info) { if (info.canvas) return info.canvas; const c = await analyzeCheap(info.file); info.canvas = c.canvas; return info.canvas; }

    // ---------- scoring ----------
    const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
    function faceQuality(f) {
        const size = clamp(Math.sqrt(f.w * f.h) / 0.32);                     // a face ~1/10 of the frame scores full
        const eyes = f.eyes >= 0.21 ? 1 : f.eyes >= 0.17 ? 0.65 : f.eyes >= 0.13 ? 0.3 : 0.1;
        const talking = f.mouth > 0.085 && f.happy < 0.5;                     // caught mid-word
        const mouth = talking ? clamp(1 - (f.mouth - 0.085) * 6, 0.45, 1) : 1;
        const expr = 0.7 + 0.3 * clamp(f.happy + f.neutral);
        const edge = (f.x < 0.01 || f.y < 0.01 || f.x + f.w > 0.99 || f.y + f.h > 0.99) ? 0.6 : 1;   // face cut by the frame
        const L = f.lum == null ? 0.5 : f.lum;                                 // the face itself in shadow or burnt out
        const light = L < 0.16 ? 0.55 : L < 0.26 ? 0.8 : L > 0.88 ? 0.7 : 1;
        return { q: size * eyes * mouth * expr * edge * light, eyes, talking, edge: edge < 1, dark: L < 0.26, burnt: L > 0.88 };
    }
    function rank(infos, target) {
        const ok = infos.filter(i => i && i.ok);
        const lv = v => Math.log(1 + Math.max(0, v));
        const sh = ok.map(i => lv(i.faces && i.faces[0] ? Math.max(i.faces[0].sharp, i.sharp * 0.8) : i.sharp));
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
            if (i.faces && i.faces.length) { fq = faceQuality(i.faces[0]); face = 0.25 + 0.75 * fq.q; }
            else if (i.subjects && i.subjects.length) {             // no face, but a person/animal: reward a clear, uncut subject
                const m = i.subjects.find(o => o.main) || i.subjects[0], cut = (m.x < 0.01 || m.x + m.w > 0.99) ? 0.75 : 1;
                face = (0.45 + 0.25 * clamp(Math.sqrt(m.w * m.h) / 0.5)) * cut;
            }
            let res = 1;
            if (target) { const need = Math.max(target.w, target.h); const have = Math.max(i.w, i.h); res = clamp(have / need, 0.4, 1); }
            const s = 100 * (0.30 * sharp + 0.14 * expo + 0.10 * contrast + 0.06 * color + 0.30 * face + 0.10 * res);
            i.score = Math.round(s);
            if (sharp > 0.75) why.push('sharp'); else if (sharp < 0.35) why.push('soft');
            if (expo < 0.5) why.push(i.mean < 0.48 ? 'dark' : 'bright');
            if (fq) { if (fq.dark) why.push('facedark'); if (fq.burnt) why.push('faceburnt'); if (fq.eyes < 0.6) why.push('eyes'); if (fq.talking) why.push('mouth'); if (fq.edge) why.push('cut'); if (fq.q > 0.7) why.push('face'); }
            if (res < 0.95) why.push('lowres');
            i.why = why; i.shot = shotOf(i);
        });
        return infos;
    }
    // shot size, for variety: close-up / medium / wide / scene (no person)
    function shotOf(i) {
        const f = i.faces && i.faces.find(x => x.conf >= 0.6);
        if (f) return f.h >= 0.2 ? 'close' : f.h >= 0.07 ? 'medium' : 'wide';
        const m = i.subjects && (i.subjects.find(o => o.main) || i.subjects[0]);
        if (m) return m.h >= 0.75 && m.w * m.h > 0.3 ? 'medium' : 'wide';
        return i.level === 'full' ? 'scene' : null;
    }
    const descDist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s); };
    const people = i => (i.faces || []).filter(f => f.desc).map(f => f.desc);
    // greedy: best score first, but
    //  - near-duplicates (dHash hamming <= dupT) are skipped, look-alikes (<= dupT + 8) lose 6 points,
    //  - each repeat of the same shot size costs 4 points (an album of wide, medium and close shots),
    //  - with noRepeat, a photo whose main person is already in the album waits until nothing else is left.
    function pickBest(infos, n, hashes, hamming, dupT = 10, only = null, o = {}) {
        const pool = infos.map((i, k) => k).filter(k => infos[k] && infos[k].ok);
        const base = k => infos[k].score - (only && !only.has(k) ? 1000 : 0);   // fully analysed candidates first
        const pick = [], used = new Set(), seen = [], shots = {};
        const ham = (a, b) => hashes && hashes[a] && hashes[b] ? hamming(hashes[a], hashes[b]) : 99;
        const samePerson = k => o.noRepeat && people(infos[k]).some(d => seen.some(e => descDist(d, e) < 0.5));
        const take = k => { pick.push(k); used.add(k); people(infos[k]).forEach(d => seen.push(d)); const sh = infos[k].shot; if (sh) shots[sh] = (shots[sh] || 0) + 1; };
        const pass = (allowDup, allowRepeat) => {
            while (pick.length < n) {
                let best = null, bs = -Infinity;
                for (const k of pool) {
                    if (used.has(k)) continue;
                    let minH = 99; for (const p of pick) minH = Math.min(minH, ham(p, k));
                    if (!allowDup && minH <= dupT) continue;
                    if (!allowRepeat && samePerson(k)) continue;
                    let v = base(k);
                    if (minH <= dupT + 8) v -= 6;
                    const sh = infos[k].shot; if (o.diverse !== false && sh) v -= 4 * (shots[sh] || 0);
                    if (v > bs) { bs = v; best = k; }
                }
                if (best === null) return;
                take(best);
            }
        };
        pass(false, false);
        const p1 = pick.length; pass(false, true);           // not enough different people: allow repeats
        const p2 = pick.length; pass(true, true);            // not enough distinct shots: allow near-duplicates
        pick.repeats = p2 - p1; pick.dups = pick.length - p2;
        return pick;
    }

    // ---------- cropping ----------
    // after the first placement: story safe zone, logo corner, faces sliced by the frame edge
    function refine(info, box, keys, o, W, H) {
        if (!box || !keys || !keys.length) return box;
        let { x, y, w: cw, h: ch } = box;
        const kx0 = Math.min(...keys.map(k => k.x0)), kx1 = Math.max(...keys.map(k => k.x1)), ky0 = Math.min(...keys.map(k => k.y0)), ky1 = Math.max(...keys.map(k => k.y1));
        let fits = (X, Y) => X >= -0.5 && Y >= -0.5 && X + cw <= W + 0.5 && Y + ch <= H + 0.5 && kx0 >= X - 1 && kx1 <= X + cw + 1 && ky0 >= Y - 1 && ky1 <= Y + ch + 1;
        const safeY = Y => !o.safeTop || ky0 >= Y + o.safeTop * ch - 1 || Y <= 0.5;
        // 1) story: heads stay below the top band where Instagram draws the profile bar
        if (o.safeTop && ky0 < y + o.safeTop * ch) { const Y = clamp(ky0 - o.safeTop * ch, 0, H - ch); if (fits(x, Y)) y = Y; }
        // the frame already uses the full height (a landscape photo in a story): zoom in a little, never past the output size
        if (o.safeTop && y <= 0.5 && ky0 < o.safeTop * ch && o.outH) {
            const r = cw / ch, ch2 = Math.max(ky0 / o.safeTop, ch / 1.3, o.outH);
            if (ch2 < ch - 1 && ch2 * r >= kx1 - kx0) {
                const cw2 = ch2 * r, cx = (kx0 + kx1) / 2, X = clamp(cx - cw2 / 2, 0, W - cw2);
                if (ky1 <= ch2 && kx0 >= X && kx1 <= X + cw2) { x = X; cw = cw2; ch = ch2; }
            }
        }
        // 2) no face under the logo
        const L = o.logo;
        if (L) {
            const pad = 0.015, hit = (X, Y) => keys.some(k => (k.x1 - X) / cw > L.x0 - pad && (k.x0 - X) / cw < L.x1 + pad && (k.y1 - Y) / ch > L.y0 - pad && (k.y0 - Y) / ch < L.y1 + pad);
            if (hit(x, y)) {
                const opts = [];
                const lx = keys.filter(k => (k.y1 - y) / ch > L.y0 - pad);              // the keys low enough to meet the logo
                if (L.x0 > 0.5) opts.push([x + Math.max(...lx.map(k => k.x1)) - x - (L.x0 - pad) * cw, y]); // move the frame right: face slides left
                else opts.push([x - ((L.x1 + pad) * cw - (Math.min(...lx.map(k => k.x0)) - x)), y]);
                opts.push([x, y + Math.max(...keys.map(k => k.y1)) - y - (L.y0 - pad) * ch]);    // or move it down: face slides up
                let best = null;
                for (const [X0, Y0] of opts) { const X = clamp(X0, 0, W - cw), Y = clamp(Y0, 0, H - ch); if (fits(X, Y) && safeY(Y) && !hit(X, Y)) { const d = Math.hypot(X - x, Y - y); if (!best || d < best[2]) best = [X, Y, d]; } }
                if (best) { x = best[0]; y = best[1]; }
            }
        }
        // 3) a second face sliced by the left/right edge: take it in whole, or leave it out, whichever moves less
        const others = (info.faces || []).filter(f => f.conf > 0.5 && !keys.some(k => k.face === f));
        for (const f of others) {
            const fx0 = f.x * W, fx1 = (f.x + f.w) * W, fy0 = f.y * H, fy1 = (f.y + f.h) * H;
            if (fy1 < y || fy0 > y + ch) continue;
            const inside = (Math.min(fx1, x + cw) - Math.max(fx0, x)) / (fx1 - fx0);
            if (!(inside > 0.12 && inside < 0.88)) continue;
            const cut = fx0 < x ? [fx0 - 0.03 * cw, fx1 + 0.01 * cw] : [fx1 + 0.03 * cw - cw, fx0 - 0.01 * cw - cw];   // [include, exclude] new x
            let best = null;
            for (const X0 of cut) { const X = clamp(X0, 0, W - cw); const d = Math.abs(X - x); if (d <= 0.15 * cw && fits(X, y) && (!L || !keys.some(k => (k.x1 - X) / cw > L.x0 && (k.x0 - X) / cw < L.x1 && (k.y1 - y) / ch > L.y0 && (k.y0 - y) / ch < L.y1))) { if (!best || d < best[1]) best = [X, d]; } }
            if (best) x = best[0];
        }
        return { x, y, w: cw, h: ch };
    }

    async function cropBox(info, tw, th, o = {}) {
        o = Object.assign({ outH: th }, o);
        const b = await cropBase(info, tw, th);
        if (!b || !b._keys) return b;
        const keys = b._keys; delete b._keys;
        return refine(info, b, keys, o, info.w, info.h);
    }

    async function cropBase(info, tw, th) {
        if (!info || !info.ok || !info.w) return null;
        const W = info.w, H = info.h, r = tw / th;
        let cw, ch;
        if (W / H > r) { ch = H; cw = H * r; } else { cw = W; ch = W / r; }
        if (Math.abs(cw - W) < 2 && Math.abs(ch - H) < 2) return { x: 0, y: 0, w: W, h: H };
        let cx, eyeY = null, top = null, keys = null;
        let faces = info.faces || [];
        // small faces in the stands must not pull the crop away from the rider/horse in the middle
        const mainS = (info.subjects || []).filter(o => o.main);
        if (faces.length && mainS.length && faces.every(f => f.w < 0.07)) {          // a clear, large face always wins
            const bodies = mainS.concat((info.subjects || []).filter(o => o.label === 'person' && o.w * o.h >= 0.1));
            const inBox = (f, o) => { const fx = f.x + f.w / 2, fy = f.y + f.h / 2; return fx >= o.x && fx <= o.x + o.w && fy >= o.y && fy <= o.y + o.h; };
            const inside = faces.filter(f => bodies.some(o => inBox(f, o)));
            const area = mainS.reduce((m, o) => Math.max(m, o.w * o.h), 0);
            if (inside.length) faces = inside; else if (area > 0.08) faces = [];
        }
        if (faces.length) {
            const big = faces[0], A0 = big.w * big.h;
            const main = faces.filter(f => f.w * f.h >= A0 * 0.3 && f.conf > 0.5);
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity;
            for (const f of main) { x0 = Math.min(x0, (f.x - 0.35 * f.w) * W); x1 = Math.max(x1, (f.x + 1.35 * f.w) * W); y0 = Math.min(y0, (f.y - 0.45 * f.h) * H); }
            if (x1 - x0 > cw) { x0 = (big.x - 0.35 * big.w) * W; x1 = (big.x + 1.35 * big.w) * W; }   // group too wide: frame the main face
            cx = (x0 + x1) / 2; eyeY = big.eyeY * H; top = y0;
            keys = main.map(f => ({ x0: (f.x - 0.1 * f.w) * W, x1: (f.x + 1.1 * f.w) * W, y0: (f.y - 0.3 * f.h) * H, y1: (f.y + f.h) * H, face: f }));
            // looking room: shift slightly toward the side the face is turned to (eye-centre vs box-centre)
            const turn = (big.cx - (big.x + big.w / 2)) / big.w; cx += clamp(turn, -0.25, 0.25) * big.w * W * 1.2;
        } else if (info.subjects && info.subjects.length) {
            // the main subject and what belongs to it (rider + horse, both wrestlers), worked out at detection time
            const S = info.subjects, main = S.filter(o => o.main), big = main[0] || S[0];
            const box = L => L.reduce((b, o) => ({ x0: Math.min(b.x0, o.x * W), y0: Math.min(b.y0, o.y * H), x1: Math.max(b.x1, (o.x + o.w) * W), y1: Math.max(b.y1, (o.y + o.h) * H) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
            let b = box(main.length ? main : [big]); if (b.x1 - b.x0 > cw) b = box([big]);
            const hd = info.head;
            cx = (b.x1 - b.x0 > cw * 0.85 && hd) ? hd.x * W : (b.x0 + b.x1) / 2;   // too wide to fit: keep the head in
            let x = clamp(cx - cw / 2, 0, W - cw), y = 0;
            if (ch < H - 1) {
                if (hd) y = hd.y * H - 0.30 * ch; else y = b.y0 - 0.06 * ch;
                if (b.y1 - b.y0 <= ch && y + ch < b.y1) y = b.y1 - ch;               // whole subject fits: keep the feet/hooves in
                if (y > b.y0 - 0.03 * ch && (hd ? hd.y * H - (b.y0) < 0.5 * ch : true)) y = Math.min(y, b.y0 - 0.03 * ch);
                y = clamp(y, 0, H - ch);
            }
            const hs = Math.max(0.04 * Math.max(W, H), (main.find(o => o.label === 'person') || big).w * W * 0.22);
            const sk = hd ? [{ x0: hd.x * W - hs, x1: hd.x * W + hs, y0: hd.y * H - hs * 1.1, y1: hd.y * H + hs * 0.8 }]
                          : [{ x0: Math.max(b.x0, x), x1: Math.min(b.x1, x + cw), y0: b.y0, y1: b.y0 + Math.min(b.y1 - b.y0, ch) * 0.25 }];
            return { x, y, w: cw, h: ch, _keys: sk };
        } else {
            const sc = G.smartcrop || G.SmartCrop, cv = sc ? await canvasOf(info) : null;
            if (sc && cv) {
                const k = cv.width / W, key = r.toFixed(3);
                info._sc = info._sc || {};
                if (!(key in info._sc)) {
                    try { const out = await sc.crop(cv, { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)), minScale: 1 }); info._sc[key] = out && out.topCrop; }
                    catch (e) { info._sc[key] = null; }
                }
                const tc = info._sc[key];
                // nothing to anchor on: saliency alone can wander (a hand, a bright light), so meet the centre half-way
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
        return { x, y, w: cw, h: ch, _keys: keys };
    }

    // preload the face models when the browser is idle, so the first photos are analysed without a wait
    if (!IN_WORKER) { try { (G.requestIdleCallback || (f => setTimeout(f, 1500)))(() => ensure(), { timeout: 4000 }); } catch (e) {} }

    G.AASmart = { ensure, ensureBody, analyzeCheap, analyze, identify, rank, pickBest, cropBox, _init: ensureLocal, _detectAll: detectAll, _describe: describeFaces, get mode() { return mode; }, get ready() { return ready; }, get failed() { return failed; } };
})();
