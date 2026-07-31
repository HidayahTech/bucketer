// Times SigV4 presigning through the exact code path the app uses, so the per-chunk vs
// per-file decision rests on a number rather than an assumption.
//
// TWO THINGS THAT LOOK ALARMING AND ARE NOT:
//
// 1. Presigning performs NO network I/O. It is HMAC arithmetic over the request shape --
//    computing a signature, not sending anything, which is exactly why the app can presign
//    while offline. The `endpoint` below is only a string folded into that arithmetic. The
//    proof is in the measurement itself: it points at port 9, the discard port, with nothing
//    listening, and completes hundreds of presigns without an error. A single real request
//    would fail with a connection refusal.
//
// 2. The credentials are AWS's own published example pair, used verbatim throughout their
//    documentation. They authenticate nothing. They are here because SigV4 needs a
//    well-formed key to derive a signing key from, and the derivation cost -- the thing being
//    measured -- is identical whatever the key happens to be.
//
// This file is bundled at measurement time by run.mjs, served on a throwaway localhost
// server, and never reaches the application bundle or a user.
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function timePresigns({ client, bucket, count }) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await getSignedUrl(client, new GetObjectCommand({
      Bucket: bucket,
      Key: `videos/2024/file-${i}.bin`,
      // Match what a real chunk request carries, since signed query params affect the work.
      ResponseContentDisposition: `attachment; filename="file-${i}.bin"; filename*=UTF-8''file-${i}.bin`,
      ResponseCacheControl: 'no-store',
    }), { expiresIn: 3600 });
    times.push(performance.now() - t0);
  }
  return times;
}

window.__runPresignBench = async ({ endpoint, bucket, warmup = 20, count = 200 }) => {
  const client = new S3Client({
    endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  });

  await timePresigns({ client, bucket, count: warmup });          // warm the signing key cache
  const reused = await timePresigns({ client, bucket, count });

  // A fresh client per call is the pathological case: SigV4 derives a signing key per
  // date/region/service, and a new client cannot reuse a cached one.
  const freshTimes = [];
  for (let i = 0; i < Math.min(count, 50); i++) {
    const c = new S3Client({
      endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    });
    const t0 = performance.now();
    await getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: `k-${i}` }), { expiresIn: 3600 });
    freshTimes.push(performance.now() - t0);
  }

  // Does a burst of signing block the main thread? A frame budget is 16ms; if signing is
  // synchronous-heavy it will show up as a long gap between animation frames.
  let worstFrameGap = 0;
  let last = performance.now();
  let raf = true;
  const tick = () => {
    const now = performance.now();
    worstFrameGap = Math.max(worstFrameGap, now - last);
    last = now;
    if (raf) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await timePresigns({ client, bucket, count: 256 });   // one 2 GiB file at 8 MiB chunks
  raf = false;

  return {
    reused: { median: median(reused), mean: reused.reduce((a, b) => a + b, 0) / reused.length,
              min: Math.min(...reused), max: Math.max(...reused), n: reused.length },
    freshClient: { median: median(freshTimes), n: freshTimes.length },
    burst256: { worstFrameGapMs: worstFrameGap },
  };
};
