// 선택한 장면(구간)의 화면 연출 편집 패널
import type { Fx, Layout, Scene, Template, TextStyle } from './types';

export interface SceneHost {
  tpl(): Template;
  playhead(): number;
  beginEdit(): void;
  changed(): void;
  selectScene(i: number | null): void;
}

const LAYOUTS: [Layout, string][] = [['full', '전체화면'], ['mirror', '좌우 거울'], ['split', '2분할'], ['grid4', '4분할']];
const TEXTS: [TextStyle, string][] = [
  ['none', '자막 없음'], ['subtitle', '하단 자막(마디마다 쌓임)'], ['trail', '글자 줄(음정 따라 오르내림)'],
  ['pop', '글자 팡팡'], ['line', '큰 문장'], ['flash', '거대 글자 번쩍'], ['ticker', '글자 띠(한 글자 반복, 음정 따라 출렁)'],
];
const FXS: [Fx, string][] = [['zoomPunch', '줌 펀치'], ['flipAlternate', '번갈아 뒤집기'], ['shake', '흔들림']];

export function renderScenePanel(host: SceneHost, el: HTMLElement, idx: number | null) {
  const tpl = host.tpl();
  el.innerHTML = '';
  const sc: Scene | undefined = idx != null ? tpl.scenes[idx] : undefined;
  if (!sc) {
    el.innerHTML = '<span class="hint">피아노롤 위쪽 장면 레인을 클릭하면 그 구간의 화면 연출(레이아웃/자막 스타일/PIP/효과)을 바꿀 수 있어.</span>';
    return;
  }
  const edit = (fn: () => void) => { host.beginEdit(); fn(); host.changed(); renderScenePanel(host, el, idx); };
  const sel = <T extends string>(opts: [T, string][], v: T, on: (v: T) => void) => {
    const s = document.createElement('select');
    for (const [k, t] of opts) s.add(new Option(t, k, false, k === v));
    s.onchange = () => edit(() => on(s.value as T));
    return s;
  };
  const lab = (t: string, ...kids: Node[]) => { const l = document.createElement('label'); l.append(t, ...kids); return l; };

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = `장면 ${idx! + 1} (${sc.start}~${sc.end}박)`;
  el.append(title);
  el.append(lab('화면 ', sel(LAYOUTS, sc.layout, (v) => (sc.layout = v))));
  el.append(lab('자막 ', sel(TEXTS, sc.text, (v) => (sc.text = v))));

  if (sc.text === 'line') {
    const t = document.createElement('input');
    t.type = 'text';
    t.value = sc.lineText ?? '';
    t.placeholder = '비우면 슬롯 글자 이어붙이기';
    t.onchange = () => edit(() => (sc.lineText = t.value));
    el.append(lab('문장 ', t));
  }
  const color = document.createElement('input');
  color.type = 'color';
  color.value = sc.textColor ?? '#ffffff';
  color.onchange = () => edit(() => (sc.textColor = color.value));
  el.append(lab('글자색 ', color));

  for (const [fx, name] of FXS) {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!sc.fx?.includes(fx);
    c.onchange = () => edit(() => {
      const s = new Set(sc.fx ?? []);
      c.checked ? s.add(fx) : s.delete(fx);
      sc.fx = [...s];
    });
    el.append(lab('', c, document.createTextNode(name)));
  }

  const pip = document.createElement('select');
  pip.add(new Option('PIP 추가…', ''));
  for (const s of tpl.slots) if (!sc.pip?.includes(s.id)) pip.add(new Option(s.name, s.id));
  pip.onchange = () => edit(() => (sc.pip = [...(sc.pip ?? []), pip.value]));
  el.append(pip);
  for (const id of sc.pip ?? []) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = `PIP: ${tpl.slots.find((s) => s.id === id)?.name ?? id} ✕`;
    b.onclick = () => edit(() => (sc.pip = sc.pip!.filter((x) => x !== id)));
    el.append(b);
  }

  const split = document.createElement('button');
  split.className = 'small';
  split.textContent = '✂ 재생헤드에서 나누기';
  split.onclick = () => {
    const b = Math.round(host.playhead() * 4) / 4;
    if (b <= sc.start || b >= sc.end) return alert('재생헤드를 이 장면 안에 두고 눌러줘');
    edit(() => {
      const right: Scene = { ...structuredClone(sc), start: b };
      sc.end = b;
      tpl.scenes.splice(idx! + 1, 0, right);
    });
  };
  const merge = document.createElement('button');
  merge.className = 'small';
  merge.textContent = '⇤ 앞 장면에 합치기';
  merge.disabled = idx === 0;
  merge.onclick = () => {
    host.beginEdit();
    tpl.scenes[idx! - 1].end = sc.end;
    tpl.scenes.splice(idx!, 1);
    host.changed();
    host.selectScene(idx! - 1);
  };
  el.append(split, merge);
}
