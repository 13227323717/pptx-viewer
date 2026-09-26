import * as Core from 'pptx-viewer-core';
import fs from 'fs';
const buf = fs.readFileSync('/Users/jiang/Desktop/PU1-U1 -1.pptx');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteLength);
const pres = await new Core.PptxHandler().load(ab);
const s = pres.slides[10];

// pic-10（钩）相关的全部步骤：入场 + 路径，含时序
const steps = (s.nativeAnimations||[]).filter(a => String(a.targetId).endsWith('pic-10') || String(a.triggerShapeId||'').endsWith('pic-10'));
console.log('=== pic-10（钩）的全部动画步骤 ===');
steps.forEach(a=>console.log(JSON.stringify({
  presetClass: a.presetClass, presetId: a.presetId,
  trigger: a.trigger, parGroupDelayMs: a.parGroupDelayMs, delayMs: a.delayMs,
  durationMs: a.durationMs, nodeId: a.nodeId,
})));

// 对照：滑轨 shape-11 的步骤
const trolley = (s.nativeAnimations||[]).filter(a => String(a.targetId).endsWith('shape-11'));
console.log('\n=== shape-11（滑轨）的步骤 ===');
trolley.forEach(a=>console.log(JSON.stringify({
  presetClass: a.presetClass, trigger: a.trigger, parGroupDelayMs: a.parGroupDelayMs, delayMs: a.delayMs, durationMs: a.durationMs,
})));

// 静态布局位置（引擎数据）
const els = s.elements || [];
for (const id of ['pic-10','shape-11']) {
  const e = els.find(x => String(x.id).endsWith(`-${id}`) || String(x.id) === `ppt/slides/slide11.xml-${id}`);
  if (e) console.log(`\n${id} 布局: x=${e.x} y=${e.y} w=${e.width} h=${e.height} (EMU)`, 
    `→ (${(e.x/9144000*100).toFixed(1)}%, ${(e.y/6858000*100).toFixed(1)}%)`);
}
