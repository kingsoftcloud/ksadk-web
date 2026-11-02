import { expect, test } from '@playwright/test';

for (const library of [false, true]) {
  test(`official named icons load locally through ${library ? 'built library CSS and exports' : 'application CSS'}`, async ({ page }, info) => {
    const external: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') external.push(url.href);
    });
    await page.goto(`/e2e/fixtures/a2ui-icon-font.html?library=${library ? '1' : '0'}`);
    await expect(page.locator('a2ui-icon i')).toHaveCount(3);
    const loaded = await page.evaluate(async () => {
      const faces = await document.fonts.load('24px "Material Icons"', 'check home search');
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = '24px "Material Icons"';
      return {
        faces: faces.map(face => ({ family: face.family, status: face.status })),
        widths: ['check', 'home', 'search'].map(name => ({ name, width: context.measureText(name).width })),
      };
    });
    expect(loaded.faces).toContainEqual({ family: 'Material Icons', status: 'loaded' });
    // A loaded ligature is one 24px glyph; fallback text is several letters wide.
    for (const { width } of loaded.widths) expect(width).toBeCloseTo(24, 1);
    expect(external).toEqual([]);
    await info.attach('font-loading', { body: JSON.stringify({ ...loaded, external }, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('named-icons.png') });
  });
}
