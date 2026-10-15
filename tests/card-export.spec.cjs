const { test, expect } = require('@playwright/test');

async function enroll(page, nickname = '奶龙同学') {
  if (!await page.locator('#enroll-dialog').isVisible()) await page.locator('[data-enroll]:visible').first().click();
  await page.locator('#student-name').fill(nickname);
  await page.locator('#student-college').selectOption('code');
  await page.locator('#fun-consent').check();
  await page.locator('#enroll-form button[type=submit]').click();
  await expect(page.locator('#enroll-result')).toBeVisible();
}
async function generate(page) {
  await page.locator('#generate-png').click();
  await expect(page.locator('#png-preview')).toBeVisible();
  await expect(page.locator('#generate-png')).toBeEnabled();
}
async function downloadBytes(page, selector) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await pending;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { filename: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

for (const nickname of ['奶龙同学', '一二三四五六七八九十一二', '<龙&"\'>']) {
  test(`PNG and SVG export under production CSP: ${nickname}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluate(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => window.cspViolations.push(event.violatedDirective));
    });
    await enroll(page, nickname);
    const id = await page.locator('#card-id').textContent();
    await generate(page);
    const png = await downloadBytes(page, '#download-png');
    expect(png.filename).toBe(`大连奶龙大学-校园纪念卡-${id}.png`);
    expect(png.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.bytes.readUInt32BE(16)).toBe(2240);
    expect(png.bytes.readUInt32BE(20)).toBe(1360);
    const svg = await downloadBytes(page, '#download-card');
    expect(svg.filename).toBe(`大连奶龙大学-校园纪念卡-${id}.svg`);
    const parsed = await page.evaluate((source) => {
      const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
      return { invalid: !!xml.querySelector('parsererror'), text: xml.documentElement.textContent };
    }, svg.bytes.toString());
    expect(parsed.invalid).toBe(false);
    expect(parsed.text).toContain(nickname);
    expect(parsed.text).toContain(id);
    expect(parsed.text).toContain('奶龙软件工程学院');
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('conversion failure can be retried and SVG remains available', async ({ page }) => {
  await enroll(page);
  await page.evaluate(() => {
    window.originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
  });
  await page.locator('#generate-png').click();
  await expect(page.locator('#png-status')).toContainText('PNG 生成失败');
  await expect(page.locator('#png-preview')).toBeHidden();
  await expect(page.locator('#generate-png')).toBeEnabled();
  expect((await downloadBytes(page, '#download-card')).bytes.toString()).toContain('<svg');
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = window.originalToBlob; });
  await generate(page);
});

test('reset discards in-flight export and releases old preview URLs', async ({ page }) => {
  await enroll(page);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    window.conversions = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      window.conversions += 1;
      original.call(this, (blob) => { window.finishOldPNG = () => callback(blob); }, type);
    };
    window.restoreToBlob = () => { HTMLCanvasElement.prototype.toBlob = original; };
  });
  await page.locator('#generate-png').click();
  await expect(page.locator('#generate-png')).toBeDisabled();
  await page.waitForFunction(() => typeof window.finishOldPNG === 'function');
  await page.locator('#generate-png').dispatchEvent('click');
  expect(await page.evaluate(() => window.conversions)).toBe(1);
  await page.locator('#enroll-reset').click();
  await page.evaluate(() => window.restoreToBlob());
  await expect(page.locator('#png-preview')).toBeHidden();
  await expect(page.locator('#png-status')).toHaveText('');
  await enroll(page, '第二张');
  await generate(page);
  const oldURL = await page.locator('#png-image').getAttribute('src');
  await page.evaluate(() => window.finishOldPNG());
  await expect(page.locator('#png-image')).toHaveAttribute('src', oldURL);
  await expect(page.locator('#png-status')).toContainText('图片已生成');
  await page.locator('#enroll-reset').click();
  expect(await page.evaluate(async (url) => {
    try { await fetch(url); return false; } catch { return true; }
  }, oldURL)).toBe(true);
  await expect(page.locator('#png-image')).not.toHaveAttribute('src');
  await expect(page.locator('#download-png')).not.toHaveAttribute('href');
});

test('desktop and mobile previews fit the dialog', async ({ page }, testInfo) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await enroll(page);
    await generate(page);
    expect(await page.locator('#enroll-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    await page.locator('#download-png').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`preview-${width}.png`) });
    const png = await downloadBytes(page, '#download-png');
    await require('node:fs/promises').writeFile(testInfo.outputPath(`card-${width}.png`), png.bytes);
    await page.locator('#enroll-reset').click();
    await page.locator('#enroll-dialog [data-close]').click();
  }
});
