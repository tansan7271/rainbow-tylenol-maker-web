// 노트 → WebAudio 스케줄링. 실시간 재생과 오프라인 렌더(내보내기)가 같은 코드를 쓴다.
import { prepareAutotune, type Autotuner } from './autotune';
import { timeStretch } from './stretch';
import { fitAt, fitClipTime, partShotAt, shotFits } from './shotfit';
import type { SlotAssets } from './media';
import { beatToSec, pitchRate, spb, type Note, type Slot, type Template } from './types';


const tuneMul = (tpl: Template) => Math.pow(2, (tpl.tuning ?? 0) / 1200);

/** 깨끗한 음정 확인용 '삑' 소리 (A4=440Hz, 살짝 감쇠하는 사각파 비슷한 톤) */
export function makeBeep(ctx: BaseAudioContext): Override {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 1.2);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let v = 0;
    for (let h = 1; h <= 7; h += 2) v += Math.sin(2 * Math.PI * 440 * h * t) / h;
    d[i] = v * 0.45 * Math.min(1, t / 0.004) * Math.exp(-t * 2.2);
  }
  return { buffer: buf, basePitch: 69 };
}

/** 테스트 모드: 모든 노트를 이 소리 하나로 연주 */
export interface Override {
  buffer: AudioBuffer;
  basePitch: number;
}
export interface Mix {
  muted: Set<string>; // 음소거 슬롯 id
  solo: string | null;
  override: Override | null;
}
export interface Buses {
  song: GainNode; // 원곡
  synth: GainNode; // 합성(슬롯) 소리
  preview: GainNode; // 슬롯 미리듣기 (볼륨/끄기 영향 안 받음)
}

/** 원곡/합성 각각의 볼륨 버스 → 컴프레서 → 출력 */
export function createBuses(ctx: BaseAudioContext, songGain: number, synthGain: number): Buses {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 6;
  comp.ratio.value = 8;
  comp.attack.value = 0.003;
  comp.release.value = 0.1;
  const out = ctx.createGain();
  out.gain.value = 0.7;
  comp.connect(out).connect(ctx.destination);
  const song = ctx.createGain();
  const synth = ctx.createGain();
  song.gain.value = songGain;
  synth.gain.value = synthGain;
  const preview = ctx.createGain();
  song.connect(comp);
  synth.connect(comp);
  preview.connect(comp);
  return { song, synth, preview };
}

/** 음정 입히기 체인: 노트 소리를 input 으로 받고, setPitch 로 그 순간 음높이를 정함. 슬롯마다 하나 (단음) */
interface PitchFx {
  input: AudioNode;
  setPitch(hz: number, when: number): void;
}
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** 진짜 오토튠: 클립 하나를 분석해 두고(음높이 추적), 노트 음높이마다 그 음으로 편 버퍼를 만들어 캐시. 길이·타이밍은 그대로라 속도 1로 틂 */
const tuners = new WeakMap<AudioBuffer, { tuner: Autotuner; out: Map<string, AudioBuffer> }>();
function tunedBuffer(buf: AudioBuffer, hz: number, strength: number): AudioBuffer {
  let e = tuners.get(buf);
  if (!e) {
    // 여러 채널이면 섞어서 분석·합성 (클립 소리는 원래 모노로 받음)
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    e = { tuner: prepareAutotune(mono, buf.sampleRate), out: new Map() };
    tuners.set(buf, e);
  }
  const key = `${hz.toFixed(2)}|${strength}`;
  let o = e.out.get(key);
  if (!o) {
    const data = e.tuner.render(hz, strength);
    o = new AudioBuffer({ length: data.length, sampleRate: buf.sampleRate, numberOfChannels: 1 });
    o.getChannelData(0).set(data);
    e.out.set(key, o);
  }
  return o;
}

