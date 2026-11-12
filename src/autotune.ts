// 진짜 오토튠: 말소리 클립의 음높이를 목표 음 하나로 강제로 맞춘다 (길이·타이밍 유지, 포먼트 최대한 유지).
//
// 순서
//   1) 음높이 추적: YIN (1/4 정도로 줄인 신호에서 대충 찾고 → 원래 샘플레이트에서 정밀 보정)
//      + 유성음 판정 + 중앙값 평활 + 옥타브 튐 보정 + 짧은 조각 정리
//   2) TD-PSOLA 재합성: 유성 구간마다 분석 피치마크(성문 펄스 위치)를 찍고,
//      (마크는 직전 마크 주변 파형과 가장 닮은 곳으로 한 주기씩 전파 → 그레인 모양이 고르게 유지됨)
//      합성 쪽은 목표 주기 간격으로 마크를 놓고, 그 시각을 감싸는 두 분석 그레인(펄스 하나 + 꼬리, Hann 창)을
//      시간 비율로 섞어 겹쳐 더한다.
//      → 그레인 안의 포먼트(음색)는 그대로, 반복 간격(음높이)만 바뀐다. 시간축은 그대로.
//   3) 짧은 창 RMS 맞춤으로 원래 크기에 맞추고, 무성음/무음 구간은 원본을 그대로 쓰며 경계는 코사인 크로스페이드.
//
// DOM 타입 없이 Float32Array만 다루므로 브라우저와 Node 양쪽에서 돈다. 외부 의존성 없음.

export interface PitchTrackOptions {
  /** 음높이 탐색 하한 (Hz). 말소리 기본 70 */
  minHz?: number;
  /** 음높이 탐색 상한 (Hz). 말소리 기본 500 */
  maxHz?: number;
  /** YIN 비주기성(0..1) 이 값보다 작으면 유성음. 기본 0.35 (말소리는 노래보다 덜 주기적이라 느슨하게) */
  voicingThreshold?: number;
  /** 클립 최대 프레임 RMS 대비 이만큼(dB) 아래는 무음으로 취급. 기본 40 */
  silenceDb?: number;
  /**
   * 음높이 분석 전에 이 주파수 아래를 깎는다 (Hz, 0 = 끔). 기본 120.
   * 폰 녹음·게임 클립의 바람/손잡이/저음 웅웅거림이 YIN을 망치는 걸 막는다.
   * 기본음이 깎여도 배음 간격으로 주기를 찾으므로 남자 목소리(≈100 Hz)도 문제없다. 출력 음색에는 영향 없음(분석용).
   */
  highpassHz?: number;
  /**
   * 음높이 분석 전에 이 주파수 위를 깎는다 (Hz, 0 = 끔). 기본 max(1500, 3 × maxHz).
   * 2~4 kHz 대역의 숨소리·잡음·압축 잡음이 주기성을 가리는 걸 막는다 (분석용, 출력 음색 영향 없음).
   */
  lowpassHz?: number;
}

export interface AutotuneOptions extends PitchTrackOptions {
  /** 0..1, 1 = 목표 음으로 완전히 평평하게 (하드 튠). 0.5면 원래 억양과 로그 주파수상 중간. 기본 1 */
  strength?: number;
  /** true(기본): 무성음/잡음 프레임은 원본 그대로 통과. false: 무음이 아닌 곳은 전부 음정을 입힌다 (더 로봇스럽고 발음은 뭉개짐) */
  keepUnvoiced?: boolean;
}

export interface PitchTrack {
  /** 프레임 간격 (샘플). 프레임 k의 중심 = k * hop 샘플 */
  hop: number;
  /** 프레임별 기본주파수 (Hz), 0 = 무성음/무음 */
  f0: Float32Array;
  /** 프레임별 YIN 비주기성 (0 = 완전 주기적, 1 = 잡음) */
  aperiodicity: Float32Array;
  /** 프레임별 RMS */
  rms: Float32Array;
}

/** MIDI 노트 번호 → Hz (A4 = 69 = 440 Hz) */
export const midiToHz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
/** Hz → MIDI 노트 번호 (소수 포함) */
export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

// ───────────────────────── 음높이 추적 ─────────────────────────

