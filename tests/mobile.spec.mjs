import { test, expect } from '@playwright/test';

test('телефон 375 px: без горизонтальной прокрутки, поиск и просмотр работают', async ({ page }) => {
  await page.goto('./?semantic=0');
  await page.waitForSelector('body[data-ready="1"]');
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noScroll()).toBeTruthy();
  await page.fill('#q', 'кредит');
  await expect(page.locator('.answer')).toBeVisible();
  expect(await noScroll()).toBeTruthy();
  await page.locator('.answer .thumb').tap();
  await expect(page.locator('#viewer')).toBeVisible();
  const box = await page.locator('#viewer').boundingBox();
  expect(box.width).toBeLessThanOrEqual(375);
  await page.locator('#v-next').tap();
  await expect(page.locator('#v-meta')).toContainText('слайд');
});
