// 노트 → WebAudio 스케줄링. 실시간 재생과 오프라인 렌더(내보내기)가 같은 코드를 쓴다.
import type { SlotAssets } from './media';
import { beatToSec, pitchRate, type Note, type Template } from './types';


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
  for (const n of tpl.notes) {
    if (n.beat >= tpl.range.end || n.beat + n.len <= fromBeat || n.beat < tpl.range.start) continue;
    const slot = slotMap.get(n.slot);
    if (!slot) continue;
    if (mix.muted.has(slot.id) || (mix.solo && mix.solo !== slot.id)) continue;
    const ov = mix.override;
    const src0 = (slot.audioFrom && slotMap.get(slot.audioFrom)) || slot; // 다른 슬롯 소리를 빌려 쓰는 슬롯
    const buf = ov ? ov.buffer : assets.get(src0.id)?.buffer;
    if (!buf) continue;
    // audioFromAt: 빌려 온 클립 안의 이 구간(초)만 씀. 이 경우 기준 음정은 이 슬롯 것 (그 조각의 음높이)
    const win = !ov && slot.audioFrom ? slot.audioFromAt : undefined;
    const clipStart = win ? win[0] : 0;
    const clipEnd = win ? Math.min(buf.duration, win[1]) : buf.duration;
    const rate = (ov ? Math.pow(2, (n.pitch - ov.basePitch) / 12) : pitchRate(win ? slot : src0, n.pitch)) * tuneMul(tpl);
    const tuned = !ov && tuneBase.has(n.id);
    const gate = ov || tuned ? true : slot.mode === 'gate';
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
    src.connect(g).connect(buses.synth);
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
    if (!slot.audioTune) continue;
    const ns = tpl.notes.filter((n) => n.slot === slot.id).sort((a, b) => a.beat - b.beat);
    let anchor = -Infinity; // 이 박에서 클립 위치가 anchorAt(박)
    let anchorAt = 0;
    let runEnd = -Infinity;
    for (const n of ns) {
      if (n.beat - runEnd > 0.5 + 1e-6) [anchor, anchorAt] = [n.beat, 0]; // 0.5박 넘게 비면 새 덩어리
      if (n.clipAt != null) [anchor, anchorAt] = [n.beat, n.clipAt]; // 클립 위치를 직접 지정 (다시 틀기 등)
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
  src.playbackRate.value = (override ? Math.pow(2, (n.pitch - override.basePitch) / 12) : pitchRate(win ? own : slot, n.pitch)) * tuneMul(tpl);
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
