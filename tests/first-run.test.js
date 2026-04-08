import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureFirstRun } from '../core/first-run.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-first-run-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function writeYaml(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.dump(value, { lineWidth: 120, noRefs: true, quotingType: '"' }), 'utf-8');
}

function readYaml(filePath) {
  return YAML.load(fs.readFileSync(filePath, 'utf-8'));
}

function makeProductDir(root) {
  const productDir = path.join(root, 'product');
  fs.mkdirSync(productDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'skills2set'), { recursive: true });
  fs.mkdirSync(path.join(productDir, 'public-ishiki-templates'), { recursive: true });
  fs.writeFileSync(path.join(productDir, 'config.example.yaml'), 'agent:\n  name: Lynn\n  yuan: lynn\n', 'utf-8');
  fs.writeFileSync(path.join(productDir, 'identity.example.md'), '# identity\n', 'utf-8');
  fs.writeFileSync(path.join(productDir, 'ishiki.example.md'), '# ishiki\n', 'utf-8');
  fs.writeFileSync(path.join(productDir, 'public-ishiki-templates', 'lynn.md'), '# public-ishiki\n', 'utf-8');
  return productDir;
}

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureFirstRun', () => {
  it('migrates the legacy hanako primary assistant into lynn', () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, '.lynn');
    const agentsDir = path.join(lynnHome, 'agents');
    const productDir = makeProductDir(root);

    writeYaml(path.join(agentsDir, 'hanako', 'config.yaml'), {
      agent: { name: 'Lynn', yuan: 'hanako' },
      user: { name: '00' },
    });
    writeJson(path.join(lynnHome, 'user', 'preferences.json'), {
      primaryAgent: 'hanako',
      agentOrder: ['hanako', 'agent-reviewer'],
      review: {
        defaultReviewer: 'hanako',
        hanakoReviewerId: 'hanako',
        butterReviewerId: null,
      },
    });

    ensureFirstRun(lynnHome, productDir);

    expect(fs.existsSync(path.join(agentsDir, 'hanako', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'lynn', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'butter', 'config.yaml'))).toBe(true);

    const prefs = JSON.parse(fs.readFileSync(path.join(lynnHome, 'user', 'preferences.json'), 'utf-8'));
    expect(prefs.primaryAgent).toBe('lynn');
    expect(prefs.agentOrder).toEqual(['lynn', 'agent-reviewer', 'hanako', 'butter']);
    expect(prefs.review.hanakoReviewerId).toBeNull();

    const migrated = readYaml(path.join(agentsDir, 'lynn', 'config.yaml'));
    expect(migrated.agent.name).toBe('Lynn');
    expect(migrated.agent.yuan).toBe('lynn');
  });

  it('keeps a real hanako agent untouched', () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, '.lynn');
    const agentsDir = path.join(lynnHome, 'agents');
    const productDir = makeProductDir(root);

    writeYaml(path.join(agentsDir, 'hanako', 'config.yaml'), {
      agent: { name: 'Hanako', yuan: 'hanako' },
    });
    writeJson(path.join(lynnHome, 'user', 'preferences.json'), {
      primaryAgent: 'hanako',
    });

    ensureFirstRun(lynnHome, productDir);

    expect(fs.existsSync(path.join(agentsDir, 'hanako', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'lynn', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'butter', 'config.yaml'))).toBe(true);
  });

  it('seeds recommended skills for near-empty agents after syncing built-in skills', () => {
    const root = makeTempRoot();
    tempRoots.push(root);
    const lynnHome = path.join(root, '.lynn');
    const agentsDir = path.join(lynnHome, 'agents');
    const productDir = makeProductDir(root);
    const skillsRoot = path.join(root, 'skills2set');

    for (const [dirName, skillName] of [
      ['quiet-musing', 'quiet-musing'],
      ['self-improving-agent', 'Self-Improving Agent'],
      ['tavily-search', 'tavily'],
      ['find-skills', 'find-skills'],
      ['summarize', 'summarize'],
      ['agent-browser', 'Agent Browser'],
      ['github', 'github'],
      ['proactive-agent', 'Proactive Agent'],
      ['ontology', 'ontology'],
      ['weather', 'weather'],
      ['skill-vetter', 'Skill Vetter'],
      ['nano-pdf', 'Nano PDF'],
      ['humanizer', 'Humanizer'],
      ['ffmpeg-video-editor', 'Ffmpeg Video Editor'],
      ['docker-essentials', 'Docker Essentials'],
      ['baidu-search', 'baidu-search'],
      ['stock-analysis', 'stock-analysis'],
    ]) {
      const skillDir = path.join(skillsRoot, dirName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\n---\n# ${skillName}\n`, 'utf-8');
    }

    writeYaml(path.join(agentsDir, 'lynn', 'config.yaml'), {
      agent: { name: 'Lynn', yuan: 'lynn' },
      skills: { enabled: ['quiet-musing'] },
    });

    ensureFirstRun(lynnHome, productDir);

    const migrated = readYaml(path.join(agentsDir, 'lynn', 'config.yaml'));
    expect(migrated.skills.enabled).toEqual(expect.arrayContaining([
      'quiet-musing',
      'self-improving-agent',
      'tavily-search',
      'find-skills',
      'summarize',
      'agent-browser',
      'github',
      'proactive-agent',
      'ontology',
      'weather',
      'skill-vetter',
      'nano-pdf',
      'humanizer',
      'ffmpeg-video-editor',
      'docker-essentials',
      'baidu-search',
      'stock-analysis',
    ]));
    expect(migrated.skills._recommended_seeded).toBe(true);
  });
});
