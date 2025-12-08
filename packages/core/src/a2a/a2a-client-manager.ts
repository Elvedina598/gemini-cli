/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  CancelTaskResponse,
  GetTaskResponse,
  MessageSendParams,
  SendMessageResponse,
} from '@a2a-js/sdk';
import { A2AClient, A2AClientOptions } from '@a2a-js/sdk/client';
import { v4 as uuidv4 } from 'uuid';

// TODO: uncomment
// const AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json';

/**
 * Manages A2A clients and caches loaded agent information.
 * Follows a singleton pattern to ensure a single client instance.
 */
export class A2AClientManager {
  private static instance: A2AClientManager;
  private clients = new Map<string, A2AClient>();
  private agentCards = new Map<string, AgentCard>();

  private constructor() {}

  /**
   * Gets the singleton instance of the A2AClientManager.
   */
  static getInstance(): A2AClientManager {
    if (!A2AClientManager.instance) {
      A2AClientManager.instance = new A2AClientManager();
    }
    return A2AClientManager.instance;
  }

  /**
   * Resets the singleton instance. Only for testing purposes.
   * @internal
   */
  static resetInstanceForTesting() {
    A2AClientManager.instance = new A2AClientManager();
  }

  /**
   * Loads an agent by fetching its AgentCard and caches the client.
   * @param name The name to assign to the agent.
   * @param url The base URL of the agent.
   * @param token Optional bearer token for authentication.
   * @returns The loaded AgentCard.
   */
  async loadAgent(
    name: string,
    url: string,
    accessToken?: string,
  ): Promise<AgentCard> {
    if (this.clients.has(name)) {
      throw new Error(`Agent with name '${name}' is already loaded.`);
    }

    // TODO: change to use AGENT_CARD_WELL_KNOWN_PATH when a2a-js is updated
    // Present now to prototype ServiceNow agent
    const options: A2AClientOptions = {
      agentCardPath: 'a2a/v1/card',
    };

    options.fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      let urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      // HACK: The A2A SDK currently appends /a2a to the base URL for messages,
      // but the service expects /a2a/v1/message:send
      if (
        init?.method === 'POST' &&
        (urlStr.endsWith('/a2a') || urlStr.endsWith('/a2a/'))
      ) {
        urlStr = urlStr.replace(/\/a2a\/?$/, '/a2a/v1/message:send');
      }

      // HACK: Unwrap JSON-RPC body for Reasoning Engine
      let body = init?.body;
      let originalRequestId: number | string | undefined;

      if (typeof body === 'string' && body.includes('"jsonrpc"')) {
        try {
          const jsonBody = JSON.parse(body);
          originalRequestId = jsonBody.id; // Capture ID for response wrapping

          if (jsonBody.jsonrpc && jsonBody.params && jsonBody.params.message) {
            const message = jsonBody.params.message;

            // 1. Remove 'kind'
            if (message.kind) {
              delete message.kind;
            }

            // 2. Transform role
            if (message.role === 'user') {
              message.role = 'ROLE_USER';
            }

            // 3. Transform parts -> content & Simplify
            if (message.parts) {
              // Map parts to the simpler structure used in the notebook: { text: "..." }
              // avoiding 'kind' field if possible
              message.content = message.parts.map((part: any) => {
                if (part.kind === 'text' && part.text) {
                  return { text: part.text };
                }
                return part;
              });
              delete message.parts;
            }

            body = JSON.stringify(jsonBody.params);
          }
        } catch (e) {
          console.error('Failed to parse/unwrap JSON-RPC body:', e);
        }
      }

      console.log('A2AClient fetch:', init?.method, urlStr);
      if (body) {
        console.log('A2AClient body:', body);
      }

      const headers = new Headers(init?.headers);
      if (accessToken) {
        headers.set('Authorization', `Bearer ${accessToken}`);
      }
      const newInit = { ...init, headers, body };

      const response = await fetch(urlStr, newInit);

      // HACK: Wrap REST response back into JSON-RPC if we unwrapped the request
      if (originalRequestId !== undefined && response.ok) {
        try {
          const responseData = await response.json();
          // The SDK expects the result to be directly in 'result',
          // but if the service returns { task: ... }, that whole object IS the result.
          // Unwrap 'task' if present (Reasoning Engine returns { task: ... }, SDK expects Task object)
          const result = responseData.task ? responseData.task : responseData;
          const wrappedResponse = {
            jsonrpc: '2.0',
            id: originalRequestId,
            result: result,
          };
          console.log(
            'A2AClient wrapped response:',
            JSON.stringify(wrappedResponse),
          );

          return new Response(JSON.stringify(wrappedResponse), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (e) {
          console.error('Failed to wrap response:', e);
          // If wrapping fails, return original response (it might be consumed already though, so careful)
          // Since we consumed .json(), we can't reuse 'response'.
          // But usually we succeed. If not, the SDK will likely fail anyway.
        }
      }

      return response;
    };

    const client = new A2AClient(url, options);
    const agentCard = await client.getAgentCard();

    this.clients.set(name, client);
    this.agentCards.set(name, agentCard);

    return agentCard;
  }

  /**
   * Sends a message to a loaded agent.
   * @param agentName The name of the agent to send the message to.
   * @param message The message content.
   * @returns The response from the agent.
   */
  async sendMessage(
    agentName: string,
    message: string,
  ): Promise<SendMessageResponse> {
    const client = this.clients.get(agentName);
    if (!client) {
      throw new Error(`Agent '${agentName}' not found.`);
    }

    const messageParams: MessageSendParams = {
      message: {
        kind: 'message',
        role: 'user',
        messageId: uuidv4(),
        parts: [{ kind: 'text', text: message }],
      },
    };

    return client.sendMessage(messageParams);
  }

  /**
   * Retrieves a task from an agent.
   * @param agentName The name of the agent.
   * @param taskId The ID of the task to retrieve.
   * @returns The task details.
   */
  async getTask(agentName: string, taskId: string): Promise<GetTaskResponse> {
    const client = this.clients.get(agentName);
    if (!client) {
      throw new Error(`Agent '${agentName}' not found.`);
    }
    return client.getTask({ id: taskId });
  }

  /**
   * Cancels a task on an agent.
   * @param agentName The name of the agent.
   * @param taskId The ID of the task to cancel.
   * @returns The cancellation response.
   */
  async cancelTask(
    agentName: string,
    taskId: string,
  ): Promise<CancelTaskResponse> {
    const client = this.clients.get(agentName);
    if (!client) {
      throw new Error(`Agent '${agentName}' not found.`);
    }
    return client.cancelTask({ id: taskId });
  }
}
