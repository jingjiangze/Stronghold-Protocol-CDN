// The speed-test probe file.
//
// Measuring "which mirror is fastest" needs both halves: how long until the first byte arrives
// (latency) and how fast the rest follows (throughput). A 26-byte robots.txt answers the first
// and tells you nothing about the second.
//
// Range requests would be the obvious way to sample a big file cheaply, but the Pages origin
// rejects the CORS preflight for a Range header (405), so a browser cannot use them. Instead the
// interface carries a small file of a known size that every origin serves: 256 KiB, generated
// deterministically (so it is stable and cacheable), and pseudo-random so no CDN can shrink it
// with compression and flatter its numbers.

export const PROBE_BYTES = 256 * 1024;
export const PROBE_KEY = 'cdn/v1/probe.bin';

/** Deterministic xorshift32 stream — same bytes on every run, incompressible enough to measure. */
export function makeProbeBuffer(bytes = PROBE_BYTES, seed = 0x9e3779b9) {
  const out = Buffer.allocUnsafe(bytes);
  let state = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}