/** 클립의 [o1, o2]초 조각을 음높이는 그대로 두고 outSamples 길이로 늘이거나 줄인 버퍼 (오토튠이면 그다음 그 음으로 폄). 노트마다 캐시 */
const stretchCache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>();
function stretchedPiece(raw: AudioBuffer, o1: number, o2: number, outSamples: number, tune: { hz: number; strength: number } | null) {
  let m = stretchCache.get(raw);
  if (!m) stretchCache.set(raw, (m = new Map()));
  const key = `${o1.toFixed(4)}|${o2.toFixed(4)}|${Math.round(outSamples)}|${tune ? tune.hz.toFixed(2) + '|' + tune.strength : ''}`;
  let b = m.get(key);
  if (!b) {
    const sr = raw.sampleRate;
    const a = Math.max(0, Math.floor(o1 * sr));
    const e = Math.min(raw.length, Math.max(a + 1, Math.ceil(o2 * sr)));
    const seg = new Float32Array(e - a);
    for (let c = 0; c < raw.numberOfChannels; c++) {
      const d = raw.getChannelData(c);
      for (let i = 0; i < seg.length; i++) seg[i] += d[a + i] / raw.numberOfChannels;
    }
    let y = timeStretch(seg, outSamples);
    if (tune) y = prepareAutotune(y, sr).render(tune.hz, tune.strength) as Float32Array<ArrayBuffer>;
    b = new AudioBuffer({ length: y.length, sampleRate: sr, numberOfChannels: 1 });
    b.getChannelData(0).set(y);
    m.set(key, b);
  }
  return b;
}

/** 리버브 잔향: 2.4초 동안 지수로 줄어드는 잡음 (스테레오, 앞부분 살짝 늦게 시작해 공간감). 컨텍스트마다 하나 */
const irCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function reverbIR(ctx: BaseAudioContext) {
  let ir = irCache.get(ctx);
  if (!ir) {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2.4);
    ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const pre = Math.min(1, t / 0.02); // 20ms 에 걸쳐 들어옴
        d[i] = (Math.random() * 2 - 1) * pre * Math.exp(-t / 0.55);
      }
    }
    irCache.set(ctx, ir);
  }
  return ir;
}

/** 보코더: 말소리의 대역별 크기(발음·리듬)로, 노트 음높이 톱니파(+약간의 잡음)를 깎아 냄 → 로봇이 노래하는 소리 */
function makeVocoder(ctx: BaseAudioContext, out: AudioNode, amount: number, startAt: number, stopAt: number, nodes: AudioScheduledSourceNode[]): PitchFx {
  const input = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 10 * amount; // 대역 통과·정류로 작아진 크기 보정
  const dry = ctx.createGain();
  dry.gain.value = 1 - amount;
  input.connect(dry).connect(out);
  wet.connect(out);
  // 반송파: 톱니파 + 자음용 잡음
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const carrier = ctx.createGain();
  const ng = ctx.createGain();
  ng.gain.value = 0.12;
  osc.connect(carrier);
  noise.connect(ng).connect(carrier);
  // 정류(절댓값) 곡선
  const abs = new Float32Array(1024);
  for (let i = 0; i < abs.length; i++) abs[i] = Math.abs((i / (abs.length - 1)) * 2 - 1);
  const BANDS = 18;
  for (let b = 0; b < BANDS; b++) {
    const fc = 120 * Math.pow(7000 / 120, b / (BANDS - 1));
    const q = 6;
    const mb = ctx.createBiquadFilter();
    mb.type = 'bandpass';
    mb.frequency.value = fc;
    mb.Q.value = q;
    const rect = ctx.createWaveShaper();
    rect.curve = abs;
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = 35;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 35;
    const vca = ctx.createGain();
    vca.gain.value = 0;
    input.connect(mb).connect(rect).connect(lp1).connect(lp2).connect(vca.gain);
    const cb = ctx.createBiquadFilter();
    cb.type = 'bandpass';
    cb.frequency.value = fc;
    cb.Q.value = q;
    carrier.connect(cb).connect(vca).connect(wet);
  }
  osc.start(startAt);
  noise.start(startAt);
  osc.stop(stopAt);
  noise.stop(stopAt);
  nodes.push(osc, noise);
  return { input, setPitch: (hz, when) => osc.frequency.setValueAtTime(hz, when) };
}

/** 공명: 말소리를 노트 음높이와 그 배음에 맞춘 좁은 대역 필터들에 통과 → 목소리 위로 그 음이 웅~ 하고 울림.
 *  (피드백 딜레이 빗살 필터는 Web Audio 에서 짧은 딜레이가 128샘플 아래로 안 내려가 높은 음을 못 내서 필터 방식으로) */