/** 윈도드-싱크 FIR 저역통과 후 d배 솎아내기 (YIN을 싸게 돌리려고) */
function lowpassDecimate(x: Float32Array, d: number): Float32Array {
  if (d <= 1) return x;
  const half = 4 * d;
  const taps = 2 * half + 1;
  const fc = 0.45 / d; // 원래 샘플레이트 기준 정규화 차단주파수 (cycles/sample)
  const h = new Float32Array(taps);
  let hs = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - half;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    hs += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= hs;
  const n = x.length;
  const m = Math.floor(n / d);
  const y = new Float32Array(m);
  for (let j = 0; j < m; j++) {
    const c = j * d;
    let s = 0;
    const i0 = Math.max(0, c - half);
    const i1 = Math.min(n - 1, c + half);
    for (let i = i0; i <= i1; i++) s += x[i] * h[i - c + half];
    y[j] = s;
  }
  return y;
}

/** RBJ 2차 고역통과 계수 (Butterworth Q) */
function hpCoefs(sampleRate: number, hz: number) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const cw = Math.cos(w);
  const a0 = 1 + al;
  return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
}

/** 2차 고역통과를 정방향(+역방향)으로 적용. zeroPhase면 앞뒤로 한 번씩 → 위상 지연 없는 4차 */
function highpass(x: Float32Array, sampleRate: number, hz: number, zeroPhase: boolean): Float32Array {
  if (!(hz > 0) || hz >= sampleRate / 2) return x;
  const { b0, b1, b2, a1, a2 } = hpCoefs(sampleRate, hz);
  const y = new Float32Array(x.length);
  const pass = (src: Float32Array, dst: Float32Array, rev: boolean) => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const n = src.length;
    for (let j = 0; j < n; j++) {
      const i = rev ? n - 1 - j : j;
      const v = src[i];
      const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1, x1 = v, y2 = y1, y1 = o;
      dst[i] = o;
    }
  };
  pass(x, y, false);
  pass(y, y, zeroPhase); // zeroPhase가 아니면 정방향 두 번 (4차)
  return y;
}

/** 앞뒤로 zero padding 한 복사본 (경계 검사 없이 읽으려고) */
function padded(x: Float32Array, pad: number): Float32Array {
  const p = new Float32Array(x.length + 2 * pad);
  p.set(x, pad);
  return p;
}

/** 프레임 길이(길이 n 신호, 중심 k*hop)의 개수 */
const frameCount = (n: number, hop: number) => (n <= 0 ? 0 : Math.floor((n - 1) / hop) + 1);

/**
 * 음높이 궤적 추출 (YIN). 프레임 k의 중심은 k*hop 샘플, hop ≈ 5 ms.
 * f0[k] = 0 이면 무성음/무음.
 */
