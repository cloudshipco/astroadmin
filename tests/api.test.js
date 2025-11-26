/**
 * API Tests for AstroAdmin
 * Tests all API endpoints
 */

const BASE_URL = 'http://localhost:3030';

// Test results
const results = {
  passed: 0,
  failed: 0,
  tests: [],
};

// Simple test runner
async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'PASS' });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'FAIL', error: error.message });
    console.error(`❌ ${name}`);
    console.error(`   Error: ${error.message}`);
  }
}

// Helper to make authenticated requests
let sessionCookie = '';

async function apiRequest(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (sessionCookie) {
    headers['Cookie'] = sessionCookie;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  // Store session cookie
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    sessionCookie = setCookie.split(';')[0];
  }

  const contentType = response.headers.get('content-type');
  let data;

  if (contentType && contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return { response, data };
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

// Run tests
async function runTests() {
  console.log('\n🧪 AstroAdmin API Tests\n');
  console.log('=' .repeat(50));

  // Test 1: Health check
  await test('Health check endpoint', async () => {
    const { response, data } = await apiRequest('/api/health');
    assertEquals(response.status, 200, 'Health check status');
    assertEquals(data.status, 'ok', 'Health check response');
  });

  // Test 2: Config endpoint
  await test('Config endpoint', async () => {
    const { response, data } = await apiRequest('/api/config');
    assertEquals(response.status, 200, 'Config status');
    assertTrue(data.environment, 'Config has environment');
    assertTrue(data.previewUrl, 'Config has previewUrl');
  });

  // Test 3: Login required for protected routes
  await test('Protected routes require auth', async () => {
    sessionCookie = ''; // Clear session
    const { response } = await apiRequest('/api/collections');
    assertEquals(response.status, 401, 'Should return 401 Unauthorized');
  });

  // Test 4: Login with valid credentials
  await test('Login with valid credentials', async () => {
    const { response, data } = await apiRequest('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'admin',
        password: 'admin',
      }),
    });
    assertEquals(response.status, 200, 'Login status');
    assertTrue(data.success, 'Login successful');
  });

  // Test 5: Session check after login
  await test('Session check shows authenticated', async () => {
    const { response, data } = await apiRequest('/api/session');
    assertEquals(response.status, 200, 'Session status');
    assertTrue(data.authenticated, 'User is authenticated');
  });

  // Test 6: Collections API - List all
  await test('GET /api/collections', async () => {
    const { response, data } = await apiRequest('/api/collections');
    assertEquals(response.status, 200, 'Collections status');
    assertTrue(data.success, 'Collections response success');
    assertTrue(Array.isArray(data.collections), 'Collections is array');
    assertTrue(data.collections.length > 0, 'Has at least one collection');
  });

  // Test 7: Collections API - Get specific collection
  await test('GET /api/collections/pages', async () => {
    const { response, data } = await apiRequest('/api/collections/pages');
    assertEquals(response.status, 200, 'Collection status');
    assertTrue(data.success, 'Collection response success');
    assertEquals(data.collection.name, 'pages', 'Collection name');
    assertTrue(Array.isArray(data.collection.entries), 'Has entries array');
  });

  // Test 8: Content API - Read existing content
  await test('GET /api/content/pages/home', async () => {
    const { response, data } = await apiRequest('/api/content/pages/home');
    assertEquals(response.status, 200, 'Content read status');
    assertTrue(data.success, 'Content read success');
    assertTrue(data.data, 'Has frontmatter data');
    assertEquals(data.type, 'content', 'Content type is content');
  });

  // Test 9: Content API - Create/update content
  await test('POST /api/content/testimonials/test-testimonial', async () => {
    const { response, data } = await apiRequest('/api/content/testimonials/test-testimonial', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          quote: 'This is a test testimonial',
          name: 'Test User',
          position: 'Tester',
          organization: 'Test Org',
          rating: 5,
          featured: false,
        },
        body: '',
        type: 'content',
      }),
    });
    assertEquals(response.status, 200, 'Content write status');
    assertTrue(data.success, 'Content write success');
  });

  // Test 10: Content API - Read the content we just created
  await test('GET /api/content/testimonials/test-testimonial', async () => {
    const { response, data } = await apiRequest('/api/content/testimonials/test-testimonial');
    assertEquals(response.status, 200, 'Test content read status');
    assertEquals(data.data.name, 'Test User', 'Content data matches');
  });

  // Test 11: Content API - Delete content
  await test('DELETE /api/content/testimonials/test-testimonial', async () => {
    const { response, data } = await apiRequest('/api/content/testimonials/test-testimonial', {
      method: 'DELETE',
    });
    assertEquals(response.status, 200, 'Content delete status');
    assertTrue(data.success, 'Content delete success');
  });

  // Test 12: Build API - Status
  await test('GET /api/build/status', async () => {
    const { response, data } = await apiRequest('/api/build/status');
    assertEquals(response.status, 200, 'Build status');
    assertTrue(data.success, 'Build status success');
    assertTrue(data.staging, 'Has staging config');
    assertTrue(data.production, 'Has production config');
  });

  // Test 13: Build API - Staging build
  await test('POST /api/build/staging', async () => {
    const { response, data } = await apiRequest('/api/build/staging', {
      method: 'POST',
    });
    assertEquals(response.status, 200, 'Staging build status');
    assertTrue(data.success || data.devMode, 'Staging build success or dev mode');
  });

  // Test 14: Git API - Status
  await test('GET /api/git/status', async () => {
    const { response, data } = await apiRequest('/api/git/status');
    assertEquals(response.status, 200, 'Git status');
    assertTrue(data.success, 'Git status success');
    assertTrue(data.status, 'Has status object');
  });

  // Test 15: Git API - Log
  await test('GET /api/git/log', async () => {
    const { response, data } = await apiRequest('/api/git/log');
    assertEquals(response.status, 200, 'Git log status');
    assertTrue(data.success, 'Git log success');
    assertTrue(Array.isArray(data.commits), 'Has commits array');
  });

  // Test 16: Logout
  await test('POST /api/logout', async () => {
    const { response, data } = await apiRequest('/api/logout', {
      method: 'POST',
    });
    assertEquals(response.status, 200, 'Logout status');
    assertTrue(data.success, 'Logout success');
  });

  // Test 17: Session after logout
  await test('Session shows unauthenticated after logout', async () => {
    const { response, data } = await apiRequest('/api/session');
    assertEquals(response.status, 200, 'Session status');
    assertEquals(data.authenticated, false, 'User is not authenticated');
  });

  // Summary
  console.log('\n' + '=' .repeat(50));
  console.log(`\n📊 Test Results:`);
  console.log(`   Passed: ${results.passed}`);
  console.log(`   Failed: ${results.failed}`);
  console.log(`   Total:  ${results.passed + results.failed}`);

  if (results.failed > 0) {
    console.log('\n❌ Some tests failed. See errors above.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  console.error('\n💥 Test runner error:', error);
  process.exit(1);
});
