import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface BuildInfo {
  version: string;
  commitHash: string;
  label: string;
}

const workspaceRootCandidates = [
  process.cwd(),
  path.resolve(process.cwd(), '..'),
  path.resolve(process.cwd(), '../..')
];

const resolveGitDir = ({ startDir }: { startDir: string }) => {
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

const resolveHeadCommit = ({ gitDir }: { gitDir: string | null }) => {
  if (!gitDir) return null;

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

const parseBuildInfo = ({ value }: { value: unknown }): BuildInfo | null => {
  if (!value || typeof value !== 'object') return null;

  const version = 'version' in value && typeof value.version === 'string' ? value.version.trim() : '';
  const commitHash = 'commitHash' in value && typeof value.commitHash === 'string' ? value.commitHash.trim() : '';
  const label = 'label' in value && typeof value.label === 'string' ? value.label.trim() : '';

  if (!version || !commitHash || !label) return null;

  return {
    version,
    commitHash,
    label
  };
};

const readGeneratedBuildInfo = () => {
  const candidatePaths = workspaceRootCandidates.flatMap((rootDir) => [
    path.join(rootDir, 'mqttctl-fe', 'static', 'generated', 'build-info.json'),
    path.join(rootDir, 'static', 'generated', 'build-info.json')
  ]);

  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) continue;

    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      const buildInfo = parseBuildInfo({ value: parsed });
      if (buildInfo) return buildInfo;
    } catch {
      continue;
    }
  }

  return null;
};

const readPackageVersion = () => {
  const candidatePaths = workspaceRootCandidates.flatMap((rootDir) => [
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'mqttctl', 'package.json')
  ]);

  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) continue;

    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === 'mqttctl-workspace' && typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      continue;
    }
  }

  return '0.0.0';
};

let cachedBuildInfo: BuildInfo | null = null;

export const getControlPlaneBuildInfo = () => {
  if (cachedBuildInfo) return cachedBuildInfo;

  const generated = readGeneratedBuildInfo();
  if (generated) {
    cachedBuildInfo = generated;
    return generated;
  }

  const version = readPackageVersion();
  const commitHash = resolveHeadCommit({ gitDir: resolveGitDir({ startDir: process.cwd() }) }) ?? 'unknown';
  cachedBuildInfo = {
    version,
    commitHash,
    label: `v${version}-${commitHash}`
  };
  return cachedBuildInfo;
};