export function detectPitchTrack(input: Float32Array, sampleRate: number, opts: PitchTrackOptions = {}): PitchTrack {
  const minHz = opts.minHz ?? 70;
  const maxHz = opts.maxHz ?? 500;
  const lpHz = opts.lowpassHz ?? Math.max(1500, 3 * maxHz);
  let data = highpass(input, sampleRate, opts.highpassHz ?? 120, false);
  if (lpHz > 0 && lpHz < sampleRate / 2) data = zeroPhaseLowpass(data, sampleRate, lpHz);
  const vThr = opts.voicingThreshold ?? 0.35;
  const silenceDb = opts.silenceDb ?? 40;

  // 줄인 샘플레이트가 대략 11 kHz 이상, 그리고 maxHz 한 주기가 최소 8샘플은 되게
  const d = Math.max(1, Math.min(Math.floor(sampleRate / 11000), Math.floor(sampleRate / (8 * maxHz))));
  const hop = d * Math.max(1, Math.round((sampleRate * 0.005) / d));
  const n = data.length;
  const K = frameCount(n, hop);
  const f0 = new Float32Array(K);
  const aper = new Float32Array(K).fill(1);
  const rms = new Float32Array(K);
  if (K === 0) return { hop, f0, aperiodicity: aper, rms };

  const fs = sampleRate / d;
  const y = lowpassDecimate(data, d);
  const tauMin = Math.max(2, Math.floor(fs / maxHz));
  const tauMax = Math.max(tauMin + 2, Math.ceil(fs / minHz));
  const W = Math.max(tauMax, Math.round(fs * 0.02)); // YIN 적분 창
  const padD = W + tauMax + 4;
  const yp = padded(y, padD);
  const Wf = W * d; // 원래 샘플레이트에서의 창
  const padF = Wf + (tauMax + 2) * d + 4;
  const xp = padded(data, padF);

  const diff = new Float64Array(tauMax + 2);
  const cmnd = new Float64Array(tauMax + 2);

  // RMS (원래 샘플레이트, 중심 ±Wf/2)
  for (let k = 0; k < K; k++) {
    const c = k * hop + padF;
    let s = 0;
    const h = Wf >> 1;
    for (let i = c - h; i < c + h; i++) s += xp[i] * xp[i];
    rms[k] = Math.sqrt(s / (2 * h));
  }
  let maxRms = 0;
  for (let k = 0; k < K; k++) if (rms[k] > maxRms) maxRms = rms[k];
  const gate = Math.max(1e-4, maxRms * Math.pow(10, -silenceDb / 20));

  for (let k = 0; k < K; k++) {
    if (rms[k] < gate) continue;
    // ── 줄인 신호에서 YIN ──
    const cd = (k * hop) / d + padD;
    const s0 = cd - ((W + tauMax) >> 1);
    let run = 0;
    cmnd[0] = 1;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = yp[s0 + j] - yp[s0 + j + tau];
        s += v * v;
      }
      diff[tau] = s;
      run += s;
      cmnd[tau] = run > 0 ? (s * tau) / run : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < 0.15) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = Infinity;
      for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < best) (best = cmnd[t]), (tau = t);
    }
    aper[k] = cmnd[tau];
    if (cmnd[tau] >= vThr) continue;
    // 포물선 보간
    let tauR = tau;
    {
      const a = diff[tau - 1], b = diff[tau], c = diff[tau + 1];
      const den = a - 2 * b + c;
      if (den > 0) tauR = tau + Math.max(-1, Math.min(1, (0.5 * (a - c)) / den));
    }
    // ── 원래 샘플레이트에서 ±d 범위 정밀 보정 ──
    let T = tauR * d;
    if (d > 1) {
      const t0 = Math.max(2, Math.floor(T - d - 1));
      const t1 = Math.ceil(T + d + 1);
      const sf = k * hop + padF - ((Wf + t1) >> 1);
      let bestT = -1, best = Infinity;
      const dv = new Float64Array(t1 - t0 + 1);
      for (let t = t0; t <= t1; t++) {
        let s = 0;
        for (let j = 0; j < Wf; j++) {
          const v = xp[sf + j] - xp[sf + j + t];
          s += v * v;
        }
        dv[t - t0] = s;
        if (s < best) (best = s), (bestT = t);
      }
      if (bestT > t0 && bestT < t1) {
        const a = dv[bestT - 1 - t0], b = dv[bestT - t0], c = dv[bestT + 1 - t0];
        const den = a - 2 * b + c;
        T = den > 0 ? bestT + Math.max(-1, Math.min(1, (0.5 * (a - c)) / den)) : bestT;
      }
    }
    const hz = sampleRate / T;
    if (hz >= minHz * 0.97 && hz <= maxHz * 1.03) f0[k] = hz;
  }

  cleanTrack(f0, Math.max(3, Math.round((0.015 * sampleRate) / hop)));
  return { hop, f0, aperiodicity: aper, rms };
}

/** 중앙값 평활 + 옥타브 튐 보정 + 짧은 유성 조각 제거 (제자리 수정) */
function cleanTrack(f0: Float32Array, minRun: number) {
  const K = f0.length;
  // 1) 유성 구간별 중앙값 기준 옥타브 보정
  forEachRun(f0, (a, b) => {
    const vals = Array.from(f0.subarray(a, b)).sort((p, q) => p - q);
    const med = vals[vals.length >> 1];
    for (let k = a; k < b; k++) {
      let v = f0[k];
      while (v > med * 1.6) v /= 2;
      while (v < med / 1.6) v *= 2;
      f0[k] = v;
    }
  });
  // 2) 유성 이웃끼리 5탭 중앙값
  const src = f0.slice();
  const buf: number[] = [];
  for (let k = 0; k < K; k++) {
    if (src[k] <= 0) continue;
    buf.length = 0;
    for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < K && src[j] > 0) buf.push(src[j]);
    buf.sort((p, q) => p - q);
    f0[k] = buf[buf.length >> 1];
  }
  // 3) 너무 짧은 유성 조각 제거
  forEachRun(f0, (a, b) => {
    if (b - a < minRun) f0.fill(0, a, b);
  });
}

