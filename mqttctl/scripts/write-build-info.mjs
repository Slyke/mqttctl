import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');
const outputPath = path.resolve(workspaceRoot, 'mqttctl-fe', 'static', 'generated', 'build-info.json');

const readJsonFile = ({ filePath }) => JSON.parse(readFileSync(filePath, 'utf8'));

const resolveGitDir = ({ startDir }) => {
  let currentDir = startDir;

  for (;;) {
    const gitPath = path.join(currentDir, '.git');
    if (existsSync(gitPath)) {
      const stats = statSync(gitPath);
      if (stats.isDirectory()) return gitPath;

      const contents = readFileSync(gitPath, 'utf8').trim();
      if (contents.startsWith('gitdir:')) {
        const configuredPath = contents.slice('gitdir:'.length).trim();
        return path.resolve(currentDir, configuredPath);
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
};

const resolveHeadCommit = ({ gitDir }) => {
  const headPath = path.join(gitDir, 'HEAD');
  if (!existsSync(headPath)) return null;

  const headContents = readFileSync(headPath, 'utf8').trim();
  if (!headContents) return null;

  if (!headContents.startsWith('ref:')) {
    return headContents.slice(0, 7);
  }

  const refName = headContents.slice('ref:'.length).trim();
  const refPath = path.join(gitDir, refName);
  if (existsSync(refPath)) {
    return readFileSync(refPath, 'utf8').trim().slice(0, 7);
  }

  const packedRefsPath = path.join(gitDir, 'packed-refs');
  if (!existsSync(packedRefsPath)) return null;

  for (const line of readFileSync(packedRefsPath, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const [commit, packedRefName] = line.trim().split(' ');
    if (packedRefName === refName && commit) return commit.slice(0, 7);
  }

  return null;
};

const packageJson = readJsonFile({ filePath: path.join(workspaceRoot, 'package.json') });
const version = typeof packageJson.version === 'string' && packageJson.version.trim()
  ? packageJson.version.trim()
  : '0.0.0';
const gitDir = resolveGitDir({ startDir: workspaceRoot });
const commitHash = gitDir ? resolveHeadCommit({ gitDir }) ?? 'unknown' : 'unknown';
const buildInfo = {
  version,
  commitHash,
  label: `v${version}-${commitHash}`
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
