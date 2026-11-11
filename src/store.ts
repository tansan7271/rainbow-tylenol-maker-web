// 템플릿(앱에 같이 묶여 배포)과 내 프로젝트(브라우저 저장소)
import type { Template } from './types';

const bundled = import.meta.glob<Template>('/templates/*/template.json', { eager: true, import: 'default' });
const tplId = (path: string) => path.split('/')[2];

export function listTemplates() {
  return Object.entries(bundled).map(([p, t]) => ({ id: tplId(p), name: t.name }));
}
export function getTemplate(id: string): Template {
  const e = Object.entries(bundled).find(([p]) => tplId(p) === id);
  if (!e) throw new Error(`템플릿 ${id} 없음`);
  return structuredClone(e[1]);
}

const KEY = 'rtm.projects';
type Saved = Record<string, { savedAt: number; tpl: Template }>;
const read = (): Saved => JSON.parse(localStorage.getItem(KEY) ?? '{}');

export function listProjects() {
  return Object.entries(read())
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .map(([name]) => name);
}
export function loadProject(name: string): Template {
  const p = read()[name];
  if (!p) throw new Error(`프로젝트 ${name} 없음`);
  return structuredClone(p.tpl);
}
export function saveProject(name: string, tpl: Template) {
  const all = read();
  all[name] = { savedAt: Date.now(), tpl };
  localStorage.setItem(KEY, JSON.stringify(all));
}
export function deleteProject(name: string) {
  const all = read();
  delete all[name];
  localStorage.setItem(KEY, JSON.stringify(all));
}

/** 프로젝트를 JSON 파일로 내려받기 */
export function downloadJson(name: string, tpl: Template) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(tpl, null, 1)], { type: 'application/json' }));
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** JSON 파일을 골라 프로젝트로 */
export function pickJson(): Promise<{ name: string; tpl: Template } | null> {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return res(null);
      try {
        const tpl = JSON.parse(await f.text()) as Template;
        if (!tpl.notes || !tpl.slots) throw new Error('프로젝트 파일이 아니야');
        res({ name: f.name.replace(/\.json$/i, ''), tpl });
      } catch (e) {
        alert('불러오기 실패: ' + (e as Error).message);
        res(null);
      }
    };
    inp.click();
  });
}