/** f0 > 0 인 연속 구간 [a, b) 마다 호출 */
function forEachRun(f0: Float32Array, fn: (a: number, b: number) => void) {
  const K = f0.length;
  let k = 0;
  while (k < K) {
    if (f0[k] <= 0) {
      k++;
      continue;
    }
    let e = k;
    while (e < K && f0[e] > 0) e++;
    fn(k, e);
    k = e;
  }
}

// ───────────────────────── 재합성 (TD-PSOLA) ─────────────────────────

/** 앞뒤 1차 IIR 저역통과 (위상 지연 없음) — 피치마크를 성문 펄스에 맞추는 용도 */
function zeroPhaseLowpass(x: Float32Array, sampleRate: number, hz: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * hz) / sampleRate);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) y[i] = s = (1 - a) * x[i] + a * s;
  s = 0;
  for (let i = x.length - 1; i >= 0; i--) y[i] = s = (1 - a) * y[i] + a * s;
  // 2번 더 (2차 → 4차 정도로 가파르게)
  s = 0;
  for (let i = 0; i < x.length; i++) y[i] = s = (1 - a) * y[i] + a * s;
  s = 0;
  for (let i = x.length - 1; i >= 0; i--) y[i] = s = (1 - a) * y[i] + a * s;
  return y;
}

/** 한 클립을 분석해 둔 상태. 같은 클립을 여러 음으로 만들 때 분석(음높이·피치마크)을 한 번만 한다. */
export interface Autotuner {
  /** 분석된 음높이 궤적 (평활 후, 틈 메우기 전) */
  track: PitchTrack;
  /** 음정을 입히는(PSOLA 처리되는) 프레임 비율 0..1 — 너무 낮으면 이 클립은 오토튠해도 거의 그대로다 */
  voicedFraction: number;
  /** 유성 프레임의 원래 음높이 중앙값 (Hz, 유성이 없으면 0) */
  medianHz: number;
  /** targetHz로 맞춘 새 버퍼 (입력과 같은 길이, [-1, 1]). strength 생략 시 준비할 때 준 옵션 값(기본 1) */
  render(targetHz: number, strength?: number): Float32Array;
}

interface Segment {
  segA: number; // PSOLA 결과를 온전히 쓰는 샘플 범위 [segA, segB)
  segB: number;
  synA: number; // 합성 마크를 놓는 범위 (경계 크로스페이드 여유 포함)
  synB: number;
  am: number[]; // 분석 피치마크 (샘플)
  aP: number[]; // 마크별 원래 주기 (샘플)
  f0At: (pos: number) => number; // 샘플 위치 → 원래 f0
}

/**
 * 클립 분석: 음높이 궤적, 유성 구간, 분석 피치마크, 크로스페이드 마스크를 미리 계산한다.
 * 1 s @ 44.1 kHz 기준 대략 10~15 ms, render 1회는 5~15 ms (Node, M 시리즈 기준).
 */