function makeResonance(ctx: BaseAudioContext, out: AudioNode, amount: number): PitchFx {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1 - 0.7 * amount;
  input.connect(dry).connect(out);
  const wet = ctx.createGain();
  wet.gain.value = 16 * amount; // 좁은 대역이라 작아진 크기 보정
  wet.connect(out);
  // 필터는 있는 소리만 키울 수 있어서, 먼저 세게 찌그러뜨려(배음을 촘촘히 만들어) 어떤 음이든 울릴 거리를 만듦
  const drive = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 12);
  drive.curve = curve;
  const pre = ctx.createGain();
  pre.gain.value = 0.25;
  input.connect(drive).connect(pre);
  const HARM = 6;
  const filters: BiquadFilterNode[] = [];
  for (let h = 1; h <= HARM; h++) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 20 + 30 * amount; // 셀수록 좁고 오래 울림
    const g = ctx.createGain();
    g.gain.value = 1 / h;
    pre.connect(bp).connect(g).connect(wet);
    filters.push(bp);
  }
  return {
    input,
    setPitch: (hz, when) => filters.forEach((f, i) => f.frequency.setValueAtTime(Math.min(ctx.sampleRate / 2 - 100, hz * (i + 1)), when)),
  };
}

/** fromBeat 부터 재생되도록 ctx 시간 startAt 기준으로 모든 소리를 예약. 정지용 노드 목록 반환 */
export function scheduleAll(
  ctx: BaseAudioContext, buses: Buses, tpl: Template, assets: Map<string, SlotAssets>,
  song: AudioBuffer | null, fromBeat: number, startAt: number, mix: Mix,
): AudioScheduledSourceNode[] {
  const nodes: AudioScheduledSourceNode[] = [];
  const t0 = beatToSec(tpl, fromBeat);
  const tEnd = beatToSec(tpl, tpl.range.end);
  const at = (b: number) => startAt + beatToSec(tpl, b) - t0;

  if (song) {
    const src = ctx.createBufferSource();
    src.buffer = song;
    const g = ctx.createGain();
    const fadeIn = fromBeat <= tpl.range.start + 0.01;
    g.gain.setValueAtTime(fadeIn ? 0 : 1, startAt);
    if (fadeIn) g.gain.linearRampToValueAtTime(1, startAt + 0.03);
    g.gain.setValueAtTime(1, Math.max(startAt, startAt + tEnd - t0 - 0.05));
    g.gain.linearRampToValueAtTime(0, startAt + tEnd - t0);
    src.connect(g).connect(buses.song);
    src.start(startAt, Math.max(0, t0));
    src.stop(startAt + tEnd - t0 + 0.01);
    nodes.push(src);
  }

  const slotMap = new Map(tpl.slots.map((s) => [s.id, s]));
  const tuneBase = tuneOffsets(tpl);
  const fits = shotFits(tpl);
  // 음정 입히기 체인 (슬롯마다 처음 쓸 때 만듦)
  const fxs = new Map<string, PitchFx>();
  const stopAt = startAt + tEnd - t0 + 0.05;
  // 이 박에서 이 슬롯의 음정 입히기: 뒤쪽 루프(tpl.loopSplit 부터)에 따로 정한 게 있으면 그것
  const fxOf = (s: Slot, beat: number) => {
    const second = tpl.loopSplit != null && beat >= tpl.loopSplit - 1e-6 && s.pitchFx2 != null;
    const kind = (second ? s.pitchFx2 : s.pitchFx) ?? 'none';
    const amount = (second ? s.pitchFxAmount2 : s.pitchFxAmount) ?? (kind === 'vocoder' ? 0.9 : kind === 'resonance' ? 0.6 : 1);
    return { kind, amount: Math.max(0, Math.min(1, amount)) };
  };
  // 슬롯 출력: 공간감(리버브)·부드럽게(고음 줄이기)가 있으면 그 체인을 거쳐서 합성 버스로. 슬롯마다 하나
  const outs = new Map<string, AudioNode>();
  const outFor = (s: Slot): AudioNode => {
    const rv = Math.max(0, Math.min(1, s.reverb ?? 0));
    const soft = Math.max(0, Math.min(1, s.soften ?? 0));
    if (!rv && !soft) return buses.synth;
    if (!outs.has(s.id)) {
      const input = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 18000 * Math.pow(2200 / 18000, soft); // 부드럽게 1 = 2.2kHz 위를 깎음
      lp.Q.value = 0.5;
      input.connect(lp);
      const dry = ctx.createGain();
      dry.gain.value = 1 - 0.55 * rv; // 리버브가 셀수록 원래 소리는 뒤로
      lp.connect(dry).connect(buses.synth);
      if (rv) {
        const conv = ctx.createConvolver();
        conv.buffer = reverbIR(ctx);
        const wet = ctx.createGain();
        wet.gain.value = 1.4 * rv;
        lp.connect(conv).connect(wet).connect(buses.synth);
      }
      outs.set(s.id, input);
    }
    return outs.get(s.id)!;
  };
  // 이 박에서 이 슬롯 소리 높이 이동(반음): 뒤쪽 루프에 따로 정한 게 있으면 그것
  const trOf = (s: Slot, beat: number) =>
    (tpl.loopSplit != null && beat >= tpl.loopSplit - 1e-6 && s.transpose2 != null ? s.transpose2 : s.transpose) ?? 0;
  const fxFor = (s: Slot, beat: number): PitchFx | null => {
    const { kind, amount } = fxOf(s, beat);
    if (kind === 'none' || kind === 'autotune') return null;
    const key = `${s.id}|${kind}|${amount}`;
    if (!fxs.has(key)) fxs.set(key, kind === 'vocoder' ? makeVocoder(ctx, outFor(s), amount, startAt, stopAt, nodes) : makeResonance(ctx, outFor(s), amount));
    return fxs.get(key)!;
  };
  // 4분면 레이어 슬롯: 박 → 그 노트가 속한 덩어리(0.5박 넘게 비면 새 덩어리)의 첫 노트 박
  const quadRuns = new Map<string, (b: number) => number>();
  const quadRunStart = (id: string) => {
    if (!quadRuns.has(id)) {
      const bs = [...tpl.notes.filter((x) => x.slot === id)].sort((a, b) => a.beat - b.beat);
      const starts: [number, number][] = []; // [덩어리 시작, 덩어리 끝]
      for (const x of bs) {
        const last = starts[starts.length - 1];
        if (last && x.beat - last[1] <= 0.5 + 1e-6) last[1] = Math.max(last[1], x.beat + x.len);
        else starts.push([x.beat, x.beat + x.len]);
      }
      quadRuns.set(id, (b) => (starts.find(([a, e]) => b >= a - 1e-6 && b <= e + 1e-6) ?? [b])[0]);
    }
    return quadRuns.get(id)!;
  };
  for (const n of tpl.notes) {
    if (n.beat >= tpl.range.end || n.beat + n.len <= fromBeat || n.beat < tpl.range.start) continue;
    const slot = slotMap.get(n.slot);
    if (!slot) continue;
    if (mix.muted.has(slot.id) || (mix.solo && mix.solo !== slot.id)) continue;
    const ov = mix.override;
    // 컷이 소리를 정하는 경우: (1) 컷 길이에 맞춤 슬롯 (2) 조각별 구간이 있는 슬롯 — 그 컷 안 노트는 컷 슬롯 클립의 해당 위치를 냄 (원래 슬롯 소리 대신)
    // 이 슬롯이 그 순간 위에 덮이는 컷(over)으로 나오는 중이면 (L 위에 번쩍하는 M 같은) 아래 컷이 소리를 가져가지 않음
    const overHere = (tpl.shots ?? []).some((x) => x.over && x.slot === slot.id && n.beat >= x.start - 1e-6 && n.beat < x.end - 1e-6);
    const isLead = slot.role !== 'backing' && slot.role !== 'overlay' && !overHere;
    const fit = isLead ? fitAt(fits, n.beat) : undefined;
    const ps = isLead && !fit ? partShotAt(tpl, n.beat) : null;
    const shotSlot = fit?.slot ?? ps?.slot;
    if (shotSlot && mix.muted.has(shotSlot.id)) continue;
    if (shotSlot && !ov) {
      // 컷 슬롯 소리 (함수로 감싸서, 레이어 슬롯이면 아래에서 자기 소리도 이어서 냄)
      (() => {
        const raw = assets.get(shotSlot.id)?.buffer;
        if (!raw) return;
        const hz = midiHz(n.pitch + trOf(shotSlot, n.beat)) * tuneMul(tpl);
        const sfx = fxOf(shotSlot, n.beat);
        const at1 = sfx.kind === 'autotune';
        const fx = at1 ? null : fxFor(shotSlot, n.beat);
        const pr = pitchRate(shotSlot, n.pitch + trOf(shotSlot, n.beat)) * tuneMul(tpl);
        if (fit) {
          // 컷 길이에 맞춤: 이 노트가 맡은 클립 조각(노트 시작~끝에 해당하는 클립 위치)을 음높이 그대로 노트 길이에 늘이거나 줄임
          // (소스가 짧으면 느리게). 그다음 음높이: 오토튠/보코더/공명이면 그것, 아니면 재생 속도로 (그만큼 미리 더 늘여 둠)
          const noteSec = Math.min(n.len * spb(tpl), startAt + tEnd - t0 - at(n.beat));
          const R = fx || at1 ? 1 : pr;
          const piece = stretchedPiece(raw, fitClipTime(fit, n.beat), fitClipTime(fit, n.beat + n.len), noteSec * R * raw.sampleRate,
            at1 ? { hz, strength: sfx.amount } : null);
          let when = at(n.beat);
          let off = 0;
          if (when < startAt) {
            off = (startAt - when) * R;
            when = startAt;
          }
          const noteEnd = when + (piece.duration - off) / R;
          if (noteEnd <= when) return;
          const src = ctx.createBufferSource();
          src.buffer = piece;
          src.playbackRate.value = R;
          const g = ctx.createGain();
          const vol = n.vel * shotSlot.gain;
          g.gain.setValueAtTime(0, when);
          g.gain.linearRampToValueAtTime(vol, when + 0.003);
          g.gain.setValueAtTime(vol, Math.max(when + 0.003, noteEnd - 0.008));
          g.gain.linearRampToValueAtTime(0, noteEnd);
          src.connect(g).connect(fx ? fx.input : outFor(shotSlot));
          fx?.setPitch(hz, when);
          src.start(when, off);
          src.stop(noteEnd + 0.01);
          nodes.push(src);
          return;
        }
        const fb = at1 ? tunedBuffer(raw, hz, sfx.amount) : raw;
        const rate = fx || at1 ? 1 : pr;
        let when = at(n.beat);
        let offset = ps!.range[0] + Math.max(0, n.beat - ps!.anchor) * spb(tpl);
        const limit = Math.min(fb.duration, ps!.range[1]);
        if (when < startAt) {
          offset += (startAt - when) * rate;
          when = startAt;
        }
        if (offset >= limit) return;
        const noteEnd = Math.min(at(n.beat + n.len), startAt + tEnd - t0, when + (limit - offset) / rate);
        if (noteEnd <= when) return;
        const src = ctx.createBufferSource();
        src.buffer = fb;
        src.playbackRate.value = rate;
        const g = ctx.createGain();
        const vol = n.vel * shotSlot.gain;
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(vol, when + 0.003);
        g.gain.setValueAtTime(vol, Math.max(when + 0.003, noteEnd - 0.008));
        g.gain.linearRampToValueAtTime(0, noteEnd);
        src.connect(g).connect(fx ? fx.input : outFor(shotSlot));
        fx?.setPitch(midiHz(n.pitch + trOf(shotSlot, n.beat)) * tuneMul(tpl), when);
        src.start(when, offset);
        src.stop(noteEnd + 0.01);
        nodes.push(src);
        return;
      })();
      // 레이어 슬롯(화면 위에 덧씌워지는 F 같은 것)은 컷 소리와 별개로 자기 소리도 냄
      if (!slot.layer) continue;
    }
    // 4분면 정상 재생 레이어(F·H 같은): 화면처럼 소리도 이어진 노트 덩어리마다 클립을 한 번 길게.
    //  once(기본) = 원래 속도·원래 음높이 / melody = 끊지 않고 이어서 틀되 노트마다 멜로디 음 (아래 일반 경로에서 이어 재생으로)
    if (!ov && slot.layer === 'quad' && slot.quadSound !== 'melody') {
      const runStart = quadRunStart(slot.id);
      if (Math.abs(runStart(n.beat) - n.beat) > 1e-6) continue; // 덩어리 첫 노트만
      const qb = assets.get(slot.id)?.buffer;
      if (!qb) continue;
      let when = at(n.beat);
      let off = 0;
      if (when < startAt) {
        off = startAt - when;
        when = startAt;
      }
      const end = Math.min(when + qb.duration - off, startAt + tEnd - t0);
      if (end <= when) continue;
      const src = ctx.createBufferSource();
      src.buffer = qb;
      const g = ctx.createGain();
      const vol = n.vel * slot.gain;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vol, when + 0.005);
      g.gain.setValueAtTime(vol, Math.max(when + 0.005, end - 0.02));
      g.gain.linearRampToValueAtTime(0, end);
      src.connect(g).connect(outFor(slot));
      src.start(when, off);
      src.stop(end + 0.01);
      nodes.push(src);
      continue;
    }
    const src0 = (slot.audioFrom && slotMap.get(slot.audioFrom)) || slot; // 다른 슬롯 소리를 빌려 쓰는 슬롯
    const raw = ov ? ov.buffer : assets.get(src0.id)?.buffer;
    if (!raw) continue;
    // audioFromAt: 빌려 온 클립 안의 이 구간(초)만 씀. 이 경우 기준 음정은 이 슬롯 것 (그 조각의 음높이)
    const win = !ov && slot.audioFrom ? slot.audioFromAt : undefined;
    const clipStart0 = win ? win[0] : 0;
    const hz = midiHz(n.pitch + (ov ? 0 : trOf(slot, n.beat))) * tuneMul(tpl);
    // 노트 길이에 맞춤: 클립 전체를 음높이 그대로 노트 길이에 늘이거나 줄여서 다 들려줌.
    // 음높이는 오토튠/보코더/공명이면 그것, 아니면 재생 속도로 (그만큼 미리 더 늘여 둠)
    const fitNote = !ov && slot.videoSpeed === 'note';
    const nfx = fxOf(slot, n.beat);
    const fx0 = ov ? null : fxFor(slot, n.beat);
    const at1 = !ov && nfx.kind === 'autotune';
    const pr = (ov ? Math.pow(2, (n.pitch - ov.basePitch) / 12) : pitchRate(win ? slot : src0, n.pitch + trOf(slot, n.beat))) * tuneMul(tpl);
    const fx = at1 ? null : fx0;
    let buf = raw;
    let rate = fx || at1 ? 1 : pr;
    let clipStart = clipStart0;
    if (fitNote) {
      const noteSec = Math.min(n.len * spb(tpl), startAt + tEnd - t0 - at(n.beat));
      buf = stretchedPiece(raw, clipStart0, win ? Math.min(raw.duration, win[1]) : raw.duration, Math.max(1, noteSec * rate * raw.sampleRate),
        at1 ? { hz, strength: nfx.amount } : null);
      clipStart = 0;
    } else if (at1) buf = tunedBuffer(raw, hz, nfx.amount);
    const clipEnd = fitNote ? buf.duration : win ? Math.min(buf.duration, win[1]) : buf.duration;
    const tuned = !ov && !fitNote && tuneBase.has(n.id);
    const gate = ov || tuned || fitNote ? true : slot.mode === 'gate';
    let when = at(n.beat);
    let offset = clipStart + (tuned ? tuneBase.get(n.id)! : 0);
    if (offset >= clipEnd) continue;
    if (when < startAt) {
      offset += (startAt - when) * rate;
      when = startAt;
      if (offset >= clipEnd) continue;
    }
    const clipLeft = when + (clipEnd - offset) / rate;
    const noteEnd = gate ? Math.min(at(n.beat + n.len), startAt + tEnd - t0, clipLeft) : clipLeft;
    if (noteEnd <= when) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const vol = n.vel * (ov ? 1 : slot.gain);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.003);
    g.gain.setValueAtTime(vol, Math.max(when + 0.003, noteEnd - 0.008));
    g.gain.linearRampToValueAtTime(0, noteEnd);
    src.connect(g).connect(fx ? fx.input : outFor(slot));
    fx?.setPitch(midiHz(n.pitch + trOf(slot, n.beat)) * tuneMul(tpl), when);
    src.start(when, offset);
    src.stop(noteEnd + 0.01);
    nodes.push(src);
  }
  return nodes;
}

