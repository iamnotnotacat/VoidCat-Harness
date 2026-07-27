import assert from "node:assert/strict";
import test from "node:test";

const modulePath: string = "../build/voidcat-vector-index.ts";
const {
  RAG_VECTOR_BANDS,
  RAG_VECTOR_BITS_PER_BAND,
  cosineSimilarity,
  createRagVectorProbes,
  createRagVectorSignature,
} = await import(modulePath) as typeof import("../build/voidcat-vector-index");

test("vector signatures are deterministic and versioned", () => {
  const vector = [1, -2, 0.5, 3];
  const first = createRagVectorSignature(vector);
  const second = createRagVectorSignature([...vector]);

  assert.deepEqual(second, first);
  assert.deepEqual(first, {
    version: 1,
    dimensions: 4,
    signature: "77f4abeebee4e0ef",
    buckets: [119, 244, 171, 238, 190, 228, 224, 239],
    fingerprint: "4:de7e1473",
  });
  assert.equal(first.buckets.length, RAG_VECTOR_BANDS);
  assert.equal(first.signature.length, RAG_VECTOR_BANDS * 2);
});

test("vector signatures reject embeddings that cannot be indexed", () => {
  assert.throws(() => createRagVectorSignature([]), /at least one value/i);
  assert.throws(() => createRagVectorSignature([0, 0, 0]), /zero vector/i);
  assert.throws(() => createRagVectorSignature([1, Number.NaN]), /not finite/i);
});

test("vector probes contain exact bands and every one-bit neighbor", () => {
  const buckets = [119, 244, 171, 238, 190, 228, 224, 239];
  const exact = createRagVectorProbes(buckets, 0);
  const neighboring = createRagVectorProbes(buckets, 1);

  assert.deepEqual(exact, buckets.map((bucket, band) => ({ band, bucket })));
  assert.equal(neighboring.length, RAG_VECTOR_BANDS * (RAG_VECTOR_BITS_PER_BAND + 1));
  assert.deepEqual(
    neighboring.filter((probe) => probe.band === 0).map((probe) => probe.bucket),
    [119, 118, 117, 115, 127, 103, 87, 55, 247],
  );
  assert.equal(new Set(neighboring.map((probe) => `${probe.band}:${probe.bucket}`)).size, neighboring.length);
  assert.throws(() => createRagVectorProbes([1, 2], 1), /expected 8 vector-index bands/i);
});

test("cosine similarity ranks aligned, orthogonal, and invalid vectors safely", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 2], [-1, -2]), -1);
  assert.equal(cosineSimilarity([1], [1, 2]), Number.NEGATIVE_INFINITY);
  assert.equal(cosineSimilarity([0, 0], [4, 5]), Number.NEGATIVE_INFINITY);
  assert.equal(cosineSimilarity([1, Number.NaN], [1, 2]), Number.NEGATIVE_INFINITY);
});
