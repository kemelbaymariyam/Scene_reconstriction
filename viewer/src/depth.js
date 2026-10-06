const cache = new Map();

async function loadArrayBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.arrayBuffer();
}

export function loadFrameData(frameId) {
  const existing = cache.get(frameId);
  if (existing) return existing;

  const promise = (async () => {
    const metaResponse = await fetch(`/processed/frame_${frameId}.json`);
    if (!metaResponse.ok) {
      throw new Error(
        `Missing processed depth for frame ${frameId}. Run: python scripts/preprocess_depth.py`,
      );
    }
    const meta = await metaResponse.json();

    const [depthBuffer, confidenceBuffer, maskBuffer] = await Promise.all([
      loadArrayBuffer(`/processed/${meta.depthFile}`),
      loadArrayBuffer(`/processed/${meta.confidenceFile}`),
      loadArrayBuffer(`/processed/${meta.maskFile}`),
    ]);

    return {
      meta,
      depth: new Float32Array(depthBuffer),
      confidence: new Float32Array(confidenceBuffer),
      mask: new Uint8Array(maskBuffer),
    };
  })();

  cache.set(frameId, promise);
  return promise;
}
