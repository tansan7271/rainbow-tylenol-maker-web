// 슬롯 목록 + 슬롯 편집 대화상자 (영상/소리 소스 고르고 구간 자르기)
import { backend } from './backend';
import { detectPitch } from './audio';
import { drawSpriteFrame, fetchAudio, type SlotAssets } from './media';
import { shownLabel, shownName, stealth } from './stealth';
import { shotPart } from './shotfit';
import { midiName, uid, type Slot, type Template } from './types';

export interface SlotHost {
  tpl(): Template;
  assets(): Map<string, SlotAssets>;
  actx(): AudioContext;
  master(): AudioNode;
  current: string;
  muted: Set<string>;
  solo: string | null;
  selectedCount(): number;
  assignSelected(slotId: string): void;
  beginEdit(): void;
  slotChanged(slot: Slot): Promise<void>;
  slotDeleted(id: string): void;
  changed(): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...kids: (Node | string)[]) => {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...kids);
  return el;
};

const PALETTE = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#3bc9db', '#4dabf7', '#748ffc', '#9775fa', '#da77f2', '#f783ac'];

export function renderSlotList(host: SlotHost, el: HTMLElement, openEditor: (s: Slot) => void) {
  const tpl = host.tpl();
  el.innerHTML = '';
  const counts = new Map<string, number>();
  for (const n of tpl.notes) counts.set(n.slot, (counts.get(n.slot) ?? 0) + 1);
  tpl.slots.forEach((s, i) => {
    const thumb = h('canvas', { width: 96, height: 64 });
    thumb.style.borderLeftColor = s.color;
    const a = host.assets().get(s.id);
    const tg = thumb.getContext('2d')!;
    if (stealth.on) {
      tg.fillStyle = s.color;
      tg.fillRect(0, 0, 96, 64);
      tg.fillStyle = '#000';
      tg.font = '900 34px sans-serif';
      tg.textAlign = 'center';
      tg.textBaseline = 'middle';
      tg.fillText(shownLabel(tpl, s), 48, 34);
    } else if (a?.sprite) drawSpriteFrame(tg, a.sprite, 0, 0, 0, 96, 64);
    const missing = !a?.buffer && !a?.sprite;
    const btn = (txt: string, title: string, fn: () => void, on = false) => {
      const b = h('button', { className: 'small' + (on ? ' on' : ''), textContent: txt, title });
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    const row = h('div', { className: 'slotRow' + (host.current === s.id ? ' current' : '') },
      h('div', { className: 'key', textContent: i < 9 ? String(i + 1) : '' }),
      thumb,
      h('div', {},
        h('div', { className: 'nm', textContent: shownName(tpl, s) }),
        h('div', { className: 'sub' + (missing ? ' warn' : ''), textContent: missing ? '⚠ 클립을 못 불러옴' : `${s.role === 'backing' ? '반주 · ' : s.role === 'overlay' ? '추가 레이어 · ' : ''}${stealth.on ? '' : `“${s.label}” · `}${midiName(s.basePitch)} · 노트 ${counts.get(s.id) ?? 0}` }),
      ),
      h('div', { className: 'btns' },
        btn('⇦', '선택한 노트를 이 슬롯으로 (A)', () => host.assignSelected(s.id)),
        btn('▶', '원래 음으로 듣기', () => playSlot(host, s)),
        btn('M', '음소거', () => { host.muted.has(s.id) ? host.muted.delete(s.id) : host.muted.add(s.id); renderSlotList(host, el, openEditor); }, host.muted.has(s.id)),
        btn('S', '솔로', () => { host.solo = host.solo === s.id ? null : s.id; renderSlotList(host, el, openEditor); }, host.solo === s.id),
        btn('✎', '편집', () => openEditor(s)),
      ),
    );
    row.onclick = () => { host.current = s.id; renderSlotList(host, el, openEditor); };
    row.ondblclick = () => openEditor(s);
    el.append(row);
  });
}

function playSlot(host: SlotHost, s: Slot) {
  const buf = host.assets().get(s.id)?.buffer;
  if (!buf) return;
  const src = host.actx().createBufferSource();
  src.buffer = buf;
  src.connect(host.master());
  src.start();
}

export function newSlot(tpl: Template, firstFile: string | undefined): Slot {
  return {
    id: uid(), name: `새 슬롯 ${tpl.slots.length + 1}`, label: '', color: PALETTE[tpl.slots.length % PALETTE.length],
    video: firstFile ? { file: firstFile, inSec: 0 } : null,
    audio: firstFile ? { file: firstFile, inSec: 0, outSec: 0.4 } : null,
    basePitch: 60, gain: 1, mode: 'gate', videoFollowsPitch: true,
  };
}

let filesCache: string[] | null = null;
async function listFiles(refresh = false) {
  if (!filesCache || refresh) filesCache = await backend.listFiles();
  return filesCache!;
}
/** 파일 고르기 창을 띄워 소스 파일을 추가 (브라우저 저장소 또는 도우미 폴더로) */
export function pickFiles(accept = 'video/*,audio/*'): Promise<string[]> {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = accept;
    inp.onchange = async () => res(inp.files?.length ? await backend.addFiles([...inp.files]) : []);
    inp.click();
  });
}
const setSrc = async (el: HTMLMediaElement, file: string) => {
  el.src = file ? await backend.mediaUrl(file).catch(() => '') : '';
};

