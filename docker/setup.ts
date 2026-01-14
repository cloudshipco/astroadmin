#!/usr/bin/env bun
/**
 * AstroAdmin Production Setup Script
 *
 * Interactive setup that:
 * 1. Prompts for Git repo and domains
 * 2. Generates SSH deploy keys
 * 3. Clones the site repos
 * 4. Creates .env with credentials
 * 5. Updates nginx config with domains
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import * as readline from "readline";

const DOCKER_DIR = import.meta.dir;

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function header(message: string) {
  console.log();
  log(`━━━ ${message} ━━━`, colors.cyan + colors.bold);
  console.log();
}

function success(message: string) {
  log(`✓ ${message}`, colors.green);
}

function warn(message: string) {
  log(`⚠ ${message}`, colors.yellow);
}

function error(message: string) {
  log(`✗ ${message}`, colors.red);
}

// Promisified readline
function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    question: (query: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(query, resolve);
      });
    },
    close: () => rl.close(),
  };
}

async function prompt(rl: ReturnType<typeof createPrompt>, question: string, defaultValue?: string): Promise<string> {
  const defaultText = defaultValue ? ` ${colors.dim}[${defaultValue}]${colors.reset}` : "";
  const answer = await rl.question(`${question}${defaultText}: `);
  return answer.trim() || defaultValue || "";
}

async function confirm(rl: ReturnType<typeof createPrompt>, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`${question} ${colors.dim}${hint}${colors.reset}: `);
  if (!answer.trim()) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

function generateSecret(length = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomBytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

async function generateSshKey(path: string, comment: string): Promise<void> {
  const dir = join(DOCKER_DIR, path);
  mkdirSync(dir, { recursive: true });

  const keyPath = join(dir, "id_ed25519");
  if (existsSync(keyPath)) {
    warn(`SSH key already exists at ${path}/id_ed25519, skipping`);
    return;
  }

  // Use spawn directly to avoid shell escaping issues with empty passphrase
  const proc = Bun.spawn(["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", comment], {
    stdout: "ignore",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ssh-keygen failed: ${stderr}`);
  }

  success(`Generated SSH key: ${path}/id_ed25519`);
}

async function cloneRepo(url: string, targetDir: string, keyPath: string): Promise<boolean> {
  const fullPath = join(DOCKER_DIR, targetDir);

  if (existsSync(fullPath)) {
    warn(`Directory ${targetDir} already exists, skipping clone`);
    return true;
  }

  const sshKeyPath = join(DOCKER_DIR, keyPath, "id_ed25519");
  const sshCommand = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new`;

  try {
    const proc = Bun.spawn(["git", "clone", url, fullPath], {
      env: { ...process.env, GIT_SSH_COMMAND: sshCommand },
      stdout: "ignore",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr);
    }

    success(`Cloned repository to ${targetDir}`);
    return true;
  } catch (e) {
    error(`Failed to clone repository: ${e}`);
    return false;
  }
}

function updateNginxConfig(mainDomain: string, adminDomain: string, previewDomain: string): void {
  const configPath = join(DOCKER_DIR, "nginx/conf.d/default.conf");
  let config = readFileSync(configPath, "utf-8");

  // Replace example domains
  config = config.replace(/example\.com/g, mainDomain);
  config = config.replace(/admin\.example\.com/g, adminDomain);
  config = config.replace(/preview\.example\.com/g, previewDomain);

  writeFileSync(configPath, config);
  success(`Updated nginx config with your domains`);
}

function createEnvFile(config: {
  username: string;
  password: string;
  sessionSecret: string;
  previewUrl: string;
  autoPush: boolean;
}): void {
  const envPath = join(DOCKER_DIR, ".env");

  if (existsSync(envPath)) {
    warn(".env file already exists, skipping");
    return;
  }

  const content = `# AstroAdmin Production Environment
# Generated by setup script

# Authentication
ADMIN_USERNAME=${config.username}
ADMIN_PASSWORD=${config.password}
SESSION_SECRET=${config.sessionSecret}

# Preview URL (must be browser-accessible)
PREVIEW_URL=${config.previewUrl}

# Git settings
GIT_AUTO_PUSH=${config.autoPush}

# Builder settings
POLL_INTERVAL=60
BRANCH=main

# Ports
HTTP_PORT=80
HTTPS_PORT=443
`;

  writeFileSync(envPath, content);
  success("Created .env file");
}

async function copyDockerfileDev(sitePath: string): Promise<void> {
  const templatePath = join(DOCKER_DIR, "Dockerfile.dev.example");
  const targetPath = join(DOCKER_DIR, sitePath, "Dockerfile.dev");

  if (existsSync(targetPath)) {
    warn(`${sitePath}/Dockerfile.dev already exists, skipping`);
    return;
  }

  const content = readFileSync(templatePath, "utf-8");
  writeFileSync(targetPath, content);
  success(`Copied Dockerfile.dev to ${sitePath}`);
}

async function createDirectories(): Promise<void> {
  const dirs = ["dist", "certs"];
  for (const dir of dirs) {
    const path = join(DOCKER_DIR, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      success(`Created ${dir} directory`);
    }
  }
}

async function main() {
  console.log();
  log("╔═══════════════════════════════════════════════════════════╗", colors.cyan);
  log("║         AstroAdmin Production Setup                       ║", colors.cyan);
  log("╚═══════════════════════════════════════════════════════════╝", colors.cyan);

  const rl = createPrompt();

  try {
    // Git repository
    header("Git Repository");
    log("Enter your Astro site's Git repository URL (SSH format)");
    const repoUrl = await prompt(rl, "Repository URL", "git@github.com:user/site.git");

    if (!repoUrl.includes("git@") && !repoUrl.includes("ssh://")) {
      warn("URL doesn't look like SSH format. SSH is required for deploy keys.");
    }

    // Domains
    header("Domain Configuration");
    log("Enter the domains for your deployment:");
    const mainDomain = await prompt(rl, "Main site domain", "example.com");
    const adminDomain = await prompt(rl, "Admin domain", `admin.${mainDomain}`);
    const previewDomain = await prompt(rl, "Preview domain", `preview.${mainDomain}`);

    // Protocol
    const useHttps = await confirm(rl, "Will you be using HTTPS?", true);
    const protocol = useHttps ? "https" : "http";

    // Credentials
    header("Admin Credentials");
    const username = await prompt(rl, "Admin username", "admin");
    const password = await prompt(rl, "Admin password");

    if (!password || password.length < 8) {
      warn("Password should be at least 8 characters for security");
    }

    // Auto-push
    header("Git Workflow");
    const autoPush = await confirm(
      rl,
      "Auto-push changes after commit? (otherwise manual publish required)",
      false
    );

    // Confirm
    header("Configuration Summary");
    console.log(`  Repository:     ${repoUrl}`);
    console.log(`  Main site:      ${protocol}://${mainDomain}`);
    console.log(`  Admin:          ${protocol}://${adminDomain}`);
    console.log(`  Preview:        ${protocol}://${previewDomain}`);
    console.log(`  Username:       ${username}`);
    console.log(`  Password:       ${"*".repeat(password.length || 5)}`);
    console.log(`  Auto-push:      ${autoPush ? "Yes" : "No"}`);
    console.log();

    const proceed = await confirm(rl, "Proceed with setup?", true);
    if (!proceed) {
      log("Setup cancelled.", colors.yellow);
      rl.close();
      return;
    }

    rl.close();

    // Execute setup
    header("Generating SSH Keys");
    await generateSshKey("ssh/rw", "astroadmin-rw");
    await generateSshKey("ssh/ro", "astroadmin-ro");

    // Show public keys
    console.log();
    log("Add these deploy keys to your GitHub repository:", colors.yellow);
    log("(Settings → Deploy keys → Add deploy key)", colors.dim);
    console.log();

    const rwPubKey = readFileSync(join(DOCKER_DIR, "ssh/rw/id_ed25519.pub"), "utf-8").trim();
    const roPubKey = readFileSync(join(DOCKER_DIR, "ssh/ro/id_ed25519.pub"), "utf-8").trim();

    log("1. Read-Write key (enable 'Allow write access'):", colors.bold);
    console.log(colors.dim + rwPubKey + colors.reset);
    console.log();
    log("2. Read-Only key (leave 'Allow write access' unchecked):", colors.bold);
    console.log(colors.dim + roPubKey + colors.reset);
    console.log();

    // Wait for user to add keys
    const rl2 = createPrompt();
    await rl2.question("Press Enter after adding the deploy keys to GitHub...");
    rl2.close();

    // Clone repos
    header("Cloning Repository");
    const cloneSuccess = await cloneRepo(repoUrl, "site", "ssh/rw");
    if (cloneSuccess) {
      await cloneRepo(repoUrl, "site-live", "ssh/ro");
    }

    // Create config files
    header("Creating Configuration");
    createEnvFile({
      username,
      password,
      sessionSecret: generateSecret(64),
      previewUrl: `${protocol}://${previewDomain}`,
      autoPush,
    });

    updateNginxConfig(mainDomain, adminDomain, previewDomain);
    await createDirectories();

    // Copy Dockerfile.dev
    if (existsSync(join(DOCKER_DIR, "site"))) {
      await copyDockerfileDev("site");

      console.log();
      warn("Remember to commit and push Dockerfile.dev to your repository:");
      log(`  cd site && git add Dockerfile.dev && git commit -m "Add Dockerfile.dev" && git push`, colors.dim);
    }

    // Done
    header("Setup Complete!");
    log("Next steps:", colors.bold);
    console.log();
    console.log("  1. Review the generated .env file");
    console.log("  2. Review nginx/conf.d/default.conf");
    if (useHttps) {
      console.log("  3. Set up SSL certificates in ./certs");
    }
    console.log(`  ${useHttps ? "4" : "3"}. Start the services:`);
    console.log();
    log("     docker-compose up -d", colors.green);
    console.log();
    console.log("  Then access your admin at:");
    log(`     ${protocol}://${adminDomain}`, colors.cyan);
    console.log();

  } catch (e) {
    error(`Setup failed: ${e}`);
    process.exit(1);
  }
}

main();