/** 오토튠 슬롯(audioTune): 노트마다 클립을 처음부터 틀지 않고, 이어진 노트 덩어리 시작부터 흐른 시간만큼 들어간 위치부터 튼다.
 *  음높이만 노트를 따라가서 말소리가 멜로디를 타는 느낌. 노트 id → 클립 안 시작 위치(초) */
export function tuneOffsets(tpl: Template) {
  const out = new Map<string, number>();
  const spbSec = 60 / tpl.bpm;
  for (const slot of tpl.slots) {
    if (!slot.audioTune && !(slot.layer === 'quad' && slot.quadSound === 'melody')) continue;
    const ns = tpl.notes.filter((n) => n.slot === slot.id).sort((a, b) => a.beat - b.beat);
    let anchor = -Infinity; // 이 박에서 클립 위치가 anchorAt(박)
    let anchorAt = 0;
    let runEnd = -Infinity;
    for (const n of ns) {
      if (n.beat - runEnd > 0.5 + 1e-6) [anchor, anchorAt] = [n.beat, 0]; // 0.5박 넘게 비면 새 덩어리
      if (n.clipAt != null && !slot.clipAtOff) [anchor, anchorAt] = [n.beat, n.clipAt]; // 클립 위치를 직접 지정 (다시 틀기 등)
      runEnd = Math.max(runEnd, n.beat + n.len);
      out.set(n.id, (anchorAt + n.beat - anchor) * spbSec);
    }
  }
  return out;
}

