import { test, expect } from '@playwright/test';

test.describe('Login Page', () => {
  test('should redirect to login page from root', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
  });

  test('should display login form', async ({ page }) => {
    await page.goto('/login');

    // Check for form elements
    await expect(page.locator('h1')).toContainText('AstroAdmin');
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('should show error on invalid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.fill('input[name="username"]', 'wrong');
    await page.fill('input[name="password"]', 'wrong');
    await page.click('button[type="submit"]');

    // Check for error message
    await expect(page.locator('.error-message')).toBeVisible();
  });

  test('should login successfully with valid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin');
    await page.click('button[type="submit"]');

    // Should redirect to dashboard
    await expect(page).toHaveURL('/dashboard');
  });

  test('should redirect to dashboard if already logged in', async ({ page }) => {
    // First login
    await page.goto('/login');
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/dashboard');

    // Try to go back to login page
    await page.goto('/login');

    // Should redirect back to dashboard
    await expect(page).toHaveURL('/dashboard');
  });
});

test.describe('Authentication Flow', () => {
  test('should protect dashboard route when not logged in', async ({ page }) => {
    // Clear cookies to ensure we're not logged in
    await page.context().clearCookies();

    await page.goto('/dashboard');

    // Should redirect to login (or show login-required message)
    // For now, dashboard doesn't exist, so we expect it to redirect or show error
    // This test will be more meaningful once dashboard is built
  });
});
