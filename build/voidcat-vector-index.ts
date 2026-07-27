export const RAG_VECTOR_INDEX_VERSION = 1;
export const RAG_VECTOR_BANDS = 8;
export const RAG_VECTOR_BITS_PER_BAND = 8;

export type RagVectorSignature = {
  version: number;
  dimensions: number;
  signature: string;
  buckets: number[];
  fingerprint: string;
};

export type RagVectorProbe = { band: number; bucket: number };

function mix32(value: number) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function projectionSign(dimension: number, bit: number) {
  const seed = Math.imul(dimension + 1, 0x9e3779b1) ^ Math.imul(bit + 1, 0x85ebca77);
  return (mix32(seed) & 1) === 0 ? -1 : 1;
}

function vectorFingerprint(vector: readonly number[]) {
  let hash = 0x811c9dc5;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  for (const rawValue of vector) {
    const value = Number.isFinite(rawValue) ? rawValue : 0;
    view.setFloat32(0, value, true);
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= view.getUint8(byte);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  hash ^= vector.length;
  hash = Math.imul(hash, 0x01000193);
  return `${vector.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Produces a deterministic 64-bit random-hyperplane SimHash, split into eight
 * independently searchable 8-bit LSH bands. No model or external service is
 * involved; the same embedding always produces the same signature.
 */
export function createRagVectorSignature(vector: readonly number[]): RagVectorSignature {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("An embedding must contain at least one value.");

  const projections = new Float64Array(RAG_VECTOR_BANDS * RAG_VECTOR_BITS_PER_BAND);
  let magnitudeSquared = 0;

  for (let dimension = 0; dimension < vector.length; dimension += 1) {
    const value = vector[dimension];
    if (!Number.isFinite(value)) throw new Error(`Embedding value ${dimension} is not finite.`);
    magnitudeSquared += value * value;
    if (value === 0) continue;
    for (let bit = 0; bit < projections.length; bit += 1) {
      projections[bit] += value * projectionSign(dimension, bit);
    }
  }

  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared === 0) throw new Error("An embedding cannot be a zero vector.");

  const buckets = new Array<number>(RAG_VECTOR_BANDS).fill(0);
  for (let bit = 0; bit < projections.length; bit += 1) {
    if (projections[bit] >= 0) buckets[Math.floor(bit / RAG_VECTOR_BITS_PER_BAND)] |= 1 << (bit % RAG_VECTOR_BITS_PER_BAND);
  }

  return {
    version: RAG_VECTOR_INDEX_VERSION,
    dimensions: vector.length,
    signature: buckets.map((bucket) => bucket.toString(16).padStart(2, "0")).join(""),
    buckets,
    fingerprint: vectorFingerprint(vector),
  };
}

/** Builds exact-band probes and, optionally, all one-bit neighboring buckets. */
export function createRagVectorProbes(buckets: readonly number[], probeRadius: 0 | 1 = 1): RagVectorProbe[] {
  if (buckets.length !== RAG_VECTOR_BANDS) throw new Error(`Expected ${RAG_VECTOR_BANDS} vector-index bands.`);
  const probes: RagVectorProbe[] = [];
  buckets.forEach((rawBucket, band) => {
    const bucket = rawBucket & 0xff;
    probes.push({ band, bucket });
    if (probeRadius === 1) {
      for (let bit = 0; bit < RAG_VECTOR_BITS_PER_BAND; bit += 1) probes.push({ band, bucket: bucket ^ (1 << bit) });
    }
  });
  return probes;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return Number.NEGATIVE_INFINITY;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}