/** 노트 하나 미리듣기 */
export function auditionNote(
  ctx: AudioContext, dest: AudioNode, tpl: Template, assets: Map<string, SlotAssets>,
  n: Pick<Note, 'slot' | 'pitch' | 'len'>, override: Override | null = null,
) {
  const own = tpl.slots.find((s) => s.id === n.slot);
  const slot = (own?.audioFrom && tpl.slots.find((s) => s.id === own.audioFrom)) || own;
  const buf = override ? override.buffer : slot && assets.get(slot.id)?.buffer;
  if (!own || !slot || !buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const win = !override && own.audioFrom ? own.audioFromAt : undefined;
  const c0 = win ? win[0] : 0;
  const c1 = win ? Math.min(buf.duration, win[1]) : buf.duration;
  src.playbackRate.value = (override ? Math.pow(2, (n.pitch - override.basePitch) / 12) : pitchRate(win ? own : slot, n.pitch + (own.transpose ?? 0))) * tuneMul(tpl);
  const g = ctx.createGain();
  const vol = override ? 1 : own.gain;
  const dur = Math.min((c1 - c0) / src.playbackRate.value, Math.max(0.12, n.len * (60 / tpl.bpm)));
  const t = ctx.currentTime;
  g.gain.setValueAtTime(vol, t);
  g.gain.setValueAtTime(vol, t + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(g).connect(dest);
  src.start(t, c0);
  src.stop(t + dur + 0.02);
}


/** YIN 간이판: 클립의 대표 음정(MIDI) 추정. 말소리라 대충이지만 시작점으로는 충분 */
export function detectPitch(buf: AudioBuffer): number | null {
  const x = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const W = 2048;
  const minTau = Math.floor(sr / 1000);
  const maxTau = Math.floor(sr / 70);
  const f0s: number[] = [];
  const d = new Float32Array(maxTau + 1);
  for (let start = 0; start + W + maxTau < x.length; start += 512) {
    let energy = 0;
    for (let i = 0; i < W; i++) energy += x[start + i] ** 2;
    if (energy / W < 1e-4) continue;
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const v = x[start + i] - x[start + i + tau];
        s += v * v;
      }
      d[tau] = s;
    }
    let run = 0;
    let best = -1;
    for (let tau = 1; tau <= maxTau; tau++) {
      run += d[tau];
      const cmnd = (d[tau] * tau) / (run || 1);
      if (tau >= minTau && cmnd < 0.15) {
        while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best > 0) f0s.push(sr / best);
  }
  if (f0s.length < 2) return null;
  f0s.sort((a, b) => a - b);
  const f = f0s[Math.floor(f0s.length / 2)];
  return 69 + 12 * Math.log2(f / 440);
}