export function prepareAutotune(data: Float32Array, sampleRate: number, opts: AutotuneOptions = {}): Autotuner {
  const n = data.length;
  const keepUnvoiced = opts.keepUnvoiced ?? true;
  const defaultStrength = opts.strength ?? 1;

  const tr = detectPitchTrack(data, sampleRate, opts);
  const { hop } = tr;
  const K = tr.f0.length;
  const f0 = tr.f0.slice();
  let medianHz = 0;
  {
    const v = Array.from(f0).filter((x) => x > 0).sort((a, b) => a - b);
    if (v.length) medianHz = v[v.length >> 1];
  }
  // 소리가 나는 프레임 (최대 RMS 대비 -40 dB 위) — keepUnvoiced=false일 때 어디까지 음정을 입힐지
  let maxRms = 0;
  for (let k = 0; k < K; k++) if (tr.rms[k] > maxRms) maxRms = tr.rms[k];
  const audible = (k: number) => tr.rms[k] >= Math.max(1e-4, maxRms * 0.01);
  const allAudible = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (!audible(k)) return false;
    return true;
  };

  // 짧은 무성 틈(≤ 20 ms)은 앞뒤 보간으로 메움 — 유성 구간이 잘게 끊기면 경계 크로스페이드가 많아져 지저분하다
  const maxGap = keepUnvoiced ? Math.round((0.02 * sampleRate) / hop) : K;
  {
    let k = 0;
    while (k < K && f0[k] <= 0) k++;
    while (k < K) {
      let e = k + 1;
      while (e < K && f0[e] > 0) e++;
      if (e >= K) break;
      let g = e;
      while (g < K && f0[g] <= 0) g++;
      if (g >= K) break;
      if (g - e <= maxGap && (keepUnvoiced || allAudible(e, g))) {
        const a = Math.log(f0[e - 1]), b = Math.log(f0[g]);
        for (let j = e; j < g; j++) f0[j] = Math.exp(a + ((b - a) * (j - e + 1)) / (g - e + 1));
      }
      k = g;
    }
  }
  if (!keepUnvoiced) {
    // 앞/뒤 끝의 소리 나는 무성 구간도 가장 가까운 유성 값으로 채움
    let first = -1, last = -1;
    for (let k = 0; k < K; k++) if (f0[k] > 0) (first < 0 && (first = k), (last = k));
    if (first >= 0) {
      for (let k = first - 1; k >= 0 && audible(k); k--) f0[k] = f0[first];
      for (let k = last + 1; k < K && audible(k); k++) f0[k] = f0[last];
    }
  }
  let voicedFrames = 0;
  for (let k = 0; k < K; k++) if (f0[k] > 0) voicedFrames++;

  const mask = new Float32Array(n); // 1 = PSOLA 결과 사용, 0 = 원본
  // 피치마크용: 저음 웅웅거림을 깎고(분석과 같은 고역통과) 900 Hz 위를 깎아 성문 펄스 봉우리만 남김
  const lp = zeroPhaseLowpass(highpass(data, sampleRate, opts.highpassHz ?? 120, true), sampleRate, 900);
  const lpPad = Math.ceil((1.5 * sampleRate) / (opts.minHz ?? 70)) + 4;
  const lpP = padded(lp, lpPad);
  const R = Math.max(4, Math.round(sampleRate * 0.005)); // 경계 크로스페이드 ±5 ms
  const segs: Segment[] = [];

  forEachRun(f0, (ks, ke) => {
    // 이 구간의 표본 범위 (프레임 k는 k*hop ± hop/2를 대표)
    const segA = Math.max(0, Math.round(ks * hop - hop / 2));
    const segB = Math.min(n, Math.round((ke - 1) * hop + hop / 2));
    if (segB - segA < 4) return;
    // 샘플 위치 → 원래 f0 (프레임 사이 선형 보간, 구간 밖은 끝값 유지)
    const f0At = (pos: number) => {
      const fk = pos / hop;
      if (fk <= ks) return f0[ks];
      if (fk >= ke - 1) return f0[ke - 1];
      const i = Math.floor(fk), t = fk - i;
      return f0[i] * (1 - t) + f0[i + 1] * t;
    };
    const periodAt = (pos: number) => sampleRate / f0At(pos);

    const synA = Math.max(0, segA - R);
    const synB = Math.min(n - 1, segB + R);
    let pMax = 0;
    for (let k = ks; k < ke; k++) pMax = Math.max(pMax, sampleRate / f0[k]);
    const anA = Math.max(0, synA - Math.ceil(pMax));
    const anB = Math.min(n - 1, synB + Math.ceil(pMax));

    // ── 분석 피치마크: 가장 센 프레임 근처의 저역 최댓값에서 시작해 앞뒤로 한 주기씩 전파 ──
    let kBest = ks;
    for (let k = ks; k < ke; k++) if (tr.rms[k] > tr.rms[kBest]) kBest = k;
    const c0 = Math.min(anB, Math.max(anA, kBest * hop));
    const P0 = periodAt(c0);
    const anchor = argmax(lp, Math.max(anA, Math.round(c0 - P0 / 2)), Math.min(anB, Math.round(c0 + P0 / 2)));
    // 다음 마크: 예상 위치(±20%) 중 직전 마크 주변 파형(한 주기 길이)과 가장 닮은 곳 (정규화 상호상관).
    // 봉우리만 쫓으면 거친 목소리에서 마크가 펄스마다 다른 지점에 붙어 그레인 모양이 들쭉날쭉 → 출력에 서브하모닉/거칠음이 생긴다.
    const nextMark = (m: number, dir: 1 | -1) => {
      const P = periodAt(m);
      const pred = m + dir * P;
      const lo = Math.max(anA, Math.round(pred - 0.2 * P));
      const hi = Math.min(anB, Math.round(pred + 0.2 * P));
      if (hi < lo) return Math.round(pred);
      const h = Math.max(4, Math.round(P / 2));
      const o = lpPad + m;
      let e0 = 0;
      for (let j = -h; j < h; j++) e0 += lpP[o + j] * lpP[o + j];
      let best = lo, bestS = -Infinity;
      for (let c = lo; c <= hi; c++) {
        const q = lpPad + c;
        let s = 0, e1 = 0;
        for (let j = -h; j < h; j++) {
          const v = lpP[q + j];
          s += lpP[o + j] * v;
          e1 += v * v;
        }
        const sc = s / Math.sqrt(e0 * e1 + 1e-20);
        if (sc > bestS) (bestS = sc), (best = c);
      }
      return best;
    };
    const fwd: number[] = [anchor];
    for (let m = anchor; m + periodAt(m) <= anB; ) fwd.push((m = nextMark(m, 1)));
    const back: number[] = [];
    for (let m = anchor; m - periodAt(m) >= anA; ) back.push((m = nextMark(m, -1)));
    const am = back.reverse().concat(fwd);
    segs.push({ segA, segB, synA, synB, am, aP: am.map(periodAt), f0At });

    // ── 마스크 (구간 경계 ±R 에서 코사인 램프, 클립 맨 끝에 닿은 쪽은 램프 없음) ──
    const fade = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));
    for (let i = synA; i <= synB; i++) {
      const wIn = segA === 0 ? 1 : fade((i - (segA - R)) / (2 * R));
      const wOut = segB === n ? 1 : fade((segB + R - 1 - i) / (2 * R));
      const w = Math.min(wIn, wOut);
      if (w > mask[i]) mask[i] = w;
    }
  });

  // 원본 에너지 누적합 (크기 맞춤용)
  const cx = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cx[i + 1] = cx[i] + data[i] * data[i];

  const render = (targetHz: number, strengthArg?: number): Float32Array => {
    const out = new Float32Array(data);
    if (!segs.length || !(targetHz > 0) || !Number.isFinite(targetHz)) return clampInPlace(out);
    const strength = Math.max(0, Math.min(1, strengthArg ?? defaultStrength));
    const fMin = 40, fMax = Math.min(2000, sampleRate / 6);
    const y = new Float32Array(n); // PSOLA 결과 (유성 구간 + 가장자리 여유분)

    const addGrain = (a: number, t: number, L: number, gain: number) => {
      const n0 = Math.max(0, Math.ceil(t - L));
      const n1 = Math.min(n - 1, Math.floor(t + L));
      const inv = Math.PI / L;
      for (let i = n0; i <= n1; i++) {
        const off = i - t;
        const p = a + off;
        const pi = Math.floor(p);
        if (pi < 0 || pi + 1 >= n) continue;
        const fr = p - pi;
        y[i] += gain * (0.5 + 0.5 * Math.cos(off * inv)) * (data[pi] * (1 - fr) + data[pi + 1] * fr);
      }
    };

    for (const { synA, synB, am, aP, f0At } of segs) {
      const targetAt = (pos: number) => {
        const fo = f0At(pos);
        const f = strength >= 1 ? targetHz : Math.exp(Math.log(fo) + strength * (Math.log(targetHz) - Math.log(fo)));
        return Math.max(fMin, Math.min(fMax, f));
      };
      // ── 합성: 목표 주기 간격으로 마크를 놓고, 그 시각을 감싸는 두 분석 그레인을 시간 비율로 섞어 겹쳐 더함 ──
      // (가장 가까운 것 하나만 쓰면 그레인이 툭툭 바뀌어 크게 내릴 때 서브하모닉·거칠음이 생긴다)
      let ai = 0;
      for (let t = synA; t <= synB; ) {
        const Ts = sampleRate / targetAt(t);
        while (ai + 1 < am.length && am[ai + 1] <= t) ai++;
        const j = Math.min(am.length - 1, ai + 1);
        const alpha = j === ai || t <= am[ai] ? 0 : Math.min(1, (t - am[ai]) / (am[j] - am[ai]));
        // 그레인 반길이: 기본은 분석 주기 1개 (펄스 하나 + 감쇠 꼬리).
        // 올릴 때는 그레인이 원래 주기보다 길면 원래 배음 구조가 비쳐 두 음이 섞여 들리므로 합성 주기(Ts)까지 줄이되,
        // 포먼트가 뭉개지지 않게 원래 주기의 0.35배 아래로는 안 줄인다.
        const Ta = aP[ai] * (1 - alpha) + aP[j] * alpha;
        const L = Math.max(2, Math.min(Ta, Math.max(Ts, 0.35 * Ta)));
        if (alpha < 1) addGrain(am[ai], t, L, 1 - alpha);
        if (alpha > 0) addGrain(am[j], t, L, alpha);
        t += Ts;
      }
    }

    // ── 크기 맞춤: 원본과 PSOLA 결과의 단구간 에너지(30 ms 박스)를 비교해 이득 적용 후 마스크로 섞음 ──
    const hb = Math.max(8, Math.round(sampleRate * 0.015));
    const cy = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cy[i + 1] = cy[i] + y[i] * y[i];
    for (let i = 0; i < n; i++) {
      const m = mask[i];
      if (m <= 0) continue;
      const a = Math.max(0, i - hb), b = Math.min(n, i + hb);
      const ex = cx[b] - cx[a], ey = cy[b] - cy[a];
      const g = ey > 1e-12 ? Math.min(4, Math.sqrt(ex / ey)) : 0;
      out[i] = m * y[i] * g + (1 - m) * data[i];
    }
    // ── 피크 제한: 크게 내리면 펄스가 뾰족해져(RMS는 같아도 피크가 큼) 잘릴 수 있으니,
    //    5 ms 블록마다 피크를 0.98 아래로 누르는 이득을 블록 사이 선형 보간해 처리된 부분에만 적용 ──
    const B = Math.max(16, Math.round(sampleRate * 0.005));
    const nb = Math.ceil(n / B);
    const bg = new Float32Array(nb).fill(1);
    for (let b = 0; b < nb; b++) {
      let pk = 0;
      for (let i = b * B, e = Math.min(n, i + B); i < e; i++) if (mask[i] > 0) pk = Math.max(pk, Math.abs(out[i]));
      if (pk > 0.98) bg[b] = 0.98 / pk;
    }
    // 이웃 블록 최솟값 (보간 중에 피크 블록 이득이 덜 먹히지 않게)
    const bgm = bg.map((_, b) => Math.min(bg[b], bg[Math.max(0, b - 1)], bg[Math.min(nb - 1, b + 1)]));
    for (let i = 0; i < n; i++) {
      const m = mask[i];
      if (m <= 0) continue;
      const fb = i / B - 0.5;
      const b0 = Math.max(0, Math.min(nb - 1, Math.floor(fb)));
      const b1 = Math.min(nb - 1, b0 + 1);
      const u = Math.max(0, Math.min(1, fb - b0));
      const g = bgm[b0] * (1 - u) + bgm[b1] * u;
      if (g < 1) out[i] *= 1 - m * (1 - g);
    }
    return clampInPlace(out);
  };

  return { track: tr, voicedFraction: K ? voicedFrames / K : 0, medianHz, render };
}

