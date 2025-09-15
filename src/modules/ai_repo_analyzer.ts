// src/modules/ai_repo_analyzer.ts
/**
 * AI-powered repository analysis for detailed insights
 * Provides in-depth analysis of repositories with actionable recommendations
 */
import type { RepoBadge } from './badge_detector'

export interface RepoAnalysis {
  repoFullName: string;
  summary: string;
  keyHighlights: string[];
  technologyStack: string[];
  architecture: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: ActionRecommendation[];
  bestPractices: BestPractice[];
  badges: RepoBadge[];
  confidence: number;
  analysisTimestamp: number;
}

export interface ActionRecommendation {
  id: string;
  title: string;
  description: string;
  command?: string;
  url?: string;
  category: 'deploy' | 'fork' | 'explore' | 'contribute' | 'learn';
  priority: 'high' | 'medium' | 'low';
}

export interface BestPractice {
  id: string;
  title: string;
  description: string;
  category: string;
  confidence: number;
  example?: string;
}

export class AIRepoAnalyzer {
  constructor(private ai: any) {}

  async analyzeRepository(
    repo: any,
    badges: RepoBadge[],
    repoContent?: string
  ): Promise<RepoAnalysis> {
    const prompt = this.buildAnalysisPrompt(repo, badges, repoContent);
    
    try {
      const response = await this.ai.run('@cf/openai/gpt-4o-mini', {
        messages: [
          {
            role: 'system',
            content: `You are an expert software engineer and repository analyst. Analyze the provided repository and return a comprehensive analysis in JSON format. Focus on practical insights that would help a developer understand why this repository is interesting and what they can do with it.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' }
      });

      const analysis = JSON.parse(response.response);
      
      return {
        repoFullName: repo.full_name,
        summary: analysis.summary || 'No summary available',
        keyHighlights: analysis.keyHighlights || [],
        technologyStack: analysis.technologyStack || [],
        architecture: analysis.architecture || 'Unknown',
        strengths: analysis.strengths || [],
        weaknesses: analysis.weaknesses || [],
        recommendations: analysis.recommendations || [],
        bestPractices: analysis.bestPractices || [],
        badges,
        confidence: analysis.confidence || 0.5,
        analysisTimestamp: Date.now()
      };
    } catch (error) {
      console.error('Error analyzing repository:', error);
      
      // Return fallback analysis
      return this.createFallbackAnalysis(repo, badges);
    }
  }

  private buildAnalysisPrompt(repo: any, badges: RepoBadge[], repoContent?: string): string {
    const badgeList = badges.map(b => b.label).join(', ');
    
    return `Analyze this repository and provide insights:

Repository: ${repo.full_name}
Description: ${repo.description || 'No description'}
Stars: ${repo.stargazers_count || 0}
Language: ${repo.language || 'Unknown'}
Topics: ${(repo.topics || []).join(', ')}
Detected Technologies: ${badgeList}

${repoContent ? `Repository Content Sample:\n${repoContent.slice(0, 2000)}...` : ''}

Please provide a JSON response with the following structure:
{
  "summary": "Brief 2-3 sentence summary of what this repository does and why it's interesting",
  "keyHighlights": ["Key feature 1", "Key feature 2", "Key feature 3"],
  "technologyStack": ["Technology 1", "Technology 2", "Technology 3"],
  "architecture": "Brief description of the architecture or design patterns used",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "weaknesses": ["Potential weakness 1", "Potential weakness 2"],
  "recommendations": [
    {
      "id": "deploy-workers",
      "title": "Deploy to Cloudflare Workers",
      "description": "This repo can be easily deployed to Cloudflare Workers",
      "command": "wrangler deploy",
      "category": "deploy",
      "priority": "high"
    }
  ],
  "bestPractices": [
    {
      "id": "example-practice",
      "title": "Example Best Practice",
      "description": "This repo demonstrates good practices for X",
      "category": "code-quality",
      "confidence": 0.8
    }
  ],
  "confidence": 0.85
}`;
  }

  private createFallbackAnalysis(repo: any, badges: RepoBadge[]): RepoAnalysis {
    const badgeList = badges.map(b => b.label).join(', ');
    
    return {
      repoFullName: repo.full_name,
      summary: `A ${repo.language || 'software'} project with ${repo.stargazers_count || 0} stars. ${repo.description || 'No description available.'}`,
      keyHighlights: [
        `${repo.stargazers_count || 0} stars`,
        `Primary language: ${repo.language || 'Unknown'}`,
        `Technologies: ${badgeList}`
      ],
      technologyStack: badges.map(b => b.label),
      architecture: 'Unknown',
      strengths: ['Active repository', 'Has documentation'],
      weaknesses: ['Limited analysis available'],
      recommendations: [
        {
          id: 'explore-code',
          title: 'Explore the Code',
          description: 'Browse the repository to understand its structure and implementation',
          url: repo.html_url,
          category: 'explore',
          priority: 'high'
        }
      ],
      bestPractices: [],
      badges,
      confidence: 0.3,
      analysisTimestamp: Date.now()
    };
  }

  async generateActionCommands(repo: any, analysis: RepoAnalysis): Promise<ActionRecommendation[]> {
    const commands: ActionRecommendation[] = [];

    // Deploy commands
    if (analysis.badges.some(b => b.id === 'cloudflare-worker')) {
      commands.push({
        id: 'deploy-workers',
        title: 'Deploy to Cloudflare Workers',
        description: 'Deploy this Cloudflare Worker to your account',
        command: `wrangler deploy --name ${repo.name}`,
        category: 'deploy',
        priority: 'high'
      });
    }

    // Fork command
    commands.push({
      id: 'fork-repo',
      title: 'Fork Repository',
      description: 'Create your own copy of this repository',
      url: `${repo.html_url}/fork`,
      category: 'fork',
      priority: 'medium'
    });

    // Clone command
    commands.push({
      id: 'clone-repo',
      title: 'Clone Repository',
      description: 'Clone the repository to your local machine',
      command: `git clone ${repo.clone_url}`,
      category: 'explore',
      priority: 'high'
    });

    // Generate prompt for AI editing
    commands.push({
      id: 'generate-prompt',
      title: 'Generate AI Edit Prompt',
      description: 'Create a prompt for AI-assisted editing of this repository',
      command: `echo "Help me understand and modify this ${repo.language} project: ${repo.html_url}"`,
      category: 'learn',
      priority: 'medium'
    });

    return commands;
  }
}