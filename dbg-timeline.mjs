import pw from '/Users/jiang/Downloads/online-classroom/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js';
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto('http://127.0.0.1:8899/', { waitUntil: 'load' });
await page.waitForFunction('window.__loaded === true', { timeout: 240000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.__viewer.goToSlide(10));
await page.waitForTimeout(2200);
await page.evaluate(() => window.__viewer.enterPresentation());
await page.waitForTimeout(4500);

const box = async (id) => page.evaluate((eid) => {
  const el = [...document.querySelectorAll(`[data-element-id="ppt/slides/slide11.xml-${eid}"]`)].find(e=>e.closest('.pptxv-stage-wrap'));
  if (!el) return null; const r = el.getBoundingClientRect();
  const stage = document.querySelector('.pptxv-stage-wrap').getBoundingClientRect();
  return { x: +(((r.x+r.width/2-stage.x)/stage.width)*100).toFixed(0), y: +(((r.y+r.height/2-stage.y)/stage.height)*100).toFixed(0) };
}, id);

let p = await box('pic-13'); await page.mouse.click(p.x, p.y); await page.waitForTimeout(2800);
p = await box('pic-4'); await page.mouse.click(p.x, p.y);

// 无采样器干扰：按固定时刻逐次读取（每次读取都是独立的 evaluate）
console.log('时间  钩: x,y/vis        车: x,y       物: x,y/vis');
for (let ms = 500; ms <= 11500; ms += 500) {
  await page.waitForTimeout(ms === 500 ? 500 : 500);
  const rec = await page.evaluate(() => {
    const stage = document.querySelector('.pptxv-stage-wrap').getBoundingClientRect();
    const out = {};
    for (const id of ['pic-10','shape-11','group-4']) {
      const el = [...document.querySelectorAll(`[data-element-id="ppt/slides/slide11.xml-${id}"]`)].find(e=>e.closest('.pptxv-stage-wrap'));
      if (el) { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        out[id] = `${(((r.x+r.width/2-stage.x)/stage.width)*100).toFixed(0)},${(((r.y+r.height/2-stage.y)/stage.height)*100).toFixed(0)}/${cs.visibility==='visible'?'V':'H'}`;
      }
    }
    return out;
  });
  console.log(`${String(ms/1000).padStart(4)}s  ${(rec['pic-10']||'-').padEnd(14)} ${(rec['shape-11']||'-').padEnd(14)} ${rec['group-4']||'-'}`);
}
await browser.close();
