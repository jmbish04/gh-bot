// src/modules/user_preferences.ts
/**
 * User preferences and learning system
 * Stores user feedback and learns from interactions
 */

export interface UserPreferences {
  userId: string;
  likedRepos: string[];
  dislikedRepos: string[];
  preferredBadges: string[];
  preferredTechnologies: string[];
  lastUpdated: number;
}

export interface RepoFeedback {
  repoFullName: string;
  feedback: 'like' | 'dislike';
  timestamp: number;
  reasoning?: string;
}

export interface LearningInsights {
  preferredTechnologies: string[];
  avoidedTechnologies: string[];
  preferredBadges: string[];
  confidence: number;
}

const DEFAULT_USER_ID = 'default-user';

export class UserPreferencesManager {
  constructor(private kv: KVNamespace) {}

  async getUserPreferences(userId: string = DEFAULT_USER_ID): Promise<UserPreferences> {
    try {
      const data = await this.kv.get(`user:${userId}`, 'json');
      if (data) {
        return data as UserPreferences;
      }
    } catch (error) {
      console.error('Error fetching user preferences:', error);
    }

    // Return default preferences
    return {
      userId,
      likedRepos: [],
      dislikedRepos: [],
      preferredBadges: [],
      preferredTechnologies: [],
      lastUpdated: Date.now()
    };
  }

  async updateUserPreferences(preferences: UserPreferences): Promise<void> {
    try {
      await this.kv.put(`user:${preferences.userId}`, JSON.stringify(preferences));
    } catch (error) {
      console.error('Error updating user preferences:', error);
      throw error;
    }
  }

  async recordRepoFeedback(
    userId: string,
    repoFullName: string,
    feedback: 'like' | 'dislike',
    reasoning?: string
  ): Promise<void> {
    const preferences = await this.getUserPreferences(userId);
    
    if (feedback === 'like') {
      if (!preferences.likedRepos.includes(repoFullName)) {
        preferences.likedRepos.push(repoFullName);
      }
      // Remove from disliked if it was there
      preferences.dislikedRepos = preferences.dislikedRepos.filter(r => r !== repoFullName);
    } else {
      if (!preferences.dislikedRepos.includes(repoFullName)) {
        preferences.dislikedRepos.push(repoFullName);
      }
      // Remove from liked if it was there
      preferences.likedRepos = preferences.likedRepos.filter(r => r !== repoFullName);
    }

    preferences.lastUpdated = Date.now();
    await this.updateUserPreferences(preferences);

    // Store individual feedback record
    const feedbackRecord: RepoFeedback = {
      repoFullName,
      feedback,
      timestamp: Date.now(),
      reasoning
    };

    try {
      await this.kv.put(
        `feedback:${userId}:${Date.now()}`,
        JSON.stringify(feedbackRecord),
        { expirationTtl: 365 * 24 * 60 * 60 } // 1 year
      );
    } catch (error) {
      console.error('Error storing feedback record:', error);
    }
  }

  async getLearningInsights(userId: string = DEFAULT_USER_ID): Promise<LearningInsights> {
    const preferences = await this.getUserPreferences(userId);
    
    // Analyze feedback patterns
    const feedbackRecords = await this.getFeedbackHistory(userId);
    
    const likedTechnologies = new Set<string>();
    const dislikedTechnologies = new Set<string>();
    const likedBadges = new Set<string>();

    // Analyze liked repos
    for (const repoName of preferences.likedRepos) {
      // This would ideally analyze the actual repo content
      // For now, we'll use simple heuristics
      if (repoName.includes('worker')) likedTechnologies.add('cloudflare-worker');
      if (repoName.includes('ui')) likedTechnologies.add('ui-library');
      if (repoName.includes('ai')) likedTechnologies.add('ai');
    }

    // Analyze feedback records for more detailed insights
    for (const record of feedbackRecords) {
      if (record.feedback === 'like' && record.reasoning) {
        // Extract technology mentions from reasoning
        const techMatches = record.reasoning.match(/\b(typescript|react|nextjs|tailwind|docker|api|database|testing|cli)\b/gi);
        if (techMatches) {
          techMatches.forEach(tech => likedTechnologies.add(tech.toLowerCase()));
        }
      }
    }

    return {
      preferredTechnologies: Array.from(likedTechnologies),
      avoidedTechnologies: Array.from(dislikedTechnologies),
      preferredBadges: Array.from(likedBadges),
      confidence: Math.min(preferences.likedRepos.length / 10, 1) // Confidence based on sample size
    };
  }

  async getFeedbackHistory(userId: string, limit: number = 100): Promise<RepoFeedback[]> {
    try {
      const list = await this.kv.list({ prefix: `feedback:${userId}:` });
      const feedbackRecords: RepoFeedback[] = [];

      for (const key of list.keys.slice(0, limit)) {
        const data = await this.kv.get(key.name, 'json');
        if (data) {
          feedbackRecords.push(data as RepoFeedback);
        }
      }

      return feedbackRecords.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Error fetching feedback history:', error);
      return [];
    }
  }

  async isRepoDisliked(userId: string, repoFullName: string): Promise<boolean> {
    const preferences = await this.getUserPreferences(userId);
    return preferences.dislikedRepos.includes(repoFullName);
  }

  async getPersonalizedScore(
    userId: string,
    repo: any,
    badges: any[]
  ): Promise<number> {
    const insights = await this.getLearningInsights(userId);
    const baseScore = repo.score || 0;
    
    // Boost score based on preferred technologies
    let boost = 0;
    for (const badge of badges) {
      if (insights.preferredTechnologies.includes(badge.id)) {
        boost += 0.2; // 20% boost per preferred technology
      }
    }

    // Reduce score for disliked repos
    const isDisliked = await this.isRepoDisliked(userId, repo.full_name);
    if (isDisliked) {
      boost -= 0.5; // 50% reduction for disliked repos
    }

    return Math.max(0, Math.min(1, baseScore + boost));
  }
}
