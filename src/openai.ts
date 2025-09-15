import type { H3Event } from 'h3';
import OpenAI from 'openai';
import { saveFailedQuery, saveUserQuery } from './modules/db';
import { searchGithub } from './modules/github';
import type { UserQuery } from './types/db';

// Constants
const MODEL = 'gpt-4o-2024-08-06' as const;
const MAX_RESULTS_PER_PAGE = 25;

// Types
type SearchEndpoint = 'commits' | 'issues' | 'repositories' | 'users';

interface SearchGithubParams {
  endpoint: SearchEndpoint;
  q: string;
  sort?: string;
  order?: 'asc' | 'desc';
  per_page?: number;
}

interface ToolCall {
  name: string;
  arguments: string;
}

// Tool definitions with proper typing
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchGithub',
      description:
        'Searches GitHub for information using the GitHub API. Call this if you need to find information on GitHub.',
      parameters: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            enum: ['commits', 'issues', 'repositories', 'users'],
            description: 'The specific search endpoint to use',
          },
          q: {
            type: 'string',
            description: 'The search query using applicable qualifiers',
          },
          sort: {
            type: 'string',
            description: 'The sort field (optional, depends on the endpoint)',
          },
          order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'The sort order (optional)',
          },
          per_page: {
            type: 'number',
            minimum: 1,
            maximum: MAX_RESULTS_PER_PAGE,
            description: `Number of results to fetch per page (max ${MAX_RESULTS_PER_PAGE})`,
          },
        },
        required: ['endpoint', 'q'],
        additionalProperties: false,
      },
    },
  },
];

// Singleton pattern for OpenAI client
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Processes a tool call and executes the searchGithub function
 */
async function processToolCall(
  toolCall: ToolCall,
  loggedInUser: string
): Promise<{ request: SearchGithubParams; response: any }> {
  if (toolCall.name !== 'searchGithub') {
    throw new Error(`Unknown tool: ${toolCall.name}`);
  }

  const functionArgs = JSON.parse(toolCall.arguments) as SearchGithubParams;
  
  // Validate and sanitize parameters
  const validatedArgs: SearchGithubParams = {
    endpoint: functionArgs.endpoint,
    q: functionArgs.q,
    sort: functionArgs.sort,
    order: functionArgs.order as 'asc' | 'desc' | undefined,
    per_page: Math.min(
      Math.max(functionArgs.per_page || 10, 1),
      MAX_RESULTS_PER_PAGE
    ),
  };

  const toolResult = await searchGithub(
    loggedInUser,
    validatedArgs.endpoint,
    validatedArgs.q,
    {
      sort: validatedArgs.sort,
      order: validatedArgs.order,
      per_page: validatedArgs.per_page,
    }
  );

  return {
    request: validatedArgs,
    response: toolResult,
  };
}

/**
 * Handles streaming responses from OpenAI
 */
async function* streamResponse(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
): AsyncGenerator<string, string, unknown> {
  let fullContent = '';
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      fullContent += content;
      yield content;
    }
  }
  
  return fullContent;
}

/**
 * Main handler for processing messages with OpenAI
 */
export async function* handleMessageWithOpenAI(
  event: H3Event,
  messages: OpenAI.ChatCompletionMessageParam[],
  loggedInUser: string
): AsyncGenerator<string, void, unknown> {
  const openai = getOpenAIClient();
  
  try {
    // Initial request with tools
    const responseStream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      stream: true,
    });

    const toolCalls: ToolCall[] = [];
    let currentToolCall: Partial<ToolCall> | null = null;
    let assistantContent = '';

    // Process the initial stream
    for await (const chunk of responseStream) {
      const choice = chunk.choices[0];
      
      // Handle content streaming
      if (choice?.delta?.content) {
        assistantContent += choice.delta.content;
        yield choice.delta.content;
      }

      // Handle tool calls (updated for newer OpenAI SDK)
      if (choice?.delta?.tool_calls) {
        for (const toolCallDelta of choice.delta.tool_calls) {
          if (toolCallDelta.id) {
            // New tool call started
            if (currentToolCall && currentToolCall.name && currentToolCall.arguments) {
              toolCalls.push(currentToolCall as ToolCall);
            }
            currentToolCall = {
              name: toolCallDelta.function?.name,
              arguments: toolCallDelta.function?.arguments || '',
            };
          } else if (currentToolCall && toolCallDelta.function?.arguments) {
            // Continue building current tool call
            currentToolCall.arguments += toolCallDelta.function.arguments;
          }
        }
      }

      // Legacy function_call support (for backward compatibility)
      if (choice?.delta?.function_call) {
        const fnc = choice.delta.function_call;
        if (fnc.name) {
          if (currentToolCall && currentToolCall.name && currentToolCall.arguments) {
            toolCalls.push(currentToolCall as ToolCall);
          }
          currentToolCall = { name: fnc.name, arguments: '' };
        }
        if (fnc.arguments && currentToolCall) {
          currentToolCall.arguments += fnc.arguments;
        }
      }

      // Check if we've finished and have tool calls to process
      if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') {
        // Add the last tool call if exists
        if (currentToolCall && currentToolCall.name && currentToolCall.arguments) {
          toolCalls.push(currentToolCall as ToolCall);
        }

        if (toolCalls.length > 0) {
          const queryToSave: UserQuery = {
            userMessage: messages[messages.length - 1]?.content as string || '',
            toolCalls: [],
            assistantReply: '',
          };

          // Add assistant message with tool calls
          const assistantMessage: OpenAI.ChatCompletionMessageParam = {
            role: 'assistant',
            content: assistantContent || null,
          };
          
          // Add tool call information to the message
          if (toolCalls[0]) {
            (assistantMessage as any).function_call = {
              name: toolCalls[0].name,
              arguments: toolCalls[0].arguments,
            };
          }
          
          messages.push(assistantMessage);

          // Process all tool calls
          for (const toolCall of toolCalls) {
            try {
              const result = await processToolCall(toolCall, loggedInUser);
              queryToSave.toolCalls.push(result);

              // Add tool response to messages
              messages.push({
                role: 'function' as any, // or 'tool' depending on OpenAI SDK version
                name: toolCall.name,
                content: JSON.stringify(result.response),
              });
            } catch (error) {
              console.error('Error processing tool call:', error);
              
              // Save failed query for debugging
              await saveFailedQuery(
                queryToSave.userMessage,
                toolCall.arguments
              ).catch(console.error);

              // Add error message to conversation
              messages.push({
                role: 'function' as any,
                name: toolCall.name,
                content: JSON.stringify({
                  error: error instanceof Error ? error.message : 'Unknown error occurred',
                }),
              });
            }
          }

          // Generate final response after tool calls
          try {
            const finalResponse = await openai.chat.completions.create({
              model: MODEL,
              messages,
              stream: true,
            });

            const finalContent = yield* streamResponse(finalResponse);
            queryToSave.assistantReply = finalContent;

            // Save the complete query if we had tool calls
            if (queryToSave.toolCalls.length > 0) {
              await saveUserQuery(loggedInUser, queryToSave).catch(console.error);
            }
          } catch (error) {
            console.error('Error generating final response:', error);
            yield '\n\nI apologize, but I encountered an error while processing your request. Please try again.';
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in OpenAI message handler:', error);
    
    // Attempt to save the failed query
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.content) {
      await saveFailedQuery(
        lastMessage.content as string,
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })
      ).catch(console.error);
    }

    yield '\n\nI apologize, but I encountered an error while processing your request. Please try again later.';
  }
}

// Export types for use in other modules
export type { SearchEndpoint, SearchGithubParams };
