// 위장 표시: 화면에 밈 이름/글자/썸네일 대신 중립적인 이름(파트 A, B…)을 보여준다. 데이터는 안 바뀜.
import type { Slot, Template } from './types';

export const stealth = { on: localStorage.getItem('rtm.stealth') === '1' };
export const setStealth = (on: boolean) => {
  stealth.on = on;
  localStorage.setItem('rtm.stealth', on ? '1' : '0');
};

export const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`);
const idx = (tpl: Template, id: string) => tpl.slots.findIndex((s) => s.id === id);

export const shownLabel = (tpl: Template, slot: Slot | undefined) =>
  !slot ? '' : stealth.on ? letter(idx(tpl, slot.id)) : slot.label;
export const shownName = (tpl: Template, slot: Slot) => (stealth.on ? `파트 ${letter(idx(tpl, slot.id))}` : slot.name);
