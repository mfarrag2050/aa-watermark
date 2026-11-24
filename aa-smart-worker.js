/* AA Smart worker — runs the face / people / pose models off the page, so the panel never freezes.
 * Loads face-api (vladmandic, MIT) and aa-smart.js itself; the page sends a 640px frame, gets back faces, subjects, head. */
importScripts('vendor-face-api.js', 'aa-smart.js');
let queue = Promise.resolve(), initP = null;
self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
        initP = initP || AASmart._init();
        initP.then(ok => self.postMessage({ type: 'init', ok, backend: ok ? faceapi.tf.getBackend() : null }));
        return;
    }
    if (m.type === 'detect') {
        queue = queue.then(async () => {      // one photo at a time: the GPU is shared
            try {
                await initP;
                const c = new OffscreenCanvas(m.w, m.h);
                c.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0);
                const res = await AASmart._detectAll(c);
                self.postMessage({ type: 'detect', id: m.id, res });
            } catch (err) { self.postMessage({ type: 'detect', id: m.id, error: String((err && err.message) || err) }); }
        });
    }
};
