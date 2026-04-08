import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const isPathWithin = ({ candidatePath, allowedDirectories }: { candidatePath: string; allowedDirectories: string[] }) => {
  const resolvedCandidate = existsSync(candidatePath)
    ? realpathSync(path.resolve(candidatePath))
    : path.resolve(candidatePath);

  return allowedDirectories.some((directory) => {
    const resolvedDirectory = existsSync(directory)
      ? realpathSync(path.resolve(directory))
      : path.resolve(directory);
    return (
      resolvedCandidate === resolvedDirectory
      || resolvedCandidate.startsWith(`${resolvedDirectory}${path.sep}`)
    );
  });
};
