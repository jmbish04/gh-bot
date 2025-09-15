// src/modules/badge_detector.ts
/**
 * Badge detection system for repositories
 * Analyzes repository content to determine relevant technology badges
 */

export interface RepoBadge {
  id: string;
  label: string;
  color: string;
  description: string;
}

export interface BadgeDetectionResult {
  badges: RepoBadge[];
  confidence: number;
  reasoning: string;
}

const BADGE_DEFINITIONS: Record<string, RepoBadge> = {
  'cloudflare-worker': {
    id: 'cloudflare-worker',
    label: 'Cloudflare Worker',
    color: '#f38020',
    description: 'Uses Cloudflare Workers platform'
  },
  'apps-script': {
    id: 'apps-script',
    label: 'Apps Script',
    color: '#4285f4',
    description: 'Google Apps Script project'
  },
  'shadcn': {
    id: 'shadcn',
    label: 'shadcn/ui',
    color: '#000000',
    description: 'Uses shadcn/ui component library'
  },
  'ui-library': {
    id: 'ui-library',
    label: 'UI Library',
    color: '#6366f1',
    description: 'Contains UI components or design system'
  },
  'ai': {
    id: 'ai',
    label: 'AI/ML',
    color: '#10b981',
    description: 'Contains AI or machine learning functionality'
  },
  'home-automation': {
    id: 'home-automation',
    label: 'Home Automation',
    color: '#8b5cf6',
    description: 'Home automation or IoT project'
  },
  'typescript': {
    id: 'typescript',
    label: 'TypeScript',
    color: '#3178c6',
    description: 'Written in TypeScript'
  },
  'react': {
    id: 'react',
    label: 'React',
    color: '#61dafb',
    description: 'Uses React framework'
  },
  'nextjs': {
    id: 'nextjs',
    label: 'Next.js',
    color: '#000000',
    description: 'Uses Next.js framework'
  },
  'tailwind': {
    id: 'tailwind',
    label: 'Tailwind CSS',
    color: '#06b6d4',
    description: 'Uses Tailwind CSS'
  },
  'docker': {
    id: 'docker',
    label: 'Docker',
    color: '#2496ed',
    description: 'Containerized with Docker'
  },
  'api': {
    id: 'api',
    label: 'API',
    color: '#f59e0b',
    description: 'Provides API endpoints'
  },
  'database': {
    id: 'database',
    label: 'Database',
    color: '#ef4444',
    description: 'Uses database storage'
  },
  'testing': {
    id: 'testing',
    label: 'Testing',
    color: '#84cc16',
    description: 'Includes comprehensive tests'
  },
  'cli': {
    id: 'cli',
    label: 'CLI Tool',
    color: '#6b7280',
    description: 'Command-line interface tool'
  }
};

const BADGE_PATTERNS: Record<string, RegExp[]> = {
  'cloudflare-worker': [
    /wrangler\.toml/i,
    /wrangler\.json/i,
    /@cloudflare\/workers-types/i,
    /cloudflare:workers/i,
    /durable_objects/i,
    /workers\.ai/i
  ],
  'apps-script': [
    /apps-script/i,
    /google\.script/i,
    /gas/i,
    /clasp/i
  ],
  'shadcn': [
    /shadcn/i,
    /@\/components\/ui/i,
    /cn\(/i,
    /class-variance-authority/i
  ],
  'ui-library': [
    /components?\.(tsx?|jsx?)$/i,
    /storybook/i,
    /design-system/i,
    /ui-library/i,
    /component.*library/i
  ],
  'ai': [
    /openai/i,
    /anthropic/i,
    /@cf\//i,
    /ai\.run/i,
    /machine.?learning/i,
    /neural.?network/i,
    /tensorflow/i,
    /pytorch/i,
    /huggingface/i
  ],
  'home-automation': [
    /home.?automation/i,
    /iot/i,
    /smart.?home/i,
    /hass/i,
    /homeassistant/i,
    /zigbee/i,
    /z-wave/i,
    /mqtt/i
  ],
  'typescript': [
    /\.ts$/i,
    /typescript/i,
    /@types\//i,
    /tsconfig\.json/i
  ],
  'react': [
    /react/i,
    /jsx/i,
    /tsx/i,
    /create-react-app/i
  ],
  'nextjs': [
    /next\.config/i,
    /next\/i,
    /_app\.(tsx?|jsx?)$/i,
    /_document\.(tsx?|jsx?)$/i
  ],
  'tailwind': [
    /tailwind/i,
    /@tailwind/i,
    /tailwindcss/i
  ],
  'docker': [
    /Dockerfile/i,
    /docker-compose/i,
    /\.dockerignore/i
  ],
  'api': [
    /api\/i,
    /endpoint/i,
    /express/i,
    /fastify/i,
    /koa/i,
    /hono/i
  ],
  'database': [
    /database/i,
    /sql/i,
    /mongodb/i,
    /postgres/i,
    /mysql/i,
    /sqlite/i,
    /prisma/i,
    /drizzle/i
  ],
  'testing': [
    /test/i,
    /spec/i,
    /jest/i,
    /vitest/i,
    /cypress/i,
    /playwright/i,
    /testing/i
  ],
  'cli': [
    /cli/i,
    /commander/i,
    /yargs/i,
    /inquirer/i,
    /command.*line/i
  ]
};

export async function detectRepoBadges(
  repo: any,
  repoContent?: string
): Promise<BadgeDetectionResult> {
  const detectedBadges: RepoBadge[] = [];
  let confidence = 0;
  const reasoning: string[] = [];

  // Check repository metadata
  const repoText = [
    repo.name || '',
    repo.description || '',
    repo.full_name || '',
    (repo.topics || []).join(' '),
    repoContent || ''
  ].join(' ').toLowerCase();

  // Check for each badge type
  for (const [badgeId, patterns] of Object.entries(BADGE_PATTERNS)) {
    let matches = 0;
    const matchedPatterns: string[] = [];

    for (const pattern of patterns) {
      if (pattern.test(repoText)) {
        matches++;
        matchedPatterns.push(pattern.source);
      }
    }

    if (matches > 0) {
      const badge = BADGE_DEFINITIONS[badgeId];
      if (badge) {
        detectedBadges.push(badge);
        confidence += matches * 0.2; // Each match adds 20% confidence
        reasoning.push(`${badge.label}: matched ${matches} pattern(s) - ${matchedPatterns.join(', ')}`);
      }
    }
  }

  // Normalize confidence to 0-1 range
  confidence = Math.min(confidence, 1);

  return {
    badges: detectedBadges,
    confidence,
    reasoning: reasoning.join('; ')
  };
}

export function getBadgeColor(badgeId: string): string {
  return BADGE_DEFINITIONS[badgeId]?.color || '#6b7280';
}

export function getAllBadgeDefinitions(): Record<string, RepoBadge> {
  return BADGE_DEFINITIONS;
}