/**
 * 오토튠 (한 번만 쓸 때): data의 음높이를 targetHz 하나로 맞춘 새 버퍼를 돌려준다 (길이 동일, [-1, 1]로 자름).
 * 같은 클립을 여러 음으로 만들 거면 prepareAutotune(...).render(hz)를 쓰는 게 빠르다.
 *
 * 쓸 만한 범위: 원래 음 대비 약 0.5배(한 옥타브 아래) ~ 3배(한 옥타브 반 위)가 자연스럽다.
 * 그 밖(±2옥타브)도 터지지 않고 음정도 맞지만, 위로는 가늘고 버즈 같은 소리, 아래로는 툭툭 끊기는 펄스 느낌이 난다.
 * 실제로 쓰이는 목표 주파수는 40 Hz ~ min(2000 Hz, sampleRate/6)로 제한된다.
 */
export function autotune(data: Float32Array, sampleRate: number, targetHz: number, opts: AutotuneOptions = {}): Float32Array {
  return prepareAutotune(data, sampleRate, opts).render(targetHz);
}

function argmax(x: Float32Array, lo: number, hi: number) {
  let bi = lo, bv = -Infinity;
  for (let i = lo; i <= hi; i++) if (x[i] > bv) (bv = x[i]), (bi = i);
  return bi;
}

function clampInPlace(x: Float32Array) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    x[i] = v > 1 ? 1 : v < -1 ? -1 : v !== v ? 0 : v;
  }
  return x;
}
