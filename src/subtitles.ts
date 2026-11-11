// 자막 입력 패널: 틀(타이밍·연출)은 템플릿에 정해져 있고, 여기선 각 자막 칸에 들어갈 글자만 입력한다.
//  1) 하단 자막 묶음  2) 화면 위 레이어 자막(슬롯에 붙은 것)  3) 자막 칸(연출 자막 이벤트)
// 반복되는 자막은 한 칸만 입력하면 반복 쪽에도 같이 들어간다.
import { textUnits } from './visual';
import type { Slot, SubtitleGroup, Template } from './types';

export interface SubHost {
  tpl(): Template;
  beginEdit(): void;
  changed(): void;
  seek(beat: number): void;
  /** 이 묶음에서 글자가 나오는 노트 수 */
  slotsIn(gr: SubtitleGroup): number;
}

const EXITS: [string, string][] = [['', '퇴장 없음'], ['left', '← 왼쪽'], ['right', '→ 오른쪽']];

export function renderSubPanel(host: SubHost, el: HTMLElement) {
  const tpl = host.tpl();
  el.innerHTML = '';
  const F = (b: number) => Math.round(((b - tpl.range.start) * 60 * tpl.video.fps) / tpl.bpm);
  const span = (a: number, b: number) => `F${F(a)}–${F(b)}`;
  const edit = (fn: () => void) => {
    host.beginEdit();
    fn();
    host.changed();
  };

  const section = (title: string, hint: string) => {
    const h = document.createElement('div');
    h.className = 'title';
    h.textContent = title;
    const p = document.createElement('div');
    p.className = 'hint';
    p.textContent = hint;
    const list = document.createElement('div');
    list.className = 'subList';
    el.append(h, p, list);
    return list;
  };

  /** 한 줄: [이동 버튼] [설명] [입력칸] [글자 수/칸 수] [추가 요소] */
  const row = (list: HTMLElement, start: number, end: number, label: string, value: string, need: number | null,
    placeholder: string, onChange: (v: string) => void, extra?: HTMLElement) => {
    const r = document.createElement('div');
    r.className = 'subRow';
    r.dataset.start = String(start);
    r.dataset.end = String(end);
    const go = document.createElement('button');
    go.className = 'small';
    go.textContent = '▶';
    go.title = `${span(start, end)} 로 이동`;
    go.onclick = () => host.seek(start);
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = label;
    name.title = label;
    const t = document.createElement('input');
    t.type = 'text';
    t.value = value;
    t.placeholder = placeholder;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    const upd = () => {
      const u = t.value.trim() ? textUnits(t.value).length : 0;
      cnt.textContent = need == null ? '' : u ? `${u}/${need}` : `${need}칸`;
      cnt.classList.toggle('warn', need != null && !!u && u !== need);
    };
    upd();
    t.onchange = () => {
      onChange(t.value);
      upd();
    };
    r.append(go, name, cnt, t, extra ?? document.createElement('span'));
    list.append(r);
  };

  // ---- 1) 하단 자막 묶음 ----
  const groups = tpl.subtitleGroups ?? [];
  if (groups.length) {
    const list = section('하단 자막 묶음', "노트마다 한 글자씩 드러남 · '/' 로 끊으면 조각마다 한 칸 · 비우면 슬롯 글자");
    groups.forEach((gr, i) => {
      if (gr.textFrom != null) return; // 반복 쪽은 원래 묶음 문장을 그대로 씀
      const reps = groups.filter((x) => x.textFrom === i);
      const ex = document.createElement('select');
      for (const [k, name] of EXITS) ex.add(new Option(name, k, false, (gr.exit ?? '') === k));
      ex.onchange = () => edit(() => (ex.value ? (gr.exit = ex.value as 'left' | 'right') : delete gr.exit));
      const label = `${span(gr.start, gr.end)}` + (reps.length ? ` (+반복 ${reps.map((x) => `F${F(x.start)}`).join(', ')})` : '');
      row(list, gr.start, gr.end, label, gr.text ?? '', host.slotsIn(gr), '비우면 슬롯 글자', (v) => edit(() => (gr.text = v)), ex);
    });
  }

  // ---- 2) 화면 위 레이어 자막 (슬롯에 붙은 것) ----
  const layerRows: { slot: Slot; key: 'layerText' | 'label'; what: string; start: number; end: number }[] = [];
  for (const s of tpl.slots) {
    const ns = tpl.notes.filter((n) => n.slot === s.id && n.beat >= tpl.range.start).sort((a, b) => a.beat - b.beat);
    if (!ns.length) continue;
    const a = ns[0].beat;
    const b = Math.max(...ns.map((n) => n.beat + n.len));
    if (s.layer === 'quad') layerRows.push({ slot: s, key: 'layerText', what: '정상 재생 화면과 같이 흐르는 자막', start: a, end: b });
    else if (s.role === 'overlay') layerRows.push({ slot: s, key: 'label', what: '깜빡이는 작은 화면 옆 자막 (모든 노트 같음)', start: a, end: b });
  }
  for (const sc of tpl.scenes) {
    if (sc.text !== 'ticker') continue;
    const n = tpl.notes
      .filter((x) => x.beat >= sc.start - 1e-6 && x.beat < sc.end - 1e-6 && tpl.slots.find((s) => s.id === x.slot && s.role !== 'backing' && s.role !== 'overlay'))
      .sort((a, b) => a.beat - b.beat)[0];
    const s = n && tpl.slots.find((x) => x.id === n.slot);
    if (s) layerRows.push({ slot: s, key: 'label', what: '글자 띠 (첫 글자 하나를 반복)', start: sc.start, end: sc.end });
  }
  if (layerRows.length) {
    const list = section('화면 위 자막', '슬롯 화면에 붙어 나오는 자막');
    const letter = (s: Slot) => String.fromCharCode(65 + tpl.slots.indexOf(s));
    for (const lr of layerRows)
      row(list, lr.start, lr.end, `${letter(lr.slot)} · ${lr.what}`, (lr.slot[lr.key] as string | undefined) ?? '', null, '',
        (v) => edit(() => (lr.slot[lr.key] = v)));
  }

  // ---- 3) 자막 칸 (연출 자막 이벤트) ----
  const fields = tpl.textFields ?? [];
  if (fields.length) {
    const list = section('연출 자막', '한 칸에 적으면 그 자막이 나오는 곳 모두에 들어감 · 칸 수가 정해진 건 한 글자씩(또는 \'/\' 조각) 나뉘어 나옴');
    for (const f of fields) {
      const evs = (tpl.texts ?? []).filter((e) => e.field === f.id);
      if (!evs.length) continue;
      const units = evs.filter((e) => e.unit != null).map((e) => e.unit!);
      const need = units.length ? Math.max(...units) + 1 : null;
      const a = Math.min(...evs.map((e) => e.start));
      const b = Math.max(...evs.map((e) => e.end));
      row(list, a, b, `${f.name} · ${span(a, b)}`, f.text, need, '', (v) => edit(() => (f.text = v)));
    }
  }

  if (!el.childElementCount) {
    const p = document.createElement('span');
    p.className = 'hint';
    p.textContent = '이 템플릿엔 입력할 자막 칸이 없어.';
    el.append(p);
  }
}

/** 재생헤드가 있는 줄 강조 (매 프레임 불러도 가벼움) */
export function highlightSubPanel(el: HTMLElement, beat: number) {
  el.querySelectorAll<HTMLElement>('.subRow').forEach((r) => {
    const on = Number(r.dataset.start) <= beat + 1e-6 && beat < Number(r.dataset.end) - 1e-6;
    if (r.classList.contains('current') !== on) r.classList.toggle('current', on);
  });
}
