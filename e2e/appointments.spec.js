import { test, expect } from '@playwright/test';

test.describe('Appointments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('reception@alamal.demo');
    await page.getByLabel(/password/i).fill('Demo1234!');
    await page.getByRole('button', { name: /sign in|log in|دخول|تسجيل/i }).click();
    await page.waitForURL(/\/$/);
  });

  test('appointments page renders the calendar', async ({ page }) => {
    await page.goto('/appointments');
    await expect(page.locator('.fc')).toBeVisible();
  });

  test('can open the new appointment modal', async ({ page }) => {
    await page.goto('/appointments');
    await page.getByRole('button', { name: /new appointment|موعد جديد/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
