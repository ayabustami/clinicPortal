import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('receptionist can log in and reach dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('reception@alamal.demo');
    await page.getByLabel(/password/i).fill('Demo1234!');
    await page.getByRole('button', { name: /sign in|log in|دخول|تسجيل/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Al Amal Family Clinic/i)).toBeVisible();
  });

  test('doctor can log in and reach My Day', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('lina@alamal.demo');
    await page.getByLabel(/password/i).fill('Demo1234!');
    await page.getByRole('button', { name: /sign in|log in|دخول|تسجيل/i }).click();
    await page.goto('/my-day');
    await expect(page).toHaveURL(/\/my-day/);
  });

  test('invalid credentials show an error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('nope@alamal.demo');
    await page.getByLabel(/password/i).fill('wrong');
    await page.getByRole('button', { name: /sign in|log in|دخول|تسجيل/i }).click();
    await expect(page.getByText(/invalid|incorrect|خطأ|غير صحيح/i)).toBeVisible();
  });
});
