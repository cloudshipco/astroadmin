/**
 * Login page functionality
 */

// Check if already logged in
async function checkSession() {
  try {
    const response = await fetch('/api/session');
    const data = await response.json();

    if (data.authenticated) {
      // Already logged in, redirect to dashboard
      window.location.href = '/dashboard';
    }
  } catch (error) {
    console.error('Session check failed:', error);
  }
}

// Handle login form submission
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const errorMessage = document.getElementById('errorMessage');
  const loginButton = document.getElementById('loginButton');
  const btnText = loginButton.querySelector('.btn-text');
  const btnLoader = loginButton.querySelector('.btn-loader');

  // Hide previous errors
  errorMessage.style.display = 'none';

  // Show loading state
  loginButton.disabled = true;
  btnText.style.display = 'none';
  btnLoader.style.display = 'inline';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();

    if (data.success) {
      // Login successful, redirect to dashboard
      window.location.href = '/dashboard';
    } else {
      // Show error
      errorMessage.textContent = data.error || 'Invalid username or password';
      errorMessage.style.display = 'block';

      // Reset button
      loginButton.disabled = false;
      btnText.style.display = 'inline';
      btnLoader.style.display = 'none';
    }
  } catch (error) {
    console.error('Login error:', error);
    errorMessage.textContent = 'Failed to connect to server';
    errorMessage.style.display = 'block';

    // Reset button
    loginButton.disabled = false;
    btnText.style.display = 'inline';
    btnLoader.style.display = 'none';
  }
});

// Check session on page load
checkSession();
