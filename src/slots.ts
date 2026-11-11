// 슬롯 목록 + 슬롯 편집 대화상자 (영상/소리 소스 고르고 구간 자르기)
import { backend } from './backend';
import { detectPitch } from './audio';
import { drawSpriteFrame, fetchAudio, type SlotAssets } from './media';
import { shownLabel, shownName, stealth } from './stealth';
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
  let audioMode: AudioMode = !s.audio ? 'none' : s.video && s.audio.file === s.video.file && Math.abs(s.audio.inSec - s.video.inSec) < 1e-3 ? 'same' : 'other';
  if (!s.audio) s.audio = { file: s.video?.file ?? files[0] ?? '', inSec: s.video?.inSec ?? 0, outSec: (s.video?.inSec ?? 0) + 0.4 };
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
  const noSubChk = h('input', { type: 'checkbox', checked: !!s.noSub });
  const colorIn = h('input', { type: 'color', value: s.color });

  // --- 영상 ---
  const vSel = fileSelect(s.video?.file, true);
  const vPlayer = h('video', { controls: true, preload: 'auto' });
  const vIn = num(s.video?.inSec ?? 0);
  const vSetBtn = h('button', { textContent: '⏺ 지금 위치를 시작점으로' });
  const loadV = async () => { await setSrc(vPlayer, vSel.value); if (vSel.value) vPlayer.currentTime = +vIn.value; };
  // 소스 파일 추가: 추가한 첫 파일을 영상(과 소리)으로 바로 고름
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
  const gainIn = h('input', { type: 'range', min: '0', max: '3', step: '0.05', value: String(s.gain) });
  const gateSel = h('select', {}, h('option', { value: 'gate', textContent: '노트 길이만큼 (gate)' }), h('option', { value: 'oneshot', textContent: '클립 끝까지 (oneshot)' }));
  gateSel.value = s.mode;
  const followChk = h('input', { type: 'checkbox', checked: s.videoFollowsPitch });
  const backingChk = h('input', { type: 'checkbox', checked: s.role === 'backing' });
  const overlayChk = h('input', { type: 'checkbox', checked: s.role === 'overlay' });
  backingChk.onchange = () => { if (backingChk.checked) overlayChk.checked = false; };
  overlayChk.onchange = () => { if (overlayChk.checked) backingChk.checked = false; };
  const restartChk = h('input', { type: 'checkbox', checked: !!s.shotRestart });
  const tuneChk = h('input', { type: 'checkbox', checked: !!s.audioTune });

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

  const syncLinked = () => { if (audioMode === 'same') vIn.value = aIn.value; };
  const refreshMode = () => {
    audioMode = modeSel.value as AudioMode;
    otherBox.style.display = audioMode === 'other' ? '' : 'none';
    aPlayerBox.style.display = audioMode === 'other' ? '' : 'none';
    vIn.disabled = audioMode === 'same';
    vSetBtn.style.display = audioMode === 'same' ? 'none' : '';
    if (audioMode === 'same') {
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
    h('fieldset', {}, h('legend', { textContent: '영상' }),
      h('div', { className: 'row' }, '영상 파일 ', vSel, refreshFiles, addFileBtn),
      h('div', { className: 'row' }, vPlayer),
      h('div', { className: 'row' }, '영상 시작점(초) ', vIn, vSetBtn),
      h('label', { title: '화면 컷이 C1 C2\' C3…처럼 이어질 때, 한 클립을 쭉 이어 틀지(기본) 컷마다 처음부터 다시 틀지' }, restartChk, '이어지는 컷에서도 컷마다 처음부터'),
    ),
    h('fieldset', {}, h('legend', { textContent: '소리' }),
      h('div', { className: 'row' }, modeSel),
      otherBox, aPlayerBox,
      h('div', { className: 'row' }, '구간 ', aIn, aInBtn, ' ~ ', aOut, aOutBtn, durDisp, playClipBtn),
      wave,
      h('div', { className: 'hint', textContent: '파형의 분홍 선을 끌어서 자르기 · 파형 클릭 = 플레이어 위치 이동 · 플레이어로 듣다가 ⏺ 버튼으로 찍어도 돼' }),
    ),
    h('fieldset', {}, h('legend', { textContent: '연주' }),
      h('label', {}, '기준 음정(MIDI) ', pitchIn, pitchName), detectBtn,
      h('label', {}, '볼륨 ', gainIn), gateSel,
      h('label', {}, followChk, '음이 높으면 영상도 빨라짐'),
      h('label', { title: '소리만 나고 메인 화면/자막은 안 바꿈 (베이스 같은 반주용)' }, backingChk, '반주 파트'),
      h('label', { title: '이어진 노트들이 클립을 처음부터가 아니라 이어서 틀고 음높이만 노트를 따라감 (말소리가 멜로디를 타는 느낌)' }, tuneChk, '오토튠처럼 (이어서 재생)'),
      h('label', { title: '소리 + 노트마다 좌우에 깜빡이는 작은 화면(음이 높으면 위) + 자체 자막. 메인 화면/자막은 안 바꿈' }, overlayChk, '추가 레이어'),
    ),
    h('div', { className: 'actions' }, del, h('div', {}, cancel, ' ', save)),
  );
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
    if (noSubChk.checked) s.noSub = true;
    else delete s.noSub;
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
    s.videoFollowsPitch = followChk.checked;
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