export async function openSlotEditor(host: SlotHost, dlg: HTMLDialogElement, orig: Slot, isNew = false) {
  const s: Slot = structuredClone(orig);
  let files = await listFiles(true);
  type AudioMode = 'same' | 'other' | 'none';
  // 소스가 하나도 없는 빈 슬롯이면 기본은 "영상과 같은 소리" (영상만 있는 슬롯은 원래대로 소리 없음)
  let audioMode: AudioMode = !s.audio
    ? s.video ? 'none' : 'same'
    : s.video && s.audio.file === s.video.file && Math.abs(s.audio.inSec - s.video.inSec) < 1e-3 ? 'same' : 'other';
  // 소리 길이 기본값: 규격의 권장 길이(audioSec)가 있으면 그것
  if (!s.audio) s.audio = { file: s.video?.file ?? files[0] ?? '', inSec: s.video?.inSec ?? 0, outSec: (s.video?.inSec ?? 0) + (s.audioSec ?? 0.4) };
  const audio = s.audio;

  dlg.innerHTML = '';
  const fileSelect = (value: string | undefined, allowNone: boolean) => {
    const sel = h('select', { className: 'file' });
    if (allowNone) sel.append(h('option', { value: '', textContent: '(영상 없음)' }));
    for (const f of files) sel.append(h('option', { value: f, textContent: f, selected: f === value }));
    if (value && !files.includes(value)) sel.append(h('option', { value, textContent: value, selected: true }));
    return sel;
  };
  const num = (v: number, step = 0.01) => h('input', { type: 'number', step: String(step), value: String(+v.toFixed(3)) });

  // --- 기본 정보 ---
  const nameIn = h('input', { type: 'text', value: s.name });
  const labelIn = h('input', { type: 'text', value: s.label, placeholder: '비우면 기본 자막(가나다)' });
  const noSubChk = h('input', { type: 'checkbox', checked: s.noSub ?? !s.label });
  const colorIn = h('input', { type: 'color', value: s.color });

  // --- 영상 ---
  const vSel = fileSelect(s.video?.file, true);
  const vPlayer = h('video', { controls: true, preload: 'auto' });
  const vIn = num(s.video?.inSec ?? 0);
  const vSetBtn = h('button', { textContent: '⏺ 지금 위치를 시작점으로' });
  const loadV = async () => { await setSrc(vPlayer, vSel.value); if (vSel.value) vPlayer.currentTime = +vIn.value; };
  // 소스 파일 추가: 추가한 첫 파일을 바로 고름
  const addFileBtn = h('button', { textContent: '📁 파일 추가…' });
  addFileBtn.onclick = async () => {
    const added = await pickFiles();
    if (!added.length) return;
    files = await listFiles(true);
    for (const sel of [vSel, aSel]) {
      const cur = sel.value;
      sel.querySelectorAll('option[value]:not([value=""])').forEach((o) => o.remove());
      for (const f of files) sel.append(h('option', { value: f, textContent: f }));
      sel.value = cur;
    }
    vSel.value = added[0];
    vSel.onchange?.(new Event('change'));
  };

  // --- 소리 ---
  const modeSel = h('select', {},
    h('option', { value: 'same', textContent: '영상과 같은 소리' }),
    h('option', { value: 'other', textContent: '다른 파일에서 소리 가져오기' }),
    h('option', { value: 'none', textContent: '소리 없음 (영상만)' }),
  );
  modeSel.value = audioMode;
  // 영상과 소리는 한 소스·한 구간으로 다룸. 예전에 소리를 다른 파일에서 가져온 슬롯만 옛 메뉴를 보여 줌
  const legacyOther = audioMode === 'other';
  const noSoundChk = h('input', { type: 'checkbox', checked: audioMode === 'none' });
  noSoundChk.onchange = () => {
    modeSel.value = noSoundChk.checked ? 'none' : 'same';
    refreshMode();
  };
  const vInRow = h('div', { className: 'row' });
  const aSel = fileSelect(audio.file, false);
  const aPlayer = h('video', { controls: true, preload: 'auto' });
  aPlayer.style.maxHeight = '120px';
  const aIn = num(audio.inSec);
  const aOut = num(audio.outSec);
  const aInBtn = h('button', { textContent: '⏺ 시작' });
  const aOutBtn = h('button', { textContent: '⏺ 끝' });
  const durDisp = h('span');
  const wave = h('canvas', { className: 'wave', width: 1600, height: 180 });
  const playClipBtn = h('button', { textContent: '▶ 자른 구간 듣기' });
  const otherBox = h('div', { className: 'row' }, '소리 파일 ', aSel);
  const aPlayerBox = h('div', { className: 'row' }, aPlayer);

  // --- 음정/기타 ---
  const pitchIn = num(s.basePitch, 0.1);
  const pitchName = h('span', { textContent: midiName(s.basePitch) });
  const detectBtn = h('button', { textContent: '🎵 자동 감지' });
  const gainIn = h('input', { type: 'range', min: '0', max: '4', step: '0.05', value: String(s.gain) });
  const normChk = h('input', { type: 'checkbox', checked: !!s.normalize });
  const gateSel = h('select', {}, h('option', { value: 'gate', textContent: '노트 길이만큼 (gate)' }), h('option', { value: 'oneshot', textContent: '클립 끝까지 (oneshot)' }));
  gateSel.value = s.mode;
  const speedSel = h('select', {},
    h('option', { value: 'normal', textContent: '영상 정상 속도' }),
    h('option', { value: 'pitch', textContent: '영상 속도 = 음높이 따라 (음이 높으면 빨라짐)' }),
    h('option', { value: 'note', textContent: '영상·소리 = 노트 길이에 맞춤 (클립 전체를 노트 안에 빨리 감아서, 음높이는 노트대로)' }),
    h('option', { value: 'shot', textContent: '영상·소리 = 컷 길이에 맞춤 (이 슬롯 컷 안 노트들에 클립 처음~끝, 오토튠처럼)' }),
  );
  speedSel.value = s.videoSpeed ?? (s.videoFollowsPitch ? 'pitch' : 'normal');
  // 조각별 구간: 이 슬롯이 C1 C2' C3… 처럼 이어진 컷으로 나오면, 조각마다 클립의 어디를 쓸지 (클립 시작 기준 초)
  const partNos = [...new Set((host.tpl().shots ?? []).filter((x) => x.slot === s.id && !x.over).map((x) => shotPart(host.tpl(), x)))].sort((a, b) => a - b);
  const partsBox = h('div');
  const partIns = new Map<number, [HTMLInputElement, HTMLInputElement]>();
  if (partNos.length > 1) {
    partsBox.append(h('div', { className: 'hint', textContent: '조각별 구간 — 이어진 컷의 n번째 조각이 클립의 어디를 쓸지 (클립 시작 기준 초, 비우면 이어서 재생). ⏺ = 플레이어의 지금 위치' }));
    for (const k of partNos) {
      const p = s.parts?.[k];
      const a = h('input', { type: 'number', step: '0.01', value: p ? String(p.at) : '', placeholder: '시작' });
      const b = h('input', { type: 'number', step: '0.01', value: p?.end != null ? String(p.end) : '', placeholder: '끝(선택)' });
      a.style.width = b.style.width = '80px';
      const here = (inp: HTMLInputElement) => () => (inp.value = String(+Math.max(0, vPlayer.currentTime - +vIn.value).toFixed(2)));
      const aBtn = h('button', { className: 'small', textContent: '⏺' });
      aBtn.onclick = here(a);
      const bBtn = h('button', { className: 'small', textContent: '⏺' });
      bBtn.onclick = here(b);
      const play = h('button', { className: 'small', textContent: '▶' });
      play.onclick = () => {
        if (a.value === '') return;
        vPlayer.currentTime = +vIn.value + +a.value;
        vPlayer.play();
        const stopAt = b.value !== '' ? +vIn.value + +b.value : null;
        if (stopAt != null) {
          const chk = () => (vPlayer.currentTime >= stopAt ? vPlayer.pause() : requestAnimationFrame(chk));
          requestAnimationFrame(chk);
        }
      };
      partIns.set(k, [a, b]);
      partsBox.append(h('div', { className: 'row' }, `조각 ${k} `, a, aBtn, ' ~ ', b, bBtn, play));
    }
  }
  // 음정 입히기 (음정이 뚜렷하지 않은 말소리를 음악처럼)
  const fxSel = h('select', { title: '말소리처럼 음정이 뚜렷하지 않은 클립에 노트 음을 강제로 입힘' },
    h('option', { value: 'none', textContent: '음정 입히기 없음' }),
    h('option', { value: 'vocoder', textContent: '보코더 (로봇이 노래하듯, 음정 정확)' }),
    h('option', { value: 'resonance', textContent: '공명 (목소리 위로 음이 울림)' }),
    h('option', { value: 'autotune', textContent: '오토튠 (목소리 음높이를 노트에 고정)' }),
  );
  fxSel.value = s.pitchFx ?? 'none';
  const fxAmt = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.pitchFxAmount ?? (s.pitchFx === 'resonance' ? 0.6 : 0.9)), title: '세기' });
  const fxAmtBox = h('label', {}, '세기 ', fxAmt);
  // 다른 슬롯 소리를 빌려 쓰는 슬롯: 빌리지 않고 이 슬롯 자기 클립을 쓰게 분리
  const lender = s.audioFrom ? host.tpl().slots.find((x) => x.id === s.audioFrom) : undefined;
  const unborrowChk = h('input', { type: 'checkbox' });
  const unborrowBox = h('label', { title: '지금은 다른 슬롯의 클립을 빌려 씀. 체크하고 저장하면 이 슬롯 자기 클립(위 소스)을 쓰고, 이 슬롯 노트만 나오는 컷 화면도 이 슬롯으로 바뀜' },
    unborrowChk, `${lender ? `“${lender.name}”` : '다른 슬롯'} 소리·화면 빌리지 않고 이 슬롯 클립 쓰기`);
  if (!lender) unborrowBox.style.display = 'none';
  // 4분면 정상 재생 레이어(F·H)의 소리 방식
  const quadSel = h('select', { title: '화면 위 4분면에서 정상 재생되는 레이어 슬롯의 소리' },
    h('option', { value: 'once', textContent: '레이어 소리: 원래대로 한 번 길게' }),
    h('option', { value: 'melody', textContent: '레이어 소리: 끊지 않고 길게 + 노트마다 멜로디 음' }),
  );
  quadSel.value = s.quadSound ?? 'once';
  if (s.layer !== 'quad') quadSel.style.display = 'none';
  // 공간감·부드럽게 (뒤쪽 화음처럼 들리게, 거친 목소리 누그러뜨리기)
  const rvIn = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.reverb ?? 0) });
  const softIn = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.soften ?? 0) });
  const spaceRow = h('div', { className: 'row' },
    h('label', { title: '리버브: 높일수록 멀리서 울리는 소리 (원래 소리는 뒤로)' }, '공간감 ', rvIn),
    h('label', { title: '고음을 깎아 거친 소리를 부드럽게' }, ' 부드럽게 ', softIn));
  // 뒤쪽 루프에서만 따로 (예: 앞 루프는 그대로, 뒤 루프 배경만 오토튠 살짝)
  const split = host.tpl().loopSplit;
  const fx2Sel = h('select', { title: '뒤쪽 루프에서만 다른 음정 입히기' },
    h('option', { value: '', textContent: '앞과 같음' }),
    h('option', { value: 'none', textContent: '없음' }),
    h('option', { value: 'vocoder', textContent: '보코더' }),
    h('option', { value: 'resonance', textContent: '공명' }),
    h('option', { value: 'autotune', textContent: '오토튠' }),
  );
  fx2Sel.value = s.pitchFx2 ?? '';
  const fx2Amt = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.pitchFxAmount2 ?? 0.5), title: '세기' });
  const fx2AmtBox = h('label', {}, '세기 ', fx2Amt);
  const syncFx2 = () => (fx2AmtBox.style.display = fx2Sel.value === '' || fx2Sel.value === 'none' ? 'none' : '');
  fx2Sel.onchange = syncFx2;
  syncFx2();
  const T = host.tpl();
  const splitF = split != null ? Math.round(((split - T.range.start) * 60 * T.video.fps) / T.bpm) : 0;
  const tr2In = h('input', { type: 'number', step: '1', min: '-24', max: '24', value: s.transpose2 != null ? String(s.transpose2) : '', placeholder: '같음' });
  tr2In.style.width = '56px';
  const fx2Row = h('div', { className: 'row' }, `뒤쪽 루프(F${splitF}~)에서는 `, fx2Sel, fx2AmtBox,
    h('label', { title: '뒤쪽 루프에서만 소리 높이 (반음). 비우면 앞과 같음' }, ' 소리 높이 ', tr2In, '반음'));
  if (split == null) fx2Row.style.display = 'none';
  // 이 슬롯 소리만 옥타브/반음 이동 (목소리가 너무 높거나 낮을 때)
  const trIn = h('input', { type: 'number', step: '1', min: '-24', max: '24', value: String(s.transpose ?? 0) });
  trIn.style.width = '56px';
  const trDown = h('button', { className: 'small', textContent: '−12' });
  trDown.onclick = () => (trIn.value = String(Math.max(-24, +trIn.value - 12)));
  const trUp = h('button', { className: 'small', textContent: '+12' });
  trUp.onclick = () => (trIn.value = String(Math.min(24, +trIn.value + 12)));
  const trBox = h('label', { title: '이 슬롯 소리만 노트보다 반음 단위로 올리거나 내림 (-12 = 한 옥타브 아래). 노트·화면은 그대로' }, '소리 높이 ', trIn, '반음 ', trDown, trUp);
  const syncFx = () => (fxAmtBox.style.display = fxSel.value === 'none' ? 'none' : '');
  fxSel.onchange = () => {
    fxAmt.value = fxSel.value === 'resonance' ? '0.6' : fxSel.value === 'autotune' ? '1' : '0.9';
    syncFx();
  };
  syncFx();
  const backingChk = h('input', { type: 'checkbox', checked: s.role === 'backing' });
  const overlayChk = h('input', { type: 'checkbox', checked: s.role === 'overlay' });
  backingChk.onchange = () => { if (backingChk.checked) overlayChk.checked = false; };
  overlayChk.onchange = () => { if (overlayChk.checked) backingChk.checked = false; };
  const restartChk = h('input', { type: 'checkbox', checked: !!s.shotRestart });
  const tuneChk = h('input', { type: 'checkbox', checked: !!s.audioTune });
  // 틀에 "같은 대사 다시 틀기"가 있는 슬롯(J 같은)만: 끄고 이어서 재생
  const hasClipAt = (host.tpl().shots ?? []).some((x) => x.slot === s.id && x.clipAt != null) || host.tpl().notes.some((n) => n.slot === s.id && n.clipAt != null);
  const clipAtOffChk = h('input', { type: 'checkbox', checked: !!s.clipAtOff });
  const clipAtOffBox = h('label', { title: '틀에서는 같은 대사를 두 번 다시 트는 자리인데, 내 클립은 다시 틀지 않고 이어서 재생' }, clipAtOffChk, '같은 대사 다시 틀기 끄기 (이어서 재생)');
  if (!hasClipAt) clipAtOffBox.style.display = 'none';

  const activePlayer = () => (audioMode === 'other' ? aPlayer : vPlayer);
  const audioFile = () => (audioMode === 'other' ? aSel.value : vSel.value);

  // 파형
  let peaks: { rate: number; peaks: number[] } | null = null;
  let peaksFile = '';
  const loadPeaks = async () => {
    const f = audioFile();
    if (!f || f === peaksFile) return drawWave();
    peaksFile = f;
    peaks = null;
    drawWave();
    peaks = await backend.peaks(f).catch(() => null);
    drawWave();
  };
  const view = () => {
    const a = +aIn.value, b = +aOut.value;
    const pad = Math.max(0.6, (b - a) * 0.8);
    return [Math.max(0, a - pad), b + pad] as const;
  };
  const drawWave = () => {
    const g = wave.getContext('2d')!;
    const W = wave.width, H = wave.height;
    g.fillStyle = '#0b0c0f';
    g.fillRect(0, 0, W, H);
    const [v0, v1] = view();
    const X = (t: number) => ((t - v0) / (v1 - v0)) * W;
    g.fillStyle = 'rgba(230,73,128,0.25)';
    g.fillRect(X(+aIn.value), 0, X(+aOut.value) - X(+aIn.value), H);
    if (peaks) {
      g.fillStyle = '#74c0fc';
      for (let x = 0; x < W; x++) {
        const t = v0 + (x / W) * (v1 - v0);
        const i = Math.floor(t * peaks.rate);
        const p = (peaks.peaks[i] ?? 0) / 255;
        g.fillRect(x, H / 2 - (p * H) / 2, 1, Math.max(1, p * H));
      }
    } else {
      g.fillStyle = '#666';
      g.font = '24px sans-serif';
      g.fillText('파형 불러오는 중…', 20, 40);
    }
    g.fillStyle = '#e64980';
    g.fillRect(X(+aIn.value) - 2, 0, 4, H);
    g.fillRect(X(+aOut.value) - 2, 0, 4, H);
    const pt = activePlayer().currentTime;
    if (pt >= v0 && pt <= v1) {
      g.fillStyle = '#ffd43b';
      g.fillRect(X(pt), 0, 2, H);
    }
    g.fillStyle = '#adb5bd';
    g.font = '20px sans-serif';
    g.fillText(`${v0.toFixed(2)}s`, 6, H - 8);
    g.fillText(`${v1.toFixed(2)}s`, W - 90, H - 8);
    durDisp.textContent = `길이 ${(+aOut.value - +aIn.value).toFixed(3)}s`;
  };
  let waveDrag: 'in' | 'out' | null = null;
  wave.onpointerdown = (e) => {
    const [v0, v1] = view();
    const t = v0 + (e.offsetX / wave.clientWidth) * (v1 - v0);
    const dIn = Math.abs(t - +aIn.value), dOut = Math.abs(t - +aOut.value);
    const tol = (v1 - v0) * 0.02;
    if (Math.min(dIn, dOut) < tol) {
      waveDrag = dIn < dOut ? 'in' : 'out';
      wave.setPointerCapture(e.pointerId);
    } else {
      activePlayer().currentTime = t;
      drawWave();
    }
  };
  wave.onpointermove = (e) => {
    if (!waveDrag) return;
    const [v0, v1] = view();
    const t = Math.max(0, v0 + (e.offsetX / wave.clientWidth) * (v1 - v0));
    if (waveDrag === 'in') aIn.value = String(+Math.min(t, +aOut.value - 0.01).toFixed(3));
    else aOut.value = String(+Math.max(t, +aIn.value + 0.01).toFixed(3));
    syncLinked();
    drawWave();
  };
  wave.onpointerup = () => (waveDrag = null);
  vPlayer.ontimeupdate = aPlayer.ontimeupdate = () => drawWave();

  const syncLinked = () => { if (audioMode !== 'other') vIn.value = aIn.value; };
  const refreshMode = () => {
    audioMode = modeSel.value as AudioMode;
    otherBox.style.display = audioMode === 'other' ? '' : 'none';
    aPlayerBox.style.display = audioMode === 'other' ? '' : 'none';
    vInRow.style.display = audioMode === 'other' ? '' : 'none';
    modeSel.style.display = legacyOther ? '' : 'none';
    if (audioMode !== 'other') {
      const d = +aOut.value - +aIn.value;
      aIn.value = vIn.value;
      aOut.value = String(+(+vIn.value + d).toFixed(3));
    }
    if (audioMode === 'other' && !aPlayer.src && aSel.value) setSrc(aPlayer, aSel.value);
    loadPeaks();
  };
  modeSel.onchange = refreshMode;
  vSel.onchange = () => { loadV(); loadPeaks(); };
  aSel.onchange = () => { setSrc(aPlayer, aSel.value); loadPeaks(); };
  vSetBtn.onclick = () => (vIn.value = String(+vPlayer.currentTime.toFixed(3)));
  aInBtn.onclick = () => {
    const d = +aOut.value - +aIn.value;
    aIn.value = String(+activePlayer().currentTime.toFixed(3));
    if (+aOut.value <= +aIn.value) aOut.value = String(+(+aIn.value + Math.max(0.05, d)).toFixed(3));
    syncLinked();
    drawWave();
  };
  aOutBtn.onclick = () => {
    aOut.value = String(+Math.max(+aIn.value + 0.01, activePlayer().currentTime).toFixed(3));
    drawWave();
  };
  aIn.oninput = aOut.oninput = () => { syncLinked(); drawWave(); };
  pitchIn.oninput = () => (pitchName.textContent = midiName(+pitchIn.value));

  playClipBtn.onclick = async () => {
    const f = audioFile();
    if (!f) return;
    const buf = await fetchAudio(host.actx(), f, +aIn.value, +aOut.value);
    const src = host.actx().createBufferSource();
    src.buffer = buf;
    src.connect(host.master());
    src.start();
    const p = vPlayer;
    if (vSel.value) {
      p.muted = true;
      p.currentTime = +vIn.value;
      p.play();
      setTimeout(() => { p.pause(); p.muted = false; }, buf.duration * 1000);
    }
  };
  detectBtn.onclick = async () => {
    const f = audioFile();
    if (!f) return;
    detectBtn.textContent = '감지 중…';
    const buf = await fetchAudio(host.actx(), f, +aIn.value, +aOut.value);
    const p = detectPitch(buf);
    detectBtn.textContent = '🎵 자동 감지';
    if (p == null) return alert('음정을 못 찾았어 (무성음/잡음 위주인 듯). 직접 입력해줘!');
    pitchIn.value = p.toFixed(1);
    pitchName.textContent = midiName(p);
  };

  const refreshFiles = h('button', { className: 'small', textContent: '↻ 파일 목록', title: '소스 파일 목록 다시 읽기' });
  refreshFiles.onclick = async () => {
    files = await listFiles(true);
    for (const [sel, none] of [[vSel, true], [aSel, false]] as const) {
      const v = sel.value;
      const n = fileSelect(v, none);
      sel.innerHTML = n.innerHTML;
      sel.value = v;
    }
  };

  const cancel = h('button', { textContent: '취소' });
  const save = h('button', { className: 'primary', textContent: '저장' });
  const del = h('button', { textContent: '🗑 슬롯 삭제' });

  dlg.append(
    h('h3', { textContent: isNew ? '새 슬롯' : `슬롯 편집 — ${s.name}` }),
    h('fieldset', {}, h('legend', { textContent: '기본' }),
      h('label', {}, '이름 ', nameIn), h('label', {}, '자막 글자 ', labelIn), h('label', {}, noSubChk, '자막 없음'), h('label', {}, '색 ', colorIn)),
    h('fieldset', {}, h('legend', { textContent: '소스 (영상 + 소리)' }),
      h('div', { className: 'row' }, '파일 ', vSel, refreshFiles, addFileBtn),
      h('div', { className: 'row' }, vPlayer),
      h('div', { className: 'row' }, '구간 ', aIn, aInBtn, ' ~ ', aOut, aOutBtn, durDisp, playClipBtn),
      wave,
      h('div', { className: 'hint', textContent: '영상과 소리는 같은 구간을 씀 · 파형의 분홍 선을 끌어서 자르기 · 파형 클릭 = 플레이어 위치 이동 · 플레이어로 보다가 ⏺ 버튼으로 찍어도 돼' }),
      h('div', { className: 'row' }, h('label', { title: '영상만 쓰고 소리는 안 냄 (화면 전용 슬롯)' }, noSoundChk, '소리 없음 (영상만)'), modeSel),
      otherBox, aPlayerBox,
      vInRow,
      h('label', { title: '화면 컷이 C1 C2\' C3…처럼 이어질 때, 한 클립을 쭉 이어 틀지(기본) 컷마다 처음부터 다시 틀지' }, restartChk, '이어지는 컷에서도 컷마다 처음부터'),
      unborrowBox,
      clipAtOffBox,
      partsBox,
    ),
    h('fieldset', {}, h('legend', { textContent: '연주' }),
      h('label', {}, '기준 음정(MIDI) ', pitchIn, pitchName), detectBtn,
      h('label', {}, '볼륨 ', gainIn), h('label', { title: '클립 소리 크기를 일정하게 맞춤 (조용한 클립을 키우되 깨지지 않게)' }, normChk, '소리 크기 자동 맞춤'), gateSel,
      speedSel,
      h('div', { className: 'row' }, fxSel, fxAmtBox),
      quadSel,
      spaceRow,
      fx2Row,
      trBox,
      h('label', { title: '소리만 나고 메인 화면/자막은 안 바꿈 (베이스 같은 반주용)' }, backingChk, '반주 파트'),
      h('label', { title: '이어진 노트들이 클립을 처음부터가 아니라 이어서 틀고 음높이만 노트를 따라감 (말소리가 멜로디를 타는 느낌)' }, tuneChk, '오토튠처럼 (이어서 재생)'),
      h('label', { title: '소리 + 노트마다 좌우에 깜빡이는 작은 화면(음이 높으면 위) + 자체 자막. 메인 화면/자막은 안 바꿈' }, overlayChk, '추가 레이어'),
    ),
    h('div', { className: 'actions' }, del, h('div', {}, cancel, ' ', save)),
  );
  vInRow.append('영상 시작점(초) ', vIn, vSetBtn);
  loadV();
  refreshMode();

  cancel.onclick = () => dlg.close();
  del.onclick = () => {
    const n = host.tpl().notes.filter((x) => x.slot === s.id).length;
    if (!confirm(`“${s.name}” 슬롯을 지울까? 이 슬롯을 쓰는 노트 ${n}개도 같이 지워져.`)) return;
    host.slotDeleted(s.id);
    dlg.close();
  };
  save.onclick = async () => {
    s.name = nameIn.value || s.name;
    s.label = labelIn.value;
    s.noSub = noSubChk.checked;
    s.color = colorIn.value;
    const keepDur = s.video?.durSec; // 소리가 있어도 영상만 길게 지정해 둔 길이는 유지
    s.video = vSel.value ? { file: vSel.value, inSec: +vIn.value, ...(keepDur ? { durSec: keepDur } : {}) } : null;
    if (audioMode === 'none') {
      s.audio = null;
      if (s.video) s.video.durSec = Math.max(0.05, +aOut.value - +aIn.value);
    } else {
      s.audio = { file: audioMode === 'same' ? vSel.value : aSel.value, inSec: +aIn.value, outSec: +aOut.value };
      if (!s.audio.file) s.audio = null;
    }
    s.basePitch = +pitchIn.value;
    s.gain = +gainIn.value;
    s.mode = gateSel.value as Slot['mode'];
    s.videoSpeed = speedSel.value as NonNullable<Slot['videoSpeed']>;
    if (unborrowChk.checked && s.audioFrom) {
      // 빌려 온 슬롯의 컷 중, 안에서 울리는 노트가 전부 이 슬롯 것인 컷은 화면도 이 슬롯으로
      host.beginEdit(); // 컷을 바꾸기 전에 되돌리기 지점
      const T = host.tpl();
      const from = s.audioFrom;
      const roleOf = (id: string) => T.slots.find((x) => x.id === id)?.role;
      for (const sh of T.shots ?? []) {
        if (sh.slot !== from || sh.over) continue;
        const ns = T.notes.filter((n) => n.beat >= sh.start - 1e-6 && n.beat < sh.end - 1e-6 && roleOf(n.slot) !== 'backing' && roleOf(n.slot) !== 'overlay');
        if (ns.length && ns.every((n) => n.slot === s.id)) sh.slot = s.id;
      }
      delete s.audioFrom;
      delete s.audioFromAt;
    }
    if (clipAtOffChk.checked) s.clipAtOff = true;
    else delete s.clipAtOff;
    if (s.layer === 'quad') s.quadSound = quadSel.value as 'once' | 'melody';
    if (normChk.checked) s.normalize = true;
    else delete s.normalize;
    if (+rvIn.value) s.reverb = +rvIn.value;
    else delete s.reverb;
    if (+softIn.value) s.soften = +softIn.value;
    else delete s.soften;
    if (fx2Sel.value) {
      s.pitchFx2 = fx2Sel.value as NonNullable<Slot['pitchFx2']>;
      s.pitchFxAmount2 = +fx2Amt.value;
    } else {
      delete s.pitchFx2;
      delete s.pitchFxAmount2;
    }
    if (tr2In.value !== '') s.transpose2 = Math.round(+tr2In.value);
    else delete s.transpose2;
    if (+trIn.value) s.transpose = Math.round(+trIn.value);
    else delete s.transpose;
    if (partIns.size) {
      const parts: NonNullable<Slot['parts']> = {};
      for (const [k, [a, b]] of partIns) if (a.value !== '') parts[k] = { at: +a.value, ...(b.value !== '' ? { end: +b.value } : {}) };
      if (Object.keys(parts).length) s.parts = parts;
      else delete s.parts;
    }
    if (fxSel.value === 'none') {
      delete s.pitchFx;
      delete s.pitchFxAmount;
    } else {
      s.pitchFx = fxSel.value as NonNullable<Slot['pitchFx']>;
      s.pitchFxAmount = +fxAmt.value;
    }
    s.videoFollowsPitch = s.videoSpeed === 'pitch';
    s.role = backingChk.checked ? 'backing' : overlayChk.checked ? 'overlay' : 'lead';
    if (tuneChk.checked) s.audioTune = true;
    else delete s.audioTune;
    if (restartChk.checked) s.shotRestart = true;
    else delete s.shotRestart;
    save.textContent = '불러오는 중…';
    host.beginEdit();
    const tpl = host.tpl();
    const i = tpl.slots.findIndex((x) => x.id === s.id);
    if (i >= 0) tpl.slots[i] = s;
    else tpl.slots.push(s);
    await host.slotChanged(s);
    host.changed();
    dlg.close();
  };
  dlg.onclose = () => { vPlayer.pause(); aPlayer.pause(); vPlayer.removeAttribute('src'); aPlayer.removeAttribute('src'); };
  dlg.showModal();
}
