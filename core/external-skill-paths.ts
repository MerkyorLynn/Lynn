import fs from 'fs';
import path from 'path';

export interface ExternalSkillPath {
  dirPath: string;
  label: string;
  exists?: boolean;
}

export function refreshExternalSkillPathExistence(
  discoveredPaths: ExternalSkillPath[],
  existsSync: (filePath: string) => boolean = fs.existsSync,
): { paths: ExternalSkillPath[]; newDirectoryAppeared: boolean } {
  let newDirectoryAppeared = false;
  const paths = discoveredPaths.map((entry) => {
    const exists = existsSync(entry.dirPath);
    if (exists && !entry.exists) newDirectoryAppeared = true;
    return { ...entry, exists };
  });
  return { paths, newDirectoryAppeared };
}

export function mergeExternalSkillPaths(
  discoveredPaths: ExternalSkillPath[],
  userConfiguredPaths: string[],
): ExternalSkillPath[] {
  // Discovery is informational. Only paths the user enabled may supply prompts.
  const merged: ExternalSkillPath[] = [];
  const seen = new Set(merged.map((entry) => entry.dirPath));

  for (const configuredPath of userConfiguredPaths || []) {
    const dirPath = path.resolve(configuredPath);
    if (seen.has(dirPath)) continue;
    merged.push({ dirPath, label: discoveredPaths.find(entry => path.resolve(entry.dirPath) === dirPath)?.label || path.basename(path.dirname(dirPath)) });
    seen.add(dirPath);
  }
  return merged;
}
