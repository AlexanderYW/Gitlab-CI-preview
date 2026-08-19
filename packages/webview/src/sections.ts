/**
 * Group GitLab CI job keys into thematic sections for the detail panel.
 * Keys not listed here land in a final "Other" section so nothing is lost.
 */
export interface Section {
  id: string;
  title: string;
  description?: string;
  keys: string[];
}

export const SECTIONS: Section[] = [
  {
    id: 'identity',
    title: 'Identity',
    description: 'How the job is identified and where it sits in the pipeline.',
    keys: ['stage', 'extends', 'image', 'services'],
  },
  {
    id: 'execution',
    title: 'Execution',
    description: 'What the job actually runs.',
    keys: ['script', 'before_script', 'after_script', 'entrypoint', 'command', 'trigger', 'release', 'pages'],
  },
  {
    id: 'control',
    title: 'Control flow',
    description: 'When and whether the job runs.',
    keys: ['rules', 'only', 'except', 'when', 'allow_failure', 'manual_confirmation', 'inherit', 'workflow'],
  },
  {
    id: 'dependencies',
    title: 'Dependencies',
    description: 'How this job relates to others.',
    keys: ['needs', 'dependencies', 'resource_group', 'parallel'],
  },
  {
    id: 'env',
    title: 'Environment & variables',
    description: 'Variables, environments, and secrets the job uses.',
    keys: ['variables', 'environment', 'secrets', 'id_tokens', 'hooks'],
  },
  {
    id: 'artifacts',
    title: 'Artifacts & cache',
    description: 'Files in / out of the job and caches.',
    keys: ['artifacts', 'cache', 'coverage'],
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Runner selection, timeouts, retries.',
    keys: ['tags', 'timeout', 'retry', 'interruptible', 'auto_cancel'],
  },
];

export function groupKeys(presentKeys: string[]): { sections: Array<{ section: Section; keys: string[] }>; other: string[] } {
  const known = new Set<string>();
  const sections = SECTIONS.map((section) => {
    const keys = section.keys.filter((k) => presentKeys.includes(k));
    keys.forEach((k) => known.add(k));
    return { section, keys };
  });
  const other = presentKeys.filter((k) => !known.has(k));
  return { sections, other };
}

export function sectionForKey(key: string): Section | null {
  return SECTIONS.find((s) => s.keys.includes(key)) ?? null;
}
