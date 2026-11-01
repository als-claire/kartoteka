// Смысловая модель в отдельном потоке, чтобы не тормозить ввод.
// transformers.js берём с CDN той же версии, что и при сборке; файлы модели
// скачиваются с huggingface.co один раз и дальше лежат в кэше браузера.
let extractor = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const { pipeline, env } = await import(`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${m.version}/dist/transformers.min.js`);
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      const loaded = {};
      extractor = await pipeline('feature-extraction', m.model.id, {
        dtype: m.model.dtype,
        progress_callback: (p) => {
          if (p.status !== 'progress' || !p.total) return;
          loaded[p.file] = [p.loaded, p.total];
          const all = Object.values(loaded);
          const pct = (100 * all.reduce((s, x) => s + x[0], 0)) / all.reduce((s, x) => s + x[1], 0);
          self.postMessage({ type: 'progress', progress: pct });
        },
      });
      await extractor(m.model.queryPrefix + 'проверка', { pooling: 'mean', normalize: true });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (m.type === 'embed') {
    try {
      const out = await extractor(m.text, { pooling: 'mean', normalize: true });
      const vec = Float32Array.from(out.data);
      self.postMessage({ type: 'vec', id: m.id, vec }, [vec.buffer]);
    } catch (err) {
      self.postMessage({ type: 'vec', id: m.id, vec: null });
    }
  }
};
