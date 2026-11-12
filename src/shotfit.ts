// 컷과 클립 위치 맞추기
//  1) "컷 길이에 맞춤" 슬롯 (videoSpeed: 'shot'):
//     그 슬롯이 나오는 컷 동안 울리는 노트들(첫 노트 시작 ~ 마지막 노트 끝)에 클립 구간을 늘이거나 줄여서 맞춘다.
//     화면은 그 구간 동안 클립을 한 번 다 보여 주고, 소리도 그 노트들이 클립을 이어서 나눠 냄(음높이는 노트대로 → 오토튠처럼).
//     이어진 컷 흐름(C1 C2' …)은 흐름 전체에 클립 하나, 컷마다 처음부터(shotRestart)·조각별 구간(parts)이 있으면 컷마다 따로.
//  2) 조각별 구간 (slot.parts): C1 C2' C3… 처럼 이어진 흐름의 n번째 컷이 클립의 어느 부분을 쓸지 따로 정함 (미세 컷 편집)
import { slotAudioDur, type Shot, type Slot, type Template } from './types';

export interface ShotFit {
  slot: Slot;
  start: number; // 이 구간의 박 (컷 또는 컷 흐름 시작~끝)
  end: number;
  ws: number; // 클립을 맞출 박 구간 (첫 노트 시작 ~ 마지막 노트 끝)
  we: number;
  c0: number; // 맞출 클립 구간(초, 클립 시작 기준)
  c1: number;
}

const linked = (a: Shot, b: Shot) => a.slot === b.slot && Math.abs(a.end - b.start) < 1e-6;

/** 컷이 이어진 흐름 안에서 몇 번째인지 (1부터). C1 C2' C3 의 숫자 */
export function shotPart(tpl: Template, shot: Shot) {
  const shots = (tpl.shots ?? []).filter((x) => !x.over);
  let i = shots.indexOf(shot);
  let k = 1;
  while (i > 0 && linked(shots[i - 1], shots[i])) {
    i--;
    k++;
  }
  const slot = tpl.slots.find((x) => x.id === shot.slot);
  return (slot?.clipAtOff ? undefined : shot.part) ?? k;
}

/** 이 컷에 정해 둔 조각 구간 [시작, 끝](초). 끝을 안 정했으면 다음 조각 시작, 그것도 없으면 클립 끝 */
export function partRange(tpl: Template, slot: Slot, shot: Shot): [number, number] | null {
  const p = slot.parts?.[shotPart(tpl, shot)];
  if (!p) return null;
  const clip = slotAudioDur(slot);
  const next = Object.values(slot.parts!)
    .map((q) => q.at)
    .filter((a) => a > p.at + 1e-6)
    .sort((a, b) => a - b)[0];
  return [p.at, Math.max(p.at + 0.01, p.end ?? next ?? clip)];
}

export function shotFits(tpl: Template): ShotFit[] {
  const slots = new Map(tpl.slots.map((s) => [s.id, s]));
  const lead = tpl.notes.filter((n) => {
    const r = slots.get(n.slot)?.role;
    return r !== 'backing' && r !== 'overlay';
  });
  const shots = (tpl.shots ?? []).filter((x) => !x.over).sort((a, b) => a.start - b.start);
  const out: ShotFit[] = [];
  for (let i = 0; i < shots.length; i++) {
    const slot = slots.get(shots[i].slot);
    if (!slot || slot.videoSpeed !== 'shot') continue;
    const first = shots[i];
    let start = first.start;
    let end = first.end;
    // 이어진 흐름이면 한 구간으로 맞춤 (C1~C5 에 클립 하나). 컷마다 처음부터(shotRestart)이거나 조각별 구간이 있으면 컷 하나씩
    while (!slot.shotRestart && !slot.parts && i + 1 < shots.length && linked(shots[i], shots[i + 1])) end = shots[++i].end;
    const ns = lead.filter((n) => n.beat >= start - 1e-6 && n.beat < end - 1e-6);
    const ws = ns.length ? Math.min(...ns.map((n) => n.beat)) : start;
    const we = ns.length ? Math.max(...ns.map((n) => n.beat + n.len)) : end;
    const [c0, c1] = partRange(tpl, slot, first) ?? [0, slotAudioDur(slot)];
    out.push({ slot, start, end, ws, we: Math.max(we, ws + 0.01), c0, c1 });
  }
  return out;
}

export const fitAt = (fits: ShotFit[], beat: number) => fits.find((f) => f.start <= beat + 1e-6 && beat < f.end - 1e-6);

/** 이 구간에서 beat 일 때 클립 안 위치(초) */
export const fitClipTime = (f: ShotFit, beat: number) => f.c0 + Math.max(0, Math.min(1, (beat - f.ws) / (f.we - f.ws))) * (f.c1 - f.c0);

/** 조각을 재생하기 시작하는 박: 그 컷 안의 첫 노트 (없으면 컷 시작). 조각 소리는 노트가 울릴 때부터 나와야 하니까 */
export function partAnchor(tpl: Template, shot: Shot) {
  const slots = new Map(tpl.slots.map((s) => [s.id, s]));
  let first = Infinity;
  for (const n of tpl.notes) {
    const r = slots.get(n.slot)?.role;
    if (r === 'backing' || r === 'overlay') continue;
    if (n.beat >= shot.start - 1e-6 && n.beat < shot.end - 1e-6) first = Math.min(first, n.beat);
  }
  return Number.isFinite(first) ? first : shot.start;
}

/** 조각별 구간이 있는 슬롯의 컷 (컷 길이에 맞춤이 아닌 경우): beat 일 때 그 컷과 조각 */
export function partShotAt(tpl: Template, beat: number) {
  for (const sh of tpl.shots ?? []) {
    if (sh.over || beat < sh.start - 1e-6 || beat >= sh.end - 1e-6) continue;
    const slot = tpl.slots.find((s) => s.id === sh.slot);
    if (!slot?.parts || slot.videoSpeed === 'shot') return null;
    const r = partRange(tpl, slot, sh);
    return r ? { shot: sh, slot, range: r, anchor: partAnchor(tpl, sh) } : null;
  }
  return null;
}
