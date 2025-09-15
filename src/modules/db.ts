/// <reference types="@cloudflare/workers-types" />
// The global declaration of DB is already present in /src/types/globals.d.ts

import type {
  RecentQuery,
  ToolCallDetails,
  TrendingUser,
  UserQuery,
} from '../types/db';

const hubDatabase = (): D1Database => {
  return DB;
};

/**
 * Retrieves the avatar URL from a tool call's response.
 *
 * @param toolCall - The details of the tool call containing the response.
 * @returns The avatar URL if found, otherwise undefined.
 */
const getAvatarUrl = (toolCall: ToolCallDetails) => {
  let avatarUrl;
  const responseItem = toolCall.response.items[0];

  if (responseItem) {
    if (responseItem.author) {
      avatarUrl = responseItem.author.avatar_url;
    } else if (responseItem.user) {
      avatarUrl = responseItem.user.avatar_url;
    } else if (responseItem.owner) {
      avatarUrl = responseItem.owner.avatar_url;
    } else if (responseItem.avatar_url) {
      avatarUrl = responseItem.avatar_url;
    }
  }

  return avatarUrl;
};

const shouldSaveUserQuery = (
  toolCall: ToolCallDetails,
  loggedInUser: string
) => {
  const responseItem = toolCall.response.items[0];
  if (
    responseItem &&
    ((responseItem.author && responseItem.author.login === loggedInUser) ||
      (responseItem.user && responseItem.user.login === loggedInUser) ||
      (responseItem.owner && responseItem.owner.login === loggedInUser) ||
      responseItem.login === loggedInUser)
  ) {
    return false;
  }

  return true;
};

export const saveUserQuery = async (
  loggedInUser: string,
  userQuery: UserQuery
) => {
  const toolCall = userQuery.toolCalls[0];
  const matchedUser = toolCall.request.q.match(/(?:author:|user:)(\S+)/);
  if (matchedUser) {
    const queriedUser = matchedUser[1].toLowerCase();
    if (queriedUser !== loggedInUser) {
      const avatarUrl = getAvatarUrl(toolCall);

      await storeQuery(
        userQuery.userMessage,
        userQuery.assistantReply,
        toolCall,
        { login: queriedUser, avatarUrl }
      );
    }
  } else if (shouldSaveUserQuery(toolCall, loggedInUser)) {
    await storeQuery(userQuery.userMessage, userQuery.assistantReply, toolCall);
  }
};

/**
 * Stores a user query and its associated details in the database.
 *
 * @param queryText - The text of the user's query.
 * @param assistantReply - The assistant's reply to the query.
 * @param toolCall - The details of the tool call associated with the query.
 * @param queriedUser - Optional details of the queried user, including login and avatar URL.
 */
const storeQuery = async (
  queryText: string,
  assistantReply: string,
  toolCall: ToolCallDetails,
  queriedUser?: { login: string; avatarUrl?: string }
) => {
  try {
    const db = hubDatabase();

    const queryStmt = db
      .prepare(
        'INSERT INTO queries (text, response, github_request, github_response) VALUES (?1, ?2, ?3, ?4)'
      )
      .bind(
        queryText,
        assistantReply,
        JSON.stringify(toolCall.request),
        JSON.stringify(toolCall.response)
      );
    if (queriedUser) {
      const [batchRes1, batchRes2] = await db.batch([
        queryStmt,
        db
          .prepare(
            `INSERT INTO trending_users (username, search_count, last_searched, avatar_url)
              VALUES (?1, 1, CURRENT_TIMESTAMP, ?2)
              ON CONFLICT(username)
              DO UPDATE SET search_count = search_count + 1, last_searched = CURRENT_TIMESTAMP, avatar_url = COALESCE(?2, avatar_url)`
          )
          .bind(queriedUser.login, queriedUser.avatarUrl),
      ]);

      console.log('storeQuery: ', batchRes1, batchRes2);
    } else {
      const res = await queryStmt.run();

      console.log('storeQuery: ', res);
    }
  } catch (error) {
    console.error('Failed to store query: ', error);
  }
};

/**
 * Retrieves the top trending users based on search count.
 *
 * @returns An array of trending users ordered by search count.
 */
export const getTrendingUsers = async () => {
  const db = hubDatabase();
  const result = await db
    .prepare('SELECT * FROM trending_users ORDER BY search_count DESC LIMIT ?')
    .bind(10)
    .all<TrendingUser>();

  return result.results;
};

/**
 * Retrieves the most recent user queries.
 *
 * @returns An array of recent queries ordered by the time they were queried.
 */
export const getRecentQueries = async () => {
  const db = hubDatabase();
  console.log('getRecentQueries');
  const result = await db
    .prepare(
      'SELECT id, text, response, queried_at FROM queries ORDER BY queried_at DESC LIMIT ?'
    )
    .bind(10)
    .all<RecentQuery>();

  console.log('getRecentQueries: ', result);
  return result.results;
};

/**
 * Saves a user's details in the database.
 *
 * @param username - The username of the user.
 * @param avatarUrl - The avatar URL of the user.
 */
export const saveUser = async (username: string, avatarUrl: string) => {
  const db = hubDatabase();
  await db
    .prepare(
      'INSERT INTO registered_users (username, avatar_url) VALUES (?1, ?2) ON CONFLICT(username) DO UPDATE SET avatar_url = excluded.avatar_url'
    )
    .bind(username, avatarUrl)
    .run();
};

/**
 * Saves a failed query in the database.
 *
 * @param queryText - The text of the failed query.
 * @param toolCallRequest - The tool call request associated with the failed query.
 */
export const saveFailedQuery = async (
  queryText: string,
  toolCallRequest: string
) => {
  const db = hubDatabase();
  await db
    .prepare(
      'INSERT INTO failed_queries (text, github_request) VALUES (?1, ?2)'
    )
    .bind(queryText, toolCallRequest)
    .run();
};

export async function insertRepoIfNew(DB: D1Database, row: {
  id: number; full_name: string; installation_id: number; default_branch: string;
  visibility: string; description: string; topics: string[];
}) {
  const exists = await DB.prepare('SELECT 1 FROM repos WHERE full_name=?').bind(row.full_name).first()
  if (exists) return false
  await DB.prepare(`
    INSERT INTO repos (id, full_name, installation_id, default_branch, visibility, description, topics, last_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(row.id, row.full_name, row.installation_id, row.default_branch, row.visibility, row.description, JSON.stringify(row.topics||[]), Date.now()).run()
  return true
}

export async function markRepoSynced(DB: D1Database, full_name: string) {
  await DB.prepare('UPDATE repos SET last_synced=?, updated_at=? WHERE full_name=?')
    .bind(Date.now(), Date.now(), full_name).run()
}
