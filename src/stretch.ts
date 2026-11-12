// 음높이를 안 바꾸고 길이만 늘이거나 줄이기 (WSOLA: 겹쳐 붙일 조각을 가장 잘 이어지는 위치에서 골라 겹쳐 더함).
// 말소리·잡음 모두에 무난하다. 길이만 바꾸고, 음높이는 따로(재생 속도·오토튠·보코더) 정한다.

/** x 를 outLen 샘플 길이로 (음높이 유지) */
export function timeStretch(x: Float32Array, outLen: number): Float32Array {
  const inLen = x.length;
  outLen = Math.max(1, Math.round(outLen));
  if (inLen < 64) {
    // 너무 짧으면 그냥 늘려 씀
    const o = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) o[i] = x[Math.min(inLen - 1, Math.floor((i * inLen) / outLen))] ?? 0;
    return o;
  }
  // 조각 길이: 기본 1024(약 23ms), 짧은 소리는 더 작게
  let N = 1024;
  while (N > 128 && N > inLen / 2) N >>= 1;
  const Hs = N / 2; // 출력에서 조각 간격
  const alpha = inLen / outLen; // 입력에서 한 조각마다 나아가는 비율
  const tol = Math.floor(N / 4); // 이어 붙일 위치를 찾는 범위
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const out = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  const at = (i: number) => (i >= 0 && i < inLen ? x[i] : 0);

  let prevPos = 0; // 직전에 쓴 입력 조각의 시작
  for (let k = 0, outPos = 0; outPos < outLen; k++, outPos += Hs) {
    const target = Math.round(k * Hs * alpha); // 원래 시간 흐름대로라면 여기
    let best = target;
    if (k > 0) {
      // 직전 조각의 자연스러운 다음 부분(prevPos + Hs)과 가장 닮은 위치를 target 주변에서 찾음
      const natural = prevPos + Hs;
      let bestScore = -Infinity;
      const L = Math.min(N / 2, 256);
      for (let d = -tol; d <= tol; d += 2) {
        const c = target + d;
        let sc = 0;
        for (let i = 0; i < L; i += 2) sc += at(natural + i) * at(c + i);
        if (sc > bestScore) {
          bestScore = sc;
          best = c;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      out[outPos + i] += at(best + i) * win[i];
      norm[outPos + i] += win[i];
    }
    prevPos = best;
  }
  const o = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) o[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  // 앞뒤 3ms 페이드로 딸깍 소리 방지
  const f = Math.min(Math.floor(outLen / 4), 132);
  for (let i = 0; i < f; i++) {
    o[i] *= i / f;
    o[outLen - 1 - i] *= i / f;
  }
  return o;
}
