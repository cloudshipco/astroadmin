import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-api-'));

function git(args) {
  return execFileSync('/usr/bin/git', ['-C', tmpRoot, ...args], {
    encoding: 'utf-8',
  }).trim();
}

try {
  process.env.ASTROADMIN_PROJECT_ROOT = tmpRoot;
  process.env.ASTROADMIN_DB = path.join(tmpRoot, 'content.db');
  process.env.GIT_ENABLED = 'true';

  fs.mkdirSync(path.join(tmpRoot, 'src/styles'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src/content'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'public/images'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src/styles/site.css'), 'body { color: black; }\n');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/page.md'), '---\ntitle: Page\n---\nBody\n');
  fs.writeFileSync(path.join(tmpRoot, 'public/images/.gitkeep'), '');

  git(['init', '-q']);
  git(['config', 'user.name', 'AstroAdmin Test']);
  git(['config', 'user.email', 'astroadmin@example.com']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Initial commit']);

  fs.writeFileSync(path.join(tmpRoot, 'src/styles/site.css'), 'body { color: blue; }\n');
  fs.writeFileSync(path.join(tmpRoot, 'src/content/page.md'), '---\ntitle: Changed\n---\nBody\n');
  git(['add', 'src/content/page.md']);

  const { getConfig } = await import('../server/config.js');
  const { commitConfiguredGitPaths } = await import('../server/api/git.js');
  const fullConfig = await getConfig();
  const { result } = await commitConfiguredGitPaths(fullConfig, 'Commit configured paths');

  assert.ok(result, 'commit succeeds');

  const committedFiles = git([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    'HEAD',
  ]).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(committedFiles, ['src/styles/site.css'], 'only configured git path was committed');

  const status = git(['status', '--short']);
  assert.match(status, /^M  src\/content\/page\.md$/m, 'pre-staged content change remains staged');

  console.log('\n🧪 Git API\n' + '='.repeat(40));
  console.log('✅ commits only configured git paths');
  console.log('='.repeat(40));
  console.log('\n📊 1 checks passed.\n');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
